// The "bump": a small rounded protrusion under an assistant bubble's
// bottom edge, appearing and disappearing with hover, focus and scrolling.
//
// It was the message Copy action, clipped. `.turn` carried
// `content-visibility: auto`, which implies PAINT containment, and paint
// containment clips descendants to the box. The Copy action is out of flow
// by design, hanging below its row into the gap between turns — so
// everything past the turn's bottom edge was cut away and only the top
// sliver of a 999px-rounded pill survived. `content-visibility: auto` also
// re-evaluates whether an element is relevant to the user as they move and
// scroll, which is where the intermittency came from.
//
// These assertions are against the stylesheet, because the geometry is CSS
// and jsdom applies none of it.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const STYLES = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/styles.css'), 'utf8')

function ruleFor(selector: string): string {
  const start = STYLES.indexOf(`${selector} {`)
  expect(start, `expected a rule for ${selector}`).toBeGreaterThan(-1)
  return STYLES.slice(start, STYLES.indexOf('}', start))
}

function token(name: string): number {
  const match = new RegExp(`${name}:\\s*(\\d+)px`).exec(ruleFor(':root'))
  expect(match, `expected a ${name} token`).not.toBeNull()
  return Number(match![1])
}

describe('nothing clips the out-of-flow message action', () => {
  it('does not paint-contain the turn', () => {
    const rule = ruleFor('.turn')

    // The bug, exactly: either of these clips anything hanging below the
    // turn's box, which is where the Copy action is designed to sit.
    expect(rule).not.toMatch(/content-visibility:\s*auto/)
    expect(rule).not.toMatch(/contain:[^;]*\bpaint\b/)
    expect(rule).not.toMatch(/overflow:\s*hidden/)
  })

  it('keeps the containment that does not clip', () => {
    // Layout and style containment still isolate a turn for a long
    // transcript; neither of them clips.
    expect(ruleFor('.turn')).toMatch(/contain:\s*layout style/)
  })

  it('no longer guesses a turn’s height', () => {
    // `contain-intrinsic-size` made every off-screen turn a placeholder
    // height until measured, which the transcript's scroll pinning had to
    // fight on every frame.
    expect(ruleFor('.turn')).not.toMatch(/contain-intrinsic-size/)
  })
})

describe('the action sits in the gap rather than in the bubble', () => {
  it('does not overlap the bubble’s bottom edge', () => {
    const rule = ruleFor('.message-actions')
    const margin = /margin-top:\s*(-?\d+)px/.exec(rule)

    expect(margin, 'expected a margin-top on .message-actions').not.toBeNull()
    // A negative pull is what made the pill read as growing out of the
    // bubble rather than sitting below it.
    expect(Number(margin![1])).toBeGreaterThanOrEqual(0)
  })

  it('has a gap between turns tall enough to hold it', () => {
    // The real geometric constraint: the action is ~21px tall, and the gap
    // it hangs into used to be 20px — so it could not fit without either
    // overlapping the bubble or colliding with the next turn.
    const gap = /gap:\s*var\(--space-(\d)\)/.exec(ruleFor('.transcript-inner'))
    expect(gap, 'expected a gap on .transcript-inner').not.toBeNull()

    const gapPx = token(`--space-${gap![1]}`)
    const offset = Number(/margin-top:\s*(-?\d+)px/.exec(ruleFor('.message-actions'))![1])
    const padding = Number(/padding:\s*(\d+)px/.exec(ruleFor('.message-action'))![1])
    // border + line-box of an 11px label, rounded up.
    const actionHeight = padding * 2 + 2 + 14

    expect(offset + actionHeight).toBeLessThanOrEqual(gapPx)
  })
})

describe('the action is revealed by the message, not the whole row', () => {
  it('triggers on the bubble rather than the full-width row', () => {
    // `.chat-row` spans the entire transcript width, so `.chat-row:hover`
    // fired with the pointer nowhere near a short bubble.
    expect(STYLES).not.toMatch(/^\.chat-row:hover \.message-actions/m)
    expect(STYLES).toContain('.chat-row:has(.chat-bubble:hover) .message-actions')
  })

  it('stays revealed while the pointer is on the action itself', () => {
    expect(STYLES).toContain('.chat-row:has(.message-actions:hover) .message-actions')
  })

  it('still reveals for a keyboard user', () => {
    expect(STYLES).toContain('.chat-row:focus-within .message-actions')
  })

  it('does not try to reveal the button from inside its hidden container', () => {
    // `opacity: 1` on the button could never beat `opacity: 0` on its own
    // parent — a dead rule that implied focus handling it did not do.
    expect(ruleFor('.message-action:focus-visible')).not.toMatch(/opacity/)
    expect(ruleFor('.message-action:focus-visible')).toMatch(/outline/)
  })
})

describe('the bubble itself draws nothing below its edge', () => {
  it('puts the streaming accent on the top edge only', () => {
    // The one pseudo-element on a bubble. `auto` for the bottom inset is
    // what keeps it off the bottom edge.
    expect(ruleFor('.chat-bubble-assistant.is-streaming::before')).toMatch(/inset:\s*-1px -1px auto/)
  })

  it('has no other pseudo-element anywhere on a chat bubble', () => {
    const pseudos = STYLES.match(/^\.chat-bubble[^\s,{]*::(before|after)/gm) ?? []
    expect(pseudos).toEqual(['.chat-bubble-assistant.is-streaming::before'])
  })
})
