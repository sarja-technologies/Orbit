import type { Artifact, ID, ProviderId, RuntimeErrorInfo } from './domain'

export type RuntimeEvent =
  | RunStartedEvent
  | TextDeltaEvent
  | StepStartedEvent
  | ToolActivityEvent
  | ArtifactDiscoveredEvent
  | ArtifactProducedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunCancelledEvent
  | ProviderStatusEvent

export interface RuntimeEventBase {
  type: string
  projectId: ID
  conversationId: ID
  runId: ID
  createdAt: string
  providerId: ProviderId
}

export interface RunStartedEvent extends RuntimeEventBase {
  type: 'run.started'
  nativeConversationId?: string | null
}

export interface TextDeltaEvent extends RuntimeEventBase {
  type: 'text.delta'
  delta: string
}

export interface StepStartedEvent extends RuntimeEventBase {
  type: 'step.started'
  label: string
  providerStepId?: string
}

export interface ToolActivityEvent extends RuntimeEventBase {
  type: 'tool.activity'
  label: string
  status: 'running' | 'completed' | 'failed'
  providerStepId?: string
}

export interface ArtifactProducedEvent extends RuntimeEventBase {
  type: 'artifact.produced'
  artifact: Artifact
}

export interface ArtifactDiscoveredEvent extends RuntimeEventBase {
  type: 'artifact.discovered'
  sourcePath: string
  name?: string
  mimeType?: string | null
  metadata?: Record<string, unknown>
}

export interface RunCompletedEvent extends RuntimeEventBase {
  type: 'run.completed'
  finalText: string
  nativeConversationId?: string | null
  usage?: Record<string, unknown>
}

export interface RunFailedEvent extends RuntimeEventBase {
  type: 'run.failed'
  error: RuntimeErrorInfo
}

export interface RunCancelledEvent extends RuntimeEventBase {
  type: 'run.cancelled'
}

export interface ProviderStatusEvent extends Omit<RuntimeEventBase, 'projectId' | 'conversationId' | 'runId'> {
  type: 'provider.status'
  projectId: ''
  conversationId: ''
  runId: ''
  status: string
  message: string | null
}

export type RunEventListener = (event: RuntimeEvent) => void
