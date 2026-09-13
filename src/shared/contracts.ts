import type { AttachmentPickerCategory } from './attachmentPicker'
import type { ResolvedDefaultModel } from './newSessionDefaults'
import type { PermissionMode } from './permissionMode'
import type { RepositoryState } from './repositoryActions'
import type {
  Artifact,
  ArtifactVersion,
  Conversation,
  ConversationTransport,
  ID,
  ModelOption,
  OrbitPreferences,
  ReasoningEffort,
  Project,
  ProjectGroup,
  ProjectFile,
  ProjectSnapshot,
  ProviderStatus,
  Reference,
  Run,
  SystemStatus
} from './domain'
import type { RuntimeEvent } from './runtime-events'

export const IPC_CHANNELS = {
  systemStatus: 'orbit:system:status',
  providersStatus: 'orbit:providers:status',
  projectsList: 'orbit:projects:list',
  projectsTree: 'orbit:projects:tree',
  projectsCreate: 'orbit:projects:create',
  projectsOpen: 'orbit:projects:open',
  workspaceOpenUnsorted: 'orbit:workspace:open-unsorted',
  conversationsListUnsorted: 'orbit:conversations:list-unsorted',
  conversationsAssignProject: 'orbit:conversations:assign-project',
  projectsSetRoot: 'orbit:projects:set-root',
  conversationsCreate: 'orbit:conversations:create',
  conversationsRename: 'orbit:conversations:rename',
  conversationsDelete: 'orbit:conversations:delete',
  conversationsSetTransport: 'orbit:conversations:set-transport',
  conversationsSetModel: 'orbit:conversations:set-model',
  conversationsSetPermissionMode: 'orbit:conversations:set-permission-mode',
  clipboardWriteText: 'orbit:clipboard:write-text',
  conversationsSetWorkingDirectory: 'orbit:conversations:set-working-directory',
  conversationsMarkActive: 'orbit:conversations:mark-active',
  dialogPickFolder: 'orbit:dialog:pick-folder',
  startupSession: 'orbit:startup:session',
  dataClear: 'orbit:data:clear',
  defaultModelStatus: 'orbit:defaults:model-status',
  preferencesGet: 'orbit:preferences:get',
  preferencesSet: 'orbit:preferences:set',
  modelsList: 'orbit:models:list',
  messagesSend: 'orbit:messages:send',
  runsCancel: 'orbit:runs:cancel',
  runsEvent: 'orbit:runs:event',
  interactionsRespond: 'orbit:interactions:respond',
  filesAttach: 'orbit:files:attach',
  filesAttachPaths: 'orbit:files:attach-paths',
  filesAttachImage: 'orbit:files:attach-image',
  filesThumbnail: 'orbit:files:thumbnail',
  artifactsList: 'orbit:artifacts:list',
  artifactsImport: 'orbit:artifacts:import',
  artifactsContent: 'orbit:artifacts:content',
  artifactsReveal: 'orbit:artifacts:reveal',
  artifactsDescribe: 'orbit:artifacts:describe',
  artifactsOpen: 'orbit:artifacts:open',
  referencesCreate: 'orbit:references:create',
  repositoryState: 'orbit:repository:state'
} as const

/** The one brand-new session an application launch opens on. Null from
 *  `startup.session()` means first run: no project exists yet, so there is
 *  nowhere to put a session and the create-project state shows instead. */
export interface StartupSession {
  /** Null for the Unsorted session every launch opens on. */
  projectId: ID | null
  conversationId: ID
}

export interface CreateProjectInput {
  name: string
  /** Absolute folder Antigravity should run in. Omitted/null means the
   *  Orbit-managed workspace directory. */
  rootPath?: string | null
}

/** Creating a session takes nothing but its project: `title` defaults to
 *  `New Session` (the first prompt names it — see shared/sessionTitle.ts)
 *  and omitting `workingDirectory` means it inherits the project's folder,
 *  which is what the UI always does. Both remain settable for callers that
 *  genuinely have a value, and `setWorkingDirectory` can override a
 *  session's folder later. */
export interface CreateConversationInput {
  /** Omitted or null creates an Unsorted session — one that belongs to no
   *  project and can be used straight away. */
  projectId?: ID | null
  title?: string
  /** Overrides the project's folder for this session only. Omitted/null
   *  means "inherit the project's folder". */
  workingDirectory?: string | null
}

export interface SetProjectRootInput {
  projectId: ID
  rootPath: string | null
}

