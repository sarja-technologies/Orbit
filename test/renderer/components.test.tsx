// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { InteractionCard, InactiveInteraction, ResolvedInteraction } from '../../src/renderer/app/components/InteractionCard'
import { AttachmentChip } from '../../src/renderer/app/components/AttachmentChip'
import { ActivitySummary, LiveActivity } from '../../src/renderer/app/components/ActivityLine'
import { Markdown } from '../../src/renderer/app/components/Markdown'
import { MessageBlock } from '../../src/renderer/app/components/MessageBlock'
import { PendingReply } from '../../src/renderer/app/components/ChatRow'
import { WorkSession } from '../../src/renderer/app/components/WorkSession'
import { applyActivity, emptyActivity } from '../../src/renderer/app/lib/activity'
import type { DraftAttachment } from '../../src/renderer/app/lib/attachments'
import type { Conversation, Message, Project } from '../../src/shared/domain'
import type { InteractionRequiredEvent, ToolActivityEvent } from '../../src/shared/runtime-events'

function interaction(overrides: Partial<InteractionRequiredEvent> = {}): InteractionRequiredEvent {
  return {
    type: 'interaction.required',
    projectId: 'p',
    conversationId: 'c',
    runId: 'r',
    providerId: 'antigravity',
    createdAt: new Date().toISOString(),
    interactionId: 'i-1',
    kind: 'permission',
    prompt: 'Requesting permission for:\n   npm run build\n\nDo you want to proceed?',
    options: [
      { id: '1', label: 'Yes' },
      { id: '4', label: 'No' }
    ],
    transport: 'pty',
    canRespond: true,
    sourceEvidence: 'native-prompt',
    ...overrides
  }
}

describe('InteractionCard', () => {
  it('shows product language with the command in monospace, not the raw CLI prompt', () => {
    render(<InteractionCard event={interaction()} busy={false} onRespond={vi.fn()} />)

    expect(screen.getByText('Run this command?')).toBeInTheDocument()
    expect(screen.getByText('npm run build')).toBeInTheDocument()
    // The raw prompt is not the visible headline.
    expect(screen.queryByText(/Requesting permission for/)).not.toBeInTheDocument()
  })

  it('keeps the original prompt available behind a disclosure', async () => {
    render(<InteractionCard event={interaction()} busy={false} onRespond={vi.fn()} />)

    await userEvent.click(screen.getByRole('button', { name: 'Show original prompt' }))
    expect(screen.getByText(/Requesting permission for/)).toBeInTheDocument()
  })

  it('sends the exact native option id for Approve', async () => {
    const onRespond = vi.fn()
    render(<InteractionCard event={interaction()} busy={false} onRespond={onRespond} />)

    await userEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onRespond).toHaveBeenCalledWith('1')
  })

  it('sends the remember-for-session native option when that box is ticked', async () => {
    const onRespond = vi.fn()
    render(
      <InteractionCard
        event={interaction({
          options: [
            { id: '1', label: 'Yes' },
            { id: '2', label: "Yes, and always allow in this conversation for commands that start with 'npm'" },
            { id: '4', label: 'No' }
          ]
        })}
        busy={false}
        onRespond={onRespond}
      />
    )

    await userEvent.click(screen.getByLabelText('Remember for this session'))
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }))
    // Semantics preserved: the session-scoped native option is sent, not '1'.
    expect(onRespond).toHaveBeenCalledWith('2')
  })

  it('does not collapse a four-option menu into four equal grey buttons', () => {
    render(
      <InteractionCard
        event={interaction({
          options: [
            { id: '1', label: 'Yes' },
            { id: '2', label: "Yes, and always allow in this conversation for commands that start with 'npm'" },
            { id: '3', label: "Yes, and always allow for commands that start with 'npm' (Persist to settings.json)" },
            { id: '4', label: 'No' }
          ]
        })}
        busy={false}
        onRespond={vi.fn()}
      />
    )

    const buttons = screen.getAllByRole('button').filter((button) => /Approve|Deny/.test(button.textContent ?? ''))
    expect(buttons).toHaveLength(2)
    expect(screen.getByLabelText('Remember for this session')).toBeInTheDocument()
  })

  it('warns visually for a destructive command without preselecting anything', () => {
    render(<InteractionCard event={interaction({ prompt: 'Requesting permission for:\n   rm -rf dist\n\nDo you want to proceed?' })} busy={false} onRespond={vi.fn()} />)

    expect(screen.getByText('rm -rf dist')).toBeInTheDocument()
    expect(screen.getByText(/could remove or overwrite work/i)).toBeInTheDocument()
  })

  it('preserves every native option verbatim for an unknown prompt shape', () => {
    render(
      <InteractionCard
        event={interaction({
          prompt: 'A completely novel question',
          options: [
            { id: 'x', label: 'Take the first path' },
            { id: 'y', label: 'Take the second path' }
          ]
        })}
        busy={false}
        onRespond={vi.fn()}
      />
    )

    expect(screen.getByText('Antigravity needs your approval')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Take the first path' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Take the second path' })).toBeInTheDocument()
  })

  it('renders a stale request as inactive with no live-looking buttons', () => {
    render(<InactiveInteraction event={interaction()} reason="stale" />)

    expect(screen.getByText('This request is no longer active')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
  })

  it('keeps a compact record of what was decided', () => {
    render(<ResolvedInteraction summary="Approved · npm run build" />)
    expect(screen.getByText('Approved · npm run build')).toBeInTheDocument()
  })
})

