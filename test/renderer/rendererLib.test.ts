import { describe, expect, it } from 'vitest'
import { applyActivity, currentActivityLine, elapsedLabel, emptyActivity, hasFailure, summarizeActivity } from '../../src/renderer/app/lib/activity'
import { durationLabel } from '../../src/renderer/app/lib/activity'
import { describeActivity, fallbackActivity, shortenPath } from '../../src/renderer/app/lib/activityCopy'
import { describeProviderProblem, describeRuntimeError } from '../../src/renderer/app/lib/errorCopy'
import { imageItemsFromClipboard, isNativeImage, projectedState, stateLabel, type DraftAttachment } from '../../src/renderer/app/lib/attachments'
import { parseInline, parseMarkdown } from '../../src/renderer/app/lib/markdown'
import { RuntimeEventBatcher } from '../../src/renderer/app/lib/runtimeEventBatcher'
import type { ToolActivityEvent } from '../../src/shared/runtime-events'
import { relativeTime } from '../../src/renderer/app/lib/relativeTime'
import type { RuntimeEvent } from '../../src/shared/runtime-events'

function activityEvent(label: string, status: ToolActivityEvent['status'], providerStepId?: string): ToolActivityEvent {
  return {
    type: 'tool.activity',
    projectId: 'p',
    conversationId: 'c',
    runId: 'r',
    providerId: 'antigravity',
    createdAt: new Date().toISOString(),
    label,
    status,
    ...(providerStepId ? { providerStepId } : {})
  }
}

describe('activity', () => {
  it('updates a step in place rather than appending duplicates', () => {
    let state = emptyActivity()
    state = applyActivity(state, activityEvent('Bash', 'running', '1'))
    state = applyActivity(state, activityEvent('Bash', 'completed', '1'))
    expect(state.items).toHaveLength(1)
    expect(state.items[0]!.status).toBe('completed')
  })

  it('tracks separate steps separately', () => {
    let state = emptyActivity()
    state = applyActivity(state, activityEvent('read_file', 'completed', '1'))
    state = applyActivity(state, activityEvent('write_file', 'running', '2'))
    expect(state.items).toHaveLength(2)
    expect(currentActivityLine(state)?.label).toBe('write_file')
  })

  it('summarizes a finished turn in plain language', () => {
    let state = emptyActivity()
    state = applyActivity(state, activityEvent('Bash', 'completed', '1'))
    state = applyActivity(state, activityEvent('Bash', 'completed', '2'))
    state = applyActivity(state, activityEvent('write_file', 'completed', '3'))
    expect(summarizeActivity(state)).toBe('Ran 2 commands, edited 1 file')
  })

  it('has no summary when nothing happened, so a plain answer stays clean', () => {
    expect(summarizeActivity(emptyActivity())).toBeNull()
  })

  it('reports a failed step', () => {
    const state = applyActivity(emptyActivity(), activityEvent('Bash', 'failed', '1'))
    expect(hasFailure(state)).toBe(true)
  })

  it('only shows elapsed time once silence would look like a hang', () => {
    expect(elapsedLabel(1000, 3000)).toBeNull()
    expect(elapsedLabel(1000, 9000)).toBe('8s')
    expect(elapsedLabel(1000, 100000)).toBe('1m 39s')
  })
})

describe('errorCopy', () => {
  it('turns a provider crash into reassuring, actionable copy and keeps the raw text', () => {
    const view = describeRuntimeError({ code: 'provider.exited', message: 'exit 139 SIGSEGV', retryable: false })
    expect(view.title).toContain('ended unexpectedly')
    expect(view.body).toContain('conversation is safe')
    expect(view.category).toBe('retryable')
    expect(view.details).toBe('exit 139 SIGSEGV')
  })

  it('classifies a missing provider as needing user action', () => {
    const view = describeRuntimeError({ code: 'provider.not_installed', message: 'agy not found', retryable: false })
    expect(view.category).toBe('user-action')
  })

  it('never leaves an unknown code without honest product copy', () => {
    const view = describeRuntimeError({ code: 'something.unexpected', message: 'boom', retryable: false })
    expect(view.title).toBe('Something went wrong')
    expect(view.details).toBe('boom')
  })

  it('shows no banner for a healthy provider', () => {
    expect(describeProviderProblem('ready', 'Antigravity · Ready')).toBeNull()
    expect(describeProviderProblem('starting', null)).toBeNull()
  })

  it('shows an actionable banner for install and sign-in problems', () => {
    expect(describeProviderProblem('unavailable', 'Antigravity is not installed.')?.action).toBe('Setup instructions')
    expect(describeProviderProblem('failed', 'please sign in first')?.action).toBe('Sign in')
  })
})