export interface SetConversationWorkingDirectoryInput {
  conversationId: ID
  workingDirectory: string | null
}

export interface PickFolderInput {
  /** Where the native picker opens, when a caller has a sensible starting
   *  point. Omitted means the OS decides. */
  defaultPath?: string | null
  title?: string
}

export interface AttachFilesInput {
  projectId: ID
  /** Which native picker to open. Omitted means the ordinary unrestricted
   *  one, which is what every caller before the + menu wanted. */
  category?: AttachmentPickerCategory
}

export interface ClearAllDataInput {
  /** The word the user typed. Checked in the main process too — see
   *  CLEAR_DATA_CONFIRMATION. */
  confirmation: string
}

export interface AssignConversationProjectInput {
  conversationId: ID
  projectId: ID
}

export interface RenameConversationInput {
  conversationId: ID
  title: string
}

export interface DeleteConversationInput {
  conversationId: ID
}

export interface SetConversationPermissionModeInput {
  conversationId: ID
  permissionMode: PermissionMode
}

export interface SetConversationModelInput {
  conversationId: ID
  /** null = a legacy value meaning Orbit's own default; normalized on the
   *  way in so it can never persist as "let agy choose". */
  model: string | null
  /** null = no explicit tier; never a manufactured default. */
  reasoningEffort: ReasoningEffort | null
}

export interface SetConversationTransportInput {
  conversationId: ID
  transport: ConversationTransport
}

/** Drag-and-drop attachment: the OS supplies real paths for files the user
 *  dragged onto the window. */
export interface AttachPathsInput {
  projectId: ID
  paths: string[]
}

/** Clipboard-paste attachment: raw image bytes with no source path. */
export interface AttachImageInput {
  projectId: ID
  name: string
  data: Uint8Array
}

export interface RespondToInteractionInput {
  conversationId: ID
  runId: ID
  interactionId: string
  optionId: string
}

export interface SendMessageInput {
  /** Optional, and only ever a consistency check: the conversation is what
   *  actually owns the turn, and an Unsorted one has no project at all. */
  projectId?: ID | null
  conversationId: ID
  content: string
  attachmentFileIds?: ID[]
  referencedArtifactIds?: ID[]
}

export interface CancelRunInput {
  runId: ID
}

export interface AttachFilesInput {
  projectId: ID
}

export interface ImportArtifactInput {
  projectId: ID
  conversationId?: ID | null
}

export interface CreateReferenceInput {
  projectId: ID
  artifactId: ID
  destinationConversationId: ID
}

export interface ArtifactContent {
  artifactId: ID
  previewKind: Artifact['previewKind']
  name: string
  mimeType: string | null
  /** False when Orbit's stored copy is gone from disk. Everything else about
   *  the artifact is still known; there is simply nothing left to show. */
  available: boolean
  dataUrl?: string
  text?: string
  byteSize: number
}

/** What a conversation card needs to draw one artifact. Deliberately
 *  path-free: the renderer identifies an artifact by id and nothing else. */
export interface ArtifactSummary {
  artifactId: ID
  /** Whether Orbit's stored copy still exists. */
  available: boolean
  byteSize: number | null
  /** A downscaled image preview, for formats shown inline. */
  previewDataUrl: string | null
  canOpen: boolean
  canReveal: boolean
}

export type ArtifactActionResult = { ok: true } | { ok: false; reason: 'missing' | 'not-openable' | 'failed' }

