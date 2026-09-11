// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WorkSession } from '../../src/renderer/app/components/WorkSession'
import { summarizeActivity } from '../../src/renderer/app/lib/activity'
import { applyActivity, emptyActivity } from '../../src/renderer/app/lib/activity'
import { ORBIT_DEFAULT_MODEL_ID } from '../../src/shared/defaultModel'
import type { Conversation, Message, Project, Run } from '../../src/shared/domain'
import type { InteractionRequiredEvent, ToolActivityEvent } from '../../src/shared/runtime-events'

const project: Project = { id: 'p', name: 'Orbit', rootPath: null, createdAt: 'now', updatedAt: 'now' }

const conversation: Conversation = {
  id: 'c',
  projectId: 'p',
  title: 'Session',
  providerId: 'antigravity',
  nativeConversationId: null,
  status: 'running',
  transport: 'pty',
  model: ORBIT_DEFAULT_MODEL_ID,
  permissionMode: 'ask',
  reasoningEffort: null,
  workingDirectory: null,
  createdAt: 'now',
  updatedAt: 'now'
}

const IDENTITY = { provider: 'gemini' as const, name: '3.8 Flash' }

function activityWith(...events: Array<Partial<ToolActivityEvent> & { label: string; kind: ToolActivityEvent['kind'] }>) {
  let state = emptyActivity()
  events.forEach((event, index) => {
    state = applyActivity(state, {
      type: 'tool.activity',
      projectId: 'p',
      conversationId: 'c',
      runId: 'r',
      providerId: 'antigravity',
      createdAt: 'now',
      status: 'succeeded',
      providerStepId: String(index + 1),
      ...event
    } as ToolActivityEvent)
  })
  return state
}

