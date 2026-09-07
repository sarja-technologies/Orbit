import { useEffect, useState } from 'react'
import { currentActivityLine, elapsedLabel, hasFailure, summarizeActivity, type ActivityState } from '../lib/activity'

/** While a turn runs: one line that updates in place, so a long turn never
 *  looks frozen and never becomes an event feed. */
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

  return (
    <div className="activity activity-live" aria-live="polite">
      <span className="activity-pip" aria-hidden="true" />
      <span className="activity-label">{current.label}</span>
      {elapsed ? <span className="activity-elapsed">{elapsed}</span> : null}
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
            <li key={item.key} className={`activity-item activity-item-${item.status}`}>
              <span className="activity-item-mark" aria-hidden="true">
                {item.status === 'failed' ? '×' : '·'}
              </span>
              <span>{item.label}</span>
              {item.status === 'failed' ? <span className="visually-hidden">failed</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}

function ChevronGlyph({ open }: { open: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false" className={open ? 'chevron open' : 'chevron'}>
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