export interface OrbitApi {
  system: {
    status(): Promise<SystemStatus>
  }
  providers: {
    status(): Promise<ProviderStatus>
  }
  projects: {
    list(): Promise<Project[]>
    /** Every project with its sessions — what the project-first sidebar
     *  renders. Cheap enough to refetch, and never partial. */
    tree(): Promise<ProjectGroup[]>
    create(input: CreateProjectInput): Promise<Project>
    open(projectId: ID): Promise<ProjectSnapshot>
    /** The Unsorted workspace — every session that belongs to no project.
     *  Its snapshot has no `project`, which is the honest shape for it. */
    openUnsorted(): Promise<ProjectSnapshot>
    setRoot(input: SetProjectRootInput): Promise<Project>
  }
  dialog: {
    /** Native OS folder picker. Resolves to null when the user cancels. */
    pickFolder(input?: PickFolderInput): Promise<string | null>
  }
  startup: {
    /** The single brand-new session this application launch opens on.
     *  Memoized in the main process, so calling it again after a remount,
     *  an HMR reload or a bridge reconnect returns the same session rather
     *  than creating another. Null on first run (no project yet). */
    session(): Promise<StartupSession | null>
  }
  preferences: {
    get(): Promise<OrbitPreferences>
    set(preferences: OrbitPreferences): Promise<OrbitPreferences>
  }
  repository: {
    /** Read-only git state for the folder a session runs in, used only to
     *  decide which quick actions are worth offering. Resolves to "not a
     *  repository" for anything it cannot read — see
     *  main/git/repositoryState.ts. */
    state(input: { conversationId: ID }): Promise<RepositoryState>
  }
  conversations: {
    create(input: CreateConversationInput): Promise<Conversation>
    /** Sessions with no project, for the sidebar's Unsorted group. */
    listUnsorted(): Promise<Conversation[]>
    /** Moves an Unsorted session into a project, in place — same session,
     *  same transcript, same native conversation id. */
    assignProject(input: AssignConversationProjectInput): Promise<Conversation>
    rename(input: RenameConversationInput): Promise<Conversation>
    delete(input: DeleteConversationInput): Promise<void>
    setTransport(input: SetConversationTransportInput): Promise<Conversation>
    setModel(input: SetConversationModelInput): Promise<Conversation>
    setPermissionMode(input: SetConversationPermissionModeInput): Promise<Conversation>
    setWorkingDirectory(input: SetConversationWorkingDirectoryInput): Promise<Conversation>
    /** Records the session on screen as the one the next launch reopens.
     *  Takes only an id; the main process reads its project from the
     *  database. */
    markActive(conversationId: ID): Promise<void>
  }
  /** Narrow clipboard capability. The renderer cannot use
   *  `navigator.clipboard`: a packaged Orbit loads over file://, which is
   *  not a secure context, so that API is simply absent there. This routes
   *  the one operation Orbit needs through the main process instead, and
   *  reports failure rather than silently doing nothing. */
  clipboard: {
    writeText(text: string): Promise<boolean>
  }
  data: {
    /** Erases everything Orbit owns and relaunches. Never touches a
     *  project's own folder — see main/data/clearAllData.ts. */
    clearAll(input: ClearAllDataInput): Promise<void>
  }
  defaults: {
    /** How a new session's model resolves right now, including whether a
     *  saved default has gone missing from the catalogue. */
    modelStatus(): Promise<ResolvedDefaultModel>
  }
  models: {
    /** The real, normalized Antigravity catalogue. Empty when it could not
     *  be read — the UI must show that honestly, never a fallback list. */
    list(): Promise<ModelOption[]>
  }
  messages: {
    send(input: SendMessageInput): Promise<Run>
  }
  runs: {
    cancel(input: CancelRunInput): Promise<Run>
    onEvent(listener: (event: RuntimeEvent) => void): () => void
  }
  interactions: {
    respond(input: RespondToInteractionInput): Promise<void>
  }
  files: {
    attach(input: AttachFilesInput): Promise<ProjectFile[]>
    attachPaths(input: AttachPathsInput): Promise<ProjectFile[]>
    attachImage(input: AttachImageInput): Promise<ProjectFile>
    /** Data URL preview for an Orbit-managed image file, or null. The
     *  renderer's CSP intentionally forbids `file:`, so bytes must come
     *  through here rather than being pointed at from disk. */
    thumbnail(fileId: ID): Promise<string | null>
    /** Real filesystem path for a dropped File. Synchronous preload call —
     *  see the preload for why `file.path` cannot be used. */
    pathForFile(file: File): string | null
  }
  artifacts: {
    list(projectId: ID): Promise<Artifact[]>
    import(input: ImportArtifactInput): Promise<Artifact[]>
    getContent(artifactId: ID): Promise<ArtifactContent>
    /** Card data for the conversation. Never rejects for a missing file. */
    describe(artifactId: ID): Promise<ArtifactSummary>
    /** Opens the artifact in the OS's default app. The main process picks
     *  and re-validates the file; the renderer only names the artifact. */
    open(artifactId: ID): Promise<ArtifactActionResult>
    reveal(artifactId: ID): Promise<ArtifactActionResult>
  }
  references: {
    create(input: CreateReferenceInput): Promise<Reference>
  }
}

export interface CreatedRunResult {
  run: Run
}

export interface ArtifactImportResult {
  artifact: Artifact
  version: ArtifactVersion
}
