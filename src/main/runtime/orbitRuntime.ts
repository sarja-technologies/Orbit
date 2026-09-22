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
import type { ArtifactActionResult, ArtifactContent, ArtifactSummary, SendMessageInput, StartupSession } from '@shared/contracts'
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
import { newOrChangedOutputs, scanOutputs, type OutputFile } from '@main/artifacts/outputScan'
import { selectTurnOutputs, type TurnEnding, type TurnOutputCandidate } from '@main/artifacts/turnOutputs'
import { imagesLookAlike } from '@main/artifacts/imageSimilarity'
import { removeUnreferencedCopies, sweepArtifactStorage } from '@main/artifacts/artifactStorageGc'
import { readRepositoryState } from '@main/git/repositoryState'
import { NO_REPOSITORY, type RepositoryState } from '@shared/repositoryActions'
import { nowIso } from '@main/util/ids'
import { StartupSessionResolver } from '@main/startup/startupSession'

interface ActiveRunState {
  text: string
  /** The folder this turn runs in. */
  workspacePath: string
  /** What the turn's outputs are established against when it ends — see
   *  registerProducedOutputs. Cleared once used, so a run's outputs are
   *  registered at most once. */
  outputs: {
    /** Candidate outputs present in the workspace when the turn started. */
    before: Map<string, OutputFile>
    startedAtMs: number
    /** What the user sent, for providers that must find their own output
     *  folder by it (see GeneratedOutputQuery). */
    prompt: string
    /** Updated as the provider reports it. */
    nativeConversationId: string | null
  } | null
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
    readLastActiveConversationId: () => this.store.readPreferences().lastActiveConversationId,
    getConversation: (conversationId) => this.store.getConversation(conversationId),
    mostRecentConversation: () => this.store.mostRecentConversation(),
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

  /** The session this launch opens on — the one the user was last in, when
   *  it still exists (see startupSession.ts). Resolved once per launch, so a
   *  remount or reload gets the same answer and can never add a session. */
  async ensureStartupSession(): Promise<StartupSession | null> {
    return this.startupSession.ensure()
  }

  setProjectRoot(projectId: ID, rootPath: string | null): Project {
    return this.store.setProjectRoot(projectId, rootPath)
  }

  openProject(projectId: ID): ProjectSnapshot {
    return this.store.openProjectSnapshot(projectId)
  }

  /** The Unsorted workspace — sessions that belong to no project. */
  openUnsorted(): ProjectSnapshot {
    return this.store.openUnsortedSnapshot()
  }

  listUnsortedConversations(): Conversation[] {
    return this.store.listUnsortedConversations()
  }

