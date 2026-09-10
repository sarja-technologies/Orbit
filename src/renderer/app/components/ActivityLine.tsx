import { useEffect, useState } from 'react'
import type { ActivityKind } from '@shared/runtime-events'
import { currentActivityLine, durationLabel, hasFailure, summarizeActivity, type ActivityItem, type ActivityState } from '../lib/activity'
import { describeActivity } from '../lib/activityCopy'

/** While a turn runs: one line that updates in place, so a long turn never
 *  looks frozen and never becomes an event feed.
 *
 *  What the line *says* is not decided here. The provider reports facts —
 *  the kind of work, the exact command, the exact path — and
 *  lib/activityCopy.ts turns those into English. This component only decides
 *  how that truth looks: a mark for the kind of work, the phrase, the literal
 *  command in monospace beside it, and how long it has been going. */
export function LiveActivity({ activity }: { activity: ActivityState }): JSX.Element | null {
  const current = currentActivityLine(activity)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!current || current.status !== 'running') return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [current?.key, current?.status])

  if (!current) return null
  const view = describeActivity(current)
  const elapsed = durationLabel(current, now)

  return (
    <div className="activity activity-live" data-kind={current.kind ?? 'unknown'} aria-live="polite">
      <ActivityGlyph kind={current.kind} />
      <span className="activity-label">{view.text}</span>
      {view.command ? <ActivityCommand command={view.command} /> : null}
      {elapsed ? <span className="activity-elapsed">{elapsed}</span> : null}
    </div>
  )
}

/** The literal command Antigravity reported, shown as the command it is.
 *  Never truncated into something that reads like a different command —
 *  overflow is handled by the style, and the full text is the title. */
function ActivityCommand({ command }: { command: string }): JSX.Element {
  return (
    <code className="activity-command" title={command}>
      {command}
    </code>
  )
}

/** One finished step, as read back in the collapsed summary. */
function ActivityItemLine({ item }: { item: ActivityItem }): JSX.Element {
  const view = describeActivity(item)
  const duration = durationLabel(item, 0)
  return (
    <li className={`activity-item activity-item-${item.status}`} data-kind={item.kind ?? 'unknown'}>
      <span className="activity-item-mark" aria-hidden="true">
        {item.status === 'failed' ? '×' : '·'}
      </span>
      <span className="activity-item-phrase">{view.text}</span>
      {view.command ? <ActivityCommand command={view.command} /> : null}
      {duration ? <span className="activity-elapsed">{duration}</span> : null}
      {item.status === 'failed' ? <span className="visually-hidden">failed</span> : null}
    </li>
  )
}

/** The turn is paused on the user, with the approval card below it. Its own
 *  component so the activity rail keeps stating the turn's state at the one
 *  moment it is most obviously not progressing, rather than vanishing. */
export function WaitingActivity({ label = 'Waiting for approval' }: { label?: string }): JSX.Element {
  return (
    <div className="activity activity-waiting" role="status">
      <span className="activity-pip" aria-hidden="true" />
      <span className="activity-label">{label}</span>
    </div>
  )
}

/** After the turn settles: a single collapsed summary, expandable to a
 *  short ordered list. Raw stdout/stderr is never shown here. */
export function ActivitySummary({ activity }: { activity: ActivityState }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const summary = summarizeActivity(activity)
  if (!summary) return null

  return (
    <div className={`activity activity-summary${hasFailure(activity) ? ' has-failure' : ''}`}>
      <button type="button" className="activity-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <ChevronGlyph open={open} />
        <span className="activity-label">{summary}</span>
      </button>
      {open ? (
        <ol className="activity-items">
          {activity.items.map((item) => (
            <ActivityItemLine key={item.key} item={item} />
          ))}
        </ol>
      ) : null}
    </div>
  )
}

/** One small literal mark per kind of work, keyed on the kind the provider
 *  actually reported. Nothing decorative — they exist so a scan down the rail
 *  can tell the kinds apart without reading every line. A step Antigravity
 *  described no further gets the neutral pip rather than a guessed icon. */
function ActivityGlyph({ kind }: { kind: ActivityKind | undefined }): JSX.Element {
  const common = { viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': true, focusable: 'false' as const, className: 'activity-glyph' }
  if (kind === 'running') {
    return (
      <svg {...common}>
        <path d="M3.5 4.5L6.5 8l-3 3.5M8.5 11.5h4" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  if (kind === 'editing') {
    return (
      <svg {...common}>
        <path d="M10.5 2.5l3 3L6 13H3v-3z" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinejoin="round" />
      </svg>
    )
  }
  if (kind === 'searching') {
    return (
      <svg {...common}>
        <circle cx="7" cy="7" r="4.2" stroke="currentColor" strokeWidth="1.4" fill="none" />
        <path d="M10.2 10.2L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    )
  }
  if (kind === 'reading' || kind === 'listing') {
    return (
      <svg {...common}>
        <path d="M4 2h5l3 3v9H4z" stroke="currentColor" strokeWidth="1.25" fill="none" strokeLinejoin="round" />
        <path d="M9 2v3h3" stroke="currentColor" strokeWidth="1.25" fill="none" strokeLinejoin="round" />
      </svg>
    )
  }
  if (kind === 'browsing') {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.3" fill="none" />
        <path d="M2.5 8h11M8 2.5c1.6 1.7 2.4 3.6 2.4 5.5S9.6 12.3 8 13.5c-1.6-1.2-2.4-3.1-2.4-5.5S6.4 4.2 8 2.5z" stroke="currentColor" strokeWidth="1.15" fill="none" />
      </svg>
    )
  }
  return <span className="activity-pip" aria-hidden="true" />
}

function ChevronGlyph({ open }: { open: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false" className={open ? 'chevron open' : 'chevron'}>
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
