import { useCopy } from '../lib/useCopy'

/** The actions a message offers on hover or focus.
 *
 *  Copy is the one thing people do to a message constantly, and it used to
 *  cost a trip through a three-dot menu. It is a button now, always in the
 *  DOM so the keyboard can reach it, and merely invisible until the row is
 *  hovered or something inside it has focus — so a settled transcript still
 *  reads as prose rather than as a stack of toolbars.
 *
 *  Nothing else is here. Orbit has no resend or regenerate: `messages.send`
 *  starts a genuinely new turn with a new user message, which is not what a
 *  Retry button promises, and a button that quietly does something else is
 *  worse than no button. */
export function MessageActions({ text, label }: { text: string; label: string }): JSX.Element {
  const { copy, copied } = useCopy()

  return (
    <div className="message-actions">
      <button
        type="button"
        className={copied ? 'message-action is-copied' : 'message-action'}
        aria-label={`Copy ${label}`}
        title={copied ? 'Copied' : `Copy ${label}`}
        onClick={() => copy(text)}
      >
        {copied ? <TickGlyph /> : <CopyGlyph />}
        <span className="message-action-label">{copied ? 'Copied' : 'Copy'}</span>
      </button>
      {/* Announced once, and only on success — the icon swap alone is
          invisible to a screen reader. */}
      <span className="visually-hidden" role="status">
        {copied ? 'Copied to clipboard' : ''}
      </span>
    </div>
  )
}

function CopyGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" stroke="currentColor" strokeWidth="1.3" fill="none" />
      <path d="M10.5 5.5v-1a1.6 1.6 0 0 0-1.6-1.6H4.1A1.6 1.6 0 0 0 2.5 4.5v4.8a1.6 1.6 0 0 0 1.6 1.6h1" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" />
    </svg>
  )
}

function TickGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
      <path d="M3.5 8.5l3 3 6-6.5" stroke="currentColor" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
