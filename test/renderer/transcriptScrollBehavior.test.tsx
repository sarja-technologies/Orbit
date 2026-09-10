// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkSession } from '../../src/renderer/app/components/WorkSession'
import type { Conversation, Message, Project } from '../../src/shared/domain'
import { ORBIT_DEFAULT_MODEL_ID } from '../../src/shared/defaultModel'

/** jsdom performs no layout: every element reports a scrollHeight of 0 and
 *  silently swallows scrollTop. These tests are therefore about the policy —
 *  when the transcript decides to re-pin, and when it refuses to — over a
 *  scroller whose geometry the test controls. The geometry is deliberately
 *  made to change *after* mount, because that is the real bug: the height a
 *  transcript reports before it has settled is not the height it ends up
 *  with. */
interface FakeLayout {
  set: (next: { scrollHeight?: number; clientHeight?: number }) => void
  metrics: () => { top: number; below: number; client: number }
  scrollTop: () => number
  scrollTo: ReturnType<typeof vi.fn>
}

function fakeLayout(node: HTMLElement, initial: { scrollHeight: number; clientHeight: number }): FakeLayout {
  let scrollHeight = initial.scrollHeight
  let clientHeight = initial.clientHeight
  let scrollTop = 0
  const scrollTo = vi.fn((options: ScrollToOptions) => {
    scrollTop = clamp(options.top ?? scrollTop)
  })

  function clamp(value: number): number {
    return Math.max(0, Math.min(value, Math.max(0, scrollHeight - clientHeight)))
  }

  Object.defineProperty(node, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  Object.defineProperty(node, 'clientHeight', { configurable: true, get: () => clientHeight })
  Object.defineProperty(node, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = clamp(value)
    }
  })
  Object.defineProperty(node, 'scrollTo', { configurable: true, writable: true, value: scrollTo })

  const layout: FakeLayout = {
    set: (next) => {
      if (next.scrollHeight !== undefined) scrollHeight = next.scrollHeight
      if (next.clientHeight !== undefined) clientHeight = next.clientHeight
    },
    metrics: () => ({ top: scrollTop, below: Math.max(0, scrollHeight - scrollTop - clientHeight), client: clientHeight }),
    scrollTop: () => scrollTop,
    scrollTo
  }
  currentLayout = layout
  return layout
}

/** Drives the scroller from outside, the way a real reader would: set the
 *  offset, then let the element tell React about it. */
function scrollTo(node: HTMLElement, top: number): void {
  node.scrollTop = top
  fireEvent.scroll(node)
  // The sentinel observer reports a frame later, exactly as in a browser.
  act(() => notifyEnd())
}

let frames: Array<() => void> = []
let resizeCallbacks: Array<() => void> = []
/** The live sentinel observers, with the band each was built with. */
let endObservers: Array<{ callback: (entries: Array<{ isIntersecting: boolean }>) => void; tolerance: number; live: boolean }> = []
/** Set by the harness whenever geometry changes, so the sentinel reports
 *  the same thing a real IntersectionObserver would: is the end of the
 *  content within `tolerance` of the viewport's bottom edge? */
let currentLayout: FakeLayout | null = null

function notifyEnd(): void {
  if (!currentLayout) return
  const { below } = currentLayout.metrics()
  for (const observer of endObservers) {
    if (!observer.live) continue
    observer.callback([{ isIntersecting: below <= observer.tolerance }])
  }
}

/** Runs the queued animation frames, including any a frame itself queues —
 *  a settling transcript legitimately needs more than one pass. */
function flushFrames(): void {
  act(() => {
    for (let pass = 0; pass < 10 && frames.length > 0; pass++) {
      const due = frames
      frames = []
      for (const frame of due) frame()
      notifyEnd()
    }
  })
}

/** Layout changed under the transcript: exactly what a ResizeObserver
 *  reports when content-visibility resolves a real height, markdown
 *  reflows, or a code block arrives. */
function settleLayout(layout: FakeLayout, scrollHeight: number): void {
  layout.set({ scrollHeight })
  act(() => {
    for (const callback of resizeCallbacks) callback()
    notifyEnd()
  })
  flushFrames()
}

