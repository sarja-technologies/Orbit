import { memo, useMemo } from 'react'
import type { Conversation, ID, Message, Project, ProjectFile, Run } from '@shared/domain'
import type { InteractionRequiredEvent } from '@shared/runtime-events'
import type { ActivityState } from '../lib/activity'
import { Markdown } from './Markdown'
import { MessageBlock, ErrorNote } from './MessageBlock'
import { ChatRow, PendingReply, ReplyingBadge } from './ChatRow'
import { ActivitySummary, LiveActivity, WaitingActivity } from './ActivityLine'
import { InactiveInteraction, InteractionCard, ResolvedInteraction } from './InteractionCard'
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
  thumbnails: Record<string, string>
  activeRunId: ID | null
  /** True while the user is composing the first message of a session that
   *  does not exist yet. There is no transcript to draw and nothing to
   *  prompt them to create — the empty-session invitation below owns the
   *  canvas — so this renders nothing at all. */
  drafting: boolean
  streamText: string
  activityByRun: Record<string, ActivityState>
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
  thumbnails,
  activeRunId,
  drafting,
  streamText,
  activityByRun,
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

  // Everything that can change the transcript's height, as one value. The
  // ResizeObserver inside the hook is what actually guarantees a landing at
  // the bottom; this only lets the ordinary cases pin before paint.
  const revision = [
    messages.length,
    messages[messages.length - 1]?.id ?? '',
    streamText.length,
    activeRunId ?? '',
    activeRunId ? (activityByRun[activeRunId]?.items.length ?? 0) : 0,
    pendingInteraction?.interactionId ?? '',
    unavailableInteraction?.interactionId ?? '',
    staleInteraction ? '1' : '0'
  ].join('|')

  const { viewportRef, contentRef, bottomRef, showJumpToLatest, onScroll, jumpToLatest } = useTranscriptScroll(
    conversation?.id ?? null,
    revision
  )

  if (!conversation) {
    if (drafting) return <div className="transcript-drafting" aria-hidden="true" />
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
              />
            )
          })}

          {activeRunId ? (
            <div className="turn">
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
                <ChatRow role="assistant" showIdentity status={<ReplyingBadge />} bubbleClassName="is-streaming">
                  <Markdown source={streamText} />
                  <span className="stream-cursor" aria-hidden="true" />
                </ChatRow>
              ) : null}

              {/* Nothing to read yet: a real assistant bubble holding animated
                  dots, so the wait happens where the answer will appear.
                  A run opens with an empty activity state, which is not yet
                  evidence of tool work — only real steps earn "working". */}
              {!pendingInteraction && !streamText ? (
                <PendingReply label={hasSteps(activityByRun[activeRunId]) ? 'Antigravity is working' : 'Antigravity is replying'} />
              ) : null}

              {/* Tool work is subordinate to the reply: indented onto the
                  assistant rail, never competing with the message itself. */}
              {!pendingInteraction && hasSteps(activityByRun[activeRunId]) ? (
                <div className="chat-aside">
                  <LiveActivity activity={activityByRun[activeRunId]!} />
                </div>
              ) : null}

              {/* The activity rail keeps stating the turn's current state even
                  when that state is "stopped, waiting on you" — otherwise the
                  rail simply vanishes at the one moment the turn is most
                  obviously not progressing. */}
              {pendingInteraction ? (
                <>
                  <div className="chat-aside">
                    <WaitingActivity />
                  </div>
                  <InteractionCard
                    event={pendingInteraction}
                    busy={respondingInteractionId === pendingInteraction.interactionId}
                    onRespond={onRespond}
                  />
                </>
              ) : null}
            </div>
          ) : null}

          {unavailableInteraction ? <InactiveInteraction event={unavailableInteraction} reason="unavailable" /> : null}
          {staleInteraction ? (
            <ErrorNote
              title="That request is no longer active"
              body="It was already answered or the turn moved on. Send another message to continue."
              details={null}
            />
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

/** A run is given an activity state the moment it starts, so the state
 *  existing says nothing. Only recorded steps do — and without this the
 *  subordinate rail draws itself with nothing on it. */
function hasSteps(activity: ActivityState | undefined): boolean {
  return Boolean(activity && activity.items.length > 0)
}

const MessageTurn = memo(function MessageTurn({
  message,
  showRole,
  attachments,
  thumbnails,
  error,
  activity,
  resolved
}: {
  message: Message
  showRole: boolean
  attachments: ProjectFile[]
  thumbnails: Record<string, string>
  error: Run['error'] | null
  activity: ActivityState | undefined
  resolved: ResolvedRecord[]
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
      <MessageBlock message={message} showRole={showRole} attachments={attachments} thumbnails={thumbnails} error={error} />
    </div>
  )
})
