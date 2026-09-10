import { useEffect, useState } from 'react'
import {
  currentActivityLine,
  hasFailure,
  isRunning,
  itemElapsedLabel,
  summarizeActivity,
  type ActivityItem,
  type ActivityState
} from '../lib/activity'
import type { AgentIdentity } from '../lib/agentIdentity'
import { AgentMark } from './ProviderLogo'

/** While a turn runs: one line that updates in place, carrying what the
 *  agent is actually doing right now and how long it has been doing it.
 *
 *  The elapsed time is the whole point of the row: a legitimate 40-second
 *  build and a frozen app look identical without it. It ticks only while
 *  the step is genuinely running, and stops the moment the step ends —
 *  including when the run is cancelled, which finalizes every open step. */
export function LiveActivity({ activity, identity }: { activity: ActivityState; identity?: AgentIdentity }): JSX.Element | null {
  const current = currentActivityLine(activity)
  const live = current !== null && isRunning(current)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!live) return
    // Re-read immediately so a row that mounts mid-step is never a second
    // behind, then keep it honest every second.
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [current?.key, live])

  if (!current) return null
  const elapsed = itemElapsedLabel(current, now)

  return (
    <div className="activity activity-live" aria-live="polite">
      {identity ? (
        <span className="activity-agent">
          <AgentMark identity={identity} size={13} />
        </span>
      ) : (
        <span className="activity-pip" aria-hidden="true" />
      )}
      {live ? <span className="activity-pip" aria-hidden="true" /> : null}
      <span className="activity-label" title={current.label}>
        {current.label}
      </span>
      {elapsed ? (
        <span className="activity-elapsed">
          <span aria-hidden="true"> · </span>
          {elapsed}
        </span>
      ) : null}
    </div>
  )
}

/** After the turn settles: a single collapsed summary, expandable to a
 *  short ordered list with each step's real duration. Raw stdout/stderr is
 *  never shown here. */
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
            <SettledItem key={item.key} item={item} />
          ))}
        </ol>
      ) : null}
    </div>
  )
}

/** One finished step. Its duration comes from the step's own start and end,
 *  so it is a fact about what happened rather than a clock that is still
 *  running — a settled row never counts up. */
function SettledItem({ item }: { item: ActivityItem }): JSX.Element {
  // `endedAt` is what a settled row reads from; the `Date.now()` fallback
  // only applies to a row still genuinely open, which the live line owns.
  const elapsed = itemElapsedLabel(item, item.endedAt ?? Date.now())
  return (
    <li className={`activity-item activity-item-${item.status}`} data-kind={item.kind}>
      <span className="activity-item-mark" aria-hidden="true">
        {item.status === 'failed' ? '×' : '·'}
      </span>
      <span className="activity-item-label">{item.label}</span>
      {elapsed ? <span className="activity-elapsed">{elapsed}</span> : null}
      {item.status === 'failed' ? <span className="visually-hidden">failed</span> : null}
    </li>
  )
}

function ChevronGlyph({ open }: { open: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false" className={open ? 'chevron open' : 'chevron'}>
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