beforeEach(() => {
  frames = []
  resizeCallbacks = []
  endObservers = []
  currentLayout = null
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      private readonly entry: (typeof endObservers)[number]
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void, options: { rootMargin?: string }) {
        const margin = Number.parseInt(options.rootMargin?.split(' ')[2] ?? '0', 10)
        this.entry = { callback, tolerance: margin, live: false }
        endObservers.push(this.entry)
      }
      observe(): void {
        this.entry.live = true
      }
      unobserve(): void {}
      disconnect(): void {
        this.entry.live = false
      }
    }
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resizeCallbacks.push(callback)
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  )
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(() => callback(0))
    return frames.length
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function reducedMotion(reduce: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: reduce && query.includes('reduce'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))
  )
}

const project: Project = {
  id: 'p',
  name: 'Orbit',
  rootPath: '/tmp/orbit',
  createdAt: '2026-09-08T10:00:00.000Z',
  updatedAt: '2026-09-08T10:00:00.000Z'
}

function conversation(id: string): Conversation {
  return {
    id,
    projectId: 'p',
    title: `Session ${id}`,
    providerId: 'antigravity',
    nativeConversationId: null,
    status: 'idle',
    transport: 'pty',
    model: ORBIT_DEFAULT_MODEL_ID,
    permissionMode: 'ask' as const,
    reasoningEffort: null,
    workingDirectory: null,
    createdAt: '2026-09-08T10:00:00.000Z',
    updatedAt: '2026-09-08T10:00:00.000Z'
  }
}

