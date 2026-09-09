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
import type { ArtifactContent, SendMessageInput } from '@shared/contracts'
import type { RuntimeEvent } from '@shared/runtime-events'
import type { AgentProvider } from './provider'
import type { OrbitStore } from '@main/persistence/store'
import type { ArtifactService } from '@main/artifacts/artifactService'
import { effortForModel, effortForNewSession, supportedEfforts } from '@shared/reasoningPolicy'
import { isRunnableSelection, resolveDefaultSelection } from '@shared/defaultModel'
import { DEFAULT_SESSION_TITLE, deriveSessionTitle } from '@shared/sessionTitle'
import { nowIso } from '@main/util/ids'

interface ActiveRunState {
  text: string
}

export class OrbitRuntime extends EventEmitter {
  private readonly activeRuns = new Map<ID, ActiveRunState>()

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

  setProjectRoot(projectId: ID, rootPath: string | null): Project {
    return this.store.setProjectRoot(projectId, rootPath)
  }

  openProject(projectId: ID): ProjectSnapshot {
    return this.store.openProjectSnapshot(projectId)
  }

  /** New sessions open on the reasoning level the user last chose (medium
   *  until they ever choose one). Antigravity accepts `--effort` without
   *  `--model`, so this is a real setting from the very first turn rather
   *  than an inert default.
   *
   *  A session needs nothing from the user to exist: no name (it starts as
   *  `New Session` and names itself from the first prompt — see
   *  sessionTitle.ts) and no folder of its own (null means it inherits the
   *  project's, which is what resolveWorkspacePath already does). */
  createConversation(projectId: ID, title = DEFAULT_SESSION_TITLE, workingDirectory: string | null = null): Conversation {
    return this.store.createConversation(projectId, title, {
      workingDirectory,
      reasoningEffort: effortForNewSession(this.store.readPreferences())
    })
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

    // Orbit owns the model choice. Before anything is persisted for this
    // turn, the session is resolved to a concrete id from the real
    // catalogue — so the model Orbit stores and shows is exactly the model
    // it is about to name on agy's command line. This is also what
    // migrates a legacy session that still carries the old "let
    // Antigravity decide" null.
    const resolved = await this.resolveConversationModel(conversation)

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
    // The user's message and its run are on disk before the turn starts.
    // Writes are coalesced (see OrbitDatabase), which is what keeps a
    // streaming turn off the main thread — but a turn boundary is exactly
    // where that trade should not apply.
    this.store.flush()

    const workspacePath = this.resolveWorkspacePath(project, conversation)
    const saveDir = path.join(this.dataDir, 'projects', project.id, 'agy-save')
    const attachments = (input.attachmentFileIds ?? [])
      .map((fileId) => this.store.getProjectFile(fileId))
      .filter((file): file is ProjectFile => file !== null && file.projectId === project.id)
    const referencedArtifacts = (input.referencedArtifactIds ?? [])
      .map((artifactId) => this.store.getArtifact(artifactId))
      .filter((artifact): artifact is Artifact => artifact !== null && artifact.projectId === project.id)
      .map((artifact) => ({ id: artifact.id, name: artifact.name, location: artifact.location, mimeType: artifact.mimeType }))

    // Automatic capability escalation, decided BEFORE delivery: attaching an
    // image needs the live session, so the conversation moves itself there
    // rather than making the user understand transports. Still one-way — see
    // setConversationTransport.
    const transport = attachments.some(isImageFile)
      ? this.setConversationTransport(conversation.id, 'pty').transport
      : conversation.transport

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
          model: resolved.model,
          reasoningEffort: resolved.reasoningEffort
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

  /** The concrete model this session will run on, persisted so that what
   *  Orbit stores and displays is the same thing it passes to agy.
   *
   *  Three cases, and none of them ends with Antigravity choosing:
   *
   *   - the session already names a model the catalogue still lists: kept
   *     exactly as it is (the user chose it), with only its reasoning tier
   *     corrected if the model does not publish the stored one;
   *   - the session names nothing — a brand-new session, or a legacy one
   *     carrying the old "Default" null — or names a model the catalogue no
   *     longer has: resolved to Orbit's own default (shared/defaultModel.ts)
   *     and written back;
   *   - the catalogue could not be read at all: a real error, not a quiet
   *     fall back to agy's own default. */
  private async resolveConversationModel(conversation: Conversation): Promise<{ model: string; reasoningEffort: ReasoningEffort | null }> {
    const models = await this.provider.listModels()
    const preferences = this.store.readPreferences()

    if (isRunnableSelection(models, conversation.model)) {
      const option = models.find((candidate) => candidate.id === conversation.model) ?? null
      const tiers = supportedEfforts(option)
      const stored = conversation.reasoningEffort
      const valid = tiers.length === 0 ? stored === null : stored !== null && tiers.includes(stored)
      if (valid) return { model: conversation.model, reasoningEffort: stored }
      const corrected = effortForModel(option, preferences)
      this.store.setConversationModel(conversation.id, conversation.model, corrected)
      return { model: conversation.model, reasoningEffort: corrected }
    }

    const selection = resolveDefaultSelection(models, preferences)
    if (!selection) {
      throw codedError(
        'provider.model_unresolved',
        'Orbit could not read Antigravity’s model list, so it cannot name the model to run. Orbit never lets Antigravity choose one for it. Check that `agy models` works, then try again.'
      )
    }
    // Persisted first, then reported from the selection itself: what the
    // provider is handed and what the store now holds are the same values,
    // by construction rather than by reading one back.
    this.store.setConversationModel(conversation.id, selection.model, selection.reasoningEffort)
    return selection
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
      const title = deriveSessionTitle(prompt)
      if (title) this.store.autoTitleConversation(conversationId, title)
    } catch {
      // The session keeps its default name; the turn proceeds regardless.
    }
  }

