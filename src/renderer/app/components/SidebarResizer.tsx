import { useCallback, useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { SIDEBAR_WIDTH } from '@shared/reasoningPolicy'

interface SidebarResizerProps {
  width: number
  /** Called continuously while dragging, so the sidebar tracks the pointer.
   *  Cheap by design: it only moves a CSS width. */
  onResize: (width: number) => void
  /** Called once, when the gesture ends. This is the only thing that
   *  persists — dragging must not write a preference on every pointer
   *  event. */
  onCommit: (width: number) => void
}

const KEYBOARD_STEP = 16

/** The drag handle between the sidebar and the workspace.
 *
 *  It is a real separator control rather than a styled div: it carries the
 *  separator role and the current width as its aria value, so the sidebar
 *  can be resized from the keyboard with the arrow keys and announced
 *  properly. The visible affordance stays almost invisible until the
 *  pointer is near it — the divider is a tool, not a piece of furniture.
 *
 *  Pointer capture is what makes the drag survive leaving the handle: once
 *  captured, every move is delivered here even when the cursor is far
 *  inside the transcript, so a fast drag cannot silently detach. */
export function SidebarResizer({ width, onResize, onCommit }: SidebarResizerProps): JSX.Element {
  const dragging = useRef(false)
  const latest = useRef(width)
  latest.current = width

  const clamp = useCallback(
    (value: number) => Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, Math.round(value))),
    []
  )

  // Text selection is suppressed for the whole document while a drag is in
  // flight. Without it, dragging left across the transcript selects it, and
  // the resize reads as a broken text selection instead of a resize.
  useEffect(() => {
    return () => {
      document.body.classList.remove('is-resizing')
    }
  }, [])

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    // Only the primary button starts a resize; a right-click here should do
    // nothing rather than begin a drag the user cannot see.
    if (event.button !== 0) return
    event.preventDefault()
    dragging.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
    document.body.classList.add('is-resizing')
  }

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return
    // The sidebar starts at the window's left edge, so the pointer's own x
    // IS the width. No offset bookkeeping, and nothing to drift.
    onResize(clamp(event.clientX))
  }

  const endDrag = (event: PointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return
    dragging.current = false
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    document.body.classList.remove('is-resizing')
    onCommit(latest.current)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.key === 'ArrowLeft' ? -KEYBOARD_STEP : event.key === 'ArrowRight' ? KEYBOARD_STEP : 0
    if (step === 0) return
    event.preventDefault()
    const next = clamp(latest.current + step)
    onResize(next)
    // A keyboard adjustment is a complete gesture on its own, so it commits
    // immediately rather than waiting for a pointer-up that never comes.
    onCommit(next)
  }

  return (
    <div
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_WIDTH.min}
      aria-valuemax={SIDEBAR_WIDTH.max}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
      onDoubleClick={() => {
        onResize(SIDEBAR_WIDTH.default)
        onCommit(SIDEBAR_WIDTH.default)
      }}
    >
      <span className="sidebar-resizer-line" aria-hidden="true" />
    </div>
  )
}
