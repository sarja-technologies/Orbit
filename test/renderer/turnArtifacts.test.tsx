// @vitest-environment jsdom
// Files a turn produced, as the user sees them in the conversation: under
// the reply that produced them, as an image preview or a compact card, with
// OS actions that name the artifact by id and nothing else.
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactActionResult, ArtifactSummary } from '../../src/shared/contracts'
import type { Artifact, Conversation, Message, Run } from '../../src/shared/domain'
import { ORBIT_DEFAULT_MODEL_ID } from '../../src/shared/defaultModel'
import { WorkSession } from '../../src/renderer/app/components/WorkSession'
import { clearArtifactSummaryCache } from '../../src/renderer/app/components/TurnArtifacts'

const PREVIEW = 'data:image/png;base64,iVBORw0KGgo='

function artifact(id: string, name: string, runId: string | null, overrides: Partial<Artifact> = {}): Artifact {
  return {
    id,
    projectId: null,
    creatorConversationId: 'c',
    creatorRunId: runId,
    type: name.endsWith('.png') ? 'image' : 'other',
    name,
    source: 'provider',
    location: `/Users/someone/Library/Application Support/Orbit/conversations/c/artifacts/${id}-${name}`,
    previewKind: name.endsWith('.png') ? 'image' : 'metadata',
    mimeType: null,
    metadata: { originalPath: `/Users/someone/work/${name}` },
    createdAt: `2026-09-13T10:00:0${id.slice(-1)}.000Z`,
    updatedAt: '2026-09-13T10:00:00.000Z',
    currentVersionId: null,
    ...overrides
  }
}

const conversation: Conversation = {
  id: 'c',
  projectId: null,
  title: 'Session',
  providerId: 'antigravity',
  nativeConversationId: null,
  status: 'idle',
  transport: 'pty',
  model: ORBIT_DEFAULT_MODEL_ID,
  permissionMode: 'ask',
  reasoningEffort: null,
  workingDirectory: null,
  createdAt: '2026-09-13T10:00:00.000Z',
  updatedAt: '2026-09-13T10:00:00.000Z'
}

function message(id: string, role: Message['role'], content: string, runId: string | null, status: Message['status'] = 'completed', sequence = 1): Message {
  return { id, projectId: null, conversationId: 'c', runId, role, content, status, createdAt: '2026-09-13T10:00:00.000Z', updatedAt: '2026-09-13T10:00:00.000Z', sequence }
}

function run(id: string, state: Run['state'] = 'completed'): Run {
  return { id, projectId: null, conversationId: 'c', providerId: 'antigravity', state, startedAt: '', endedAt: '', cancellationRequestedAt: null, nativeRunId: null, error: null, metadata: {} }
}

let summaries: Record<string, ArtifactSummary>
let api: { describe: ReturnType<typeof vi.fn>; open: ReturnType<typeof vi.fn>; reveal: ReturnType<typeof vi.fn>; getContent: ReturnType<typeof vi.fn> }

beforeEach(() => {
  clearArtifactSummaryCache()
  summaries = {}
  api = {
    describe: vi.fn(async (id: string) => summaries[id]),
    open: vi.fn(async (): Promise<ArtifactActionResult> => ({ ok: true })),
    reveal: vi.fn(async (): Promise<ArtifactActionResult> => ({ ok: true })),
    getContent: vi.fn(async (id: string) => ({ artifactId: id, previewKind: 'image', name: 'x', mimeType: 'image/png', available: true, byteSize: 10, dataUrl: 'data:image/png;base64,FULL' }))
  }
  ;(window as unknown as { orbit: unknown }).orbit = { artifacts: api }
})

afterEach(() => {
  delete (window as unknown as { orbit?: unknown }).orbit
})

function available(id: string, overrides: Partial<ArtifactSummary> = {}): ArtifactSummary {
  return { artifactId: id, available: true, byteSize: 2048, previewDataUrl: null, canOpen: true, canReveal: true, ...overrides }
}

function renderSession(messages: Message[], artifacts: Artifact[], runs: Run[] = [run('r1')]) {
  return render(
    <WorkSession
      project={null}
      conversation={conversation}
      messages={messages}
      runs={runs}
      projectFiles={[]}
      artifacts={artifacts}
      thumbnails={{}}
      activeRunId={null}
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
    />
  )
}

const turn = [message('u1', 'user', 'Create a PNG of a mountain', null, 'completed', 1), message('a1', 'assistant', 'Here is your mountain.', 'r1', 'completed', 2)]

