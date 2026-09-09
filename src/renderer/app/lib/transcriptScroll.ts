/** The transcript's scroll policy, expressed as pure functions.
 *
 *  Everything here is deliberately free of DOM handles so the interesting
 *  question — "should the transcript still be following the newest content?"
 *  — can be tested directly. jsdom performs no layout, so a component test
 *  can never prove this by scrolling a real element; it can only prove that
 *  the component asks these functions and obeys them.
 *
 *  The policy takes its two inputs from deliberately different places, and
 *  the split is the whole design:
 *
 *  - *Has the reader moved up?* comes from the scroll offsets, which are exact
 *    and available synchronously. Auto-follow has to be released in the same
 *    tick the reader starts scrolling, or they get yanked back.
 *  - *Is the end of the transcript in view?* comes from an IntersectionObserver
 *    watching a sentinel at the end of the content. That answer arrives a
 *    frame later, which is fine for re-arming, and unlike a `scrollHeight`
 *    sample it is never read halfway through `content-visibility` resolving
 *    heights — the reading that made an earlier version of this flicker. */

export interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** Whether the transcript is pinned to the newest content, and the geometry
 *  the decision was last made against. Both offsets are remembered because
 *  a falling `scrollTop` alone is ambiguous: the reader may have dragged the
 *  viewport up the content, or the content may have shrunk out from under a
 *  viewport the browser then had to clamp. Comparing how far each moved
 *  separates the two. */
export interface FollowState {
  following: boolean
  lastTop: number
  lastBottom: number
}

/** Floor and ceiling for the near-bottom band. A fixed pixel count is wrong
 *  in both directions: 8px is unreachable by a trackpad flick, and 400px on
 *  a short window would call half the viewport "the bottom". */
export const MIN_NEAR_BOTTOM = 72
export const MAX_NEAR_BOTTOM = 160
const NEAR_BOTTOM_RATIO = 0.12

/** A scroll offset moves by sub-pixel amounts on a HiDPI trackpad and after
 *  a fractional layout; anything under a pixel is not a reader scrolling. */
const MOTION_EPSILON = 1

export function initialFollowState(): FollowState {
  return { following: true, lastTop: 0, lastBottom: 0 }
}

/** Roughly one short paragraph of slack, scaled to the window. Used as the
 *  sentinel observer's bottom margin, so "at the bottom" means "the end of
 *  the transcript is within this band of the viewport". */
export function nearBottomTolerance(clientHeight: number): number {
  const scaled = clientHeight * NEAR_BOTTOM_RATIO
  return Math.min(MAX_NEAR_BOTTOM, Math.max(MIN_NEAR_BOTTOM, scaled))
}

/** How much content sits below the fold. Never negative: over-scroll and
 *  fractional layout can push the sum past the scroll height. */
export function distanceFromBottom(metrics: ScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight)
}

/** The offset that puts the newest content on the bottom edge. */
export function bottomOffset(metrics: ScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight)
}

/** The same question the sentinel answers, asked of raw geometry instead.
 *  Only for runtimes with no IntersectionObserver — it is a synchronous
 *  sample, and a synchronous sample can catch layout mid-change. */
export function isNearBottom(metrics: ScrollMetrics, tolerance = nearBottomTolerance(metrics.clientHeight)): boolean {
  return distanceFromBottom(metrics) <= tolerance
}

/** The viewport's offset changed. Auto-follow is released only when the
 *  reader themselves moved up the content — never on downward movement, and
 *  never on the transcript changing shape.
 *
 *  Three things move a scroll offset, and only the first is the reader:
 *
 *  - they drag upward: `scrollTop` falls, the bottom stays where it was.
 *  - the transcript grows below them: `scrollTop` does not move at all, so
 *    this never even reaches here — which is what keeps a streaming reply
 *    from cancelling its own auto-follow on the first token.
 *  - the transcript *shrinks* while pinned to the bottom — a pending row
 *    giving way to a shorter settled one, activity collapsing at the end of
 *    a run — and the browser clamps `scrollTop` down to the new maximum.
 *    Both offsets fall together.
 *
 *  So the test is not "did `scrollTop` fall" but "did it fall further than
 *  the bottom did". Reading the third case as the reader stepping away is
 *  what silently disarmed following at the end of every run.
 *
 *  Releasing on a small upward nudge is safe because the sentinel re-arms it
 *  immediately if the reader never actually left the band. */
export function onReaderScrolled(previous: FollowState, metrics: ScrollMetrics): FollowState {
  const bottom = bottomOffset(metrics)
  const topDelta = metrics.scrollTop - previous.lastTop
  const bottomDelta = bottom - previous.lastBottom
  const readerMovedUp = topDelta < -MOTION_EPSILON && topDelta < bottomDelta - MOTION_EPSILON
  return { following: readerMovedUp ? false : previous.following, lastTop: metrics.scrollTop, lastBottom: bottom }
}

/** The end of the transcript came into (or left) the near-bottom band.
 *  Arriving at the end always re-arms following, so a reader who scrolls
 *  back down is picked up again without having to find a button. Leaving it
 *  never releases following on its own — only the reader's own scrolling
 *  does, above. */
export function onBottomVisibility(previous: FollowState, atBottom: boolean): FollowState {
  return atBottom ? { ...previous, following: true } : previous
}

/** The jump-to-latest affordance is offered exactly when auto-follow is off
 *  and the end of the transcript is genuinely out of view. */
export function shouldShowJumpToLatest(state: FollowState, atBottom: boolean): boolean {
  return !state.following && !atBottom
}
