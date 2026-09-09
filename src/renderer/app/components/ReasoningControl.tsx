import { useRef, type KeyboardEvent, type PointerEvent } from 'react'
import type { ModelOption, ReasoningEffort } from '@shared/domain'
import { EFFORT_LABEL, descendingEfforts } from '../lib/modelDisplay'
import { reasoningTheme, stopOffset, tierAtFraction, trackFill } from '../lib/reasoningVisual'

interface ReasoningControlProps {
  model: ModelOption | null
  effort: ReasoningEffort | null
  onChange: (effort: ReasoningEffort) => void
}

/** How many particles drift through the active part of the track. Enough to
 *  read as motion, few enough that it never becomes the loudest thing on
 *  screen. */
const PARTICLES = [0, 1, 2, 3, 4]

/** The reasoning control, sized to the model in front of it.
 *
 *  Geometry is structural, not numeric: the control is a grid of exactly one
 *  row per real tier, the track spans every row, and each stop sits at its
 *  own row's centre. A two-tier model therefore gets a physically shorter
 *  track with two stops — never a three-stop control with a dead gap where
 *  medium would be. Models with one tier or none render a statement instead
 *  of a control that cannot move. */
export function ReasoningControl({ model, effort, onChange }: ReasoningControlProps): JSX.Element {
  const railRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const efforts = descendingEfforts(model)
  const theme = reasoningTheme(model, effort)

  if (efforts.length === 0) {
    return (
      <p className="reasoning-statement">
        {model ? 'Reasoning is controlled by the model.' : 'Choose a model to see its reasoning levels.'}
      </p>
    )
  }

  if (efforts.length === 1) {
    const fixed = efforts[0]!
    return (
      <div className="reasoning-fixed" data-theme="mid">
        <span className="reasoning-fixed-level">{EFFORT_LABEL[fixed]}</span>
        <span className="reasoning-fixed-note">Fixed by this model</span>
      </div>
    )
  }

  const fill = trackFill(model, effort)
  const handleOffset = effort ? stopOffset(efforts.length, efforts.indexOf(effort)) : null

  const applyFromPointer = (event: PointerEvent<HTMLDivElement>): void => {
    const node = railRef.current
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

  // Arrow keys walk the real tiers; Home/End jump to the extremes this model
  // actually has. Nothing here can land between two published tiers.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const current = effort ? efforts.indexOf(effort) : efforts.length - 1
    let next: number | null = null
    if (event.key === 'ArrowUp' || event.key === 'ArrowRight') next = Math.max(0, current - 1)
    if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') next = Math.min(efforts.length - 1, current + 1)
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = efforts.length - 1
    if (next === null) return
    event.preventDefault()
    const chosen = efforts[next]
    if (chosen && chosen !== effort) onChange(chosen)
  }

  return (
    <div className="reasoning-scale" data-theme={theme} style={{ ['--stops' as string]: efforts.length }}>
      <div
        ref={railRef}
        className="reasoning-rail"
        role="slider"
        tabIndex={0}
        aria-label="Reasoning effort"
        aria-orientation="vertical"
        aria-valuemin={1}
        aria-valuemax={efforts.length}
        {...(effort
          ? { 'aria-valuenow': efforts.length - efforts.indexOf(effort), 'aria-valuetext': EFFORT_LABEL[effort] }
          : { 'aria-valuetext': 'Automatic' })}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={onKeyDown}
      >
        <div className="reasoning-track">
          <div className="reasoning-flow" style={{ height: `${fill * 100}%` }} aria-hidden="true">
            {PARTICLES.map((index) => (
              <span key={index} className={`reasoning-particle particle-${index}`} />
            ))}
          </div>
          {/* One tick per real stop, drawn from the same offset the handle
              and the label use, so the three can never drift apart. */}
          {efforts.map((level, index) => (
            <span
              key={level}
              className="reasoning-tick"
              style={{ top: `${stopOffset(efforts.length, index) * 100}%` }}
              aria-hidden="true"
            />
          ))}
        </div>
        {handleOffset !== null ? <span className="reasoning-handle" style={{ top: `${handleOffset * 100}%` }} aria-hidden="true" /> : null}
      </div>

      {efforts.map((level, index) => (
        <button
          key={level}
          type="button"
          className={level === effort ? 'reasoning-stop active' : 'reasoning-stop'}
          style={{ gridRow: index + 1 }}
          aria-pressed={level === effort}
          onClick={() => onChange(level)}
        >
          {EFFORT_LABEL[level]}
        </button>
      ))}
    </div>
  )
}
