import type { ConversationTransport, ID, ProjectFile, ProviderStatus } from '@shared/domain'
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
}

export interface RespondToInteractionInput {
  conversationId: ID
  runId: ID
  interactionId: string
  optionId: string
}

export interface AgentProvider {
  getStatus(): Promise<ProviderStatus>
  sendMessage(input: ProviderSendInput, onEvent: (event: RuntimeEvent) => void): Promise<void>
  cancelRun(runId: ID): Promise<void>
  respondToInteraction(input: RespondToInteractionInput): Promise<void>
  shutdown(): Promise<void>
}
