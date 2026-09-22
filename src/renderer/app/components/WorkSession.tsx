import { memo, useMemo } from 'react'
import type { Artifact, Conversation, ID, Message, ModelOption, Project, ProjectFile, Run } from '@shared/domain'
import type { InteractionRequiredEvent } from '@shared/runtime-events'
import { hasRunningStep, type ActivityState } from '../lib/activity'
import { agentIdentity, runModelId, type AgentIdentity } from '../lib/agentIdentity'
import { Markdown } from './Markdown'
import { MessageBlock, ErrorNote } from './MessageBlock'
import { ChatRow, PendingReply, ReplyingBadge } from './ChatRow'
import { ActivitySummary, LiveActivity } from './ActivityLine'
import { InactiveInteraction, InteractionCard, ResolvedInteraction } from './InteractionCard'
import { TurnArtifacts } from './TurnArtifacts'
import { useTranscriptScroll } from '../lib/useTranscriptScroll'

export interface ResolvedRecord {
  interactionId: string
  runId: ID
  summary: string
}

interface WorkSessionProps {
  project: Project | null
  conversation: Conversation | null
  messages: Message[]
  runs: Run[]
  projectFiles: ProjectFile[]
  /** Everything the workspace's turns produced. Each is drawn under the
   *  reply of the run that created it. */
  artifacts?: Artifact[]
  thumbnails: Record<string, string>
  activeRunId: ID | null
  streamText: string
  activityByRun: Record<string, ActivityState>
  /** Who is answering in this session — resolved by App from the session's
   *  current model selection. Used for a turn that has no recorded model of
   *  its own, and for any row that represents the session rather than one
   *  past turn. */
  identity: AgentIdentity
  /** The real catalogue, so a past turn can be labelled with the model it
   *  actually ran on rather than with whatever the session is set to now.
   *  Optional: with no catalogue, every turn falls back to `identity`. */
  models?: readonly ModelOption[]
  /** The user pressed Stop and the run has not finished tearing down yet.
   *  A deliberate lifecycle state, shown as such rather than as a stall. */
  stopping: boolean
  pendingInteraction: InteractionRequiredEvent | null
  unavailableInteraction: InteractionRequiredEvent | null
  staleInteraction: boolean
  respondingInteractionId: string | null
  resolvedRecords: ResolvedRecord[]
  onRespond: (optionId: string) => void
}