describe('attachments', () => {
  const file = (overrides: Partial<DraftAttachment> = {}): DraftAttachment => ({
    fileId: 'f1',
    name: 'shot.png',
    mimeType: 'image/png',
    byteSize: 2048,
    thumbnail: null,
    state: 'ready',
    error: null,
    ...overrides
  })

  it('treats real raster images as native-deliverable', () => {
    expect(isNativeImage(file())).toBe(true)
    expect(isNativeImage(file({ name: 'photo.jpg', mimeType: 'image/jpeg' }))).toBe(true)
  })

  it('excludes SVG and oversized images from native delivery', () => {
    expect(isNativeImage(file({ name: 'logo.svg', mimeType: 'image/svg+xml' }))).toBe(false)
    expect(isNativeImage(file({ byteSize: 20 * 1024 * 1024 }))).toBe(false)
  })

  it('projects a non-image attachment to reference mode', () => {
    expect(projectedState(file({ name: 'notes.txt', mimeType: 'text/plain' }), true)).toBe('reference')
  })

  it('projects an image to reference mode when this machine cannot deliver media', () => {
    expect(projectedState(file(), false)).toBe('reference')
    expect(projectedState(file(), true)).toBe('attaching')
  })

  it('keeps a failed attachment failed', () => {
    expect(projectedState(file({ state: 'failed' }), true)).toBe('failed')
  })

  it('regression: a ready image resolves to reference at rest when this machine cannot deliver media', () => {
    // The composer shows this outcome BEFORE sending. Previously reference
    // mode was only applied during send, where it was cleared within
    // milliseconds and the user never saw it.
    const ready = file({ state: 'ready' })
    expect(projectedState(ready, false)).toBe('reference')
    expect(stateLabel(projectedState(ready, false))).toBe('Shared as reference')
    // With native media available a ready image must NOT claim to be a
    // reference, and must not prematurely claim to be attaching at rest.
    expect(projectedState(ready, true)).toBe('attaching')
  })

  it('describes every state in user-facing language with no transport jargon', () => {
    for (const state of ['ready', 'attaching', 'attached', 'reference', 'failed'] as const) {
      const label = stateLabel(state)
      expect(label).toBeTruthy()
      expect(label.toLowerCase()).not.toMatch(/pty|clipboard|transport|view_file|wl-/)
    }
  })

  it('only treats real image payloads as pasteable attachments', () => {
    const items = [
      { kind: 'string', type: 'text/plain' },
      { kind: 'file', type: 'image/png' },
      { kind: 'file', type: 'application/pdf' }
    ] as unknown as DataTransferItemList
    // Ordinary copied text must fall through to the textarea untouched.
    expect(imageItemsFromClipboard(items)).toHaveLength(1)
    expect(imageItemsFromClipboard(null)).toHaveLength(0)
  })
})

describe('markdown', () => {
  it('parses headings, lists and paragraphs', () => {
    const blocks = parseMarkdown('# Title\n\nSome text.\n\n- one\n- two\n')
    expect(blocks.map((block) => block.type)).toEqual(['heading', 'paragraph', 'list'])
  })

  it('preserves fenced code verbatim, including markdown-looking content', () => {
    const blocks = parseMarkdown('```ts\nconst a = **not bold**\n```')
    expect(blocks[0]).toEqual({ type: 'code', language: 'ts', value: 'const a = **not bold**' })
  })

  it('parses ordered lists', () => {
    const blocks = parseMarkdown('1. first\n2. second')
    expect(blocks[0]).toMatchObject({ type: 'list', ordered: true })
  })

  it('handles inline emphasis and code', () => {
    expect(parseInline('a **b** and `c`')).toEqual([
      { type: 'text', value: 'a ' },
      { type: 'strong', value: 'b' },
      { type: 'text', value: ' and ' },
      { type: 'code', value: 'c' }
    ])
  })

  it('does not let emphasis markers inside inline code become formatting', () => {
    expect(parseInline('`**literal**`')).toEqual([{ type: 'code', value: '**literal**' }])
  })

  it('returns plain text unchanged when there is no markup', () => {
    expect(parseInline('just words')).toEqual([{ type: 'text', value: 'just words' }])
  })
})

describe('relativeTime', () => {
  const now = Date.parse('2026-09-07T12:00:00Z')

  it('reads as a mail client would', () => {
    expect(relativeTime('2026-09-07T11:59:40Z', now)).toBe('Now')
    expect(relativeTime('2026-09-07T11:20:00Z', now)).toBe('40m ago')
    expect(relativeTime('2026-09-07T09:00:00Z', now)).toBe('3h ago')
    expect(relativeTime('2026-09-05T12:00:00Z', now)).toBe('2d ago')
    expect(relativeTime('2026-08-24T12:00:00Z', now)).toBe('2w ago')
    expect(relativeTime('2026-06-07T12:00:00Z', now)).toBe('3mo ago')
  })

  it('says nothing rather than guessing for an unusable timestamp', () => {
    expect(relativeTime('not-a-date', now)).toBe('')
  })
})

