import { describe, expect, it } from 'vitest'
import {
  MAX_NEAR_BOTTOM,
  MIN_NEAR_BOTTOM,
  bottomOffset,
  distanceFromBottom,
  initialFollowState,
  isNearBottom,
  nearBottomTolerance,
  onBottomVisibility,
  onReaderScrolled,
  shouldShowJumpToLatest,
  type FollowState,
  type ScrollMetrics
} from '../../src/renderer/app/lib/transcriptScroll'

/** A viewport 800px tall — tolerance 96px — scrolled so that `below` pixels
 *  of transcript sit under the fold. */
function view(below: number, options: { clientHeight?: number; scrollTop?: number } = {}): ScrollMetrics {
  const clientHeight = options.clientHeight ?? 800
  const scrollTop = options.scrollTop ?? 4000
  return { clientHeight, scrollTop, scrollHeight: scrollTop + clientHeight + below }
}

describe('nearBottomTolerance', () => {
  it('scales with the window instead of hard-coding a pixel count', () => {
    expect(nearBottomTolerance(1000)).toBe(120)
  })

  it('never shrinks below a reachable band on a short window', () => {
    expect(nearBottomTolerance(200)).toBe(MIN_NEAR_BOTTOM)
    expect(nearBottomTolerance(0)).toBe(MIN_NEAR_BOTTOM)
  })

  it('never grows into calling a chunk of a tall window "the bottom"', () => {
    expect(nearBottomTolerance(4000)).toBe(MAX_NEAR_BOTTOM)
  })
})

describe('distanceFromBottom', () => {
  it('measures the content below the fold', () => {
    expect(distanceFromBottom(view(250))).toBe(250)
  })

  it('reports zero rather than a negative during over-scroll', () => {
    expect(distanceFromBottom({ scrollTop: 120, scrollHeight: 500, clientHeight: 400 })).toBe(0)
  })
})

describe('isNearBottom', () => {
  it('does not require exact pixel equality', () => {
    expect(isNearBottom(view(0))).toBe(true)
    expect(isNearBottom(view(40))).toBe(true)
    expect(isNearBottom(view(96))).toBe(true)
  })

  it('stops counting once the reader is a screenful up', () => {
    expect(isNearBottom(view(97))).toBe(false)
    expect(isNearBottom(view(2000))).toBe(false)
  })

  it('treats a transcript shorter than its viewport as at the bottom', () => {
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 800 })).toBe(true)
  })
})

describe('bottomOffset', () => {
  it('is the offset that puts the newest content on the bottom edge', () => {
    expect(bottomOffset({ scrollTop: 0, scrollHeight: 5000, clientHeight: 800 })).toBe(4200)
  })

  it('is zero when nothing overflows', () => {
    expect(bottomOffset({ scrollTop: 0, scrollHeight: 300, clientHeight: 800 })).toBe(0)
  })
})