const permission: InteractionRequiredEvent = {
  type: 'interaction.required',
  projectId: 'p',
  conversationId: 'c',
  runId: 'r',
  providerId: 'antigravity',
  createdAt: 'now',
  interactionId: 'r:pty:1',
  kind: 'permission',
  prompt: 'Create scratch.txt?',
  options: [
    { id: 'yes', label: 'Yes' },
    { id: 'no', label: 'No' }
  ],
  transport: 'pty',
  canRespond: true,
  sourceEvidence: 'native-prompt'
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
      identity={IDENTITY}
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

describe('the pending reply is one status, not two', () => {
  it('shows a single replying presentation', () => {
    const { container } = session()

    // One status row, and nothing that says the same thing again.
    expect(container.querySelectorAll('.chat-status')).toHaveLength(1)
    expect(screen.getAllByText(/is replying/)).toHaveLength(1)
    expect(screen.getByText('3.8 Flash is replying')).toBeInTheDocument()
  })

  it('no longer draws a Replying badge beside a replying bubble', () => {
    const { container } = session()

    // The old shape: a `Replying` pill in the identity line plus a pending
    // bubble underneath repeating it on a row that did not share an edge.
    expect(screen.queryByText('Replying')).not.toBeInTheDocument()
    expect(container.querySelector('.chat-bubble-pending')).toBeNull()
    expect(container.querySelectorAll('.chat-bubble')).toHaveLength(0)
  })

  it('keeps the status on the assistant content rail, with the mark in its own gutter', () => {
    const { container } = session()
    const row = container.querySelector('.chat-row-status')

    expect(row).not.toBeNull()
    expect(row!.querySelector('.chat-mark')).not.toBeNull()
    // The status is the row's content cell — the same cell a bubble uses —
    // rather than a separately indented block.
    expect(row!.querySelector('.chat-status')).not.toBeNull()
  })

  it('leaves no empty row behind once text starts streaming', () => {
    const { container } = session({ streamText: 'The answer begins' })

    // The pending status is gone, replaced by the real bubble.
    expect(container.querySelectorAll('.chat-status')).toHaveLength(0)
    expect(screen.queryByText(/is replying/)).not.toBeInTheDocument()
    expect(container.querySelector('.chat-bubble-assistant.is-streaming')).not.toBeNull()
  })

  it('claims no empty identity row when there is no identity line to draw', () => {
    const { container } = session()

    // The status row occupies the grid's only row: an unused first row
    // would still charge its row-gap, which is the dead space that made
    // the pending state look like two stacked lines.
    const row = container.querySelector('.chat-row-status')
    expect(row).not.toBeNull()
    expect(row!.querySelector('.chat-meta')).toBeNull()
    expect(row!.querySelectorAll(':scope > *')).toHaveLength(2)
  })

  it('states stopping on the same geometry, attributed to the model', () => {
    const { container } = session({ stopping: true })

    expect(container.querySelectorAll('.chat-status')).toHaveLength(1)
    expect(screen.getByText('Stopping…')).toBeInTheDocument()
    expect(screen.getByText('3.8 Flash')).toBeInTheDocument()
    expect(screen.queryByText(/is replying/)).not.toBeInTheDocument()
    expect(container.querySelector('.chat-row-status')).not.toBeNull()
  })

  it('says working, not replying, while a step is genuinely running', () => {
    const running = applyActivity(emptyActivity(), {
      type: 'tool.activity',
      projectId: 'p',
      conversationId: 'c',
      runId: 'r',
      providerId: 'antigravity',
      createdAt: 'now',
      label: 'Running npm run build',
      kind: 'command',
      status: 'running',
      providerStepId: '1'
    })
    const { container } = session({ activityByRun: { r: running } })

    expect(screen.getByText('3.8 Flash is working')).toBeInTheDocument()
    expect(container.querySelectorAll('.chat-status')).toHaveLength(1)
  })

  it('keeps the model identity that was handed to it', () => {
    const { container } = session({ identity: { provider: 'anthropic', name: 'Claude Opus 4.6' } })

    expect(screen.getByText('Claude Opus 4.6 is replying')).toBeInTheDocument()
    expect(container.querySelector('.chat-mark')).toHaveAttribute('data-provider', 'anthropic')
  })
})

describe('everything under the assistant turn shares one anchor', () => {
  it('puts the interaction card on the assistant rail', () => {
    const { container } = session({ pendingInteraction: permission })

    const rail = container.querySelector('.chat-rail')
    expect(rail).not.toBeNull()
    expect(rail!.querySelector('.interaction')).not.toBeNull()
  })

  it('puts an unavailable interaction on the same rail', () => {
    const { container } = session({
      unavailableInteraction: { ...permission, canRespond: false, sourceEvidence: 'headless-denial' }
    })

    expect(container.querySelector('.chat-rail .interaction')).not.toBeNull()
  })

  it('puts a stale-request error on the same rail', () => {
    const { container } = session({ staleInteraction: true })

    expect(container.querySelector('.chat-rail .error-note')).not.toBeNull()
  })

  it('hangs the live activity rail off the hairline aside, not a loose margin', () => {
    const { container } = session({
      activityByRun: { r: activityWith({ label: 'Listed src', kind: 'list' }) }
    })

    expect(container.querySelector('.chat-aside .activity')).not.toBeNull()
  })

  it('gives the collapsed summary the same aside as the assistant turn above it', () => {
    const message: Message = {
      id: 'm1',
      projectId: 'p',
      conversationId: 'c',
      runId: 'r',
      role: 'assistant',
      content: 'Here is what I found.',
      status: 'completed',
      sequence: 1,
      createdAt: 'now',
      updatedAt: 'now'
    }
    const run: Run = {
      id: 'r',
      projectId: 'p',
      conversationId: 'c',
      providerId: 'antigravity',
      state: 'completed',
      startedAt: 'now',
      endedAt: 'now',
      cancellationRequestedAt: null,
      nativeRunId: null,
      error: null,
      metadata: {}
    }
    const { container } = session({
      messages: [message],
      runs: [run],
      activeRunId: null,
      activityByRun: { r: activityWith({ label: 'Listed src', kind: 'list' }) }
    })

    const aside = container.querySelector('.chat-aside')
    expect(aside).not.toBeNull()
    expect(aside!.querySelector('.activity-summary')).not.toBeNull()
    // Same turn, so the summary and the reply are siblings under one anchor
    // rather than two independently indented blocks.
    expect(aside!.closest('.turn')?.querySelector('.chat-row-assistant')).not.toBeNull()
  })
})

describe('the collapsed activity summary reads naturally', () => {
  it('never says "Listed 1 listing"', () => {
    const summary = summarizeActivity(activityWith({ label: 'Listed src', kind: 'list' }))

    expect(summary).not.toMatch(/listing/i)
    expect(summary).toBe('Listed 1 folder')
  })

  it('pluralizes a repeated listing', () => {
    const summary = summarizeActivity(
      activityWith({ label: 'Listed src', kind: 'list' }, { label: 'Listed test', kind: 'list' }, { label: 'Listed docs', kind: 'list' })
    )

    expect(summary).toBe('Listed 3 folders')
  })

  it('keeps singular and plural right for every counted kind', () => {
    expect(summarizeActivity(activityWith({ label: 'Ran build', kind: 'command' }))).toBe('Ran 1 command')
    expect(summarizeActivity(activityWith({ label: 'Ran a', kind: 'command' }, { label: 'Ran b', kind: 'command' }))).toBe('Ran 2 commands')
    expect(summarizeActivity(activityWith({ label: 'Read a', kind: 'read' }))).toBe('Read 1 file')
    expect(summarizeActivity(activityWith({ label: 'Searched x', kind: 'search' }))).toBe('Searched 1 search')
  })

  it('never renders a doubled noun for any counted kind', () => {
    for (const kind of ['command', 'edit', 'read', 'search', 'list'] as const) {
      const one = summarizeActivity(activityWith({ label: 'Step', kind }))!
      // e.g. "listed 1 listing" / "read 1 read" — a noun that just repeats
      // its own verb is the bug this guards.
      const [verb, , noun] = one.split(' ')
      expect(noun!.toLowerCase()).not.toBe(verb!.toLowerCase())
    }
  })
})
