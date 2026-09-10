import type { ConversationTransport, ID, ModelOption, ProjectFile, ProviderStatus, ReasoningEffort } from '@shared/domain'
import type { RuntimeEvent } from '@shared/runtime-events'

export interface ProviderSendInput {
  projectId: ID
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
}
