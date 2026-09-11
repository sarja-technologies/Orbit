import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type {
  Artifact,
  Conversation,
  ID,
  OrbitPreferences,
  Project,
  ProjectFile,
  ProjectGroup,
  ProjectSnapshot,
  ModelOption,
  ProviderStatus,
  ReasoningEffort,
  Reference,
  Run,
  RuntimeErrorInfo,
  SystemStatus
} from '@shared/domain'
import type { ArtifactContent, SendMessageInput, StartupSession } from '@shared/contracts'
import type { RuntimeEvent } from '@shared/runtime-events'
import type { AgentProvider } from './provider'
import type { OrbitStore } from '@main/persistence/store'
import type { ArtifactService } from '@main/artifacts/artifactService'
import { effortForNewSession } from '@shared/reasoningPolicy'
import { ORBIT_DEFAULT_MODEL_ID } from '@shared/defaultModel'
import { resolveDefaultModel, resolveDefaultPermissionMode } from '@shared/newSessionDefaults'
import type { PermissionMode } from '@shared/permissionMode'
import { transportForTurn } from '@shared/transportPolicy'
import { DEFAULT_SESSION_TITLE, deriveTitleForPrompt } from '@shared/sessionTitle'
import { nowIso } from '@main/util/ids'
import { StartupSessionResolver } from '@main/startup/startupSession'

interface ActiveRunState {
  text: string
}

export class OrbitRuntime extends EventEmitter {
  private readonly activeRuns = new Map<ID, ActiveRunState>()
  /** The most recent normalized catalogue, so a new session can be given a
   *  tier the default model genuinely publishes without `createConversation`
   *  becoming async. Warmed by `listModels()` (which the renderer calls at
   *  startup) and by `warmModelCatalogue()`. Empty until one of those has
   *  succeeded, which `effortForNewSession` treats as "unknown tiers" rather
   *  than as an excuse to guess. */
  private cachedModels: ModelOption[] = []
  /** Owns the "exactly one brand-new session per application launch"
   *  invariant. Constructed once with the runtime — which lives for the
   *  length of the launch — so no renderer-side lifecycle can make a
   *  second one. */
  private readonly startupSession = new StartupSessionResolver({
    listProjectTree: () => this.store.listProjectTree(),
    readLastActiveProjectId: () => this.store.readPreferences().lastActiveProjectId,
    createConversation: (projectId) => this.createConversation(projectId)
  })

  constructor(
    private readonly store: OrbitStore,
    private readonly artifactService: ArtifactService,
    private readonly provider: AgentProvider,
    private readonly dataDir: string,
    private readonly version: string
  ) {
    super()
  }

  async getSystemStatus(): Promise<SystemStatus> {
    return {
      appName: 'Orbit by AgentDock',
      version: this.version,
      dataDir: this.dataDir,
      provider: await this.provider.getStatus()
    }
  }

  async getProviderStatus(): Promise<ProviderStatus> {
    return this.provider.getStatus()
  }

  /** Orbit's own application data directory — the only place Clear all
   *  data is ever allowed to delete from. */
  get dataDirectory(): string {
    return this.dataDir
  }

  listProjects(): Project[] {
    return this.store.listProjects()
  }

  listProjectTree(): ProjectGroup[] {
    return this.store.listProjectTree()
  }

  createProject(name: string, rootPath: string | null = null): Project {
    if (!name.trim()) throw new Error('Project name is required.')
    const project = this.store.createProject(name, rootPath)
    this.createConversation(project.id)
    return project
  }

  /** The one fresh session this launch opens on. Creates it on the first
   *  call and returns that same session to every call afterwards, so a
   *  remount or reload cannot litter the project with duplicates. Null on
   *  first run, when no project exists to hold it. */
  async ensureStartupSession(): Promise<StartupSession | null> {
    return this.startupSession.ensure()
  }

  setProjectRoot(projectId: ID, rootPath: string | null): Project {
    return this.store.setProjectRoot(projectId, rootPath)
  }

  openProject(projectId: ID): ProjectSnapshot {
    return this.store.openProjectSnapshot(projectId)
  }

