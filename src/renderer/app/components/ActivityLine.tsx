import { useEffect, useState } from 'react'
import {
  activityKind,
  activityPhrase,
  currentActivityLine,
  elapsedLabel,
  hasFailure,
  summarizeActivity,
  type ActivityKind,
  type ActivityState
} from '../lib/activity'

/** While a turn runs: one line that updates in place, so a long turn never
 *  looks frozen and never becomes an event feed.
 *
 *  Two pieces of information, in the order a person wants them: what
 *  Antigravity is doing right now, in Orbit's words, and then the exact
 *  tool it is doing it with. The second is the part that matters when
 *  something goes wrong, so it is always shown when supplied — but quietly,
 *  because this whole line is subordinate to the reply it sits under. */
export function LiveActivity({ activity }: { activity: ActivityState }): JSX.Element | null {
  const current = currentActivityLine(activity)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!current || current.status !== 'running') return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [current?.key, current?.status])

  if (!current) return null
  const elapsed = current.status === 'running' ? elapsedLabel(current.startedAt, now) : null
  const kind = activityKind(current.label)

  return (
    <div className="activity activity-live" data-kind={kind} aria-live="polite">
      <ActivityGlyph kind={kind} />
      <span className="activity-label">{activityPhrase(current)}</span>
      {/* The literal tool/command, kept readable rather than replaced by the
          phrase above it. */}
      <span className="activity-detail" title={current.label}>
        {current.label}
      </span>
      {elapsed ? <span className="activity-elapsed">{elapsed}</span> : null}
    </div>
  )
}

/** The turn is paused on the user. Its own component so the runtime branch
 *  has one place to render a waiting state that is not an approval card —
 *  the card itself already covers the case where there are options to
 *  choose from. */
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
            <li key={item.key} className={`activity-item activity-item-${item.status}`} data-kind={activityKind(item.label)}>
              <span className="activity-item-mark" aria-hidden="true">
                {item.status === 'failed' ? '×' : '·'}
              </span>
              <span className="activity-item-phrase">{activityPhrase(item)}</span>
              <span className="activity-detail" title={item.label}>
                {item.label}
              </span>
              {item.status === 'failed' ? <span className="visually-hidden">failed</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}

/** One small literal mark per kind of work: a chevron for a command, a
 *  pencil for an edit, a page for a read, a magnifier for a search. Nothing
 *  decorative — they exist so a scan down the rail can tell the kinds apart
 *  without reading every line. */
function ActivityGlyph({ kind }: { kind: ActivityKind }): JSX.Element {
  const common = { viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': true, focusable: 'false' as const, className: 'activity-glyph' }
  if (kind === 'command') {
    return (
      <svg {...common}>
        <path d="M3.5 4.5L6.5 8l-3 3.5M8.5 11.5h4" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  if (kind === 'edit') {
    return (
      <svg {...common}>
        <path d="M10.5 2.5l3 3L6 13H3v-3z" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinejoin="round" />
      </svg>
    )
  }
  if (kind === 'search') {
    return (
      <svg {...common}>
        <circle cx="7" cy="7" r="4.2" stroke="currentColor" strokeWidth="1.4" fill="none" />
        <path d="M10.2 10.2L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    )
  }
  if (kind === 'read') {
    return (
      <svg {...common}>
        <path d="M4 2h5l3 3v9H4z" stroke="currentColor" strokeWidth="1.25" fill="none" strokeLinejoin="round" />
        <path d="M9 2v3h3" stroke="currentColor" strokeWidth="1.25" fill="none" strokeLinejoin="round" />
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
