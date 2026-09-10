import { useEffect, useRef, useState } from 'react'
import { requireOrbitApi } from '../orbitApi'

interface MessageActionsProps {
  /** Exactly what the user should get on the clipboard: a user message's own
   *  text, or an assistant reply's markdown source — never the rendered
   *  HTML, and never a re-serialization of it. */
  text: string
  /** Names the message in the action's accessible label, so a transcript
   *  full of copy buttons is navigable rather than a row of identical
   *  "Copy" controls. */
  label: string
}

type Result = 'idle' | 'copied' | 'failed'

/** The actions that appear on a message when the pointer or the keyboard
 *  reaches it.
 *
 *  Copy is the only one. The transcript is for reading, and a permanent row
 *  of buttons under every message turns it into a control panel — so these
 *  are revealed on hover and on focus-within, and are real focusable
 *  buttons in the tab order either way, which is what keeps them reachable
 *  without a pointer.
 *
 *  The write goes through Orbit's narrow clipboard IPC rather than
 *  `navigator.clipboard`: a packaged Orbit loads over file://, which is not
 *  a secure context, so the browser API is undefined there and a copy that
 *  "worked" in development would do nothing at all in the real app. The
 *  result is reported either way — a failed copy says so instead of
 *  pretending. */
export function MessageActions({ text, label }: MessageActionsProps): JSX.Element {
  const [result, setResult] = useState<Result>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  const flash = (next: Result): void => {
    setResult(next)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setResult('idle'), 1600)
  }

  const copy = async (): Promise<void> => {
    try {
      const written = await requireOrbitApi().clipboard.writeText(text)
      flash(written ? 'copied' : 'failed')
    } catch {
      flash('failed')
    }
  }

  return (
    <div className="message-actions">
      <button
        type="button"
        className={`message-action${result === 'failed' ? ' is-failed' : ''}`}
        aria-label={result === 'copied' ? `${label} copied` : `Copy ${label}`}
        title={result === 'failed' ? 'Could not copy' : 'Copy'}
        onClick={() => void copy()}
      >
        {result === 'copied' ? <CheckGlyph /> : <CopyGlyph />}
        <span className="message-action-text">
          {result === 'copied' ? 'Copied' : result === 'failed' ? 'Failed' : 'Copy'}
        </span>
      </button>
      {/* Announced without stealing focus, so a keyboard user hears the
          outcome of their own action. */}
      <span role="status" aria-live="polite" className="visually-hidden">
        {result === 'copied' ? `${label} copied` : result === 'failed' ? `${label} could not be copied` : ''}
      </span>
    </div>
  )
}

function CopyGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
      <rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.5 3.6a1.6 1.6 0 0 0-1.5-1.1H4.6A2.1 2.1 0 0 0 2.5 4.6v4.4a1.6 1.6 0 0 0 1.1 1.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function CheckGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
      <path d="M3.4 8.6l3 3 6.2-7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
