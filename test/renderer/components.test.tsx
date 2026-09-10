// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { InteractionCard, InactiveInteraction, ResolvedInteraction } from '../../src/renderer/app/components/InteractionCard'
import { AttachmentChip } from '../../src/renderer/app/components/AttachmentChip'
import { ActivitySummary, LiveActivity } from '../../src/renderer/app/components/ActivityLine'
import { Markdown } from '../../src/renderer/app/components/Markdown'
import { MessageBlock } from '../../src/renderer/app/components/MessageBlock'
import { PendingReply } from '../../src/renderer/app/components/ChatRow'
import { WorkSession } from '../../src/renderer/app/components/WorkSession'
import { applyActivity, emptyActivity, finalizeActivity } from '../../src/renderer/app/lib/activity'
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
  const event = (
    label: string,
    status: ToolActivityEvent['status'],
    id: string,
    kind: ToolActivityEvent['kind'] = 'tool'
  ): ToolActivityEvent => ({
    type: 'tool.activity',
    projectId: 'p',
    conversationId: 'c',
    runId: 'r',
    providerId: 'antigravity',
    createdAt: new Date().toISOString(),
    label,
    status,
    kind,
    providerStepId: id
  })

  it('shows a single live line, not an event feed', () => {
    let state = applyActivity(emptyActivity(), event('Running npm run build', 'running', '1', 'command'))
    state = applyActivity(state, event('Reading App.tsx', 'running', '2', 'read'))
    render(<LiveActivity activity={state} />)
    // Only the current step is shown while running.
    expect(screen.getByText('Reading App.tsx')).toBeInTheDocument()
    expect(screen.queryByText('Running npm run build')).not.toBeInTheDocument()
  })

  it('shows the real command a run is on, not a generic working label', () => {
    const state = applyActivity(emptyActivity(), event('Running npm run build', 'running', '1', 'command'))
    render(<LiveActivity activity={state} />)

    expect(screen.getByText('Running npm run build')).toBeInTheDocument()
    expect(screen.queryByText(/is working/)).not.toBeInTheDocument()
  })

  it('counts up while a command is running, and stops the moment it finishes', () => {
    vi.useFakeTimers()
    try {
      const started = Date.now()
      const state = applyActivity(emptyActivity(), event('Running npm run build', 'running', '1', 'command'), started)
      const { rerender, container } = render(<LiveActivity activity={state} />)

      const elapsed = (): string => container.querySelector('.activity-elapsed')?.textContent?.trim() ?? ''
      expect(elapsed()).toBe('')

      act(() => {
        vi.advanceTimersByTime(12_000)
      })
      expect(elapsed()).toContain('12s')

      act(() => {
        vi.advanceTimersByTime(122_000)
      })
      expect(elapsed()).toContain('2m 14s')

      // The command completes at 134s. Its time is now a fact about what
      // happened, and no amount of further waiting may change it.
      const done = applyActivity(state, event('Running npm run build', 'completed', '1', 'command'), started + 134_000)
      rerender(<LiveActivity activity={done} />)
      expect(elapsed()).toContain('2m 14s')

      act(() => {
        vi.advanceTimersByTime(60_000)
      })
      expect(elapsed()).toContain('2m 14s')
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops counting a step left open by a cancelled run', () => {
    vi.useFakeTimers()
    try {
      const started = Date.now()
      const state = applyActivity(emptyActivity(), event('Running npm run build', 'running', '1', 'command'), started)
      const { rerender, container } = render(<LiveActivity activity={state} />)
      act(() => {
        vi.advanceTimersByTime(8_000)
      })

      // Exactly what App does on run.cancelled: close every open step.
      rerender(<LiveActivity activity={finalizeActivity(state, started + 8_000)} />)
      act(() => {
        vi.advanceTimersByTime(30_000)
      })

      expect(container.querySelector('.activity-elapsed')?.textContent).toContain('8s')
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks the live row with the working model\u2019s own logo', () => {
    const state = applyActivity(emptyActivity(), event('Running npm run build', 'running', '1', 'command'))
    const { container } = render(
      <LiveActivity activity={state} identity={{ provider: 'anthropic', name: 'Claude Sonnet 4.6' }} />
    )
    expect(container.querySelector('.activity-agent [data-provider="anthropic"]')).not.toBeNull()
  })

  it('collapses a finished turn into a summary that expands on request, with each step\u2019s real time', async () => {
    let state = applyActivity(emptyActivity(), event('Running npm test', 'running', '1', 'command'), 1000)
    state = applyActivity(state, event('Running npm test', 'completed', '1', 'command'), 4000)
    state = applyActivity(state, event('Editing styles.css', 'completed', '2', 'edit'), 5000)
    render(<ActivitySummary activity={state} />)

    expect(screen.getByText('Ran 1 command, edited 1 file')).toBeInTheDocument()
    expect(screen.queryByText('Running npm test')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /Ran 1 command/ }))
    expect(screen.getByText('Running npm test')).toBeInTheDocument()
    expect(screen.getByText('3s')).toBeInTheDocument()
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
        identity={{ provider: 'gemini', name: '3.8 Flash' }}
        stopping={false}
        pendingInteraction={null}
        unavailableInteraction={null}
        staleInteraction={false}
        respondingInteractionId={null}
        resolvedRecords={[]}
        onRespond={vi.fn()}
        {...props}
      />
    )

  it('holds an animated assistant bubble open before the first token arrives, named after the working model', () => {
    const { container } = session()

    expect(screen.getByText('3.8 Flash is replying')).toBeInTheDocument()
    expect(container.querySelectorAll('.typing-dot')).toHaveLength(3)
    // The wait happens on the assistant's side, where the answer will land.
    expect(container.querySelector('.chat-row-assistant .chat-bubble-pending')).not.toBeNull()
  })

  it('marks the working turn with the model\u2019s own logo, never Orbit\u2019s', () => {
    const { container } = session()
    const mark = container.querySelector('.chat-mark')

    expect(mark).toHaveAttribute('data-provider', 'gemini')
    expect(mark!.querySelector('[data-provider="gemini"]')).not.toBeNull()
    // Orbit's own Saturn mark stands for the app, not for the AI.
    expect(container.querySelector('.orbit-logo')).toBeNull()
  })

  it('says which vendor is answering for Claude and for OpenAI too', () => {
    const claude = session({ identity: { provider: 'anthropic', name: 'Claude Opus 4.6' } })
    expect(screen.getByText('Claude Opus 4.6 is replying')).toBeInTheDocument()
    expect(claude.container.querySelector('.chat-mark')).toHaveAttribute('data-provider', 'anthropic')
    claude.unmount()

    const openai = session({ identity: { provider: 'openai', name: 'GPT-5 Codex' } })
    expect(screen.getByText('GPT-5 Codex is replying')).toBeInTheDocument()
    expect(openai.container.querySelector('.chat-mark')).toHaveAttribute('data-provider', 'openai')
  })

  it('draws a neutral mark, not a guessed vendor, when the model is Antigravity\u2019s own default', () => {
    const { container } = session({ identity: { provider: null, name: 'Antigravity' } })

    expect(screen.getByText('Antigravity is replying')).toBeInTheDocument()
    expect(container.querySelector('.chat-mark')).toHaveAttribute('data-provider', 'unknown')
    expect(container.querySelector('.chat-mark [data-provider="unknown"]')).not.toBeNull()
  })

  it('states a deliberate stop as a stop, while the run finishes tearing down', () => {
    session({ stopping: true })

    expect(screen.getByText('Stopping…')).toBeInTheDocument()
    expect(screen.getAllByText('Stopping').length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toMatch(/couldn’t be read|went wrong|try again/i)
  })

  it('says working, not replying, once tool steps are running', () => {
    const activity = applyActivity(emptyActivity(), {
      type: 'tool.activity',
      projectId: 'p',
      conversationId: 'c',
      runId: 'r',
      providerId: 'antigravity',
      createdAt: new Date().toISOString(),
      label: 'Running npm test',
      status: 'running',
      kind: 'command',
      providerStepId: '1'
    })
    const { container } = session({ activityByRun: { r: activity } })

    expect(screen.getByText('3.8 Flash is working')).toBeInTheDocument()
    // Tool detail is subordinate to the reply, not a peer of it — and it
    // carries the real command, not a restatement of "working".
    expect(container.querySelector('.chat-aside .activity-live')).not.toBeNull()
    expect(screen.getByText('Running npm test')).toBeInTheDocument()
  })

  it('drops back to replying once every step has finished', () => {
    let activity = applyActivity(emptyActivity(), {
      type: 'tool.activity',
      projectId: 'p',
      conversationId: 'c',
      runId: 'r',
      providerId: 'antigravity',
      createdAt: new Date().toISOString(),
      label: 'Running npm test',
      status: 'running',
      kind: 'command',
      providerStepId: '1'
    })
    activity = finalizeActivity(activity)

    session({ activityByRun: { r: activity } })
    expect(screen.getByText('3.8 Flash is replying')).toBeInTheDocument()
  })

  it('does not draw the subordinate rail for a run that has recorded no steps', () => {
    // Every run starts with an empty activity state. Treating that as
    // evidence of tool work drew an empty rail and claimed "working"
    // before anything had actually run.
    const { container } = session({ activityByRun: { r: emptyActivity() } })

    expect(container.querySelector('.chat-aside')).toBeNull()
    expect(screen.getByText('3.8 Flash is replying')).toBeInTheDocument()
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
