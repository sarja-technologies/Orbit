// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { MessageBlock } from '../../src/renderer/app/components/MessageBlock'
import { reportPreview } from '../../src/renderer/app/lib/reportPreview'
import type { Message } from '../../src/shared/domain'

function reply(content: string): Message {
  return {
    id: 'message_1',
    projectId: 'project_1',
    conversationId: 'conversation_1',
    runId: 'run_1',
    role: 'assistant',
    content,
    status: 'completed',
    createdAt: '2026-09-22T10:00:00.000Z',
    updatedAt: '2026-09-22T10:00:00.000Z',
    sequence: 2
  }
}

function paragraphs(count: number, word = 'Renamed the helper and updated its callers.'): string {
  return Array.from({ length: count }, (_, index) => `Step ${index + 1}. ${word}`).join('\n\n')
}

/** A long, entirely successful report — the case the fold exists for. */
const LONG_REPORT = ['## What I changed', '', 'Renamed the transport helper and moved its callers.', '', paragraphs(20)].join('\n')

function renderReply(content: string): void {
  render(<MessageBlock message={reply(content)} showRole attachments={[]} thumbnails={{}} />)
}

describe('deciding whether a reply folds', () => {
  it('leaves a short reply alone', () => {
    const view = reportPreview('Done — the test passes now.')
    expect(view.collapsible).toBe(false)
    expect(view.preview).toBe('Done — the test passes now.')
  })

  it('folds a long report and reports how much is behind the fold', () => {
    const view = reportPreview(LONG_REPORT)
    expect(view.collapsible).toBe(true)
    expect(view.hiddenLines).toBeGreaterThan(0)
  })

  it('shows a real prefix of the real message, never a rewritten summary', () => {
    const view = reportPreview(LONG_REPORT)
    // Character-for-character the opening of what the model actually wrote.
    expect(LONG_REPORT.startsWith(view.preview)).toBe(true)
    expect(view.preview.length).toBeGreaterThan(0)
  })

  it('never cuts inside a fenced code block', () => {
    const fenced = ['Here is the patch.', '', '```ts', ...Array.from({ length: 40 }, (_, i) => `const line${i} = ${i}`), '```'].join('\n')
    const view = reportPreview(fenced)
    // The only boundary is inside the fence, so there is nowhere safe to
    // cut and the message is shown whole rather than as a fragment.
    expect(view.collapsible).toBe(false)
  })

  it('keeps a report that goes on to describe a failure fully expanded', () => {
    const trouble = [LONG_REPORT, '', 'One test is still failing: the PTY retirement case errors out.'].join('\n')
    const view = reportPreview(trouble)
    expect(view.collapsible).toBe(false)
  })

  it('keeps a report carrying a failure marker fully expanded', () => {
    const marked = [LONG_REPORT, '', '✗ build/renderer — unable to resolve @shared/domain'].join('\n')
    expect(reportPreview(marked).collapsible).toBe(false)
  })

  it('does not fold when barely anything would be hidden', () => {
    const barely = [paragraphs(13), '', 'Done.'].join('\n')
    const view = reportPreview(barely)
    if (view.collapsible) expect(view.hiddenLines).toBeGreaterThanOrEqual(6)
  })
})

describe('a folded report in the transcript', () => {
  it('shows the opening and offers the rest', () => {
    renderReply(LONG_REPORT)

    expect(screen.getByText('What I changed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Show full report/ })).toBeInTheDocument()
    // The tail is genuinely not rendered yet — not merely hidden with CSS.
    expect(screen.queryByText(/Step 20\./)).not.toBeInTheDocument()
  })

  it('reveals the whole report on one click, and stays open', async () => {
    const user = userEvent.setup()
    renderReply(LONG_REPORT)

    await user.click(screen.getByRole('button', { name: /Show full report/ }))

    expect(screen.getByText(/Step 20\./)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Show full report/ })).not.toBeInTheDocument()
  })

  it('never folds a short reply', () => {
    renderReply('Done — the test passes now.')
    expect(screen.queryByRole('button', { name: /Show full report/ })).not.toBeInTheDocument()
    expect(screen.getByText('Done — the test passes now.')).toBeInTheDocument()
  })

  it('never folds the reader’s own message', () => {
    render(
      <MessageBlock message={{ ...reply(LONG_REPORT), role: 'user', id: 'message_2' }} showRole attachments={[]} thumbnails={{}} />
    )
    expect(screen.queryByRole('button', { name: /Show full report/ })).not.toBeInTheDocument()
  })

  it('shows a long report that reports a failure in full, with no button', () => {
    renderReply([LONG_REPORT, '', 'The build failed: two modules could not be resolved.'].join('\n'))

    expect(screen.queryByRole('button', { name: /Show full report/ })).not.toBeInTheDocument()
    expect(screen.getByText(/The build failed/)).toBeInTheDocument()
  })

  it('leaves a failed turn on its own error presentation', () => {
    render(
      <MessageBlock
        message={{ ...reply(LONG_REPORT), status: 'failed' }}
        showRole
        attachments={[]}
        thumbnails={{}}
        error={{ code: 'provider.failed', message: 'agy exited with code 1', retryable: true }}
      />
    )
    // Failures never go through the fold at all.
    expect(screen.queryByRole('button', { name: /Show full report/ })).not.toBeInTheDocument()
  })
})