  /** New sessions open on Orbit's own default model, concretely — never on
   *  a placeholder that leaves agy to choose. The reasoning level is the one
   *  the user last chose (medium until they ever choose one), mapped onto
   *  the tiers that model genuinely publishes; null until the catalogue is
   *  readable, rather than a guessed tier.
   *
   *  A session needs nothing from the user to exist: no name (it starts as
   *  `New Session` and names itself from the first prompt — see
   *  sessionTitle.ts) and no folder of its own (null means it inherits the
   *  project's, which is what resolveWorkspacePath already does). */
  createConversation(projectId: ID, title = DEFAULT_SESSION_TITLE, workingDirectory: string | null = null): Conversation {
    const preferences = this.store.readPreferences()
    // The user's chosen defaults, resolved against the real catalogue —
    // never a stale saved id, and never "let agy decide". Applied at
    // creation only: changing a default in Settings is about the sessions
    // that come next, and rewriting existing ones would be changing work
    // the user did not ask to change.
    const model = resolveDefaultModel(preferences, this.cachedModels)
    return this.store.createConversation(projectId, title, {
      workingDirectory,
      model: model.modelId,
      permissionMode: resolveDefaultPermissionMode(preferences),
      reasoningEffort: effortForNewSession(preferences, this.cachedModels, model.modelId)
    })
  }

  /** How a new session's model resolves right now, including whether a
   *  saved default has gone missing from the catalogue. The Settings panel
   *  reads this so it can say so rather than silently substituting. */
  defaultModelStatus(): ReturnType<typeof resolveDefaultModel> {
    return resolveDefaultModel(this.store.readPreferences(), this.cachedModels)
  }

  setConversationWorkingDirectory(conversationId: ID, workingDirectory: string | null): Conversation {
    return this.store.setConversationWorkingDirectory(conversationId, workingDirectory)
  }

  getPreferences(): OrbitPreferences {
    return this.store.readPreferences()
  }

  setPreferences(preferences: OrbitPreferences): OrbitPreferences {
    return this.store.writePreferences(preferences)
  }

  renameConversation(conversationId: ID, title: string): Conversation {
    return this.store.renameConversation(conversationId, title)
  }

  /** Releases any live provider session the conversation owns before
   *  removing it, so deleting an interactive session never orphans a
   *  running process. */
  async deleteConversation(conversationId: ID): Promise<void> {
    const conversation = this.store.requireConversation(conversationId)
    await this.provider.releaseConversation(conversationId)
    this.store.deleteConversation(conversation.id)
  }

  async sendMessage(input: SendMessageInput): Promise<Run> {
    const project = this.store.getProject(input.projectId)
    if (!project) throw new Error('Project not found.')
    const conversation = this.store.requireConversation(input.conversationId)
    if (conversation.projectId !== project.id) throw new Error('Conversation does not belong to this project.')
    if (!input.content.trim()) throw new Error('Message cannot be empty.')

    this.store.createMessage({
      projectId: project.id,
      conversationId: conversation.id,
      runId: null,
      role: 'user',
      content: input.content,
      status: 'completed'
    })
    this.nameSessionFromPrompt(conversation.id, input.content)
    const run = this.store.createRun({
      projectId: project.id,
      conversationId: conversation.id,
      metadata: {
        attachmentFileIds: input.attachmentFileIds ?? [],
        referencedArtifactIds: input.referencedArtifactIds ?? []
      }
    })
    this.activeRuns.set(run.id, { text: '' })

    const workspacePath = this.resolveWorkspacePath(project, conversation)
    const saveDir = path.join(this.dataDir, 'projects', project.id, 'agy-save')
    const attachments = (input.attachmentFileIds ?? [])
      .map((fileId) => this.store.getProjectFile(fileId))
      .filter((file): file is ProjectFile => file !== null && file.projectId === project.id)
    const referencedArtifacts = (input.referencedArtifactIds ?? [])
      .map((artifactId) => this.store.getArtifact(artifactId))
      .filter((artifact): artifact is Artifact => artifact !== null && artifact.projectId === project.id)
      .map((artifact) => ({ id: artifact.id, name: artifact.name, location: artifact.location, mimeType: artifact.mimeType }))

    // Capability escalation, decided BEFORE delivery rather than discovered
    // during the turn. Two things need the live session: attaching an image
    // (the headless path has no native attachment mechanism) and, more
    // importantly, "Ask first" — agy cannot present an approval headlessly,
    // so asking has to be possible before anything runs, not after a tool
    // has already been refused. Still one-way — see setConversationTransport.
    const wanted = transportForTurn({
      current: conversation.transport,
      permissionMode: conversation.permissionMode,
      hasImageAttachment: attachments.some(isImageFile)
    })
    const transport = wanted === conversation.transport ? conversation.transport : this.setConversationTransport(conversation.id, wanted).transport

    void this.provider
      .sendMessage(
        {
          projectId: project.id,
          conversationId: conversation.id,
          runId: run.id,
          prompt: buildPrompt(input.content, referencedArtifacts, attachments, transport),
          nativeConversationId: conversation.nativeConversationId,
          workspacePath,
          saveDir,
          attachments,
          referencedArtifacts,
          transport,
          model: conversation.model,
          reasoningEffort: conversation.reasoningEffort,
          permissionMode: conversation.permissionMode
        },
        (event) => this.handleProviderEvent(event)
      )
      .catch((error: unknown) => {
        const runtimeError = normalizeError(error)
        const failed: RuntimeEvent = {
          type: 'run.failed',
          projectId: project.id,
          conversationId: conversation.id,
          runId: run.id,
          providerId: 'antigravity',
          createdAt: nowIso(),
          error: runtimeError
        }
        this.handleProviderEvent(failed)
      })

    return run
  }

