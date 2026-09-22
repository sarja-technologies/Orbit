import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findRecentConversationId } from '../../src/main/runtime/providers/antigravity/nativeConversationHistory'

let tempDir = ''
let historyFile = ''

/** A fixed "now" so every entry's eligibility is explicit rather than
 *  dependent on how fast the test runs. */
const NOW = 1_790_000_000_000

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-agy-history-'))
  historyFile = path.join(tempDir, 'history.jsonl')
})

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function writeHistory(lines: Array<Record<string, unknown>>): void {
  fs.writeFileSync(historyFile, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
}

/** The calling session: this workspace, started at NOW, having sent these
 *  prompts. */
function lookup(prompts: string[], overrides: Partial<Parameters<typeof findRecentConversationId>[0]> = {}) {
  return findRecentConversationId({
    workspacePath: '/tmp/ws-a',
    notBeforeMs: NOW,
    prompts,
    historyFilePath: historyFile,
    ...overrides
  })
}

describe('finding this session’s native conversation id', () => {
  it('returns the id recorded against a prompt this session actually sent', () => {
    writeHistory([
      { display: 'first prompt, no id yet', timestamp: NOW + 1, workspace: '/tmp/ws-a' },
      { display: 'second prompt', timestamp: NOW + 2, workspace: '/tmp/ws-a', conversationId: 'abc-123' },
      { display: 'unrelated workspace', timestamp: NOW + 3, workspace: '/tmp/ws-b', conversationId: 'other-id' }
    ])
    expect(lookup(['first prompt, no id yet', 'second prompt'])).toBe('abc-123')
  })

  it('returns null when no entry matches the workspace', () => {
    writeHistory([{ display: 'x', timestamp: NOW + 1, workspace: '/tmp/other', conversationId: 'nope' }])
    expect(lookup(['x'])).toBeNull()
  })

  it('returns null when the entry has no conversationId yet (first prompt of a conversation)', () => {
    writeHistory([{ display: 'first ever prompt', timestamp: NOW + 1, workspace: '/tmp/ws-a' }])
    expect(lookup(['first ever prompt'])).toBeNull()
  })

  it('never throws when the history file does not exist', () => {
    expect(lookup(['x'], { historyFilePath: path.join(tempDir, 'missing.jsonl') })).toBeNull()
  })

  it('never throws on a malformed history file', () => {
    fs.writeFileSync(historyFile, 'not json at all\n{"broken":\n')
    expect(lookup(['x'])).toBeNull()
  })

  it('ignores an entry whose conversationId is not a string', () => {
    writeHistory([{ display: 'weird', timestamp: NOW + 1, workspace: '/tmp/ws-a', conversationId: 42 }])
    expect(lookup(['weird'])).toBeNull()
  })

  it('falls back to the real default path when no override is given', () => {
    // Just verifies the no-override call path never throws in this
    // environment, whatever the real file contains.
    expect(() =>
      findRecentConversationId({ workspacePath: '/definitely/not/a/real/workspace', notBeforeMs: NOW, prompts: ['x'] })
    ).not.toThrow()
  })
})

describe('never claiming another session’s conversation', () => {
  it('does not take the id of an earlier session that used the same folder', () => {
    // THE CROSS-WIRING BUG. Every session in an Orbit project shares that
    // project's folder. Session A ran here and has an id; session B has
    // just sent its first prompt, which agy logs without one. Answering
    // "the most recent id for this workspace" handed B session A's
    // conversation, and B would then resume into a history the user never
    // put there.
    writeHistory([
      { display: 'A first', timestamp: NOW - 10_000, workspace: '/tmp/ws-a' },
      { display: 'A second', timestamp: NOW - 9_000, workspace: '/tmp/ws-a', conversationId: 'session-a-id' },
      { display: 'B first', timestamp: NOW + 1, workspace: '/tmp/ws-a' }
    ])
    expect(lookup(['B first'])).toBeNull()
  })

  it('ignores an entry from the same folder that this session never sent', () => {
    // A concurrent session in the same folder, whose prompt was logged
    // inside this session's own time window.
    writeHistory([
      { display: 'mine', timestamp: NOW + 1, workspace: '/tmp/ws-a' },
      { display: 'theirs', timestamp: NOW + 2, workspace: '/tmp/ws-a', conversationId: 'their-id' }
    ])
    expect(lookup(['mine'])).toBeNull()
  })

  it('ignores an entry logged before this session began', () => {
    writeHistory([{ display: 'reused prompt', timestamp: NOW - 60_000, workspace: '/tmp/ws-a', conversationId: 'old-id' }])
    expect(lookup(['reused prompt'])).toBeNull()
  })

  it('declines to answer at all when two ids both carry this session’s prompts', () => {
    // The genuinely ambiguous case: two concurrent sessions in one folder
    // sending byte-identical prompts. Nothing in the file can tell them
    // apart, so nothing is returned — declining costs a resume, guessing
    // would hand the user someone else's conversation.
    writeHistory([
      { display: 'same text', timestamp: NOW + 1, workspace: '/tmp/ws-a', conversationId: 'id-one' },
      { display: 'same text', timestamp: NOW + 2, workspace: '/tmp/ws-a', conversationId: 'id-two' }
    ])
    expect(lookup(['same text'])).toBeNull()
  })

  it('still answers when this session’s own prompts all carry one id', () => {
    // The ordinary multi-turn case must not be mistaken for ambiguity.
    writeHistory([
      { display: 'turn one', timestamp: NOW + 1, workspace: '/tmp/ws-a', conversationId: 'mine' },
      { display: 'turn two', timestamp: NOW + 2, workspace: '/tmp/ws-a', conversationId: 'mine' }
    ])
    expect(lookup(['turn one', 'turn two'])).toBe('mine')
  })

  it('returns nothing when the session has delivered no prompts at all', () => {
    writeHistory([{ display: 'anything', timestamp: NOW + 1, workspace: '/tmp/ws-a', conversationId: 'some-id' }])
    expect(lookup([])).toBeNull()
  })

  it('tolerates a small clock skew between agy’s timestamp and Orbit’s', () => {
    writeHistory([{ display: 'mine', timestamp: NOW - 2_000, workspace: '/tmp/ws-a', conversationId: 'mine-id' }])
    expect(lookup(['mine'])).toBe('mine-id')
  })

  it('matches a multi-line prompt verbatim, newlines and all', () => {
    // `display` holds the prompt verbatim — confirmed against a real
    // history file — which is what makes matching on it sound.
    const prompt = 'Create a file containing:\n\nHello from Orbit.'
    writeHistory([{ display: prompt, timestamp: NOW + 1, workspace: '/tmp/ws-a', conversationId: 'multiline-id' }])
    expect(lookup([prompt])).toBe('multiline-id')
  })
})
