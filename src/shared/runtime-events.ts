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

/** What kind of work a step is, when the provider genuinely says so.
 *
 *  Deliberately a small closed set of *observed* categories rather than a
 *  free-text status: it is derived from real Antigravity evidence (a
 *  structured `tool_name` plus its own parameters, or a literal line agy
 *  drew on the interactive screen), never from guessing what a turn is
 *  probably doing. `'working'` is the restrained fallback for a step that
 *  is genuinely happening but that Antigravity described no further; a run
 *  with no activity evidence at all emits nothing and the UI says so on its
 *  own terms. */
export type ActivityKind =
  | 'thinking'
  | 'reading'
  | 'listing'
  | 'searching'
  | 'running'
  | 'editing'
  | 'browsing'
  | 'waiting'
  | 'tool'
  | 'working'

/** One unit of observable work.
 *
 *  `label` is Antigravity's own word for the step — the structured
 *  `tool_name` (`run_command`, `view_file`, ...) or the literal text agy
 *  drew on its interactive screen (`Verifying Requirements Thoroughly`).
 *  It is never rewritten here; turning it into product language is the
 *  renderer's job (see renderer/app/lib/activityCopy.ts), exactly as with
 *  interaction and error copy.
 *
 *  `command`/`target` carry the real subject when the provider named one.
 *  A shell command is preserved verbatim and never summarized into a
 *  description of itself. */
export interface ToolActivityEvent extends RuntimeEventBase {
  type: 'tool.activity'
  label: string
  status: 'running' | 'completed' | 'failed'
  providerStepId?: string
  /** Absent when Antigravity gave no evidence of what kind of work this is;
   *  the renderer then falls back rather than inventing a category. */
  kind?: ActivityKind
  /** The literal shell command, exactly as Antigravity reported it. */
  command?: string
  /** The literal file, directory or query the step names. */
  target?: string
  /** Real elapsed seconds, only when the provider reported them. Never a
   *  locally measured stand-in — the UI times a running step itself. */
  durationSeconds?: number
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
