import { useState } from 'react'
import type { InteractionRequiredEvent } from '@shared/runtime-events'
import { describeInteraction, type InteractionOptionView } from '../lib/interactionCopy'

interface InteractionCardProps {
  event: InteractionRequiredEvent
  busy: boolean
  onRespond: (optionId: string) => void
}

/** Antigravity's approval request, in Orbit's voice. The native option a
 *  button maps to is never substituted — only how it is presented. */
export function InteractionCard({ event, busy, onRespond }: InteractionCardProps): JSX.Element {
  const view = describeInteraction(event)
  const [remember, setRemember] = useState<'session' | 'always' | null>(null)
  const [showOriginal, setShowOriginal] = useState(false)

  // Approving with a "remember" preference selected must send that exact
  // native option, not a plain approve plus a local flag.
  const approveTarget: InteractionOptionView | null =
    (remember === 'always' ? view.rememberAlways : remember === 'session' ? view.rememberSession : null) ?? view.approve

  const unresolvedOnly = !view.approve && !view.deny && view.other.length > 0

  return (
    <section className={`interaction${view.approve?.destructive ? ' interaction-caution' : ''}`} role="group" aria-label="Antigravity needs your approval">
      <div className="interaction-head">
        <ShieldGlyph />
        <h2 className="interaction-title">{view.title}</h2>
      </div>

      {view.command ? <div className="interaction-command">{view.command}</div> : null}
      {view.detail ? <p className="interaction-detail">{view.detail}</p> : null}
      {view.approve?.destructive ? <p className="interaction-caution-note">This looks like it could remove or overwrite work.</p> : null}

      {/* Nothing was confidently classified — present every native option
          exactly as Antigravity supplied it rather than guessing. */}
      {unresolvedOnly ? (
        <div className="interaction-actions">
          {view.other.map((option) => (
            <button key={option.id} type="button" className="secondary" disabled={busy} onClick={() => onRespond(option.id)}>
              {option.nativeLabel}
            </button>
          ))}
        </div>
      ) : (
        <>
          {view.rememberSession || view.rememberAlways ? (
            <div className="interaction-remember">
              {view.rememberSession ? (
                <label>
                  <input
                    type="checkbox"
                    checked={remember === 'session'}
                    disabled={busy}
                    onChange={(input) => setRemember(input.target.checked ? 'session' : null)}
                  />
                  <span>{view.rememberSession.label}</span>
                </label>
              ) : null}
              {view.rememberAlways ? (
                <label>
                  <input
                    type="checkbox"
                    checked={remember === 'always'}
                    disabled={busy}
                    onChange={(input) => setRemember(input.target.checked ? 'always' : null)}
                  />
                  <span>{view.rememberAlways.label}</span>
                </label>
              ) : null}
            </div>
          ) : null}

          <div className="interaction-actions">
            {approveTarget ? (
              <button type="button" className="primary" disabled={busy} onClick={() => onRespond(approveTarget.id)}>
                Approve
              </button>
            ) : null}
            {view.deny ? (
              <button type="button" className="secondary" disabled={busy} onClick={() => onRespond(view.deny!.id)}>
                Deny
              </button>
            ) : null}
            {view.other.map((option) => (
              <button key={option.id} type="button" className="ghost" disabled={busy} onClick={() => onRespond(option.id)}>
                {option.nativeLabel}
              </button>
            ))}
          </div>
        </>
      )}

      <button type="button" className="disclosure" aria-expanded={showOriginal} onClick={() => setShowOriginal((value) => !value)}>
        {showOriginal ? 'Hide original prompt' : 'Show original prompt'}
      </button>
      {showOriginal ? <pre className="disclosure-body">{view.originalPrompt}</pre> : null}
    </section>
  )
}

/** A non-actionable interaction: Antigravity already skipped it, or the
 *  request went stale. Never rendered with live-looking buttons. */
export function InactiveInteraction({ event, reason }: { event: InteractionRequiredEvent; reason: 'unavailable' | 'stale' }): JSX.Element {
  const view = describeInteraction(event)
  const [showOriginal, setShowOriginal] = useState(false)
  return (
    <section className="interaction interaction-inactive" role="status">
      <div className="interaction-head">
        <ShieldGlyph />
        <h2 className="interaction-title">{reason === 'stale' ? 'This request is no longer active' : view.title}</h2>
      </div>
      {reason === 'stale' ? <p className="interaction-detail">Send another message to continue.</p> : view.detail ? <p className="interaction-detail">{view.detail}</p> : null}
      <button type="button" className="disclosure" aria-expanded={showOriginal} onClick={() => setShowOriginal((value) => !value)}>
        {showOriginal ? 'Hide original prompt' : 'Show original prompt'}
      </button>
      {showOriginal ? <pre className="disclosure-body">{view.originalPrompt}</pre> : null}
    </section>
  )
}

/** The compact record left in the transcript after an interaction resolves,
 *  so the decision stays visible rather than vanishing. */
export function ResolvedInteraction({ summary }: { summary: string }): JSX.Element {
  const denied = summary.startsWith('Denied')
  return (
    <div className={`transcript-note${denied ? ' transcript-note-denied' : ''}`}>
      <span className="transcript-note-mark" aria-hidden="true">
        {denied ? '×' : '✓'}
      </span>
      {summary}
    </div>
  )
}

function ShieldGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="M8 2l5 2v4.2c0 3-2.1 5.2-5 5.8-2.9-.6-5-2.8-5-5.8V4z" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
    </svg>
  )
}
