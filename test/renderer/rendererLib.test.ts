import { describe, expect, it } from 'vitest'
import { applyActivity, currentActivityLine, elapsedLabel, emptyActivity, hasFailure, summarizeActivity } from '../../src/renderer/app/lib/activity'
import { describeProviderProblem, describeRuntimeError } from '../../src/renderer/app/lib/errorCopy'
import { imageItemsFromClipboard, isNativeImage, projectedState, stateLabel, type DraftAttachment } from '../../src/renderer/app/lib/attachments'
import { parseInline, parseMarkdown } from '../../src/renderer/app/lib/markdown'
import type { ToolActivityEvent } from '../../src/shared/runtime-events'

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