export function WorkSession({
  project,
  conversation,
  messages,
  runs,
  projectFiles,
  artifacts = EMPTY_ARTIFACTS,
  thumbnails,
  activeRunId,
  streamText,
  activityByRun,
  identity,
  models = EMPTY_MODELS,
  stopping,
  pendingInteraction,
  unavailableInteraction,
  staleInteraction,
  respondingInteractionId,
  resolvedRecords,
  onRespond
}: WorkSessionProps): JSX.Element {
  const runsById = useMemo(() => new Map(runs.map((run) => [run.id, run])), [runs])
  const projectFilesById = useMemo(() => new Map(projectFiles.map((file) => [file.id, file])), [projectFiles])
  const attachmentsByRun = useMemo(() => {
    const next = new Map<ID, ProjectFile[]>()
    for (const run of runs) {
      const ids = Array.isArray(run.metadata?.attachmentFileIds) ? (run.metadata.attachmentFileIds as ID[]) : []
      next.set(
        run.id,
        ids.map((id) => projectFilesById.get(id)).filter((file): file is ProjectFile => Boolean(file))
      )
    }
    return next
  }, [projectFilesById, runs])
  // Keyed by the run that produced them, which is exactly the key the
  // assistant message for that turn carries. A user import has no run and
  // stays in the Artifacts panel only.
  const artifactsByRun = useMemo(() => {
    const next = new Map<ID, Artifact[]>()
    for (const artifact of [...artifacts].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      if (artifact.source !== 'provider' || !artifact.creatorRunId) continue
      const list = next.get(artifact.creatorRunId)
      if (list) list.push(artifact)
      else next.set(artifact.creatorRunId, [artifact])
    }
    return next
  }, [artifacts])
  const resolvedByRun = useMemo(() => {
    const next = new Map<ID, ResolvedRecord[]>()
    for (const record of resolvedRecords) {
      const records = next.get(record.runId)
      if (records) records.push(record)
      else next.set(record.runId, [record])
    }
    return next
  }, [resolvedRecords])
  const runIdByUserMessageId = useMemo(() => {
    const next = new Map<ID, ID>()
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index]!
      if (message.role !== 'user') continue
      for (let cursor = index + 1; cursor < messages.length; cursor++) {
        const candidate = messages[cursor]!
        if (candidate.runId) {
          next.set(message.id, candidate.runId)
          break
        }
        if (candidate.role === 'user') break
      }
    }
    return next
  }, [messages])

  /** The identity a given run's turn is labelled with: the model that run
   *  actually ran on, resolved against the real catalogue.
   *
   *  Every row used to take the session's *current* selection, so switching
   *  a session from Gemini to Claude silently restamped the whole history
   *  with Claude's name and mark — a claim about who answered that was
   *  simply untrue. A run written before Orbit recorded its model has
   *  nothing better to fall back on than that selection, so it still gets
   *  it; every new turn carries its own.
   *
   *  Results are cached by model id so a settled MessageTurn keeps getting
   *  the same object and its memo barrier still holds. */
  const identityForRun = useMemo(() => {
    const cache = new Map<string, AgentIdentity>()
    return (runId: ID | null | undefined): AgentIdentity => {
      const recorded = runId ? runModelId(runsById.get(runId)?.metadata) : null
      if (!recorded) return identity
      const cached = cache.get(recorded)
      if (cached) return cached
      const resolved = agentIdentity(models, recorded)
      cache.set(recorded, resolved)
      return resolved
    }
  }, [identity, models, runsById])

  // Everything that can change the transcript's height, as one value. The
  // ResizeObserver inside the hook is what actually guarantees a landing at
  // the bottom; this only lets the ordinary cases pin before paint.
  const revision = [
    messages.length,
    messages[messages.length - 1]?.id ?? '',
    artifacts.length,
    streamText.length,
    activeRunId ?? '',
    activeRunId ? (activityByRun[activeRunId]?.items.length ?? 0) : 0,
    stopping ? '1' : '0',
    pendingInteraction?.interactionId ?? '',
    unavailableInteraction?.interactionId ?? '',
    staleInteraction ? '1' : '0'
  ].join('|')

  const liveIdentity = identityForRun(activeRunId)

  const { viewportRef, contentRef, bottomRef, showJumpToLatest, onScroll, jumpToLatest } = useTranscriptScroll(
    conversation?.id ?? null,
    revision
  )

  if (!conversation) {
    return (
      <div className="transcript-empty">
        <p>{project ? 'Create a session to start working.' : 'Create a project to begin.'}</p>
      </div>
    )
  }

  return (
    <div className="transcript-viewport">
      <div className="transcript" ref={viewportRef} onScroll={onScroll}>
        <div className="transcript-inner" ref={contentRef}>
          {messages.map((message, index) => {
            const previous = index > 0 ? messages[index - 1] : undefined
            const showRole = !previous || previous.role !== message.role
            const runId = message.role === 'user' ? (runIdByUserMessageId.get(message.id) ?? null) : message.runId
            const activity = message.role === 'assistant' && message.runId ? activityByRun[message.runId] : undefined
            const resolved = message.role === 'assistant' && message.runId ? (resolvedByRun.get(message.runId) ?? EMPTY_RESOLVED) : EMPTY_RESOLVED

            return (
              <MessageTurn
                key={message.id}
                message={message}
                showRole={showRole}
                attachments={message.role === 'user' && runId ? (attachmentsByRun.get(runId) ?? EMPTY_ATTACHMENTS) : EMPTY_ATTACHMENTS}
                thumbnails={thumbnails}
                error={message.runId ? (runsById.get(message.runId)?.error ?? null) : null}
                activity={activity}
                resolved={resolved}
                artifacts={message.role === 'assistant' && message.runId ? (artifactsByRun.get(message.runId) ?? EMPTY_ARTIFACTS) : EMPTY_ARTIFACTS}
                identity={identityForRun(message.runId)}
              />
            )
          })}

          {activeRunId ? (
            <div className="turn">
              {/* The live run is labelled the same way a settled one is —
                  from the run's own recorded model. Changing the session's
                  model mid-flight retires and respawns the process, so the
                  row must not silently adopt the new name before the
                  replacement turn has actually started. */}
              {resolvedRecords
                .filter((record) => record.runId === activeRunId)
                .map((record) => (
                  <div className="chat-aside" key={record.interactionId}>
                    <ResolvedInteraction summary={record.summary} />
                  </div>
                ))}

              {/* Text has started arriving. The bubble is the real assistant
                  surface, plus a live badge and a moving edge so a reply
                  mid-flight never reads as a finished one. */}
              {streamText ? (
                <ChatRow
                  role="assistant"
                  showIdentity
                  identity={liveIdentity}
                  status={<ReplyingBadge label={stopping ? 'Stopping' : 'Replying'} />}
                  bubbleClassName="is-streaming"
                >
                  <Markdown source={streamText} />
                  <span className="stream-cursor" aria-hidden="true" />
                </ChatRow>
              ) : null}

              {/* Nothing to read yet: a real assistant bubble holding animated
                  dots, so the wait happens where the answer will appear.
                  A run opens with an empty activity state, which is not yet
                  evidence of tool work — only real steps earn "working".
                  The activity rail below carries the specifics; this line
                  only says which of the two phases the turn is in. */}
              {!pendingInteraction && !streamText ? (
                <PendingReply identity={liveIdentity} {...pendingLabel(liveIdentity.name, activityByRun[activeRunId], stopping)} />
              ) : null}

              {/* Tool work is subordinate to the reply: indented onto the
                  assistant rail, never competing with the message itself.
                  This is where the real command, path or status lives. */}
              {!pendingInteraction && hasSteps(activityByRun[activeRunId]) ? (
                <div className="chat-aside">
                  <LiveActivity activity={activityByRun[activeRunId]!} identity={liveIdentity} />
                </div>
              ) : null}

              {pendingInteraction ? (
                <div className="chat-rail">
                  <InteractionCard
                    event={pendingInteraction}
                    busy={respondingInteractionId === pendingInteraction.interactionId}
                    onRespond={onRespond}
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          {unavailableInteraction ? (
            <div className="chat-rail">
              <InactiveInteraction event={unavailableInteraction} reason="unavailable" />
            </div>
          ) : null}
          {staleInteraction ? (
            <div className="chat-rail">
              <ErrorNote
                title="That request is no longer active"
                body="It was already answered or the turn moved on. Send another message to continue."
                details={null}
              />
            </div>
          ) : null}
        </div>

        {/* The end of the conversation, as an element. Whether this is in
            view is the definition of "at the bottom" — a question a
            `scrollHeight` sample answers wrongly while turns are still
            resolving their real heights. */}
        <div className="transcript-end" ref={bottomRef} aria-hidden="true" />
      </div>

      {/* Offered rather than imposed: new content while the reader is up
          in the history moves nothing, it just makes the way back one
          click. */}
      {showJumpToLatest ? (
        <button type="button" className="jump-latest" onClick={jumpToLatest} aria-label="Jump to latest">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
            <path
              d="M8 3v9m0 0 3.4-3.4M8 12 4.6 8.6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      ) : null}
    </div>
  )
}

const EMPTY_ATTACHMENTS: ProjectFile[] = []
const EMPTY_RESOLVED: ResolvedRecord[] = []
const EMPTY_ARTIFACTS: Artifact[] = []
const EMPTY_MODELS: readonly ModelOption[] = []

/** A run is given an activity state the moment it starts, so the state
 *  existing says nothing. Only recorded steps do — and without this the
 *  subordinate rail draws itself with nothing on it. */
function hasSteps(activity: ActivityState | undefined): boolean {
  return Boolean(activity && activity.items.length > 0)
}

/** The one-line phase, attributed to whoever is actually answering. Says
 *  "working" only when a step is genuinely running — a turn whose steps
 *  have all finished is waiting on text again, not still working.
 *
 *  `who` is set only for phases whose wording does not already carry the
 *  name, so stopping reads "<model> · Stopping…" on the same geometry as
 *  "<model> is replying" rather than as a differently shaped row. */
function pendingLabel(
  name: string,
  activity: ActivityState | undefined,
  stopping: boolean
): { who: string | null; label: string } {
  if (stopping) return { who: name, label: 'Stopping…' }
  if (activity && hasRunningStep(activity)) return { who: null, label: `${name} is working` }
  return { who: null, label: `${name} is replying` }
}

const MessageTurn = memo(function MessageTurn({
  message,
  showRole,
  attachments,
  thumbnails,
  error,
  activity,
  resolved,
  artifacts,
  identity
}: {
  message: Message
  showRole: boolean
  attachments: ProjectFile[]
  thumbnails: Record<string, string>
  error: Run['error'] | null
  activity: ActivityState | undefined
  resolved: ResolvedRecord[]
  artifacts: Artifact[]
  identity: AgentIdentity
}): JSX.Element {
  return (
    <div className="turn">
      {/* What the turn did sits on the assistant rail above what it said,
          one step quieter, so scanning the conversation never means
          reading past a tool log. */}
      {hasSteps(activity) || resolved.length > 0 ? (
        <div className="chat-aside">
          {hasSteps(activity) ? <ActivitySummary activity={activity!} /> : null}
          {resolved.map((record) => (
            <ResolvedInteraction key={record.interactionId} summary={record.summary} />
          ))}
        </div>
      ) : null}
      <MessageBlock
        message={message}
        showRole={showRole}
        attachments={attachments}
        thumbnails={thumbnails}
        error={error}
        identity={identity}
        hasArtifacts={artifacts.length > 0}
      />
      {/* What the turn produced, directly under what it said — including a
          stopped or failed turn, which keeps only provably finished files. */}
      <TurnArtifacts artifacts={artifacts} />
    </div>
  )
})
