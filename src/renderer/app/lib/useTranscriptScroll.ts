import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import {
  bottomOffset,
  initialFollowState,
  isNearBottom,
  nearBottomTolerance,
  onBottomVisibility,
  onReaderScrolled,
  shouldShowJumpToLatest,
  type FollowState,
  type ScrollMetrics
} from './transcriptScroll'

export interface TranscriptScroll {
  /** The scrolling element. */
  viewportRef: RefObject<HTMLDivElement>
  /** The element whose height *is* the conversation, watched for growth. */
  contentRef: RefObject<HTMLDivElement>
  /** A zero-content marker at the end of the transcript. Its visibility is
   *  the definition of "at the bottom". */
  bottomRef: RefObject<HTMLDivElement>
  showJumpToLatest: boolean
  onScroll: () => void
  jumpToLatest: () => void
}

/** Keeps a transcript pinned to its newest content without ever fighting the
 *  reader.
 *
 *  The hard part is not "scroll to the bottom" — it is that the bottom keeps
 *  moving after the scroll. A transcript settles its height over several
 *  frames: `content-visibility: auto` turns swap a 160px placeholder for
 *  their real height only once they are near the viewport, markdown reflows,
 *  code blocks and thumbnails resolve. Any single `scrollTop = scrollHeight`
 *  therefore aims at a height that is about to be wrong.
 *
 *  So following is a standing state, not an event. While it is on, every
 *  observed height change re-pins, coalesced onto one animation frame; the
 *  transcript converges on the true bottom over however many frames layout
 *  actually takes, with no timers and no guesses about how long that is.
 *
 *  Three observers, each answering one question:
 *
 *  - `ResizeObserver` — did the transcript's height change? Drives re-pinning.
 *  - `IntersectionObserver` — is the end of the transcript in view? Defines
 *    "at the bottom", and re-arms following when the reader comes back down.
 *  - the `scroll` event — did the reader move up? Releases following, in the
 *    same tick, so nothing ever yanks them.
 *
 *  @param sessionKey Identifies the conversation on screen. A change is a
 *    fresh navigation: following is re-armed and scroll position is not
 *    carried over from the session being left.
 *  @param revision Changes whenever the transcript's content does. Only a
 *    hint — the ResizeObserver is the real signal — but it lets the common
 *    case pin before paint instead of a frame later, and keeps the policy
 *    working in environments with no observers at all.
 */