function history(count: number, conversationId = 'c1'): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${conversationId}-m${index}`,
    projectId: 'p',
    conversationId,
    runId: null,
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `Turn ${index}`,
    status: 'completed' as const,
    sequence: index,
    createdAt: '2026-09-08T10:00:00.000Z',
    updatedAt: '2026-09-08T10:00:00.000Z'
  }))
}

type Props = Parameters<typeof WorkSession>[0]

function props(overrides: Partial<Props> = {}): Props {
  return {
    project,
    conversation: conversation('c1'),
    messages: [],
    runs: [],
    projectFiles: [],
    thumbnails: {},
    activeRunId: null,
    streamText: '',
    activityByRun: {},
    identity: { provider: 'gemini' as const, name: '3.8 Flash' },
    stopping: false,
    pendingInteraction: null,
    unavailableInteraction: null,
    staleInteraction: false,
    respondingInteractionId: null,
    resolvedRecords: [],
    onRespond: vi.fn(),
    ...overrides
  }
}

/** Mounts a session and hands back the scroller with controllable geometry,
 *  already settled at whatever height the first layout reported. */
function openSession(overrides: Partial<Props> = {}, initialHeight = 1000) {
  const view = render(<WorkSession {...props(overrides)} />)
  const node = view.container.querySelector('.transcript') as HTMLElement
  const layout = fakeLayout(node, { scrollHeight: initialHeight, clientHeight: 800 })
  return { ...view, node, layout }
}

describe('transcript scrolling', () => {
  it('lands at the bottom after layout settles, not at the height it first reported', () => {
    // The original bug: one scrollTop write against a transcript whose
    // turns were still 160px content-visibility placeholders left the
    // viewport hundreds of pixels above the newest message.
    const { node, layout } = openSession({ messages: history(40) })
    settleLayout(layout, 1000)
    expect(node.scrollTop).toBe(200)

    settleLayout(layout, 9000)
    expect(node.scrollTop).toBe(8200)

    // And keeps converging: content-visibility resolves heights in waves.
    settleLayout(layout, 14000)
    expect(node.scrollTop).toBe(13200)
  })

  it('offers no jump control on an empty session, and does not crash without a conversation', () => {
    const { container, layout } = openSession({ messages: [] })
    settleLayout(layout, 400)

    expect(container.querySelector('.jump-latest')).toBeNull()

    const empty = render(<WorkSession {...props({ conversation: null })} />)
    expect(empty.container.querySelector('.transcript')).toBeNull()
    expect(screen.getByText('Create a session to start working.')).toBeInTheDocument()
  })

  it('follows a streaming reply while the reader is at the bottom', () => {
    const { node, layout, rerender } = openSession({ messages: history(4), activeRunId: 'r' })
    settleLayout(layout, 4000)
    expect(node.scrollTop).toBe(3200)

    layout.set({ scrollHeight: 4600 })
    rerender(<WorkSession {...props({ messages: history(4), activeRunId: 'r', streamText: 'Reading the diff' })} />)
    flushFrames()

    expect(node.scrollTop).toBe(3800)
  })

  it('stops following the moment the reader scrolls up, and offers the way back', () => {
    const { node, layout, rerender, container } = openSession({ messages: history(20), activeRunId: 'r' })
    settleLayout(layout, 8000)
    expect(node.scrollTop).toBe(7200)

    scrollTo(node, 2000)
    expect(container.querySelector('.jump-latest')).not.toBeNull()

    // The reply keeps growing. The viewport must not move.
    layout.set({ scrollHeight: 9500 })
    rerender(<WorkSession {...props({ messages: history(20), activeRunId: 'r', streamText: 'A very long answer' })} />)
    flushFrames()
    settleLayout(layout, 11000)

    expect(node.scrollTop).toBe(2000)
  })

  it('picks the reader back up when they scroll to the bottom by hand', () => {
    const { node, layout, container, rerender } = openSession({ messages: history(20), activeRunId: 'r' })
    settleLayout(layout, 8000)
    scrollTo(node, 2000)
    expect(container.querySelector('.jump-latest')).not.toBeNull()

    // Within the tolerance band, not on the exact pixel.
    scrollTo(node, 7160)
    expect(container.querySelector('.jump-latest')).toBeNull()

    layout.set({ scrollHeight: 8600 })
    rerender(<WorkSession {...props({ messages: history(20), activeRunId: 'r', streamText: 'more' })} />)
    flushFrames()
    expect(node.scrollTop).toBe(7800)
  })

  it('returns to the newest content and resumes following when jump-to-latest is clicked', () => {
    reducedMotion(false)
    const { node, layout, container, rerender } = openSession({ messages: history(20), activeRunId: 'r' })
    settleLayout(layout, 8000)
    scrollTo(node, 1000)

    const jump = container.querySelector('.jump-latest') as HTMLButtonElement
    act(() => {
      jump.click()
    })
    flushFrames()

    // An explicit request is the one place an animation is appropriate.
    expect(layout.scrollTo).toHaveBeenCalledWith({ top: 7200, behavior: 'smooth' })
    expect(node.scrollTop).toBe(7200)
    expect(container.querySelector('.jump-latest')).toBeNull()

    layout.set({ scrollHeight: 8600 })
    rerender(<WorkSession {...props({ messages: history(20), activeRunId: 'r', streamText: 'more' })} />)
    flushFrames()
    expect(node.scrollTop).toBe(7800)
  })

  it('jumps instantly rather than animating when the reader asked for reduced motion', () => {
    reducedMotion(true)
    const { node, layout, container } = openSession({ messages: history(20), activeRunId: 'r' })
    settleLayout(layout, 8000)
    scrollTo(node, 1000)

    act(() => {
      ;(container.querySelector('.jump-latest') as HTMLButtonElement).click()
    })

    expect(layout.scrollTo).not.toHaveBeenCalled()
    expect(node.scrollTop).toBe(7200)
  })

  it('treats a different session as a fresh navigation, even at an identical message count', () => {
    // The old effect keyed on `messages.length`, so switching between two
    // sessions of the same length re-scrolled nothing at all — and the
    // previous session's "reader is scrolled up" state came along with it.
    const { node, layout, rerender } = openSession({ messages: history(20, 'c1') })
    settleLayout(layout, 8000)
    scrollTo(node, 500)
    expect(node.scrollTop).toBe(500)

    rerender(<WorkSession {...props({ conversation: conversation('c2'), messages: history(20, 'c2') })} />)
    flushFrames()

    expect(node.scrollTop).toBe(7200)
  })

  it('keeps the newest turn visible when the window is resized during a reply', () => {
    const { node, layout } = openSession({ messages: history(20), activeRunId: 'r' })
    settleLayout(layout, 8000)
    expect(node.scrollTop).toBe(7200)

    // A shorter window: same content, a bottom that moved.
    layout.set({ clientHeight: 500 })
    act(() => {
      for (const callback of resizeCallbacks) callback()
    })
    flushFrames()

    expect(node.scrollTop).toBe(7500)
  })

  it('does not tear down the settled history when the jump control appears', () => {
    // Showing the control is state, and state re-renders WorkSession. The
    // history above must survive that as the same elements rather than
    // being rebuilt underneath the reader.
    const { node, layout, container } = openSession({ messages: history(30) })
    settleLayout(layout, 8000)
    const turns = Array.from(container.querySelectorAll('.turn'))

    scrollTo(node, 1000)
    expect(container.querySelector('.jump-latest')).not.toBeNull()
    expect(Array.from(container.querySelectorAll('.turn'))).toEqual(turns)
  })

  it('keeps following when a finishing turn shrinks the transcript under a pinned viewport', () => {
    // Caught in a real Electron run, not in jsdom: at the end of a reply the
    // pending row gives way to a shorter settled one, the transcript loses
    // height, and the browser clamps scrollTop down to the new maximum. That
    // clamp is not the reader scrolling up — but reading it as one disarmed
    // auto-follow after every single turn.
    const { node, layout, container, rerender } = openSession({ messages: history(20), activeRunId: 'r' })
    settleLayout(layout, 8000)
    expect(node.scrollTop).toBe(7200)

    // The browser's clamp, and the scroll event it produces.
    layout.set({ scrollHeight: 7900 })
    node.scrollTop = 7100
    fireEvent.scroll(node)
    act(() => notifyEnd())

    expect(container.querySelector('.jump-latest')).toBeNull()

    // Still following: the next thing to arrive is tracked.
    layout.set({ scrollHeight: 8600 })
    rerender(<WorkSession {...props({ messages: history(21), activeRunId: null })} />)
    flushFrames()
    expect(node.scrollTop).toBe(7800)
  })

  it('does not release following for a nudge that stays inside the bottom band', () => {
    // Releasing on any upward movement is safe precisely because the
    // sentinel puts it straight back when the reader never actually left.
    const { node, layout, container, rerender } = openSession({ messages: history(20), activeRunId: 'r' })
    settleLayout(layout, 8000)

    scrollTo(node, 7200 - 30)
    expect(container.querySelector('.jump-latest')).toBeNull()

    layout.set({ scrollHeight: 8600 })
    rerender(<WorkSession {...props({ messages: history(20), activeRunId: 'r', streamText: 'more' })} />)
    flushFrames()
    expect(node.scrollTop).toBe(7800)
  })

  it('falls back to geometry when the runtime has no IntersectionObserver', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const { node, layout, container, rerender } = openSession({ messages: history(20), activeRunId: 'r' })
    settleLayout(layout, 8000)
    expect(node.scrollTop).toBe(7200)

    scrollTo(node, 2000)
    expect(container.querySelector('.jump-latest')).not.toBeNull()

    layout.set({ scrollHeight: 9000 })
    rerender(<WorkSession {...props({ messages: history(20), activeRunId: 'r', streamText: 'more' })} />)
    flushFrames()
    expect(node.scrollTop).toBe(2000)

    // And the same event still re-arms on the way back down.
    scrollTo(node, 8160)
    expect(container.querySelector('.jump-latest')).toBeNull()
  })

  it('coalesces a burst of layout changes into one scroll write per frame', () => {
    // Streaming changes the transcript's height far more often than it is
    // painted. Re-pinning per change would be pure wasted layout, and is
    // what the recent streaming work exists to avoid.
    const { node, layout } = openSession({ messages: history(20), activeRunId: 'r' })
    settleLayout(layout, 8000)

    const before = (window.requestAnimationFrame as ReturnType<typeof vi.fn>).mock.calls.length
    act(() => {
      for (let step = 1; step <= 12; step++) {
        layout.set({ scrollHeight: 8000 + step * 40 })
        for (const callback of resizeCallbacks) callback()
      }
    })
    expect((window.requestAnimationFrame as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before + 1)

    // And the one write that does happen lands on the final height.
    flushFrames()
    expect(node.scrollTop).toBe(7680)
  })
})
