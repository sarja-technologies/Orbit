import { memo, useEffect, useMemo, useRef } from 'react'
import type { Conversation, ID, Message, Project, ProjectFile, Run } from '@shared/domain'
import type { InteractionRequiredEvent } from '@shared/runtime-events'
import type { ActivityState } from '../lib/activity'
import { Markdown } from './Markdown'
import { MessageBlock, ErrorNote } from './MessageBlock'
import { ActivitySummary, LiveActivity } from './ActivityLine'
import { InactiveInteraction, InteractionCard, ResolvedInteraction } from './InteractionCard'

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
  streamText,
  activityByRun,
  pendingInteraction,
  unavailableInteraction,
  staleInteraction,
  respondingInteractionId,
  resolvedRecords,
  onRespond
}: WorkSessionProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
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

  // Follow new output only when the reader is already at the bottom, so
  // scrolling back through a long session isn't yanked away.
  useEffect(() => {
    const node = scrollRef.current
    if (!node || !atBottomRef.current) return
    node.scrollTop = node.scrollHeight
  }, [messages.length, streamText, pendingInteraction?.interactionId, activeRunId])

  if (!conversation) {
    return (
      <div className="transcript-empty">
        <p>{project ? 'Create a session to start working.' : 'Create a project to begin.'}</p>
      </div>
    )
  }

  return (
    <div className="transcript" ref={scrollRef} onScroll={(event) => {
      const node = event.currentTarget
      atBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48
    }}>
      <div className="transcript-inner">
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
                <ResolvedInteraction key={record.interactionId} summary={record.summary} />
              ))}

            {streamText ? (
              <article className="block block-assistant">
                <div className="block-role">Antigravity</div>
                <Markdown source={streamText} />
                <span className="stream-cursor" aria-hidden="true" />
              </article>
            ) : null}

            {!pendingInteraction && activityByRun[activeRunId] ? <LiveActivity activity={activityByRun[activeRunId]!} /> : null}

            {!pendingInteraction && !streamText && !activityByRun[activeRunId] ? (
              <div className="activity activity-live" aria-live="polite">
                <span className="activity-pip" aria-hidden="true" />
                <span className="activity-label">Working</span>
              </div>
            ) : null}

            {pendingInteraction ? (
              <InteractionCard
                event={pendingInteraction}
                busy={respondingInteractionId === pendingInteraction.interactionId}
                onRespond={onRespond}
              />
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
    </div>
  )
}

const EMPTY_ATTACHMENTS: ProjectFile[] = []
const EMPTY_RESOLVED: ResolvedRecord[] = []

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
      {activity ? <ActivitySummary activity={activity} /> : null}
      {resolved.map((record) => (
        <ResolvedInteraction key={record.interactionId} summary={record.summary} />
      ))}
      <MessageBlock message={message} showRole={showRole} attachments={attachments} thumbnails={thumbnails} error={error} />
    </div>
  )
})
