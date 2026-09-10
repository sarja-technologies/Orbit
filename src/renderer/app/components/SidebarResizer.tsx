import { useRef, type KeyboardEvent, type PointerEvent } from 'react'

interface SidebarResizerProps {
  width: number
  min: number
  max: number
  dragging: boolean
  onResize: (width: number) => void
  onNudge: (delta: number) => void
  onReset: () => void
  onDraggingChange: (dragging: boolean) => void
}

/** How far an arrow key moves the edge. Small enough to aim with, large
 *  enough that crossing the whole range does not take a hundred presses. */
const KEY_STEP = 16

/** The seam between navigation and conversation, as a real control.
 *
 *  A four-pixel hit area over a one-pixel line: the divider stays a hairline
 *  at rest and only lights up under the pointer, so the affordance is
 *  discoverable without the app growing a permanent grab handle. It is a
 *  `separator` with a value and a range, which is what makes it operable
 *  from the keyboard as well as the mouse. */
export function SidebarResizer({
  width,
  min,
  max,
  dragging,
  onResize,
  onNudge,
  onReset,
  onDraggingChange
}: SidebarResizerProps): JSX.Element {
  // The pointer's offset within the handle at grab time. Without it the
  // sidebar edge jumps to the cursor on the first move.
  const grabOffset = useRef(0)

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    grabOffset.current = event.clientX - width
    event.currentTarget.setPointerCapture(event.pointerId)
    onDraggingChange(true)
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    onResize(event.clientX - grabOffset.current)
  }

  const endDrag = (event: PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    onDraggingChange(false)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowLeft') onNudge(-KEY_STEP)
    else if (event.key === 'ArrowRight') onNudge(KEY_STEP)
    else if (event.key === 'Home') onNudge(-Number.MAX_SAFE_INTEGER)
    else if (event.key === 'End') onNudge(Number.MAX_SAFE_INTEGER)
    else if (event.key === 'Enter' || event.key === ' ') onReset()
    else return
    event.preventDefault()
  }

  return (
    <div
      className={dragging ? 'sidebar-resizer is-dragging' : 'sidebar-resizer'}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    >
      <span className="sidebar-resizer-grip" aria-hidden="true" />
    </div>
  )
}
