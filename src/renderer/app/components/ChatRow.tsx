import type { ReactNode } from 'react'
import { RUNTIME_NAME, type AgentIdentity } from '../lib/agentIdentity'
import { AgentMark } from './ProviderLogo'

/** Local wall-clock time, or nothing at all if the stored value cannot be
 *  parsed — an empty slot beats a made-up timestamp. */
export function clockTime(iso: string): string {
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return ''
  return new Date(parsed).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** Used wherever no session is in hand to resolve an identity from — the
 *  runtime's own name and its neutral glyph, never Orbit's mark. */
export const RUNTIME_IDENTITY: AgentIdentity = { provider: null, name: RUNTIME_NAME }

interface ChatRowProps {
  role: 'user' | 'assistant'
  /** Draws the identity line (name, time, and the assistant's mark).
   *  Suppressed when the previous row came from the same speaker, so a
   *  burst of messages reads as one block instead of a stack of headers. */
  showIdentity: boolean
  /** Who answered: the selected model's vendor mark and short name. Omitted
   *  falls back to the runtime, which is what a session with no explicit
   *  model selection genuinely is. */
  identity?: AgentIdentity
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
export function ChatRow({
  role,
  showIdentity,
  identity = RUNTIME_IDENTITY,
  timestamp,
  status,
  bubbleClassName,
  children
}: ChatRowProps): JSX.Element {
  const isUser = role === 'user'
  const time = timestamp ? clockTime(timestamp) : ''

  return (
    // Without an identity line there is no first row to fill, so the grid
    // is told that rather than leaving an empty one whose row-gap still
    // costs a line of dead space.
    <div className={`chat-row chat-row-${role}${showIdentity ? '' : ' chat-row-grouped'}`}>
      {!isUser && showIdentity ? <AssistantMark identity={identity} /> : null}
      {showIdentity ? (
        <div className="chat-meta">
          <span className="chat-name">{isUser ? 'You' : identity.name}</span>
          {status ?? (time ? <time dateTime={timestamp ?? undefined}>{time}</time> : null)}
        </div>
      ) : null}
      <div className={`chat-bubble chat-bubble-${role}${bubbleClassName ? ` ${bubbleClassName}` : ''}`}>{children}</div>
    </div>
  )
}

/** The working AI's own mark — Gemini's, Claude's, OpenAI's, or the neutral
 *  automatic glyph when Orbit genuinely cannot tell which model answered.
 *
 *  Never Orbit's Saturn: that mark is the product, and using it here made
 *  every provider's answer look like it came from Orbit itself. Present
 *  only on the assistant side — right-alignment already says "you", so a
 *  second avatar would be noise. */
function AssistantMark({ identity }: { identity: AgentIdentity }): JSX.Element {
  return (
    <span className="chat-mark" data-provider={identity.provider ?? 'unknown'}>
      <AgentMark identity={identity} size={15} />
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
export function ReplyingBadge({ label = 'Replying' }: { label?: string }): JSX.Element {
  return (
    <span className="chat-live">
      <span className="chat-live-pip" aria-hidden="true" />
      {label}
    </span>
  )
}

/** Stands in for the assistant bubble between "sent" and the first token.
 *  Its own component, and its own row, so streaming updates never touch
 *  the settled transcript above it.
 *
 *  Exactly one status presentation, never two. This used to draw a
 *  `Replying` badge in the identity line *and* a bubble underneath saying
 *  "<model> is replying", which said the same thing twice on two rows that
 *  did not share an edge. It is now a single line — the mark in its gutter,
 *  the text on the assistant content rail — so the wait sits exactly where
 *  the answer will appear. */
export function PendingReply({
  who,
  label,
  identity = RUNTIME_IDENTITY
}: {
  /** Named separately only when the phase does not already carry the name,
   *  which is what gives "<model> · Stopping…" its own reading. */
  who?: string | null
  label?: string
  identity?: AgentIdentity
}): JSX.Element {
  return (
    <div className="chat-row chat-row-assistant chat-row-status" aria-live="polite">
      <AssistantMark identity={identity} />
      <p className="chat-status">
        {who ? (
          <>
            <span className="chat-status-who">{who}</span>
            <span className="chat-status-sep" aria-hidden="true">
              ·
            </span>
          </>
        ) : null}
        <span className="chat-status-label">{label ?? `${identity.name} is replying`}</span>
        <TypingDots />
      </p>
    </div>
  )
}