describe('onReaderScrolled', () => {
  /** A follow state parked exactly on the bottom of a 5000px transcript in
   *  an 800px viewport: scroll offset 4200, which is also the bottom. */
  const pinned = { following: true, lastTop: 4200, lastBottom: 4200 }

  it('starts following', () => {
    expect(initialFollowState().following).toBe(true)
  })

  it('releases following when the reader drags the viewport up the content', () => {
    // The bottom has not moved; only the reader has.
    const state = onReaderScrolled(pinned, { scrollTop: 2800, scrollHeight: 5000, clientHeight: 800 })
    expect(state.following).toBe(false)
    expect(state.lastTop).toBe(2800)
  })

  it('keeps following when the reader scrolls further down', () => {
    expect(onReaderScrolled({ following: true, lastTop: 3000, lastBottom: 4200 }, { scrollTop: 3600, scrollHeight: 5000, clientHeight: 800 }).following).toBe(true)
  })

  it('ignores sub-pixel drift as an upward scroll', () => {
    expect(onReaderScrolled(pinned, { scrollTop: 4199.4, scrollHeight: 5000, clientHeight: 800 }).following).toBe(true)
  })

  it('keeps following when the transcript shrinks and the browser clamps the offset', () => {
    // The regression this exists to prevent, and the one that survived into
    // a real Electron run: at the end of a turn the pending row gives way to
    // a shorter settled one, the transcript loses 60px, and the browser
    // pulls scrollTop down with it. The reader did not move — and reading
    // this as "they stepped away" silently disarmed following after every
    // single reply.
    const shrunk = { scrollTop: 4140, scrollHeight: 4940, clientHeight: 800 }
    expect(onReaderScrolled(pinned, shrunk).following).toBe(true)
    expect(onReaderScrolled(pinned, shrunk).lastBottom).toBe(4140)
  })

  it('still releases when the reader drags up during a turn that is also shrinking', () => {
    const both = { scrollTop: 2800, scrollHeight: 4940, clientHeight: 800 }
    expect(onReaderScrolled(pinned, both).following).toBe(false)
  })

  it('leaves an already-released state released', () => {
    const away = { following: false, lastTop: 1200, lastBottom: 4200 }
    expect(onReaderScrolled(away, { scrollTop: 1800, scrollHeight: 5000, clientHeight: 800 }).following).toBe(false)
  })
})

describe('onBottomVisibility', () => {
  it('re-arms following when the end of the transcript comes into view', () => {
    // How a reader who scrolls back down by hand gets picked up again
    // without having to find the button.
    expect(onBottomVisibility({ following: false, lastTop: 1200, lastBottom: 4200 }, true).following).toBe(true)
  })

  it('never releases following on its own', () => {
    // Only the reader's own upward scrolling does that. The end of a
    // streaming reply leaves the band constantly as text arrives, and that
    // must not be read as the reader stepping away.
    expect(onBottomVisibility({ following: true, lastTop: 4200, lastBottom: 4200 }, false).following).toBe(true)
    expect(onBottomVisibility({ following: false, lastTop: 1200, lastBottom: 4200 }, false).following).toBe(false)
  })

  it('does not disturb the geometry the scroll handler is tracking', () => {
    const state = onBottomVisibility({ following: false, lastTop: 1200, lastBottom: 4200 }, true)
    expect(state.lastTop).toBe(1200)
    expect(state.lastBottom).toBe(4200)
  })
})

describe('a small nudge up inside the band', () => {
  it('is released by the scroll and re-armed by the sentinel, so it settles as still following', () => {
    // A 30px flick while parked at the bottom is not "take me out of the
    // conversation". The scroll releases first because it must be
    // instantaneous; the sentinel, still intersecting, puts it back.
    let state: FollowState = { following: true, lastTop: 4200, lastBottom: 4200 }
    state = onReaderScrolled(state, { scrollTop: 4170, scrollHeight: 5000, clientHeight: 800 })
    expect(state.following).toBe(false)

    state = onBottomVisibility(state, true)
    expect(state.following).toBe(true)
  })

  it('stays released when the nudge actually leaves the band', () => {
    let state: FollowState = { following: true, lastTop: 4200, lastBottom: 4200 }
    state = onReaderScrolled(state, { scrollTop: 2400, scrollHeight: 5000, clientHeight: 800 })
    state = onBottomVisibility(state, false)
    expect(state.following).toBe(false)
  })
})

describe('shouldShowJumpToLatest', () => {
  it('offers the way back only when following is off and the end is out of view', () => {
    expect(shouldShowJumpToLatest({ following: false, lastTop: 1200, lastBottom: 4200 }, false)).toBe(true)
  })

  it('stays hidden while the transcript is following', () => {
    expect(shouldShowJumpToLatest({ following: true, lastTop: 4200, lastBottom: 4200 }, false)).toBe(false)
  })

  it('stays hidden when the end of the transcript is already in view', () => {
    expect(shouldShowJumpToLatest({ following: false, lastTop: 4200, lastBottom: 4200 }, true)).toBe(false)
  })
})
