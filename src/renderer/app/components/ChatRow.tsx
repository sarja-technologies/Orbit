import type { ReactNode } from 'react'

/** Local wall-clock time, or nothing at all if the stored value cannot be
 *  parsed — an empty slot beats a made-up timestamp. */
export function clockTime(iso: string): string {
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return ''
  return new Date(parsed).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

interface ChatRowProps {
  role: 'user' | 'assistant'
  /** Draws the identity line (name, time, and the assistant's mark).
   *  Suppressed when the previous row came from the same speaker, so a
   *  burst of messages reads as one block instead of a stack of headers. */
  showIdentity: boolean
  timestamp?: string | null
  /** Replaces the timestamp — used for the live "Replying" state. */
  status?: ReactNode
  /** Widens the bubble's own class list, e.g. to mark it streaming. */
  bubbleClassName?: string
  children: ReactNode
}

/** The single layout primitive every conversation row goes through.
 *
 *  Both variants are one CSS grid so the assistant's mark, its identity
 *  line and its bubble share a column edge — and so the two roles differ
 *  by grid definition rather than by a pile of one-off overrides. User
 *  rows collapse to a single right-justified column; assistant rows keep
 *  a mark gutter on the left that subordinate activity also indents to.
 *
 *  Deliberately not memoized: `children` is a fresh element on every
 *  render, so a memo here could never hit. The barrier that actually keeps
 *  settled messages from re-rendering is MessageBlock's, one level up. */
export function ChatRow({ role, showIdentity, timestamp, status, bubbleClassName, children }: ChatRowProps): JSX.Element {
  const isUser = role === 'user'
  const time = timestamp ? clockTime(timestamp) : ''

  return (
    <div className={`chat-row chat-row-${role}`}>
      {!isUser && showIdentity ? <AssistantMark /> : null}
      {showIdentity ? (
        <div className="chat-meta">
          <span className="chat-name">{isUser ? 'You' : 'Antigravity'}</span>
          {status ?? (time ? <time dateTime={timestamp ?? undefined}>{time}</time> : null)}
        </div>
      ) : null}
      <div className={`chat-bubble chat-bubble-${role}${bubbleClassName ? ` ${bubbleClassName}` : ''}`}>{children}</div>
    </div>
  )
}

/** Antigravity's identity mark. Present only on the assistant side —
 *  right-alignment already says "you", so a second avatar would be noise. */
function AssistantMark(): JSX.Element {
  return (
    <span className="chat-mark" aria-hidden="true">
      <svg viewBox="0 0 16 16" width="13" height="13" focusable="false">
        <circle cx="8" cy="8" r="2.6" fill="currentColor" />
        <ellipse
          cx="8"
          cy="8"
          rx="6.4"
          ry="3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.15"
          opacity="0.75"
          transform="rotate(-28 8 8)"
        />
      </svg>
    </span>
  )
}

/** Three dots that rise in sequence. The animation is decoration — the
 *  meaning always travels in the adjacent text, so reduced motion and
 *  screen readers lose nothing. */
export function TypingDots(): JSX.Element {
  return (
    <span className="typing-dots" aria-hidden="true">
      <span className="typing-dot" />
      <span className="typing-dot" />
      <span className="typing-dot" />
    </span>
  )
}

/** The badge that rides in the identity line while text is arriving, so a
 *  reply that has already started still reads as unfinished. */
export function ReplyingBadge(): JSX.Element {
  return (
    <span className="chat-live">
      <span className="chat-live-pip" aria-hidden="true" />
      Replying
    </span>
  )
}

/** Stands in for the assistant bubble between "sent" and the first token.
 *  Its own component, and its own row, so streaming updates never touch
 *  the settled transcript above it. */
export function PendingReply({ label = 'Antigravity is replying' }: { label?: string }): JSX.Element {
  return (
    <div className="chat-row chat-row-assistant" aria-live="polite">
      <AssistantMark />
      <div className="chat-meta">
        <span className="chat-name">Antigravity</span>
        <ReplyingBadge />
      </div>
      <div className="chat-bubble chat-bubble-assistant chat-bubble-pending">
        <TypingDots />
        <span className="chat-pending-label">{label}</span>
      </div>
    </div>
  )
}
