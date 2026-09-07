import { useEffect, useRef } from 'react'
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

  const attachmentsFor = (runId: ID | null): ProjectFile[] => {
    if (!runId) return []
    const run = runs.find((candidate) => candidate.id === runId)
    const ids = Array.isArray(run?.metadata?.attachmentFileIds) ? (run.metadata.attachmentFileIds as ID[]) : []
    return ids.map((id) => projectFiles.find((file) => file.id === id)).filter((file): file is ProjectFile => Boolean(file))
  }

  // A user message carries the attachments of the run it started, which is
  // the next run in sequence rather than its own (user rows have no runId).
  const runIdForUserMessage = (index: number): ID | null => {
    for (let i = index + 1; i < messages.length; i++) {
      const candidate = messages[i]!
      if (candidate.runId) return candidate.runId
      if (candidate.role === 'user') break
    }
    return null
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
          const runId = message.role === 'user' ? runIdForUserMessage(index) : message.runId
          const activity = message.role === 'assistant' && message.runId ? activityByRun[message.runId] : undefined
          const resolved = message.role === 'assistant' && message.runId ? resolvedRecords.filter((record) => record.runId === message.runId) : []

          return (
            <div key={message.id} className="turn">
              {activity ? <ActivitySummary activity={activity} /> : null}
              {resolved.map((record) => (
                <ResolvedInteraction key={record.interactionId} summary={record.summary} />
              ))}
              <MessageBlock
                message={message}
                showRole={showRole}
                attachments={message.role === 'user' ? attachmentsFor(runId) : []}
                thumbnails={thumbnails}
                error={message.runId ? runs.find((run) => run.id === message.runId)?.error ?? null : null}
              />
            </div>
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