describe('RuntimeEventBatcher', () => {
  const base = {
    projectId: 'p',
    conversationId: 'c',
    runId: 'r',
    providerId: 'antigravity' as const,
    createdAt: 'now'
  }

  it('coalesces tiny streamed deltas into one paint-frame batch', () => {
    const batches: Array<Record<string, string>> = []
    const immediate: RuntimeEvent[] = []
    let scheduled = (): void => {
      throw new Error('flush was not scheduled')
    }
    const batcher = new RuntimeEventBatcher(
      (batch) => batches.push(batch.textDeltas),
      (event) => immediate.push(event),
      (callback) => {
        scheduled = callback
        return 1
      },
      () => undefined
    )

    batcher.push({ ...base, type: 'text.delta', delta: 'Hel' })
    batcher.push({ ...base, type: 'text.delta', delta: 'lo' })

    expect(batches).toHaveLength(0)
    scheduled()
    expect(batches).toEqual([{ r: 'Hello' }])
    expect(immediate).toHaveLength(0)
  })

  it('flushes pending stream output before immediate run events', () => {
    const order: string[] = []
    let scheduled = false
    const batcher = new RuntimeEventBatcher(
      (batch) => order.push(`batch:${batch.textDeltas.r}`),
      (event) => order.push(`event:${event.type}`),
      () => {
        scheduled = true
        return 1
      },
      () => {
        scheduled = false
      }
    )

    batcher.push({ ...base, type: 'text.delta', delta: 'done' })
    batcher.push({ ...base, type: 'run.completed', finalText: 'done' })

    expect(scheduled).toBe(false)
    expect(order).toEqual(['batch:done', 'event:run.completed'])
  })
})

describe('activity copy', () => {
  const item = (overrides: Partial<Parameters<typeof describeActivity>[0] & object> = {}) => ({
    key: 'k',
    label: 'run_command',
    status: 'running' as const,
    startedAt: 0,
    ...overrides
  })

  it('shows the exact command rather than a description of it', () => {
    const view = describeActivity(item({ kind: 'running', command: 'git push --force-with-lease origin main' }))
    expect(view.text).toBe('Running')
    expect(view.command).toBe('git push --force-with-lease origin main')
  })

  it('names the file, shortened for reading, for every path-shaped step', () => {
    expect(describeActivity(item({ kind: 'reading', target: '/ws/src/renderer/App.tsx' })).text).toBe('Reading App.tsx')
    expect(describeActivity(item({ kind: 'editing', target: '/ws/notes.md' })).text).toBe('Editing notes.md')
    expect(describeActivity(item({ kind: 'listing', target: '/ws/src' })).text).toBe('Inspecting src')
  })

  it('shows a search query in full, because a shortened one means nothing', () => {
    expect(describeActivity(item({ kind: 'searching', target: 'use.*Effect' })).text).toBe('Searching project for “use.*Effect”')
  })

  it('has a word for each state a turn passes through', () => {
    expect(describeActivity(item({ kind: 'thinking' })).text).toBe('Thinking')
    expect(describeActivity(item({ kind: 'waiting' })).text).toBe('Waiting for approval')
    expect(describeActivity(item({ kind: 'browsing', target: 'https://example.com' })).text).toBe('Browsing https://example.com')
  })

  it("uses Antigravity's own words when that is what it reported", () => {
    expect(describeActivity(item({ kind: 'working', label: 'Verifying Requirements Thoroughly' })).text).toBe('Verifying Requirements Thoroughly')
  })

  it('falls back to a restrained line rather than claiming to be replying', () => {
    expect(fallbackActivity().text).toBe('Working…')
    expect(describeActivity(null).text).toBe('Working…')
    expect(describeActivity(undefined).text).toBe('Working…')
    // An event with nothing usable in it gets the fallback, not a guess.
    expect(describeActivity(item({ label: '   ' })).text).toBe('Working…')
  })

  it('says a command failed rather than that it is still running', () => {
    expect(describeActivity(item({ kind: 'running', command: 'npm test', status: 'failed' })).text).toBe('Command failed')
  })

  it('never claims to know what an unclassified tool did', () => {
    expect(describeActivity(item({ label: 'manage_inbox', kind: 'tool' })).text).toBe('Using manage_inbox')
    expect(describeActivity(item({ label: 'manage_inbox', kind: 'tool', target: '/ws/a.ts' })).text).toBe('Using manage_inbox on a.ts')
  })

  it('shortens a path without inventing one', () => {
    expect(shortenPath('/ws/src/App.tsx')).toBe('App.tsx')
    expect(shortenPath('C:\\ws\\src\\App.tsx')).toBe('App.tsx')
    expect(shortenPath('/ws/src/')).toBe('src')
    expect(shortenPath('App.tsx')).toBe('App.tsx')
  })
})

describe('activity duration', () => {
  const base = { key: 'k', label: 'run_command', status: 'running' as const, startedAt: 0 }

  it("prefers Antigravity's own measurement over Orbit's clock", () => {
    expect(durationLabel({ ...base, status: 'completed', durationSeconds: 42 }, 999_999)).toBe('42s')
    expect(durationLabel({ ...base, durationSeconds: 125 }, 0)).toBe('2m 5s')
  })

  it('times a running step itself, once silence would read as a hang', () => {
    expect(durationLabel(base, 3_000)).toBeNull()
    expect(durationLabel(base, 9_000)).toBe('9s')
  })

  it('says nothing about a finished step Antigravity did not time', () => {
    expect(durationLabel({ ...base, status: 'completed' }, 999_999)).toBeNull()
  })
})

