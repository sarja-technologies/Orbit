import { useRef, type KeyboardEvent, type PointerEvent } from 'react'
import type { ModelOption, ReasoningEffort } from '@shared/domain'
import { EFFORT_LABEL, descendingEfforts } from '../lib/modelDisplay'
import { animationTempo, reasoningTheme, tierAtFraction, trackFill } from '../lib/reasoningVisual'

interface ReasoningSliderProps {
  model: ModelOption | null
  effort: ReasoningEffort | null
  fastMode: boolean
  onChange: (effort: ReasoningEffort | null) => void
}

/** One continuous vertical track with the activity animation running inside
 *  it — not a column of separate dots. Highest tier at the top. The track
 *  only ever offers the tiers the selected model genuinely publishes, so a
 *  two-tier model gets two stops, not a three-stop control with a gap. */
export function ReasoningSlider({ model, effort, fastMode, onChange }: ReasoningSliderProps): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const efforts = descendingEfforts(model)
  const theme = reasoningTheme(model, effort)
  const tempo = animationTempo(fastMode)
  const fill = trackFill(model, effort)

  const applyFromPointer = (event: PointerEvent<HTMLDivElement>): void => {
    const node = trackRef.current
    if (!node) return
    const rect = node.getBoundingClientRect()
    if (rect.height === 0) return
    const next = tierAtFraction(efforts, (event.clientY - rect.top) / rect.height)
    if (next && next !== effort) onChange(next)
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    dragging.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
    applyFromPointer(event)
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (dragging.current) applyFromPointer(event)
  }

  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    dragging.current = false
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  // Arrow keys walk the real tiers; Home/End jump to the extremes this
  // model actually has.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (efforts.length === 0) return
    const current = effort ? efforts.indexOf(effort) : efforts.length
    let next: number | null = null
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') next = Math.max(0, Math.min(current, efforts.length) - 1)
    if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') next = Math.min(efforts.length - 1, current + 1)
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = efforts.length - 1
    if (next === null) return
    event.preventDefault()
    const chosen = efforts[next]
    if (chosen) onChange(chosen)
  }

  return (
    <div className={`reasoning-slider theme-${theme} tempo-${tempo}`}>
      {/* The handle sits outside the clipped track so it can overhang it. */}
      <div className="reasoning-track-wrap">
      <div
        ref={trackRef}
        className="reasoning-track"
        role="slider"
        tabIndex={0}
        aria-label="Reasoning effort"
        aria-orientation="vertical"
        aria-valuemin={1}
        aria-valuemax={efforts.length}
        {...(effort ? { 'aria-valuenow': efforts.length - efforts.indexOf(effort), 'aria-valuetext': EFFORT_LABEL[effort] } : { 'aria-valuetext': 'Automatic' })}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={onKeyDown}
      >
        <div className="reasoning-flow" style={{ height: `${Math.round(fill * 100)}%` }}>
          {theme === 'peak' ? (
            <div className="reasoning-sparks" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
          ) : null}
        </div>
      </div>
      {effort ? <div className="reasoning-handle" style={{ top: `${Math.round((1 - fill) * 100)}%` }} /> : null}
      </div>

      <div className="reasoning-levels">
        {efforts.map((level, index) => (
          <button
            key={level}
            type="button"
            className={level === effort ? 'reasoning-level active' : 'reasoning-level'}
            // Pinned to the exact track position it selects, so the label
            // and the stop it refers to always line up.
            style={{ top: efforts.length === 1 ? '50%' : `${(index / (efforts.length - 1)) * 100}%` }}
            aria-pressed={level === effort}
            // Choosing the current tier again returns to Antigravity's own
            // default rather than locking the user into a tier they can
            // only escape by switching model.
            onClick={() => onChange(level === effort ? null : level)}
          >
            {EFFORT_LABEL[level]}
          </button>
        ))}
      </div>
    </div>
  )
}
