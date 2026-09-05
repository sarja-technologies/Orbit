export type ID = string

export type ProviderId = 'antigravity'

export interface Project {
  id: ID
  name: string
  createdAt: string
  updatedAt: string
}

/** Which channel Orbit uses to talk to the provider for this conversation.
 *  'structured' (the default) is `agy --print --output-format stream-json`
 *  — headless, no live interaction channel. 'pty' is a persistent
 *  interactive `agy` session that can surface and answer native
 *  questions/permission prompts. A conversation's transport is sticky:
 *  once 'pty', it never silently downgrades back to 'structured' (see
 *  docs/antigravity-transports.md's transport-continuity section). */
export type ConversationTransport = 'structured' | 'pty'

export interface Conversation {
  id: ID
  projectId: ID
  title: string
  providerId: ProviderId
  nativeConversationId: string | null
  status: 'idle' | 'running' | 'failed'
  transport: ConversationTransport
  createdAt: string
  updatedAt: string
}

export type MessageRole = 'user' | 'assistant' | 'system'
export type MessageStatus = 'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled'

export interface Message {
  id: ID
  projectId: ID
  conversationId: ID
  runId: ID | null
  role: MessageRole
  content: string
  status: MessageStatus
  createdAt: string
  updatedAt: string
  sequence: number
}

export type RunState = 'queued' | 'running' | 'waiting_for_interaction' | 'cancelling' | 'completed' | 'failed' | 'cancelled'

export interface Run {
  id: ID
  projectId: ID
  conversationId: ID
  providerId: ProviderId
  state: RunState
  startedAt: string
  endedAt: string | null
  cancellationRequestedAt: string | null
  nativeRunId: string | null
  error: RuntimeErrorInfo | null
  metadata: Record<string, unknown>
}

export type ArtifactType =
  | 'image'
  | 'markdown'
  | 'html'
  | 'svg'
  | 'code'
  | 'diff'
  | 'text'
  | 'audio'
  | 'video'
  | 'other'

export interface Artifact {
  id: ID
  projectId: ID
  creatorConversationId: ID | null
  creatorRunId: ID | null
  type: ArtifactType
  name: string
  source: 'provider' | 'user-import'
  location: string
  previewKind: 'image' | 'text' | 'markdown' | 'html' | 'svg' | 'audio' | 'video' | 'metadata'
  mimeType: string | null
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
  currentVersionId: ID | null
}

export interface ArtifactVersion {
  id: ID
  artifactId: ID
  versionNumber: number
  location: string
  previewLocation: string | null
  mimeType: string | null
  byteSize: number
  contentHash: string
  metadata: Record<string, unknown>
  createdAt: string
}

export interface ProjectFile {
  id: ID
  projectId: ID
  originalPath: string
  storedPath: string
  name: string
  mimeType: string | null
  byteSize: number
  contentHash: string
  createdAt: string
}

export interface Reference {
  id: ID
  projectId: ID
  sourceType: 'artifact' | 'project_file' | 'message'
  sourceId: ID
  targetType: 'conversation'
  targetId: ID
  relation: 'referenced-in'
  createdAt: string
}

export interface RuntimeErrorInfo {
  code: string
  message: string
  retryable: boolean
  details?: Record<string, unknown>
}

export interface ProjectSnapshot {
  project: Project
  conversations: Conversation[]
  messages: Message[]
  runs: Run[]
  artifacts: Artifact[]
  artifactVersions: ArtifactVersion[]
  projectFiles: ProjectFile[]
  references: Reference[]
}

export interface SystemStatus {
  appName: string
  version: string
  dataDir: string
  provider: ProviderStatus
}

export interface ProviderStatus {
  id: ProviderId
  state: 'idle' | 'starting' | 'ready' | 'unavailable' | 'failed'
  sdkAvailable: boolean
  authConfigured: boolean
  message: string | null
  details: Record<string, unknown>
}