describe('AttachmentChip', () => {
  const base: DraftAttachment = {
    fileId: 'f1',
    name: 'diagram.png',
    mimeType: 'image/png',
    byteSize: 4096,
    thumbnail: null,
    state: 'ready',
    error: null
  }

  it('is always removable', async () => {
    const onRemove = vi.fn()
    render(<AttachmentChip attachment={base} onRemove={onRemove} onRetry={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Remove diagram.png' }))
    expect(onRemove).toHaveBeenCalled()
  })

  it('offers retry only for a genuine failure', () => {
    const { rerender } = render(<AttachmentChip attachment={base} onRemove={vi.fn()} onRetry={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument()

    rerender(<AttachmentChip attachment={{ ...base, state: 'failed' }} onRemove={vi.fn()} onRetry={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Retry attaching diagram.png' })).toBeInTheDocument()
  })

  it('explains reference mode without naming any transport internals', () => {
    render(<AttachmentChip attachment={{ ...base, state: 'reference' }} onRemove={vi.fn()} onRetry={vi.fn()} />)
    expect(screen.getByText('Shared as reference')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/pty|clipboard|wl-|view_file/i)
  })
})

describe('activity rendering', () => {
  const event = (label: string, status: ToolActivityEvent['status'], id: string): ToolActivityEvent => ({
    type: 'tool.activity',
    projectId: 'p',
    conversationId: 'c',
    runId: 'r',
    providerId: 'antigravity',
    createdAt: new Date().toISOString(),
    label,
    status,
    providerStepId: id
  })

  it('shows a single live line, not an event feed', () => {
    let state = applyActivity(emptyActivity(), event('Bash(npm run build)', 'running', '1'))
    state = applyActivity(state, event('read_file(App.tsx)', 'running', '2'))
    render(<LiveActivity activity={state} />)
    // Only the current step is shown while running.
    expect(screen.getByText('read_file(App.tsx)')).toBeInTheDocument()
    expect(screen.queryByText('Bash(npm run build)')).not.toBeInTheDocument()
  })

  it('collapses a finished turn into a summary that expands on request', async () => {
    let state = applyActivity(emptyActivity(), event('Bash(a)', 'completed', '1'))
    state = applyActivity(state, event('write_file(b)', 'completed', '2'))
    render(<ActivitySummary activity={state} />)

    expect(screen.getByText('Ran 1 command, edited 1 file')).toBeInTheDocument()
    expect(screen.queryByText('Bash(a)')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /Ran 1 command/ }))
    expect(screen.getByText('Bash(a)')).toBeInTheDocument()
  })
})

describe('conversation sides', () => {
  const message = (overrides: Partial<Message> = {}): Message => ({
    id: 'm-1',
    projectId: 'p',
    conversationId: 'c',
    runId: 'r',
    role: 'user',
    content: 'Ship the release notes.',
    status: 'completed',
    createdAt: '2026-09-08T10:04:00.000Z',
    updatedAt: '2026-09-08T10:04:00.000Z',
    sequence: 1,
    ...overrides
  })

  const block = (overrides: Partial<Message> = {}, showRole = true): HTMLElement => {
    const { container } = render(
      <MessageBlock message={message(overrides)} showRole={showRole} attachments={[]} thumbnails={{}} error={null} />
    )
    return container.querySelector('.chat-row') as HTMLElement
  }

  it('puts the reader on the right in a sent bubble', () => {
    const row = block()
    expect(row).toHaveClass('chat-row-user')
    expect(row.querySelector('.chat-bubble-user')).not.toBeNull()
    // The assistant's surface is never applied to a user turn.
    expect(row.querySelector('.chat-bubble-assistant')).toBeNull()
    expect(screen.getByText('You')).toBeInTheDocument()
  })

  it('puts Antigravity on the left in its own bubble', () => {
    const row = block({ role: 'assistant', content: 'Done — notes are drafted.' })
    expect(row).toHaveClass('chat-row-assistant')
    expect(row.querySelector('.chat-bubble-assistant')).not.toBeNull()
    expect(row.querySelector('.chat-bubble-user')).toBeNull()
    expect(screen.getByText('Antigravity')).toBeInTheDocument()
  })

  it('carries the side on the row even when a grouped message drops its header', () => {
    const row = block({ role: 'assistant' }, false)
    // Grouping only removes the label; alignment must still identify the
    // speaker, or a follow-up message becomes unattributable.
    expect(row).toHaveClass('chat-row-assistant')
    expect(row.querySelector('.chat-bubble-assistant')).not.toBeNull()
    expect(screen.queryByText('Antigravity')).not.toBeInTheDocument()
  })

  it('shows a real send time rather than a placeholder', () => {
    const row = block()
    const time = row.querySelector('time')
    expect(time).toHaveAttribute('dateTime', '2026-09-08T10:04:00.000Z')
    expect(time?.textContent).toMatch(/\d/)
  })
})

describe('reply-in-progress state', () => {
  const project: Project = {
    id: 'p',
    name: 'Orbit',
    rootPath: null,
    createdAt: '2026-09-08T10:00:00.000Z',
    updatedAt: '2026-09-08T10:00:00.000Z'
  }

  const conversation: Conversation = {
    id: 'c',
    projectId: 'p',
    title: 'Session',
    providerId: 'antigravity',
    nativeConversationId: null,
    status: 'running',
    transport: 'pty',
    model: null,
    reasoningEffort: null,
    workingDirectory: null,
    createdAt: '2026-09-08T10:00:00.000Z',
    updatedAt: '2026-09-08T10:00:00.000Z'
  }

  const session = (props: Partial<Parameters<typeof WorkSession>[0]> = {}) =>
    render(
      <WorkSession
        project={project}
        conversation={conversation}
        messages={[]}
        runs={[]}
        projectFiles={[]}
        thumbnails={{}}
        activeRunId="r"
        streamText=""
        activityByRun={{}}
        pendingInteraction={null}
        unavailableInteraction={null}
        staleInteraction={false}
        respondingInteractionId={null}
        resolvedRecords={[]}
        onRespond={vi.fn()}
        {...props}
      />
    )

  it('holds an animated assistant bubble open before the first token arrives', () => {
    const { container } = session()

    expect(screen.getByText('Antigravity is replying')).toBeInTheDocument()
    expect(container.querySelectorAll('.typing-dot')).toHaveLength(3)
    // The wait happens on the assistant's side, where the answer will land.
    expect(container.querySelector('.chat-row-assistant .chat-bubble-pending')).not.toBeNull()
  })

  it('says working, not replying, once tool steps are running', () => {
    const activity = applyActivity(emptyActivity(), {
      type: 'tool.activity',
      projectId: 'p',
      conversationId: 'c',
      runId: 'r',
      providerId: 'antigravity',
      createdAt: new Date().toISOString(),
      label: 'Bash(npm test)',
      status: 'running',
      providerStepId: '1'
    })
    const { container } = session({ activityByRun: { r: activity } })

    expect(screen.getByText('Antigravity is working')).toBeInTheDocument()
    // Tool detail is subordinate to the reply, not a peer of it.
    expect(container.querySelector('.chat-aside .activity-live')).not.toBeNull()
  })

  it('does not draw the subordinate rail for a run that has recorded no steps', () => {
    // Every run starts with an empty activity state. Treating that as
    // evidence of tool work drew an empty rail and claimed "working"
    // before anything had actually run.
    const { container } = session({ activityByRun: { r: emptyActivity() } })

    expect(container.querySelector('.chat-aside')).toBeNull()
    expect(screen.getByText('Antigravity is replying')).toBeInTheDocument()
  })

  it('keeps a streaming reply visibly unfinished while text is arriving', () => {
    const { container } = session({ streamText: 'Working through the diff' })

    expect(screen.getByText('Working through the diff')).toBeInTheDocument()
    expect(screen.getByText('Replying')).toBeInTheDocument()
    expect(container.querySelector('.chat-bubble-assistant.is-streaming')).not.toBeNull()
    // The placeholder yields to the real bubble rather than stacking under it.
    expect(container.querySelector('.chat-bubble-pending')).toBeNull()
  })

  it('drops every live indicator once no run is active', () => {
    const { container } = session({ activeRunId: null })

    expect(container.querySelector('.chat-bubble-pending')).toBeNull()
    expect(container.querySelector('.is-streaming')).toBeNull()
    expect(screen.queryByText('Replying')).not.toBeInTheDocument()
  })

  it('announces the pending row so the wait is not a silent one', () => {
    const { container } = render(<PendingReply />)
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull()
  })
})

describe('Markdown', () => {
  it('renders structure rather than raw markup, and never injects HTML', () => {
    render(<Markdown source={'## Heading\n\n- **bold** item\n\n```js\nconst x = 1\n```\n\n<img src=x onerror=alert(1)>'} />)

    expect(screen.getByRole('heading', { name: 'Heading' })).toBeInTheDocument()
    expect(screen.getByRole('listitem')).toBeInTheDocument()
    expect(screen.getByText('const x = 1')).toBeInTheDocument()
    // The HTML-looking text is displayed as text; no element was created.
    expect(document.querySelector('img')).toBeNull()
  })
})
