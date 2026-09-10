import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readScreenActivity } from '../../src/main/terminal/TerminalActivityReader'

const here = path.dirname(fileURLToPath(import.meta.url))

/** The real captured PTY frames from a live agy 1.1.27 turn — the same
 *  fixture the streaming tests read. */
const CAPTURED = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/agyPtyStreamFrames.json'), 'utf8')) as {
  frames: Array<{ tMs: number; lines: string[] }>
}

const COMPOSE = ['─'.repeat(120), '>', '─'.repeat(120), '? for shortcuts']

describe('readScreenActivity', () => {
  it('reads agy’s own live status line off a real captured frame', () => {
    // Frame 0 of the live capture ends in "⣽  Verifying Requirements
    // Thoroughly..." — agy's own visible status for what it is doing.
    const first = CAPTURED.frames[0]!.lines
    expect(first.some((line) => /Verifying Requirements Thoroughly/.test(line))).toBe(true)
    expect(readScreenActivity(first)).toEqual({ label: 'Verifying Requirements Thoroughly', kind: 'status' })
  })

  it('treats a status agy is animating as one activity, not three', () => {
    const of = (text: string) => readScreenActivity(['> a prompt', `⣽  ${text}`, ...COMPOSE])
    expect(of('Working')).toEqual(of('Working.'))
    expect(of('Working...')).toEqual({ label: 'Working', kind: 'status' })
  })

  it('reads a concrete tool row when that is the last thing agy drew', () => {
    const lines = ['> a prompt', '⣽  Working...', '● Running npm run build', ...COMPOSE]
    expect(readScreenActivity(lines)).toEqual({ label: 'Running npm run build', kind: 'tool' })
  })

  it('reports the bottom-most row, never an older one further up', () => {
    // agy's display only grows downward, so the lowest row is the most
    // recent thing it drew — and the only one that can be called current.
    const lines = ['> a prompt', '● Running npm run build', '⣽  Writing the answer...', ...COMPOSE]
    expect(readScreenActivity(lines)).toEqual({ label: 'Writing the answer', kind: 'status' })
  })

  it('takes the lowest row, because agy’s display only grows downward', () => {
    const lines = ['> a prompt', '● Reading src/App.tsx', '● Running npm test', ...COMPOSE]
    expect(readScreenActivity(lines)?.label).toBe('Running npm test')
  })

  it('never reports the thought marker as live work', () => {
    // "▸ Thought for 11s" uses the same row shape as a tool row but
    // describes a phase that is already over — showing it would freeze the
    // activity line on it for the rest of the turn.
    expect(readScreenActivity(['> a prompt', '▸ Thought for 11s', ...COMPOSE])).toBeNull()
  })

  it('ignores the rotating tip agy hangs off its working indicator', () => {
    const lines = ['> a prompt', '└ Tip: Use /model to switch between available models.', ...COMPOSE]
    expect(readScreenActivity(lines)).toBeNull()
  })

  it('reports nothing at all when the screen says nothing', () => {
    // A settled screen carries no status row, and Orbit does not
    // reconstruct one from the answer text.
    expect(readScreenActivity(['> a prompt', '', 'Here is the answer.', ...COMPOSE])).toBeNull()
    expect(readScreenActivity([])).toBeNull()
  })

  it('ignores a bare spinner frame with no words after it', () => {
    expect(readScreenActivity(['> a prompt', '⣽ ', ...COMPOSE])).toBeNull()
  })

  it('never reads a status out of the scrolled-away top of a long screen', () => {
    // Only the live tail matters: a status row that has scrolled far up is
    // history, not what is happening now.
    const lines = ['⣽  Working...', ...Array.from({ length: 30 }, (_, i) => `line ${i}`), ...COMPOSE]
    expect(readScreenActivity(lines)).toBeNull()
  })
})
