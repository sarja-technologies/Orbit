import { memo, useState } from 'react'
import type { Message, ProjectFile, RuntimeErrorInfo } from '@shared/domain'
import { Markdown } from './Markdown'
import { ChatRow } from './ChatRow'
import { describeRuntimeError } from '../lib/errorCopy'
import { isImage } from '../lib/attachments'
import type { AgentIdentity } from '../lib/agentIdentity'
import { MessageActions } from './MessageActions'

interface MessageBlockProps {
  message: Message
  /** Suppresses the role label when the previous block had the same role. */
  showRole: boolean
  attachments: ProjectFile[]
  thumbnails: Record<string, string>
  /** The error the run actually recorded, when this block is a failure. It
   *  carries the real code, which decides which explanation the reader
   *  gets — a denied permission and an unreadable response are not the
   *  same problem and must not share copy. */
  error?: RuntimeErrorInfo | null
  /** Who answered — the session's model, so a turn is marked with the AI
   *  that produced it rather than with Orbit's own logo. */
  identity?: AgentIdentity
  /** The turn produced files, which are drawn under this block. */
  hasArtifacts?: boolean
}

/** One message in the work-session transcript. Side carries the speaker:
 *  the reader's own turns sit right in a sent bubble, Antigravity's sit
 *  left in its own surface. The label and timestamp confirm that read
 *  rather than being the only thing that provides it. */
function MessageBlockView({ message, showRole, attachments, thumbnails, error, identity, hasArtifacts = false }: MessageBlockProps): JSX.Element | null {
  if (message.status === 'failed') return <FailureBlock message={message} error={error ?? null} />
  // Stopping a run is a normal thing to do, not a fault. It gets a quiet
  // note that names what happened and nothing else: no warning colour, no
  // "something went wrong", no retry prompt.
  if (message.status === 'cancelled') return <StoppedNote />
  // A turn can finish with nothing to show — the model did the work in
  // tools and said nothing, or its final text could not be read off the
  // live session. Either way, say so rather than leaving a blank gap the
  // reader has to interpret.
  if (message.role === 'assistant' && message.content.trim().length === 0) {
    // Files are the answer: the cards below say what the turn did.
    if (hasArtifacts) return null
    return <div className="transcript-note chat-rail">This turn finished without any text to show.</div>
  }

  const isUser = message.role === 'user'
  return (
    // Real send time from the stored message — never a placeholder.
    <ChatRow
      role={isUser ? 'user' : 'assistant'}
      showIdentity={showRole}
      timestamp={message.createdAt}
      {...(identity ? { identity } : {})}
      // The message's own source text, never the rendered markup: what
      // lands on the clipboard is what was written. Passed as the row's
      // actions rather than as content, so the bubble holds the message and
      // nothing else.
      actions={<MessageActions text={message.content} label={isUser ? 'your message' : 'reply'} />}
    >
      {isUser ? <div className="chat-user-text">{message.content}</div> : <Markdown source={message.content} />}
      {attachments.length > 0 ? <SentAttachments attachments={attachments} thumbnails={thumbnails} /> : null}
    </ChatRow>
  )
}

export const MessageBlock = memo(MessageBlockView)

/** A run the user stopped. Deliberately in the same quiet register as any
 *  other transcript note — the conversation is intact, the composer is
 *  ready, and there is nothing to recover from. */
export function StoppedNote(): JSX.Element {
  return (
    <div className="transcript-note transcript-note-stopped chat-rail" role="status">
      <span className="transcript-note-mark" aria-hidden="true">
        <StopGlyph />
      </span>
      <span>You stopped this response</span>
    </div>
  )
}

function StopGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" focusable="false">
      <rect x="3.5" y="3.5" width="9" height="9" rx="2" fill="currentColor" />
    </svg>
  )
}

function SentAttachments({ attachments, thumbnails }: { attachments: ProjectFile[]; thumbnails: Record<string, string> }): JSX.Element {
  return (
    <div className="sent-attachments">
      {attachments.map((file) => {
        const thumbnail = thumbnails[file.id]
        return isImage(file) && thumbnail ? (
          <img key={file.id} className="sent-thumb" src={thumbnail} alt={file.name} title={file.name} />
        ) : (
          <span key={file.id} className="sent-file" title={file.name}>
            <FileGlyph />
            {file.name}
          </span>
        )
      })}
    </div>
  )
}

function FailureBlock({ message, error }: { message: Message; error: RuntimeErrorInfo | null }): JSX.Element {
  // Persisted failures only carry the message text, so the code is
  // unknown here; the generic mapping still yields honest product copy.
  const view = describeRuntimeError(error ?? { code: 'provider.failed', message: message.content, retryable: true })
  return (
    <div className="chat-rail">
      <ErrorNote title={view.title} body={view.body} details={view.details ?? message.content} />
    </div>
  )
}

interface ErrorNoteProps {
  title: string
  body: string | null
  details: string | null
}

/** Errors read as "this step didn't work", not "the app broke". The raw
 *  technical text is always preserved behind a disclosure. */
export function ErrorNote({ title, body, details }: ErrorNoteProps): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="error-note" role="status">
      <div className="error-note-head">
        <WarnGlyph />
        <span className="error-note-title">{title}</span>
      </div>
      {body ? <p className="error-note-body">{body}</p> : null}
      {details && details !== title ? (
        <>
          <button type="button" className="disclosure" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            {open ? 'Hide details' : 'Show details'}
          </button>
          {open ? <pre className="disclosure-body">{details}</pre> : null}
        </>
      ) : null}
    </div>
  )
}

function FileGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
      <path d="M4 2h5l3 3v9H4z" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
      <path d="M9 2v3h3" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
    </svg>
  )
}

function WarnGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <path d="M8 2.5 14.5 13.5h-13z" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
      <path d="M8 6.5v3.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8" cy="11.6" r="0.75" fill="currentColor" />
    </svg>
  )
}