  /** Files an Unsorted session into a project without recreating it.
   *
   *  A session with no folder of its own would otherwise *inherit* the
   *  project's the moment it joined — so the next turn would run in the
   *  user's real work, with a scratch history behind it and files it had
   *  already written left somewhere else entirely. Before the move, a
   *  session that has genuinely used its Orbit workspace has that path
   *  pinned as its own working directory, so it keeps running exactly where
   *  its files are. Nothing is copied, moved or deleted, and the project's
   *  folder is not touched.
   *
   *  Pointing the session at the project's folder stays available, and
   *  deliberately separate: it is the user's decision, made explicitly. */
  assignConversationToProject(conversationId: ID, projectId: ID): Conversation {
    const conversation = this.store.requireConversation(conversationId)
    if (!conversation.workingDirectory) {
      const workspace = this.sessionWorkspaceRoot(conversation.id)
      if (isDirectory(workspace)) this.store.setConversationWorkingDirectory(conversation.id, workspace)
    }
    return this.store.assignConversationToProject(conversationId, projectId)
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
  createConversation(projectId: ID | null, title = DEFAULT_SESSION_TITLE, workingDirectory: string | null = null): Conversation {
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

  /** Where the user is is not a preference the renderer writes wholesale: a
   *  preferences object captured before the last selection would otherwise
   *  silently put the user back in an older session. Those two fields are
   *  owned by markConversationActive and always kept as stored. */
  setPreferences(preferences: OrbitPreferences): OrbitPreferences {
    const stored = this.store.readPreferences()
    return this.store.writePreferences({
      ...preferences,
      lastActiveProjectId: stored.lastActiveProjectId,
      lastActiveConversationId: stored.lastActiveConversationId
    })
  }

  /** Records the session the user is in, for the next launch to reopen.
   *  Unsorted sessions included. The project is taken from the conversation
   *  row, never from the caller. An id that does not exist changes nothing. */
  markConversationActive(conversationId: ID): OrbitPreferences {
    const conversation = this.store.getConversation(conversationId)
    const stored = this.store.readPreferences()
    if (!conversation) return stored
    if (stored.lastActiveConversationId === conversation.id && stored.lastActiveProjectId === conversation.projectId) return stored
    return this.store.writePreferences({ ...stored, lastActiveConversationId: conversation.id, lastActiveProjectId: conversation.projectId })
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
    // The rows go first; only then are the copies they named reclaimed, and
    // only those no remaining row still refers to. See artifactStorageGc.ts.
    const locations = this.store.deleteConversation(conversation.id)
    this.reclaimStorage(locations)
  }

  /** Deletes an artifact and reclaims its stored copy once nothing refers to
   *  it. The original the copy was made from is never touched. */
  deleteArtifact(artifactId: ID): void {
    if (!this.store.getArtifact(artifactId)) return
    this.reclaimStorage(this.store.deleteArtifact(artifactId))
  }

  /** Best-effort: a copy that cannot be removed now stays unreferenced, and
   *  the next storage sweep reclaims it. Never a reason for a delete to fail. */
  private reclaimStorage(locations: string[]): void {
    try {
      removeUnreferencedCopies(locations, this.dataDir, this.store)
    } catch {
      // See above.
    }
  }

  /** Reconciles Orbit's artifact storage with the database. Run at startup,
   *  before anything can be writing a copy. */
  sweepArtifactStorage(): ReturnType<typeof sweepArtifactStorage> {
    try {
      return sweepArtifactStorage(this.dataDir, this.store, { minAgeMs: 0 })
    } catch {
      return { removed: [], failed: [] }
    }
  }

  async sendMessage(input: SendMessageInput): Promise<Run> {
    // The conversation owns the turn. A caller may still name the project it
    // believes the session is in, and disagreeing with the session's own
    // record is a real error — but an Unsorted session simply has none.
    const conversation = this.store.requireConversation(input.conversationId)
    const project = conversation.projectId ? this.store.getProject(conversation.projectId) : null
    if (conversation.projectId && !project) throw new Error('Project not found.')
    if (input.projectId && input.projectId !== conversation.projectId) {
      throw new Error('Conversation does not belong to this project.')
    }
    if (!input.content.trim()) throw new Error('Message cannot be empty.')

    this.store.createMessage({
      projectId: conversation.projectId,
      conversationId: conversation.id,
      runId: null,
      role: 'user',
      content: input.content,
      status: 'completed'
    })
    this.nameSessionFromPrompt(conversation.id, input.content)
    const run = this.store.createRun({
      projectId: conversation.projectId,
      conversationId: conversation.id,
      metadata: {
        attachmentFileIds: input.attachmentFileIds ?? [],
        referencedArtifactIds: input.referencedArtifactIds ?? [],
        // The model this turn actually runs on, recorded now because the
        // session's selection is a live setting the user can change
        // afterward. Without it the transcript had only the *current*
        // selection to label past turns with, so switching models silently
        // re-attributed every earlier reply to a model that never saw it.
        // This is the same value handed to the provider below, so it is a
        // record of what was sent rather than a second opinion about it.
        model: conversation.model,
        reasoningEffort: conversation.reasoningEffort
      }
    })
    const workspacePath = this.resolveWorkspacePath(project, conversation)
    // Taken before anything runs, so "new since this turn started" is a
    // fact rather than a guess. For every session, Unsorted included —
    // what a session produces belongs to it whether or not it has a project.
    this.activeRuns.set(run.id, {
      text: '',
      workspacePath,
      outputs: {
        before: this.scanWorkspaceOutputs(workspacePath),
        startedAtMs: Date.now(),
        prompt: input.content,
        nativeConversationId: conversation.nativeConversationId
      }
    })
    // An Unsorted session keeps its own save directory beside its workspace,
    // so nothing it produces lands in a project it does not belong to.
    const saveDir = project
      ? path.join(this.dataDir, 'projects', project.id, 'agy-save')
      : path.join(this.sessionWorkspaceRoot(conversation.id), '.agy-save')
    // Both are project-scoped by definition, so an Unsorted session has
    // none: the filters below simply come out empty rather than being
    // special-cased.
    const attachments = (input.attachmentFileIds ?? [])
      .map((fileId) => this.store.getProjectFile(fileId))
      .filter((file): file is ProjectFile => file !== null && file.projectId === conversation.projectId)
    const referencedArtifacts = (input.referencedArtifactIds ?? [])
      .map((artifactId) => this.store.getArtifact(artifactId))
      .filter((artifact): artifact is Artifact => artifact !== null && artifact.projectId === conversation.projectId)
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
          projectId: conversation.projectId,
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
          projectId: conversation.projectId,
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
    // Idempotent. A run that has already ended stays ended — a late or
    // repeated Stop must never turn a finished run back into a stopping one —
    // and a second Stop on a stopping run joins the one under way.
    const current = this.store.requireRun(runId)
    if (TERMINAL_RUN_STATES.has(current.state)) return current
    if (current.state !== 'cancelling') this.store.updateRunState(runId, 'cancelling')
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

  /** The git state of the folder this session actually runs in.
   *
   *  Read-only, and only ever used to decide which repository quick
   *  actions to offer. The actions themselves never run git — they submit
   *  a prompt, and the agent does the work under this session's own
   *  permission mode (see shared/repositoryActions.ts).
   *
   *  Resolves the workspace the same way a turn does, so the state
   *  describes the folder the agent would genuinely be working in. */
  async getRepositoryState(conversationId: ID): Promise<RepositoryState> {
    const conversation = this.store.getConversation(conversationId)
    if (!conversation) return NO_REPOSITORY
    const project = conversation.projectId ? this.store.getProject(conversation.projectId) : null
    return readRepositoryState(this.resolveWorkspacePath(project, conversation))
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

  describeArtifact(artifactId: ID): ArtifactSummary {
    return this.artifactService.describe(artifactId)
  }

  openArtifact(artifactId: ID): Promise<ArtifactActionResult> {
    return this.artifactService.open(artifactId)
  }

  revealArtifact(artifactId: ID): Promise<ArtifactActionResult> {
    return this.artifactService.reveal(artifactId)
  }

  createReference(projectId: ID, artifactId: ID, destinationConversationId: ID): Reference {
    return this.store.createReference({ projectId, artifactId, destinationConversationId })
  }

  /** Stops every live execution — the provider terminates each agy and the
   *  process tree under it — and then gives each run that was still going
   *  its real ending, so no turn is left 'running' forever in history. */
  async shutdown(): Promise<void> {
    const interrupted = [...this.activeRuns.keys()]
    await this.provider.shutdown()
    for (const runId of interrupted) {
      const run = safeRequireRun(this.store, runId)
      if (!run || TERMINAL_RUN_STATES.has(run.state)) continue
      this.handleProviderEvent({
        type: 'run.cancelled',
        projectId: run.projectId,
        conversationId: run.conversationId,
        runId: run.id,
        providerId: 'antigravity',
        createdAt: nowIso()
      })
    }
  }

  /** Settles runs a previous launch never finished — Orbit crashed or was
   *  killed mid-turn, so nothing recorded their ending. Called at startup,
   *  before anything can be running. Each gets a failed ending that says
   *  plainly what happened, rather than a turn that looks in progress
   *  forever with no reply beneath it. Returns how many were settled. */
  recoverInterruptedRuns(): number {
    const stale = this.store.listUnfinishedRuns()
    for (const run of stale) {
      this.store.createMessage({
        projectId: run.projectId,
        conversationId: run.conversationId,
        runId: run.id,
        role: 'assistant',
        content: 'Orbit closed before this response finished',
        status: 'failed'
      })
      this.store.updateRunState(run.id, 'failed', { code: 'app.interrupted', message: 'Orbit closed before this response finished', retryable: true })
    }
    return stale.length
  }

  /** Where Antigravity actually runs: the session's own folder, else the
   *  project's, else the Orbit-managed workspace that pre-folder projects
   *  have always used. A folder that no longer exists falls back rather
   *  than failing the turn — the user has been told where it is running. */
  /** Where an Unsorted session runs: a real directory of its own under
   *  Orbit's data, named after the session.
   *
   *  Not a temp directory — a session's files have to still be there when
   *  the user comes back to it, and /tmp is cleared out from under them.
   *  It lives for as long as the session's history does. */
  private sessionWorkspaceRoot(conversationId: ID): string {
    return path.join(this.dataDir, 'workspaces', conversationId)
  }

  private resolveWorkspacePath(project: Project | null, conversation: Conversation): string {
    // The session's own folder wins, then the project's; both must really
    // exist before agy is pointed at them.
    for (const candidate of [conversation.workingDirectory, project?.rootPath ?? null]) {
      if (candidate && path.isAbsolute(candidate) && isDirectory(candidate)) return candidate
    }
    // Nothing was chosen. A session in a project falls back to the workspace
    // Orbit manages for that project; one with no project gets its own, so
    // it can be used immediately without choosing a folder first.
    const managed = project
      ? path.join(this.dataDir, 'projects', project.id, 'workspace')
      : this.sessionWorkspaceRoot(conversation.id)
    fs.mkdirSync(managed, { recursive: true })
    return managed
  }

  private scanWorkspaceOutputs(workspacePath: string): Map<string, OutputFile> {
    try {
      return scanOutputs(workspacePath, [this.dataDir])
    } catch {
      return new Map()
    }
  }

  /** Registers the files this turn handed to the user, attributed to it.
   *
   *  Two kinds of evidence, both read off the filesystem so they hold on
   *  either transport: deliverables that appeared or changed in the
   *  workspace since the turn started, and files the provider's own tools
   *  generated outside it (agy's image generation — see
   *  providers/antigravity/generatedOutputs.ts). turnOutputs.ts decides
   *  which of those become cards; this only gathers and records them.
   *
   *  Deliberately best-effort. Finding outputs must never be able to fail a
   *  turn: the answer the user was waiting for matters more than a card for
   *  a file they can still find on disk. */
  private registerProducedOutputs(event: RuntimeEvent, active: ActiveRunState | undefined): void {
    const snapshot = active?.outputs
    if (!active || !snapshot) return
    // Taken once, so a second ending for the same run — which the terminal
    // guard already drops — could never register the same files twice.
    active.outputs = null

    const ending: TurnEnding = event.type === 'run.completed' ? 'completed' : event.type === 'run.cancelled' ? 'cancelled' : 'failed'
    try {
      const candidates: TurnOutputCandidate[] = newOrChangedOutputs(snapshot.before, this.scanWorkspaceOutputs(active.workspacePath)).map((file) => ({
        filePath: file.filePath,
        root: active.workspacePath,
        displayName: path.basename(file.filePath),
        byteSize: file.byteSize,
        modifiedMs: file.modifiedMs,
        origin: 'workspace',
        created: file.created
      }))

      const nativeConversationId =
        (event.type === 'run.completed' ? event.nativeConversationId : null) ??
        snapshot.nativeConversationId ??
        this.store.getConversation(event.conversationId)?.nativeConversationId ??
        null
      const generated =
        this.provider.findGeneratedOutputs?.({
          conversationId: event.conversationId,
          nativeConversationId,
          prompt: snapshot.prompt,
          startedAtMs: snapshot.startedAtMs
        }) ?? []
      for (const output of generated) candidates.push({ ...output, created: true })
      if (candidates.length === 0) return

      const selected = selectTurnOutputs({
        candidates,
        ending,
        finalText: event.type === 'run.completed' ? event.finalText || active.text : '',
        alreadyRegistered: generated.length > 0 ? this.registeredOriginals(event.conversationId) : [],
        imagesLookAlike
      })

      for (const output of selected) {
        try {
          const artifact = this.artifactService.registerOutput({
            projectId: event.projectId,
            conversationId: event.conversationId,
            runId: event.runId,
            sourcePath: output.filePath,
            sourceRoot: output.root,
            displayName: output.displayName,
            metadata: {
              detectedBy: output.origin === 'workspace' ? 'workspace-scan' : 'provider-output-folder',
              turnEnding: ending
            }
          })
          this.announceArtifact(event, artifact)
        } catch {
          // One unreadable file must not stop the rest from registering.
        }
      }
    } catch {
      // See above: never a reason for the turn itself to fail.
    }
  }

  /** Where earlier turns' provider outputs came from, with their content. */
  private registeredOriginals(conversationId: ID): Array<{ originalPath: string; contentHash: string }> {
    const registered: Array<{ originalPath: string; contentHash: string }> = []
    for (const artifact of this.store.listConversationArtifacts(conversationId)) {
      const originalPath = artifact.metadata.originalPath
      const version = artifact.currentVersionId ? this.store.getArtifactVersion(artifact.currentVersionId) : null
      if (typeof originalPath === 'string' && version) registered.push({ originalPath, contentHash: version.contentHash })
    }
    return registered
  }

  private announceArtifact(event: RuntimeEvent, artifact: Artifact): void {
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
    // Output that arrives after a run ended — the tail of a stopped
    // process's stream, a screen redraw — belongs to nothing any more. It is
    // kept for diagnostics and reaches no transcript. Interaction events are
    // deliberately not included: agy can raise a prompt just after its turn
    // was reported complete, and that prompt still needs an answer.
    if (STALE_AFTER_END.has(event.type) && TERMINAL_RUN_STATES.has(run.state)) {
      this.store.addRunEvent(event)
      return
    }

    if (event.type === 'text.delta') active && (active.text += event.delta)
    if (event.type === 'run.started' && event.nativeConversationId) {
      this.store.updateConversationNativeId(event.conversationId, event.nativeConversationId)
      if (active?.outputs) active.outputs.nativeConversationId = event.nativeConversationId
    }
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
    // A provider naming an exact output path. The path is untrusted: it is
    // only registered if it is a real file inside this turn's workspace, and
    // a bad one is ignored rather than failing a turn that otherwise worked.
    if (event.type === 'artifact.discovered' && active) {
      try {
        const artifact = this.artifactService.registerProviderArtifact({
          projectId: event.projectId,
          conversationId: event.conversationId,
          runId: event.runId,
          sourcePath: event.sourcePath,
          sourceRoot: active.workspacePath,
          metadata: { ...(event.metadata ?? {}), detectedBy: 'provider-event' }
        })
        this.announceArtifact(event, artifact)
      } catch {
        // Outside the workspace, missing, or not a regular file.
      }
    }
    // Outputs the turn actually produced, registered before the run is
    // marked finished so they are already there when the renderer reloads
    // on completion. Runs for every ending — a cancelled or failed turn can
    // still have finished writing a file before it stopped — but a turn
    // that did not complete keeps only provably finished files.
    if (isTerminalEvent(event)) this.registerProducedOutputs(event, active)

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

const STALE_AFTER_END: ReadonlySet<RuntimeEvent['type']> = new Set<RuntimeEvent['type']>(['text.delta', 'tool.activity', 'step.started', 'artifact.discovered', 'run.notice'])

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