  /** Gives a still-unnamed session a name from the prompt the user just
   *  sent. Lives here rather than in the renderer so it holds for every
   *  route into a turn, and so the sidebar picks it up from the same
   *  project refresh it already does after a send.
   *
   *  Deliberately fail-safe on both sides: the store declines unless the
   *  session is genuinely still Orbit's to name (see autoTitleConversation),
   *  and anything that goes wrong here leaves the session as `New Session`
   *  without touching the message that is on its way out. Naming a session
   *  is never a reason not to send a prompt. */
  private nameSessionFromPrompt(conversationId: ID, prompt: string): void {
    try {
      const derived = deriveTitleForPrompt(prompt)
      if (derived) this.store.autoTitleConversation(conversationId, derived)
    } catch {
      // The session keeps its default name; the turn proceeds regardless.
    }
  }

  async cancelRun(runId: ID): Promise<Run> {
    this.store.updateRunState(runId, 'cancelling')
    await this.provider.cancelRun(runId)
    // Read back rather than returning the 'cancelling' snapshot above: a run
    // stopped while it was waiting on a model-change retirement has no live
    // process to interrupt, so the provider acknowledges it synchronously
    // and `run.cancelled` has already been handled by the time this returns.
    // Reporting the stale snapshot would tell the caller a settled run is
    // still stopping.
    return this.store.requireRun(runId)
  }

  /** 'pty' is sticky by design (see ConversationTransport's doc comment) —
   *  requesting 'structured' on an already-'pty' conversation is a no-op
   *  rather than a silent downgrade of an interactive session. */
  setConversationTransport(conversationId: ID, transport: Conversation['transport']): Conversation {
    const conversation = this.store.requireConversation(conversationId)
    if (conversation.transport === 'pty' && transport === 'structured') return conversation
    return this.store.setConversationTransport(conversationId, transport)
  }

  async listModels(): Promise<ModelOption[]> {
    const models = await this.provider.listModels()
    if (models.length > 0) this.cachedModels = models
    return models
  }

  /** Best-effort catalogue warm-up. Fire-and-forget at startup so the very
   *  first session created in a launch already knows the default model's
   *  real reasoning tiers. A failure is not an error here — it simply
   *  leaves the cache empty, and effort is settled once a catalogue loads. */
  warmModelCatalogue(): void {
    void this.listModels().catch(() => {
      // Nothing to do: an unreadable catalogue is reported through provider
      // status, and a session created meanwhile settles its tier later.
    })
  }

  /** Persists a conversation's model/effort choice. The provider decides
   *  what that means at launch (see modelCatalog.resolveInvocation); Orbit
   *  never manufactures a tier the catalogue does not list. */
  setConversationModel(conversationId: ID, model: string | null, reasoningEffort: ReasoningEffort | null): Conversation {
    return this.store.setConversationModel(conversationId, model, reasoningEffort)
  }

  /** Persists how a session handles permission requests. Applied as a real
   *  agy flag at launch, so an in-flight session picks it up the same way a
   *  model change does — on its next spawn. */
  setConversationPermissionMode(conversationId: ID, permissionMode: PermissionMode): Conversation {
    return this.store.setConversationPermissionMode(conversationId, permissionMode)
  }

  async respondToInteraction(input: { conversationId: ID; runId: ID; interactionId: string; optionId: string }): Promise<void> {
    const run = this.store.requireRun(input.runId)
    if (run.conversationId !== input.conversationId) throw new Error('Interaction does not belong to this conversation.')
    if (run.state !== 'waiting_for_interaction') throw new Error('This run has no pending interaction to respond to.')
    await this.provider.respondToInteraction(input)
  }

