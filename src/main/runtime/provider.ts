import type { ConversationTransport, ID, ModelOption, ProjectFile, ProviderStatus, ReasoningEffort } from '@shared/domain'
import type { RuntimeEvent } from '@shared/runtime-events'
import type { PermissionMode } from '@shared/permissionMode'

export interface ProviderSendInput {
  /** Null for an Unsorted session. */
  projectId: ID | null
  conversationId: ID
  runId: ID
  prompt: string
  nativeConversationId: string | null
  workspacePath: string
  saveDir: string
  attachments: ProjectFile[]
  referencedArtifacts: Array<{ id: ID; name: string; location: string; mimeType: string | null }>
  /** Selected once, before delivery, by OrbitRuntime — never guessed from
   *  message content. 'pty' conversations get a live interactive session
   *  that can surface and answer native questions/permission prompts and
   *  attach images natively; 'structured' is the default headless path. */
  transport: ConversationTransport
  /** The conversation's model — always concrete. Orbit owns the default, so
   *  there is no "null means agy decides" state here; it is resolved into
   *  real --model/--effort args by the provider. */
  model: string
  /** How this session handles permission requests, as a real agy launch
   *  flag. Both transports must apply it identically. */
  permissionMode: PermissionMode
  reasoningEffort: ReasoningEffort | null
}

export interface RespondToInteractionInput {
  conversationId: ID
  runId: ID
  interactionId: string
  optionId: string
}

export interface AgentProvider {
  getStatus(): Promise<ProviderStatus>
  /** The real, normalized model catalogue. Empty when it cannot be read —
   *  callers must not substitute a fabricated list. */
  listModels(): Promise<ModelOption[]>
  sendMessage(input: ProviderSendInput, onEvent: (event: RuntimeEvent) => void): Promise<void>
  cancelRun(runId: ID): Promise<void>
  respondToInteraction(input: RespondToInteractionInput): Promise<void>
  /** Releases any live process a conversation owns. Called when the
   *  conversation is deleted so an interactive session is never orphaned. */
  releaseConversation(conversationId: ID): Promise<void>
  shutdown(): Promise<void>
  /** Optional: files the provider's own tools generated OUTSIDE the
   *  workspace during a turn. Synchronous and never throws. A provider that
   *  only ever writes into the workspace does not implement it — the
   *  runtime's workspace scan already covers that. */
  findGeneratedOutputs?(query: GeneratedOutputQuery): GeneratedOutput[]
}

/** What the runtime knows about a finished turn when it asks the provider
 *  for files the provider generated outside the workspace. */
export interface GeneratedOutputQuery {
  conversationId: ID
  /** The native conversation id as best known when the turn ended — null on
   *  a turn where the runtime never learned one. */
  nativeConversationId: string | null
  /** What the user sent this turn. */
  prompt: string
  /** When Orbit started the turn, in epoch milliseconds. */
  startedAtMs: number
}

/** A file the provider's own tooling generated outside the workspace. */
export interface GeneratedOutput {
  /** Absolute path, as found on disk. Revalidated before any use. */
  filePath: string
  /** The folder it was found in. Opening it later is only ever allowed
   *  while it is still physically inside this folder. */
  root: string
  /** The name to show — the provider may know a better one than the file's. */
  displayName: string
  byteSize: number
  modifiedMs: number
  origin: 'provider-generated'
}
