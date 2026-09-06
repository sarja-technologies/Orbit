import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findRecentConversationId } from '../../src/main/runtime/providers/antigravity/nativeConversationHistory'

let tempDir = ''
let historyFile = ''

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

describe('findRecentConversationId', () => {
  it('returns the conversation id of the most recent matching entry for the workspace', () => {
    writeHistory([
      { display: 'first prompt, no id yet', timestamp: 1, workspace: '/tmp/ws-a' },
      { display: 'second prompt', timestamp: 2, workspace: '/tmp/ws-a', conversationId: 'abc-123' },
      { display: 'unrelated workspace', timestamp: 3, workspace: '/tmp/ws-b', conversationId: 'other-id' }
    ])
    expect(findRecentConversationId('/tmp/ws-a', historyFile)).toBe('abc-123')
  })

  it('returns null when no entry matches the workspace', () => {
    writeHistory([{ display: 'x', timestamp: 1, workspace: '/tmp/other', conversationId: 'nope' }])
    expect(findRecentConversationId('/tmp/ws-a', historyFile)).toBeNull()
  })

  it('returns null when the entry has no conversationId yet (first prompt of a conversation)', () => {
    writeHistory([{ display: 'first ever prompt', timestamp: 1, workspace: '/tmp/ws-a' }])
    expect(findRecentConversationId('/tmp/ws-a', historyFile)).toBeNull()
  })

  it('never throws when the history file does not exist', () => {
    expect(findRecentConversationId('/tmp/ws-a', path.join(tempDir, 'missing.jsonl'))).toBeNull()
  })

  it('never throws on a malformed history file', () => {
    fs.writeFileSync(historyFile, 'not json at all\n{"broken":\n')
    expect(findRecentConversationId('/tmp/ws-a', historyFile)).toBeNull()
  })

  it('picks the latest of several conversation ids for the same workspace', () => {
    writeHistory([
      { display: 'a', timestamp: 1, workspace: '/tmp/ws-a', conversationId: 'old-id' },
      { display: 'b', timestamp: 2, workspace: '/tmp/ws-a', conversationId: 'new-id' }
    ])
    expect(findRecentConversationId('/tmp/ws-a', historyFile)).toBe('new-id')
  })

  it('ignores a workspace entry whose conversationId is not a string', () => {
    writeHistory([{ display: 'weird', timestamp: 1, workspace: '/tmp/ws-a', conversationId: 42 }])
    expect(findRecentConversationId('/tmp/ws-a', historyFile)).toBeNull()
  })

  it('falls back to the real default path (~/.gemini/antigravity-cli/history.jsonl) when no override is given', () => {
    // Just verifies the no-argument call path never throws in this
    // environment, whatever the real file contains.
    expect(() => findRecentConversationId('/definitely/not/a/real/workspace')).not.toThrow()
  })
})