  attachFiles(projectId: ID, paths: string[]): ProjectFile[] {
    return this.artifactService.attachProjectFiles(projectId, paths)
  }

  getProjectFileThumbnail(fileId: ID): string | null {
    return this.artifactService.getProjectFileThumbnail(fileId)
  }

  /** Used by clipboard paste, which supplies bytes rather than a path. */
  attachFileBytes(projectId: ID, name: string, bytes: Uint8Array): ProjectFile {
    if (!this.store.getProject(projectId)) throw new Error('Project not found.')
    return this.artifactService.attachProjectBytes(projectId, name, bytes)
  }

  importArtifacts(projectId: ID, paths: string[], conversationId: ID | null = null): Artifact[] {
    return this.artifactService.importUserArtifacts(projectId, paths, conversationId)
  }

  listArtifacts(projectId: ID): Artifact[] {
    return this.store.listArtifacts(projectId)
  }

  getArtifactContent(artifactId: ID): ArtifactContent {
    return this.artifactService.getContent(artifactId)
  }

  async revealArtifact(artifactId: ID): Promise<void> {
    await this.artifactService.reveal(artifactId)
  }

  createReference(projectId: ID, artifactId: ID, destinationConversationId: ID): Reference {
    return this.store.createReference({ projectId, artifactId, destinationConversationId })
  }

  async shutdown(): Promise<void> {
    await this.provider.shutdown()
  }

  /** Where Antigravity actually runs: the session's own folder, else the
   *  project's, else the Orbit-managed workspace that pre-folder projects
   *  have always used. A folder that no longer exists falls back rather
   *  than failing the turn — the user has been told where it is running. */
  private resolveWorkspacePath(project: Project, conversation: Conversation): string {
    const managed = path.join(this.dataDir, 'projects', project.id, 'workspace')
    for (const candidate of [conversation.workingDirectory, project.rootPath]) {
      if (candidate && path.isAbsolute(candidate) && isDirectory(candidate)) return candidate
    }
    return managed
  }

  private handleProviderEvent(event: RuntimeEvent): void {
    const active = this.activeRuns.get(event.runId)
    const run = safeRequireRun(this.store, event.runId)
    if (!run || run.projectId !== event.projectId || run.conversationId !== event.conversationId) return

    // CRITICAL (real bug): a run ends exactly once. A transport can report
    // a second ending after the first — most often the stream or the PTY
    // closing moments after the user's Stop was already acknowledged — and
    // handling it appended a *second* assistant message and rewrote the
    // run's outcome. A cancellation the user asked for would turn into
    // `provider.exited` / `provider.failed` a beat later, so Stop looked
    // like a crash. Whichever ending arrived first is the real one; the
    // raw event is still persisted for diagnostics, but it changes no
    // state and reaches no renderer.
    if (isTerminalEvent(event) && TERMINAL_RUN_STATES.has(run.state)) {
      this.store.addRunEvent(event)
      return
    }

    if (event.type === 'text.delta') active && (active.text += event.delta)
    if (event.type === 'run.started' && event.nativeConversationId) this.store.updateConversationNativeId(event.conversationId, event.nativeConversationId)
    if (event.type === 'interaction.required' && event.canRespond) this.store.updateRunState(event.runId, 'waiting_for_interaction')
    // Defensive only. An `ask` session is already on the PTY before its
    // turn starts (see transportForTurn), so normal Ask First never reaches
    // this. It survives for the cases that are not normal Ask First — a
    // `skip` session agy refused something in anyway, or a headless denial
    // from a path that predates the pre-flight choice — and escalates the
    // conversation so the next turn can ask directly. The partially
    // executed turn is deliberately NOT retried: re-running it could repeat
    // tool side effects that already happened.
    if (event.type === 'interaction.required' && !event.canRespond) {
      this.setConversationTransport(event.conversationId, 'pty')
    }
    if (event.type === 'interaction.resolved' && event.outcome !== 'cancelled' && run.state === 'waiting_for_interaction') {
      this.store.updateRunState(event.runId, 'running')
    }
    if (event.type === 'artifact.discovered') {
      try {
        const artifact = this.artifactService.registerProviderArtifact({
          projectId: event.projectId,
          conversationId: event.conversationId,
          runId: event.runId,
          sourcePath: event.sourcePath,
          metadata: event.metadata ?? {}
        })
        const produced: RuntimeEvent = {
          type: 'artifact.produced',
          projectId: event.projectId,
          conversationId: event.conversationId,
          runId: event.runId,
          providerId: 'antigravity',
          createdAt: nowIso(),
          artifact
        }
        this.store.addRunEvent(produced)
        this.emit('event', produced)
      } catch (error) {
        const failed: RuntimeEvent = {
          type: 'run.failed',
          projectId: event.projectId,
          conversationId: event.conversationId,
          runId: event.runId,
          providerId: 'antigravity',
          createdAt: nowIso(),
          error: normalizeError(error)
        }
        this.handleProviderEvent(failed)
        return
      }
    }
    if (event.type === 'run.completed') {
      const text = event.finalText || active?.text || ''
      if (event.nativeConversationId) this.store.updateConversationNativeId(event.conversationId, event.nativeConversationId)
      this.store.createMessage({
        projectId: event.projectId,
        conversationId: event.conversationId,
        runId: event.runId,
        role: 'assistant',
        content: text,
        status: 'completed'
      })
      this.store.updateRunState(event.runId, 'completed')
      this.activeRuns.delete(event.runId)
    }
    if (event.type === 'run.failed') {
      this.store.createMessage({
        projectId: event.projectId,
        conversationId: event.conversationId,
        runId: event.runId,
        role: 'assistant',
        content: event.error.message,
        status: 'failed'
      })
      this.store.updateRunState(event.runId, 'failed', event.error)
      this.activeRuns.delete(event.runId)
    }
    if (event.type === 'run.cancelled') {
      this.store.createMessage({
        projectId: event.projectId,
        conversationId: event.conversationId,
        runId: event.runId,
        role: 'assistant',
        content: 'Request cancelled.',
        status: 'cancelled'
      })
      this.store.updateRunState(event.runId, 'cancelled')
      this.activeRuns.delete(event.runId)
    }
    this.store.addRunEvent(event)
    this.emit('event', event)
  }
}

