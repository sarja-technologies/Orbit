import type { Artifact, ID, ProviderId, RuntimeErrorInfo } from './domain'

export type RuntimeEvent =
  | RunStartedEvent
  | TextDeltaEvent
  | StepStartedEvent
  | ToolActivityEvent
  | InteractionRequiredEvent
  | InteractionResolvedEvent
  | ArtifactDiscoveredEvent
  | ArtifactProducedEvent
  | RunNoticeEvent
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

/** What a step is actually doing, as classified by the provider that read
 *  it — never by matching words in a display label. The renderer groups and
 *  summarizes on this, so rewording a label can never silently reclassify
 *  the step it describes. */
export type ToolActivityKind = 'command' | 'read' | 'edit' | 'search' | 'list' | 'status' | 'tool'

export interface ToolActivityEvent extends RuntimeEventBase {
  type: 'tool.activity'
  /** The line a person reads, e.g. `Running npm run build`. Built by the
   *  provider out of the runtime's own event data — never invented, and
   *  never a reconstruction of anything the runtime did not emit. */
  label: string
  status: 'running' | 'completed' | 'failed'
  providerStepId?: string
  kind?: ToolActivityKind
  /** The real command line, path or query the runtime supplied, when it
   *  supplied one. Absent means the runtime named the tool and nothing
   *  more, so the label carries only what was genuinely reported. */
  detail?: string
}

/** A provider observed an interaction it cannot safely complete alone. */
export interface InteractionRequiredEvent extends RuntimeEventBase {
  type: 'interaction.required'
  interactionId: string
  kind: 'question' | 'permission' | 'authentication' | 'selection'
  prompt: string
  options: Array<{ id: string; label: string; destructive?: boolean }>
  transport: 'pty' | 'structured-followup'
  /** False means agy already skipped/denied the original operation. */
  canRespond: boolean
  sourceEvidence: 'native-prompt' | 'headless-denial'
}

export interface InteractionResolvedEvent extends RuntimeEventBase {
  type: 'interaction.resolved'
  interactionId: string
  outcome: 'approved' | 'denied' | 'answered' | 'cancelled'
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

/** Something the user needs told about a run that is neither an error nor a
 *  question — today, that Orbit could not apply a model change yet. Kept
 *  distinct from `run.failed` because the turn itself is fine. */
export interface RunNoticeEvent extends RuntimeEventBase {
  type: 'run.notice'
  code: string
  message: string
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
