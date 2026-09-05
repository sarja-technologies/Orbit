import type {
  Artifact,
  ArtifactVersion,
  Conversation,
  ID,
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
  messagesSend: 'orbit:messages:send',
  runsCancel: 'orbit:runs:cancel',
  runsEvent: 'orbit:runs:event',
  filesAttach: 'orbit:files:attach',
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
  }
  messages: {
    send(input: SendMessageInput): Promise<Run>
  }
  runs: {
    cancel(input: CancelRunInput): Promise<Run>
    onEvent(listener: (event: RuntimeEvent) => void): () => void
  }
  files: {
    attach(input: AttachFilesInput): Promise<ProjectFile[]>
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