  /** Stop.
   *
   *  Accepting a Stop is what makes a run interrupted, and it is recorded
   *  before the provider is even asked — `'cancelling'` IS "Stop accepted"
   *  (see handleProviderEvent, which converts anything that lands
   *  afterwards). A run that has ALREADY finished is not stopped: a Stop
   *  that loses the race to a real completion changes nothing, rather than
   *  dragging a finished turn back into a stopping state it can never
   *  leave. */
  async cancelRun(runId: ID): Promise<Run> {
    const current = this.store.requireRun(runId)
    if (isTerminalState(current.state)) return current
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

  listModels(): Promise<ModelOption[]> {
    return this.provider.listModels()
  }

  /** Persists a conversation's model/effort choice. The provider decides
   *  what that means at launch (see modelCatalog.resolveInvocation); Orbit
   *  never manufactures a tier the catalogue does not list. */
  setConversationModel(conversationId: ID, model: string | null, reasoningEffort: ReasoningEffort | null): Conversation {
    return this.store.setConversationModel(conversationId, model, reasoningEffort)
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

  private handleProviderEvent(incoming: RuntimeEvent): void {
    // Rebindable: the Stop-precedence rule below can rewrite a terminal
    // event into the interruption it really is.
    let event = incoming
    const active = this.activeRuns.get(event.runId)
    const run = safeRequireRun(this.store, event.runId)
    if (!run || run.projectId !== event.projectId || run.conversationId !== event.conversationId) return

    // CRITICAL (the Stop race): a run that has already settled must not
    // settle again. A stopped agy reports its own death on the way out —
    // a non-zero exit, a closed stream, a transport error — and each of
    // those arrives as `run.failed` a beat after `run.cancelled`. Without
    // this the second event overwrote the deliberate interruption with a
    // crash: a second assistant message, the run's state flipped to
    // 'failed', and "Antigravity's response couldn't be read" shown for
    // something the user did on purpose. The providers make cancellation
    // win at their own level too; this is the backstop that holds for any
    // provider, and it is deliberately about *terminality*, not about
    // cancellation specifically — a completed run cannot be failed either.
    if (isTerminalEvent(event) && isTerminalState(run.state)) return

    // STOP PRECEDENCE. Once a Stop has been accepted for a run that was
    // still active, that run is interrupted — whatever the transport goes
    // on to say. agy can finish the turn it was already most of the way
    // through and report SUCCESS, or die from the signal and report a
    // failure; both arrive after the user has already decided. Converting
    // them here (rather than dropping them) is what keeps the interruption
    // a real terminal state instead of leaving the run stuck 'cancelling'.
    //
    // A completion that lands after a Stop still carries the authoritative
    // text for what Antigravity produced, and it is kept on exactly the
    // terms the ordinary completion path uses (`finalText || streamed`).
    // The point is to preserve everything Antigravity actually said, not to
    // punish the turn for having been stopped.
    if (isTerminalEvent(event) && event.type !== 'run.cancelled' && run.state === 'cancelling') {
      if (event.type === 'run.completed' && active && event.finalText) active.text = event.finalText
      event = { ...baseOf(event), type: 'run.cancelled' }
    }

    if (event.type === 'text.delta') active && (active.text += event.delta)
    if (event.type === 'run.started' && event.nativeConversationId) this.store.updateConversationNativeId(event.conversationId, event.nativeConversationId)
    if (event.type === 'interaction.required' && event.canRespond) this.store.updateRunState(event.runId, 'waiting_for_interaction')
    // Antigravity needed to ask something the headless path cannot present.
    // Escalate the conversation so the next turn can ask the user directly,
    // without ever asking the user to pick a transport themselves.
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
    // A stop the user asked for is its own terminal state, not a failure.
    // Whatever Antigravity had already said is kept: the message is the
    // real partial answer, marked `cancelled`, so the transcript shows what
    // was actually produced and the UI can label it as interrupted from the
    // status alone. Nothing is invented to stand in for it — a turn stopped
    // before it said anything stores an empty message, and the renderer
    // presents that as the interruption it is.
    if (event.type === 'run.cancelled') {
      this.store.createMessage({
        projectId: event.projectId,
        conversationId: event.conversationId,
        runId: event.runId,
        role: 'assistant',
        content: active?.text ?? '',
        status: 'cancelled'
      })
      this.store.updateRunState(event.runId, 'cancelled')
      this.activeRuns.delete(event.runId)
    }
    this.store.addRunEvent(event)
    // A settled turn is worth having on disk immediately; everything during
    // one is worth coalescing. One flush per turn, not one per delta.
    if (isTerminalEvent(event)) this.store.flush()
    this.emit('event', event)
  }
}

/** Events that end a run. Anything else (a late prompt, an artifact, a
 *  notice) is still meaningful after one has ended. */
function isTerminalEvent(event: RuntimeEvent): boolean {
  return event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled'
}

function isTerminalState(state: Run['state']): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled'
}

/** The routing fields every runtime event carries, so one can be rebuilt as
 *  a different type without inventing any of them. */
function baseOf(event: RuntimeEvent): Pick<RuntimeEvent, 'projectId' | 'conversationId' | 'runId' | 'providerId' | 'createdAt'> {
  return {
    projectId: event.projectId,
    conversationId: event.conversationId,
    runId: event.runId,
    providerId: event.providerId,
    createdAt: event.createdAt
  }
}

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
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
