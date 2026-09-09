import { useCallback, useEffect, useRef, useState } from 'react'

const STORAGE_KEY = 'orbit.sidebar.width'

export const SIDEBAR_DEFAULT_WIDTH = 258
export const SIDEBAR_MIN_WIDTH = 208
export const SIDEBAR_MAX_WIDTH = 420

/** The conversation is the point of the window, so it keeps a floor no drag
 *  can push it below. On a narrow window this is what stops the sidebar's
 *  maximum from being reachable at all, rather than letting the transcript
 *  be squeezed to nothing. */
export const CONVERSATION_MIN_WIDTH = 520

/** The widest the sidebar may be given the window it is in. Never below the
 *  minimum: on a window too small for both, the sidebar keeps its floor and
 *  the conversation gives way, because a sidebar narrower than its own
 *  minimum is unusable rather than merely cramped. */
export function maxWidthForViewport(viewportWidth: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, viewportWidth - CONVERSATION_MIN_WIDTH))
}

export function clampSidebarWidth(width: number, viewportWidth: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH
  return Math.round(Math.min(Math.max(width, SIDEBAR_MIN_WIDTH), maxWidthForViewport(viewportWidth)))
}

function readStoredWidth(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10)
    return Number.isFinite(parsed) ? parsed : SIDEBAR_DEFAULT_WIDTH
  } catch {
    return SIDEBAR_DEFAULT_WIDTH
  }
}

function writeStoredWidth(width: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(width))
  } catch {
    // A width that failed to persist still applies to this session; it
    // simply will not be remembered next launch.
  }
}

export interface SidebarWidth {
  width: number
  min: number
  /** The live maximum for the current window, not the constant — what the
   *  separator reports as its range. */
  max: number
  /** Absolute width in px, clamped and persisted. */
  setWidth: (width: number) => void
  /** Relative nudge, for the separator's arrow keys. */
  nudge: (delta: number) => void
  reset: () => void
  dragging: boolean
  setDragging: (dragging: boolean) => void
}

/** The sidebar's width, as one piece of state with one owner.
 *
 *  Persisted locally because it is a per-machine display preference, not
 *  workspace data: it belongs with the expanded-projects list in
 *  localStorage rather than in the Orbit database. Re-clamped whenever the
 *  window changes so a width saved on a wide monitor cannot leave the
 *  conversation unusable on a laptop. */
export function useSidebarWidth(): SidebarWidth {
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth))
  const [width, setWidthState] = useState(() => clampSidebarWidth(readStoredWidth(), typeof window === 'undefined' ? 1440 : window.innerWidth))
  const [dragging, setDragging] = useState(false)
  // Written on every drag frame, so persistence is not a per-pixel
  // localStorage write.
  const pending = useRef(width)

  useEffect(() => {
    const onResize = (): void => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const max = maxWidthForViewport(viewportWidth)

  // A narrower window can invalidate a width that was legal when it was
  // chosen. Correct it rather than letting the conversation be crushed.
  useEffect(() => {
    setWidthState((current) => {
      const clamped = clampSidebarWidth(current, viewportWidth)
      if (clamped !== current) pending.current = clamped
      return clamped
    })
  }, [viewportWidth])

  const setWidth = useCallback(
    (next: number) => {
      const clamped = clampSidebarWidth(next, viewportWidth)
      pending.current = clamped
      setWidthState(clamped)
    },
    [viewportWidth]
  )

  const nudge = useCallback((delta: number) => setWidth(pending.current + delta), [setWidth])
  const reset = useCallback(() => setWidth(SIDEBAR_DEFAULT_WIDTH), [setWidth])

  // Persisted when the drag ends rather than during it.
  useEffect(() => {
    if (dragging) return
    writeStoredWidth(width)
  }, [dragging, width])

  return { width, min: SIDEBAR_MIN_WIDTH, max, setWidth, nudge, reset, dragging, setDragging }
}
