import type { ID, ProjectFile, ProviderStatus } from '@shared/domain'
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
}

export interface AgentProvider {
  getStatus(): Promise<ProviderStatus>
  sendMessage(input: ProviderSendInput, onEvent: (event: RuntimeEvent) => void): Promise<void>
  cancelRun(runId: ID): Promise<void>
  shutdown(): Promise<void>
}
