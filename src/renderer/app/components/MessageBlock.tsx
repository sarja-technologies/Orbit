import { useState } from 'react'
import type { Message, ProjectFile } from '@shared/domain'
import { Markdown } from './Markdown'
import { describeRuntimeError } from '../lib/errorCopy'
import { isImage } from '../lib/attachments'

interface MessageBlockProps {
  message: Message
  /** Suppresses the role label when the previous block had the same role. */
  showRole: boolean
  attachments: ProjectFile[]
  thumbnails: Record<string, string>
}

/** One block in the work-session transcript. Everything is left-aligned
 *  document flow — role is carried by a label and type weight, never by
 *  alignment or a filled bubble. */
/** Local wall-clock time, or nothing at all if the stored value cannot be
 *  parsed — an empty slot beats a made-up timestamp. */
function clockTime(iso: string): string {
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return ''
  return new Date(parsed).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function MessageBlock({ message, showRole, attachments, thumbnails }: MessageBlockProps): JSX.Element {
  if (message.status === 'failed') return <FailureBlock message={message} />
  if (message.status === 'cancelled') return <div className="transcript-note">Cancelled</div>

  const isUser = message.role === 'user'
  return (
    <article className={`block block-${message.role}`}>
      {showRole ? (
        <div className="block-role">
          <span>{isUser ? 'You' : 'Antigravity'}</span>
          {/* Real send time from the stored message — never a placeholder. */}
          <time dateTime={message.createdAt}>{clockTime(message.createdAt)}</time>
        </div>
      ) : null}
      {isUser ? <div className="block-user-text">{message.content}</div> : <Markdown source={message.content} />}
      {attachments.length > 0 ? <SentAttachments attachments={attachments} thumbnails={thumbnails} /> : null}
    </article>
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

function FailureBlock({ message }: { message: Message }): JSX.Element {
  // Persisted failures only carry the message text, so the code is
  // unknown here; the generic mapping still yields honest product copy.
  const view = describeRuntimeError({ code: 'provider.failed', message: message.content, retryable: true })
  return <ErrorNote title={view.title} body={view.body} details={message.content} />
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
