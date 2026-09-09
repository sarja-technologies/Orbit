export type ID = string

export type ProviderId = 'antigravity'

export interface Project {
  id: ID
  name: string
  /** The real folder Antigravity runs in for this project's sessions.
   *  null means the project has no folder of its own and falls back to the
   *  Orbit-managed workspace directory — never a guessed path. */
  rootPath: string | null
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

/** The real reasoning tiers Antigravity's own catalogue exposes. Which of
 *  these a given model supports is model-dependent and never assumed — see
 *  modelCatalog.ts. */
export type ReasoningEffort = 'low' | 'medium' | 'high'

export interface ModelOption {
  id: string
  label: string
  /** Present only when the catalogue genuinely lists tier variants for this
   *  model. Absent means the model has no reasoning control at all. */
  supportedReasoningEfforts?: readonly ReasoningEffort[]
  /** What this model is for, when the catalogue itself says so. `agy models`
   *  publishes only an id and a label today, so nothing populates this yet —
   *  it exists so real metadata takes precedence the moment it appears.
   *  Until then the renderer derives the line from the model's own family
   *  name (see renderer/app/lib/modelMetadata.ts) and never invents one. */
  description?: string
}

export interface Conversation {
  id: ID
  projectId: ID
  title: string
  providerId: ProviderId
  nativeConversationId: string | null
  status: 'idle' | 'running' | 'failed'
  transport: ConversationTransport
  /** null means "whatever Antigravity's own default is" — never a guess. */
  model: string | null
  /** null means no explicit tier chosen; a multi-tier model without one
   *  falls back to Antigravity's default rather than a manufactured tier. */
  reasoningEffort: ReasoningEffort | null
  /** Per-session override of the project's root folder. null means "use the
   *  project's folder", which is what almost every session wants. */
  workingDirectory: string | null
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

/** One project plus the sessions that belong to it — the shape the
 *  project-first sidebar renders directly, without needing every project's
 *  full snapshot in memory. */
export interface ProjectGroup {
  project: Project
  conversations: Conversation[]
}

/** Cross-session user preferences. Persisted in the Orbit database rather
 *  than the renderer, so they survive a reinstall of the window state and
 *  are readable by the runtime when it seeds a new session. */
export interface OrbitPreferences {
  /** The last reasoning tier the user explicitly chose, on any model. null
   *  until they have ever chosen one — see reasoningPolicy.ts, which
   *  defaults that case to medium. */
  lastReasoningEffort: ReasoningEffort | null
  /** Explicit per-model choices, so switching away from a model and back
   *  returns the tier that model was left on. Keyed by normalized model id. */
  modelReasoningEfforts: Record<string, ReasoningEffort>
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