/** Run states from which there is no further outcome. 'cancelling' is
 *  deliberately absent: a run that has been asked to stop has not stopped
 *  yet, and its real ending is still to come. */
const TERMINAL_RUN_STATES: ReadonlySet<Run['state']> = new Set<Run['state']>(['completed', 'failed', 'cancelled'])

function isTerminalEvent(event: RuntimeEvent): boolean {
  return event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled'
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

function safeRequireRun(store: OrbitStore, runId: ID): Run | null {
  try {
    return store.requireRun(runId)
  } catch {
    return null
  }
}

function normalizeError(error: unknown): RuntimeErrorInfo {
  if (error instanceof Error) {
    const code = typeof (error as Error & { code?: unknown }).code === 'string' ? String((error as Error & { code?: unknown }).code) : 'provider.failed'
    return { code, message: error.message, retryable: false }
  }
  return { code: 'provider.failed', message: 'Provider failed.', retryable: false }
}

// Kept in sync with AntigravityPtySession's identical isSupportedImage —
// SVG is deliberately excluded (Electron's nativeImage can't rasterize it
// for a native clipboard paste), even though it's an "image/*" mime type.
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp']
function isImageFile(file: ProjectFile): boolean {
  if (file.mimeType === 'image/svg+xml') return false
  if (file.mimeType?.startsWith('image/')) return true
  const lower = file.name.toLowerCase()
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

function buildPrompt(
  content: string,
  artifacts: Array<{ id: ID; name: string; location: string }>,
  attachments: ProjectFile[],
  transport: Conversation['transport']
): string {
  const sections = [content]
  if (artifacts.length) sections.push(`Referenced Orbit artifacts:\n${artifacts.map((artifact) => `- ${artifact.name} (${artifact.id}) at ${artifact.location}`).join('\n')}`)
  // PTY transport attaches images natively (clipboard paste, before this
  // prompt is even sent) — the structured `view_file` fallback hint is
  // only needed for non-image attachments there, and for every attachment
  // under structured transport (which has no native attachment mechanism).
  const needsViewFileHint = transport === 'structured' ? attachments : attachments.filter((file) => !isImageFile(file))
  if (needsViewFileHint.length) sections.push(`Attached Orbit files (inspect these managed paths with view_file when relevant):\n${needsViewFileHint.map((file) => `- ${file.name}: ${file.storedPath}`).join('\n')}`)
  return sections.join('\n\n')
}
