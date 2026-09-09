// @vitest-environment jsdom
import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SidebarResizer } from '../../src/renderer/app/components/SidebarResizer'
import {
  CONVERSATION_MIN_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  maxWidthForViewport
} from '../../src/renderer/app/lib/useSidebarWidth'

describe('sidebar width constraints', () => {
  it('keeps the sidebar between its own bounds', () => {
    expect(clampSidebarWidth(9999, 1600)).toBe(SIDEBAR_MAX_WIDTH)
    expect(clampSidebarWidth(10, 1600)).toBe(SIDEBAR_MIN_WIDTH)
    expect(clampSidebarWidth(300, 1600)).toBe(300)
  })

  it('never lets a drag squeeze the conversation below its own floor', () => {
    // 900px window: the sidebar may take everything the conversation does
    // not need, and not a pixel more.
    expect(maxWidthForViewport(900)).toBe(900 - CONVERSATION_MIN_WIDTH)
    expect(clampSidebarWidth(SIDEBAR_MAX_WIDTH, 900)).toBe(900 - CONVERSATION_MIN_WIDTH)
  })

  it('keeps the sidebar usable on a window too small for both', () => {
    // Below this there is no width that satisfies everyone. The sidebar
    // keeps its floor rather than collapsing to something unreadable.
    expect(maxWidthForViewport(400)).toBe(SIDEBAR_MIN_WIDTH)
    expect(clampSidebarWidth(120, 400)).toBe(SIDEBAR_MIN_WIDTH)
  })

  it('falls back to the default rather than propagating a broken value', () => {
    expect(clampSidebarWidth(Number.NaN, 1600)).toBe(SIDEBAR_DEFAULT_WIDTH)
  })
})

function renderResizer(width = 260) {
  const onResize = vi.fn()
  const onNudge = vi.fn()
  const onReset = vi.fn()
  const onDraggingChange = vi.fn()
  const view = render(
    <SidebarResizer
      width={width}
      min={SIDEBAR_MIN_WIDTH}
      max={SIDEBAR_MAX_WIDTH}
      dragging={false}
      onResize={onResize}
      onNudge={onNudge}
      onReset={onReset}
      onDraggingChange={onDraggingChange}
    />
  )
  return { ...view, onResize, onNudge, onReset, onDraggingChange, handle: screen.getByRole('separator', { name: 'Resize sidebar' }) }
}

/** jsdom implements no PointerEvent at all, so `fireEvent.pointerMove` emits
 *  a bare Event with no coordinates and every drag assertion silently tests
 *  nothing. A MouseEvent carries real clientX and dispatches under whatever
 *  type it is given, which is what React's pointer listeners key off. */
function pointer(node: Element, type: string, clientX?: number): void {
  fireEvent(node, new MouseEvent(type, { bubbles: true, cancelable: true, ...(clientX === undefined ? {} : { clientX }) }))
}

describe('SidebarResizer', () => {
  beforeEach(() => {
    // jsdom implements neither, and the component must not depend on the
    // capture succeeding to be operable.
    Element.prototype.setPointerCapture = vi.fn()
    Element.prototype.releasePointerCapture = vi.fn()
    Element.prototype.hasPointerCapture = vi.fn(() => true)
  })

  it('reports its real range, so the separator is meaningful to assistive tech', () => {
    const { handle } = renderResizer(272)
    expect(handle).toHaveAttribute('aria-orientation', 'vertical')
    expect(handle).toHaveAttribute('aria-valuenow', '272')
    expect(handle).toHaveAttribute('aria-valuemin', String(SIDEBAR_MIN_WIDTH))
    expect(handle).toHaveAttribute('aria-valuemax', String(SIDEBAR_MAX_WIDTH))
  })

  it('is reachable and operable from the keyboard', async () => {
    const user = userEvent.setup()
    const { handle, onNudge, onReset } = renderResizer()
    await user.tab()
    expect(handle).toHaveFocus()

    await user.keyboard('{ArrowRight}')
    expect(onNudge).toHaveBeenCalledWith(16)
    await user.keyboard('{ArrowLeft}')
    expect(onNudge).toHaveBeenCalledWith(-16)

    await user.keyboard('{Enter}')
    expect(onReset).toHaveBeenCalled()
  })

  it('drags from where it was grabbed, not from the cursor', () => {
    const harness = renderHarness(260)
    // Grabbed 6px to the right of the edge. Moving the pointer to 400 must
    // land the edge on 394, not 400, or the sidebar jumps under the cursor
    // on the very first frame of every drag.
    pointer(harness.handle(), 'pointerdown', 266)
    pointer(harness.handle(), 'pointermove', 400)
    expect(harness.width()).toBe(394)

    pointer(harness.handle(), 'pointerup')
    pointer(harness.handle(), 'pointermove', 600)
    // The drag is over; stray movement no longer resizes anything.
    expect(harness.width()).toBe(394)
  })

  it('clamps a drag past the maximum instead of following the pointer', () => {
    const harness = renderHarness(260)
    pointer(harness.handle(), 'pointerdown', 260)
    pointer(harness.handle(), 'pointermove', 5000)
    expect(harness.width()).toBe(maxWidthForViewport(window.innerWidth))
  })

  it('resets to the default width on a double click', () => {
    const { handle, onReset } = renderResizer()
    fireEvent.doubleClick(handle)
    expect(onReset).toHaveBeenCalled()
  })

  it('ignores pointer movement when no drag is in progress', () => {
    const { handle, onResize } = renderResizer(260)
    pointer(handle, 'pointermove', 400)
    expect(onResize).not.toHaveBeenCalled()
  })
})

/** The resizer as the app actually wires it: controlled, with the real
 *  clamping hook behind it, so a drag is exercised end to end rather than
 *  against a mock that would accept any number. */
function Harness({ initial }: { initial: number }): JSX.Element {
  const [width, setWidth] = useState(initial)
  const [dragging, setDragging] = useState(false)
  return (
    <>
      <SidebarResizer
        width={width}
        min={SIDEBAR_MIN_WIDTH}
        max={maxWidthForViewport(window.innerWidth)}
        dragging={dragging}
        onResize={(next) => setWidth(clampSidebarWidth(next, window.innerWidth))}
        onNudge={(delta) => setWidth((current) => clampSidebarWidth(current + delta, window.innerWidth))}
        onReset={() => setWidth(SIDEBAR_DEFAULT_WIDTH)}
        onDraggingChange={setDragging}
      />
      <output data-testid="width">{width}</output>
    </>
  )
}

function renderHarness(initial: number) {
  render(<Harness initial={initial} />)
  return {
    handle: () => screen.getByRole('separator', { name: 'Resize sidebar' }),
    width: () => Number(screen.getByTestId('width').textContent)
  }
}