export function useTranscriptScroll(sessionKey: string | null, revision: string): TranscriptScroll {
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const followRef = useRef<FollowState>(initialFollowState())
  const atBottomRef = useRef(true)
  const frameRef = useRef<number | null>(null)
  const endObserverRef = useRef<IntersectionObserver | null>(null)
  const toleranceRef = useRef(0)
  const [showJumpToLatest, setShowJumpToLatest] = useState(false)
  const shownRef = useRef(false)

  const publishJump = useCallback((next: boolean): void => {
    if (shownRef.current === next) return
    shownRef.current = next
    setShowJumpToLatest(next)
  }, [])

  /** The sentinel when it is watching, geometry when it is not. The fallback
   *  matters for runtimes without an IntersectionObserver, and it is why the
   *  policy still holds under test. */
  const atBottom = useCallback((node: HTMLElement): boolean => {
    if (endObserverRef.current) return atBottomRef.current
    return isNearBottom(readMetrics(node))
  }, [])

  const sync = useCallback(
    (node: HTMLElement): void => {
      publishJump(shouldShowJumpToLatest(followRef.current, atBottom(node)))
    },
    [atBottom, publishJump]
  )

  /** Writes the scroll offset and records it, so the scroll event this
   *  provokes is not mistaken for the reader moving. */
  const pinNow = useCallback((node: HTMLElement): void => {
    const bottom = bottomOffset(readMetrics(node))
    node.scrollTop = bottom
    followRef.current = { following: true, lastTop: node.scrollTop, lastBottom: bottom }
    // We just put the end on the bottom edge. Saying so now rather than
    // waiting for the observer keeps the control from blinking into
    // existence for one frame after every pin.
    atBottomRef.current = true
  }, [])

  /** The near-bottom band scales with the window, so the sentinel's observer
   *  is rebuilt when a resize actually changes the band — not on every
   *  resize, and not per frame. */
  const watchEnd = useCallback((): void => {
    const node = viewportRef.current
    const end = bottomRef.current
    if (!node || !end || typeof IntersectionObserver === 'undefined') return
    const tolerance = Math.round(nearBottomTolerance(node.clientHeight))
    if (endObserverRef.current && toleranceRef.current === tolerance) return

    endObserverRef.current?.disconnect()
    toleranceRef.current = tolerance
    const observer = new IntersectionObserver(
      (entries) => {
        const last = entries[entries.length - 1]
        if (!last) return
        atBottomRef.current = last.isIntersecting
        followRef.current = onBottomVisibility(followRef.current, last.isIntersecting)
        const viewport = viewportRef.current
        if (viewport) sync(viewport)
      },
      { root: node, rootMargin: `0px 0px ${tolerance}px 0px`, threshold: 0 }
    )
    observer.observe(end)
    endObserverRef.current = observer
  }, [sync])

  /** One re-pin per frame at most. Streaming can change the transcript's
   *  height many times between paints; the reader can only see the last
   *  one, so the rest are wasted layout. */
  const settle = useCallback((): void => {
    if (frameRef.current !== null) return
    frameRef.current = requestFrame(() => {
      frameRef.current = null
      const node = viewportRef.current
      if (!node) return
      watchEnd()
      // Re-read intent inside the frame: the reader may have scrolled away
      // between the schedule and the callback, and they win.
      if (followRef.current.following) pinNow(node)
      sync(node)
    })
  }, [pinNow, sync, watchEnd])

  // A different conversation is a fresh navigation: land on its newest
  // message, and never inherit where the previous session was parked.
  // Before paint, so the first frame of a session is already at the bottom
  // rather than at the top with a visible correction afterwards.
  useLayoutEffect(() => {
    followRef.current = initialFollowState()
    atBottomRef.current = true
    publishJump(false)
    const node = viewportRef.current
    if (!node) return
    pinNow(node)
    settle()
  }, [sessionKey, pinNow, publishJump, settle])

  // New content while following: pin pre-paint so a streaming reply never
  // shows a frame scrolled off the bottom. Layout that settles later is
  // caught by the observers.
  useLayoutEffect(() => {
    const node = viewportRef.current
    if (!node) return
    if (followRef.current.following) pinNow(node)
    settle()
  }, [revision, pinNow, settle])

  // Height changes the render cannot predict: content-visibility resolving
  // real heights, markdown reflow, images and code blocks arriving, and the
  // window being resized while a reply is in flight.
  useEffect(() => {
    const node = viewportRef.current
    if (!node) return
    watchEnd()
    if (typeof ResizeObserver === 'undefined') return
    // Scroll from a frame rather than from the callback, so writing
    // scrollTop can never re-enter the observer within its own delivery.
    const observer = new ResizeObserver(() => settle())
    observer.observe(node)
    const content = contentRef.current
    if (content) observer.observe(content)
    return () => observer.disconnect()
  }, [sessionKey, settle, watchEnd])

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelFrame(frameRef.current)
      frameRef.current = null
      endObserverRef.current?.disconnect()
      endObserverRef.current = null
    },
    []
  )

  const onScroll = useCallback((): void => {
    const node = viewportRef.current
    if (!node) return
    followRef.current = onReaderScrolled(followRef.current, readMetrics(node))
    // Without a sentinel there is no later signal to re-arm from, so the
    // same event has to answer both halves of the question.
    if (!endObserverRef.current) followRef.current = onBottomVisibility(followRef.current, atBottom(node))
    sync(node)
  }, [atBottom, sync])

  /** An explicit request, so this is the one place a scroll may animate.
   *  Live generation stays on instant follow — a smooth scroll per token
   *  would queue animations behind each other and stutter. */
  const jumpToLatest = useCallback((): void => {
    const node = viewportRef.current
    if (!node) return
    followRef.current = { following: true, lastTop: node.scrollTop, lastBottom: bottomOffset(readMetrics(node)) }
    publishJump(false)

    if (prefersReducedMotion() || typeof node.scrollTo !== 'function') {
      pinNow(node)
      sync(node)
      return
    }

    // The transcript can grow mid-animation, which would leave a smooth
    // scroll short of a bottom that moved after it was aimed. Finish the
    // job when the animation actually ends rather than after a guessed delay.
    if ('onscrollend' in node) {
      node.addEventListener(
        'scrollend',
        () => {
          if (followRef.current.following) settle()
        },
        { once: true }
      )
    }
    node.scrollTo({ top: bottomOffset(readMetrics(node)), behavior: 'smooth' })
    if (!('onscrollend' in node)) settle()
  }, [pinNow, publishJump, settle, sync])

  return { viewportRef, contentRef, bottomRef, showJumpToLatest, onScroll, jumpToLatest }
}

function readMetrics(node: HTMLElement): ScrollMetrics {
  return { scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight }
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function requestFrame(callback: () => void): number {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    return window.requestAnimationFrame(callback)
  }
  return setTimeout(callback, 16) as unknown as number
}

function cancelFrame(handle: number): void {
  if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(handle)
    return
  }
  clearTimeout(handle)
}
