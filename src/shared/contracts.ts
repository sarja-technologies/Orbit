import type {
  Artifact,
  ArtifactVersion,
  Conversation,
  ConversationTransport,
  ID,
  ModelOption,
  ReasoningEffort,
  Project,
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
  projectsCreate: 'orbit:projects:create',
  projectsOpen: 'orbit:projects:open',
  conversationsCreate: 'orbit:conversations:create',
  conversationsRename: 'orbit:conversations:rename',
  conversationsDelete: 'orbit:conversations:delete',
  conversationsSetTransport: 'orbit:conversations:set-transport',
  conversationsSetModel: 'orbit:conversations:set-model',
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
  referencesCreate: 'orbit:references:create'
} as const

export interface CreateProjectInput {
  name: string
}

export interface CreateConversationInput {
  projectId: ID
  title?: string
}

export interface RenameConversationInput {
  conversationId: ID
  title: string
}

export interface DeleteConversationInput {
  conversationId: ID
}

export interface SetConversationModelInput {
  conversationId: ID
  /** null = use Antigravity's own default model. */
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
  projectId: ID
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
  dataUrl?: string
  text?: string
  location: string
  byteSize: number
}

export interface OrbitApi {
  system: {
    status(): Promise<SystemStatus>
  }
  providers: {
    status(): Promise<ProviderStatus>
  }
  projects: {
    list(): Promise<Project[]>
    create(input: CreateProjectInput): Promise<Project>
    open(projectId: ID): Promise<ProjectSnapshot>
  }
  conversations: {
    create(input: CreateConversationInput): Promise<Conversation>
    rename(input: RenameConversationInput): Promise<Conversation>
    delete(input: DeleteConversationInput): Promise<void>
    setTransport(input: SetConversationTransportInput): Promise<Conversation>
    setModel(input: SetConversationModelInput): Promise<Conversation>
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
    reveal(artifactId: ID): Promise<void>
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