describe('an image the turn produced', () => {
  it('appears as a preview directly under the reply that produced it', async () => {
    summaries.x1 = available('x1', { previewDataUrl: PREVIEW })
    const { container } = renderSession(turn, [artifact('x1', 'mountain.png', 'r1')])

    const image = await screen.findByRole('img', { name: 'mountain.png' })
    expect(image).toHaveAttribute('src', PREVIEW)
    // In the assistant's turn, after its bubble.
    const turnEl = image.closest('.turn')!
    expect(turnEl.querySelector('.chat-row-assistant')).not.toBeNull()
    expect(turnEl.querySelector('.chat-row-assistant')!.compareDocumentPosition(image) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // No filesystem path is drawn anywhere.
    expect(container.textContent).not.toContain('/Users/someone')
  })

  it('opens larger on click, loading the full image only then', async () => {
    const user = userEvent.setup()
    summaries.x1 = available('x1', { previewDataUrl: PREVIEW })
    renderSession(turn, [artifact('x1', 'mountain.png', 'r1')])

    expect(api.getContent).not.toHaveBeenCalled()
    await user.click(await screen.findByRole('button', { name: 'View mountain.png larger' }))

    const dialog = await screen.findByRole('dialog', { name: 'mountain.png' })
    await waitFor(() => expect(within(dialog).getByRole('img', { name: 'mountain.png' })).toHaveAttribute('src', 'data:image/png;base64,FULL'))
    expect(api.getContent).toHaveBeenCalledWith('x1')
  })

  it('offers Open and Show in folder, which send only the artifact id', async () => {
    const user = userEvent.setup()
    summaries.x1 = available('x1', { previewDataUrl: PREVIEW })
    renderSession(turn, [artifact('x1', 'mountain.png', 'r1')])

    await user.click(await screen.findByRole('button', { name: 'Open' }))
    await user.click(screen.getByRole('button', { name: /Show in (Finder|folder)/ }))

    expect(api.open).toHaveBeenCalledWith('x1')
    expect(api.reveal).toHaveBeenCalledWith('x1')
  })
})

describe('a non-image output', () => {
  it('is a compact card with its name, type and size', async () => {
    summaries.x1 = available('x1', { byteSize: 1536 })
    renderSession(turn, [artifact('x1', 'report.pdf', 'r1')])

    expect(await screen.findByText('report.pdf')).toBeInTheDocument()
    expect(await screen.findByText(/PDF document · 2 KB/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument()
  })
})

describe('a file that no longer exists', () => {
  it('says so instead of breaking the conversation', async () => {
    summaries.x1 = { artifactId: 'x1', available: false, byteSize: 900, previewDataUrl: null, canOpen: false, canReveal: false }
    renderSession(turn, [artifact('x1', 'mountain.png', 'r1')])

    expect(await screen.findByText('No longer available')).toBeInTheDocument()
    expect(screen.getByText('mountain.png')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull()
    expect(screen.getByText('Here is your mountain.')).toBeInTheDocument()
  })

  it('flips to unavailable when an action finds the file gone', async () => {
    const user = userEvent.setup()
    summaries.x1 = available('x1')
    api.open.mockResolvedValue({ ok: false, reason: 'missing' })
    renderSession(turn, [artifact('x1', 'report.pdf', 'r1')])

    await user.click(await screen.findByRole('button', { name: 'Open' }))
    expect(await screen.findByText('This file is no longer available.')).toBeInTheDocument()
  })
})

describe('association with turns', () => {
  it('keeps each output under its own turn', async () => {
    summaries.x1 = available('x1')
    summaries.x2 = available('x2')
    const messages = [
      message('u1', 'user', 'First', null, 'completed', 1),
      message('a1', 'assistant', 'First reply', 'r1', 'completed', 2),
      message('u2', 'user', 'Second', null, 'completed', 3),
      message('a2', 'assistant', 'Second reply', 'r2', 'completed', 4)
    ]
    renderSession(messages, [artifact('x1', 'one.pdf', 'r1'), artifact('x2', 'two.pdf', 'r2')], [run('r1'), run('r2')])

    const first = (await screen.findByText('one.pdf')).closest('.turn')!
    const second = (await screen.findByText('two.pdf')).closest('.turn')!
    expect(within(first as HTMLElement).getByText('First reply')).toBeInTheDocument()
    expect(within(second as HTMLElement).getByText('Second reply')).toBeInTheDocument()
  })

  it('does not draw a user import in the conversation', () => {
    renderSession(turn, [artifact('x1', 'brief.pdf', null, { source: 'user-import' })])
    expect(screen.queryByText('brief.pdf')).toBeNull()
  })

  it('still shows what a stopped turn finished producing', async () => {
    summaries.x1 = available('x1')
    renderSession([message('u1', 'user', 'Go', null, 'completed', 1), message('a1', 'assistant', 'Request cancelled.', 'r1', 'cancelled', 2)], [artifact('x1', 'done.pdf', 'r1')], [run('r1', 'cancelled')])

    expect(screen.getByText('You stopped this response')).toBeInTheDocument()
    expect(await screen.findByText('done.pdf')).toBeInTheDocument()
  })

  it('does not claim the turn had nothing to show when it produced files', async () => {
    summaries.x1 = available('x1')
    renderSession([message('u1', 'user', 'Go', null, 'completed', 1), message('a1', 'assistant', '', 'r1', 'completed', 2)], [artifact('x1', 'out.zip', 'r1')])

    expect(await screen.findByText('out.zip')).toBeInTheDocument()
    expect(screen.queryByText('This turn finished without any text to show.')).toBeNull()
  })
})
