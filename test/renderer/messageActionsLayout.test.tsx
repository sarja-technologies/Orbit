// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageBlock } from '../../src/renderer/app/components/MessageBlock'
import type { Message } from '../../src/shared/domain'

const IDENTITY = { provider: 'gemini' as const, name: '3.8 Flash' }

function message(overrides: Partial<Message> & { role: Message['role']; content: string }): Message {
  return {
    id: 'm1',
    projectId: 'p',
    conversationId: 'c',
    runId: 'r',
    status: 'completed',
    sequence: 1,
    createdAt: '2026-09-11T10:00:00.000Z',
    updatedAt: '2026-09-11T10:00:00.000Z',
    ...overrides
  }
}

const block = (msg: Message) =>
  render(
    <MessageBlock message={msg} showRole attachments={[]} thumbnails={{}} error={null} identity={IDENTITY} />
  )

/** The reveal and the out-of-flow positioning are the whole fix and they
 *  live in CSS, which jsdom does not apply — so the contract is asserted
 *  against the stylesheet itself rather than pretended about in the DOM. */
const STYLES = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/styles.css'), 'utf8')

function ruleFor(selector: string): string {
  const start = STYLES.indexOf(`${selector} {`)
  expect(start, `expected a rule for ${selector}`).toBeGreaterThan(-1)
  return STYLES.slice(start, STYLES.indexOf('}', start))
}

describe('the copy action lives outside the bubble', () => {
  it('keeps a user message’s action out of its bubble', () => {
    const { container } = block(message({ role: 'user', content: 'hi' }))

    const bubble = container.querySelector('.chat-bubble-user')
    const actions = container.querySelector('.message-actions')

    expect(bubble).not.toBeNull()
    expect(actions).not.toBeNull()
    // The bug: rendered as a ChatRow child, the action landed inside the
    // bubble and a two-character message came out two rows tall.
    expect(bubble!.contains(actions)).toBe(false)
    expect(bubble!.querySelector('.message-actions')).toBeNull()
  })

  it('keeps an assistant message’s action out of its bubble', () => {
    const { container } = block(message({ role: 'assistant', content: 'Here you go.' }))

    const bubble = container.querySelector('.chat-bubble-assistant')
    const actions = container.querySelector('.message-actions')

    expect(bubble).not.toBeNull()
    expect(actions).not.toBeNull()
    expect(bubble!.contains(actions)).toBe(false)
    expect(bubble!.querySelector('.message-actions')).toBeNull()
  })

  it('makes the action a sibling of the bubble, inside the same row', () => {
    const { container } = block(message({ role: 'user', content: 'hi' }))

    const row = container.querySelector('.chat-row')
    const bubble = row!.querySelector('.chat-bubble')
    const actions = row!.querySelector('.message-actions')

    expect(actions!.parentElement).toBe(row)
    expect(bubble!.parentElement).toBe(row)
  })

  it('leaves the bubble holding only the message content', () => {
    const { container } = block(message({ role: 'user', content: 'hi' }))
    const bubble = container.querySelector('.chat-bubble-user')!

    // One child: the text. Nothing else is paying for a line of height.
    expect(bubble.children).toHaveLength(1)
    expect(bubble.querySelector('.chat-user-text')!.textContent).toBe('hi')
    expect(bubble.querySelector('button')).toBeNull()
  })

  it('adds no bubble children for an assistant reply either', () => {
    const { container } = block(message({ role: 'assistant', content: 'Done.' }))
    const bubble = container.querySelector('.chat-bubble-assistant')!

    expect(bubble.querySelector('button')).toBeNull()
    expect(bubble.textContent).toBe('Done.')
  })
})

describe('the action costs the row no height', () => {
  it('is taken out of flow rather than laid out under the bubble', () => {
    const rule = ruleFor('.message-actions')

    expect(rule).toMatch(/position:\s*absolute/)
    // Anchored to the row's bottom edge, so it hangs into the gap between
    // turns instead of reserving space of its own.
    expect(rule).toMatch(/top:\s*100%/)
  })

  it('hangs off the row, which is the positioning context', () => {
    expect(ruleFor('.chat-row')).toMatch(/position:\s*relative/)
  })

  it('is invisible at rest, so the transcript is not a control panel', () => {
    const rule = ruleFor('.message-actions')

    expect(rule).toMatch(/opacity:\s*0/)
    expect(rule).toMatch(/pointer-events:\s*none/)
  })

  it('reveals on hover and on focus reaching anywhere in the row', () => {
    const reveal = ruleFor('.chat-row:hover .message-actions,\n.chat-row:focus-within .message-actions')

    expect(reveal).toMatch(/opacity:\s*1/)
    expect(reveal).toMatch(/pointer-events:\s*auto/)
  })

  it('hides with opacity, never a technique that drops it from the tab order', () => {
    const rule = ruleFor('.message-actions')

    // `display: none` or `visibility: hidden` would take the button out of
    // the accessibility tree, so it could never be reached by keyboard.
    expect(rule).not.toMatch(/display:\s*none/)
    expect(rule).not.toMatch(/visibility:\s*hidden/)
  })

  it('anchors each side to its own bubble edge', () => {
    expect(ruleFor('.chat-row-assistant .message-actions')).toMatch(/left:\s*var\(--chat-rail\)/)
    expect(ruleFor('.chat-row-user .message-actions')).toMatch(/right:\s*0/)
  })
})

describe('the action still works from the message', () => {
  const writeText = vi.fn(async () => true)

  beforeEach(() => {
    writeText.mockClear()
    writeText.mockResolvedValue(true)
    ;(window as unknown as { orbit: unknown }).orbit = { clipboard: { writeText } }
  })

  afterEach(() => {
    delete (window as unknown as { orbit?: unknown }).orbit
  })

  it('copies the user message from its own row', async () => {
    const user = userEvent.setup()
    block(message({ role: 'user', content: 'Ship the release notes' }))

    await user.click(screen.getByRole('button', { name: /Copy your message/ }))

    expect(writeText).toHaveBeenCalledWith('Ship the release notes')
  })

  it('copies the assistant reply’s source from its own row', async () => {
    const user = userEvent.setup()
    const source = '## Heading\n\n- one\n- two'
    block(message({ role: 'assistant', content: source }))

    await user.click(screen.getByRole('button', { name: /Copy reply/ }))

    expect(writeText).toHaveBeenCalledWith(source)
  })

  it('stays reachable by keyboard now that it sits outside the bubble', async () => {
    const user = userEvent.setup()
    block(message({ role: 'assistant', content: 'Done.' }))
    const button = screen.getByRole('button', { name: /Copy reply/ })

    // In the a11y tree and in the tab order, not merely painted.
    expect(button).toBeVisible()
    await user.tab()
    expect(button).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(writeText).toHaveBeenCalledTimes(1)
  })
})

describe('message alignment is unchanged', () => {
  it('keeps the reader on the right, with no mark', () => {
    const { container } = block(message({ role: 'user', content: 'hi' }))

    expect(container.querySelector('.chat-row-user')).not.toBeNull()
    expect(container.querySelector('.chat-mark')).toBeNull()
  })

  it('keeps the assistant on the left, with its own mark', () => {
    const { container } = block(message({ role: 'assistant', content: 'Done.' }))

    expect(container.querySelector('.chat-row-assistant')).not.toBeNull()
    expect(container.querySelector('.chat-mark')).toHaveAttribute('data-provider', 'gemini')
  })
})
