// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/app/App'
import type { OrbitApi } from '../../src/shared/contracts'
import type { Conversation, Message, Project, ProjectSnapshot, ProviderStatus, Run } from '../../src/shared/domain'
import type { RunEventListener, RuntimeEvent } from '../../src/shared/runtime-events'

const PROJECT: Project = { id: 'project_1', name: 'Orbit', rootPath: '/home/dev/orbit', createdAt: 'now', updatedAt: 'now' }
const SESSION: Conversation = {
  id: 'conversation_1',
  projectId: 'project_1',
  title: 'Main',
  providerId: 'antigravity',
  nativeConversationId: null,
  status: 'idle',
  transport: 'structured',
  model: null,
  reasoningEffort: 'medium',
  workingDirectory: null,
  createdAt: 'now',
  updatedAt: 'now'
}
const RUN: Run = {
  id: 'run_1',
  projectId: 'project_1',
  conversationId: 'conversation_1',
  providerId: 'antigravity',
  state: 'running',
  startedAt: 'now',
  endedAt: null,
  cancellationRequestedAt: null,
  nativeRunId: null,
  error: null,
  metadata: {}
}

const message = (id: string, role: Message['role'], content: string): Message => ({
  id,
  projectId: 'project_1',
  conversationId: 'conversation_1',
  runId: role === 'assistant' ? 'run_1' : null,
  role,
  content,
  status: 'completed',
  sequence: role === 'user' ? 1 : 2,
  createdAt: 'now',
  updatedAt: 'now'
})

const emit = (partial: Partial<RuntimeEvent> & { type: RuntimeEvent['type'] }, listener: RunEventListener): void => {
  act(() => listener(event(partial)))
}

const event = (partial: Partial<RuntimeEvent> & { type: RuntimeEvent['type'] }): RuntimeEvent =>
  ({
    projectId: 'project_1',
    conversationId: 'conversation_1',
    runId: 'run_1',
    providerId: 'antigravity',
    createdAt: 'now',
    ...partial
  }) as RuntimeEvent

describe('streaming hand-off to the persisted assistant message', () => {
  let api: OrbitApi
  let listener: RunEventListener | null
  let messages: Message[]
  /** Lets a test hold the post-completion project refresh open, which is
   *  exactly the window the streamed answer used to vanish in. */
  let releaseOpen: (() => void) | null

  const snapshot = (): ProjectSnapshot => ({
    project: PROJECT,
    conversations: [SESSION],
    messages: [...messages],
    runs: [RUN],
    artifacts: [],
    artifactVersions: [],
    projectFiles: [],
    references: []
  })

  beforeEach(() => {
    window.localStorage.clear()
    listener = null
    releaseOpen = null
    messages = []
    const providerStatus: ProviderStatus = {
      id: 'antigravity',
      state: 'ready',
      sdkAvailable: true,
      authConfigured: true,
      message: 'Antigravity · Ready',
      details: {}
    }
    api = {
      system: { status: vi.fn() },
      providers: { status: vi.fn(async () => providerStatus) },
      projects: {
        list: vi.fn(async () => [PROJECT]),
        tree: vi.fn(async () => [{ project: PROJECT, conversations: [SESSION] }]),
        create: vi.fn(),
        open: vi.fn(async () => {
          if (releaseOpen) await new Promise<void>((resolve) => { releaseOpen = resolve })
          return snapshot()
        }),
        setRoot: vi.fn()
      },
      dialog: { pickFolder: vi.fn() },
      preferences: { get: vi.fn(async () => ({ lastReasoningEffort: null, modelReasoningEfforts: {} })), set: vi.fn(async (next) => next) },
      conversations: { create: vi.fn(), rename: vi.fn(), delete: vi.fn(), setTransport: vi.fn(), setModel: vi.fn(), setWorkingDirectory: vi.fn() },
      models: { list: vi.fn(async () => []) },
      messages: { send: vi.fn(async () => RUN) },
      runs: {
        cancel: vi.fn(),
        onEvent: vi.fn((next: RunEventListener) => {
          listener = next
          return () => undefined
        })
      },
      interactions: { respond: vi.fn() },
      files: { attach: vi.fn(), attachPaths: vi.fn(), attachImage: vi.fn(), thumbnail: vi.fn(async () => null), pathForFile: vi.fn(() => null) },
      artifacts: { list: vi.fn(), import: vi.fn(), getContent: vi.fn(), reveal: vi.fn() },
      references: { create: vi.fn() }
    }
    Object.defineProperty(window, 'orbit', { value: api, configurable: true })
  })

  const startRun = async (): Promise<void> => {
    render(<App />)
    await screen.findByText('Projects')
    await userEvent.type(screen.getByRole('textbox', { name: /message/i }), 'Tell me about bicycles')
    await userEvent.click(screen.getByRole('button', { name: /send/i }))
    await waitFor(() => expect(api.messages.send).toHaveBeenCalled())
  }

  it('renders assistant text as deltas arrive, before the run completes', async () => {
    await startRun()

    emit({ type: 'text.delta', delta: 'The bicycle stands ' } as Partial<RuntimeEvent> & { type: 'text.delta' }, listener!)
    emit({ type: 'text.delta', delta: 'as one of the most efficient machines ever built.' } as Partial<RuntimeEvent> & { type: 'text.delta' }, listener!)

    expect(await screen.findByText(/The bicycle stands as one of the most efficient machines ever built\./)).toBeInTheDocument()
  })

  it('never blanks the streamed answer while the completed turn is being loaded', async () => {
    await startRun()
    emit({ type: 'text.delta', delta: 'A complete answer.' } as Partial<RuntimeEvent> & { type: 'text.delta' }, listener!)
    await screen.findByText('A complete answer.')

    // Hold the refresh open, exactly as a slow round trip would.
    releaseOpen = () => undefined
    messages = [message('m1', 'user', 'Tell me about bicycles'), message('m2', 'assistant', 'A complete answer.')]
    emit({ type: 'run.completed', finalText: 'A complete answer.', nativeConversationId: null } as Partial<RuntimeEvent> & { type: 'run.completed' }, listener!)

    // The reply is still on screen while the stored message is in flight —
    // this is the regression: it used to disappear for the whole round trip.
    await waitFor(() => expect(releaseOpen).not.toBe(null))
    expect(screen.getByText('A complete answer.')).toBeInTheDocument()

    releaseOpen!()
    // And once the stored message lands, exactly one copy remains.
    await waitFor(() => expect(screen.getAllByText('A complete answer.')).toHaveLength(1))
  })

  it('keeps a late permission prompt visible when it arrives during the completion refresh', async () => {
    // The exact ordering the review flagged. Antigravity reads the PTY screen
    // asynchronously, so a prompt can arrive after the turn reported
    // complete — while the refresh that completion started is still in
    // flight. That refresh's cleanup used to retire the very run the prompt
    // had just reclaimed, hiding a question the user has to answer and
    // leaving the session wedged behind it.
    await startRun()
    emit({ type: 'text.delta', delta: 'Working on it.' } as Partial<RuntimeEvent> & { type: 'text.delta' }, listener!)
    await screen.findByText('Working on it.')

    // 3. hold the refresh open.
    releaseOpen = () => undefined
    messages = [message('m1', 'user', 'Tell me about bicycles'), message('m2', 'assistant', 'Working on it.')]

    // 4. completion starts the refresh.
    emit({ type: 'run.completed', finalText: 'Working on it.', nativeConversationId: null } as Partial<RuntimeEvent> & { type: 'run.completed' }, listener!)
    await waitFor(() => expect(releaseOpen).not.toBe(null))

    // 5. the late prompt arrives before the refresh resolves.
    emit(
      {
        type: 'interaction.required',
        interactionId: 'run_1:pty:1',
        kind: 'permission',
        prompt: 'Requesting permission for:\nrm -rf build\n\nDo you want to proceed?',
        options: [
          { id: '1', label: 'Yes' },
          { id: '2', label: 'No' }
        ],
        transport: 'pty',
        canRespond: true,
        sourceEvidence: 'native-prompt'
      } as Partial<RuntimeEvent> & { type: 'interaction.required' },
      listener!
    )
    const card = await screen.findByRole('group', { name: /approval/i })
    expect(within(card).getByText('rm -rf build')).toBeInTheDocument()

    // 6. release the refresh (and let later refreshes run unimpeded).
    const release = releaseOpen!
    releaseOpen = null
    release()

    // 7. the prompt must still be there, and still actionable.
    await waitFor(() => expect(screen.getAllByText('Working on it.').length).toBeGreaterThan(0))
    const survivor = screen.getByRole('group', { name: /approval/i })
    expect(within(survivor).getByText('rm -rf build'), 'the late prompt must survive the completion refresh').toBeInTheDocument()
    const approve = within(survivor).getAllByRole('button').find((button) => !(button as HTMLButtonElement).disabled)
    expect(approve, 'an actionable option').toBeDefined()

    // 8. answering it continues the normal lifecycle.
    await userEvent.click(approve!)
    await waitFor(() => expect(api.interactions.respond).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run_1', interactionId: 'run_1:pty:1' })))

    emit({ type: 'interaction.resolved', interactionId: 'run_1:pty:1', outcome: 'approved' } as Partial<RuntimeEvent> & { type: 'interaction.resolved' }, listener!)
    await waitFor(() => expect(screen.queryByRole('group', { name: /approval/i })).not.toBeInTheDocument())

    // The run is still live (the turn resumed), and the following completion
    // retires it for real.
    messages = [message('m1', 'user', 'Tell me about bicycles'), message('m2', 'assistant', 'Done.')]
    emit({ type: 'run.completed', finalText: 'Done.', nativeConversationId: null } as Partial<RuntimeEvent> & { type: 'run.completed' }, listener!)
    await waitFor(() => expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument())
  })

  it('returns the composer to Send once a stopped run reports itself cancelled', async () => {
    // The renderer half of "Stop means Stop". The backend answers a Stop
    // pressed during a model-change retirement immediately, so `run.cancelled`
    // can arrive without the run ever having produced a reply — the composer
    // must leave the Stop state, and the streamed text must hand over to the
    // persisted turn rather than lingering as a second copy.
    await startRun()
    emit({ type: 'text.delta', delta: 'Half an answ' } as Partial<RuntimeEvent> & { type: 'text.delta' }, listener!)
    await screen.findByText('Half an answ')

    await userEvent.click(screen.getByRole('button', { name: /stop generating/i }))
    expect(api.runs.cancel).toHaveBeenCalledWith({ runId: 'run_1' })
    // Nothing has come back yet, so the run is still live and still stoppable.
    expect(screen.getByRole('button', { name: /stop generating/i })).toBeInTheDocument()

    // The runtime persists what Antigravity had actually said, marked
    // cancelled — it does not invent a message announcing the stop.
    messages = [
      message('m1', 'user', 'Tell me about bicycles'),
      { ...message('m2', 'assistant', 'Half an answ'), status: 'cancelled' }
    ]
    emit({ type: 'run.cancelled' } as Partial<RuntimeEvent> & { type: 'run.cancelled' }, listener!)

    await waitFor(() => expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument())
    // The partial answer survived the stop, and there is exactly one of it.
    expect(screen.getAllByText('Half an answ')).toHaveLength(1)
    // A stop reads as the reader's own action, not as a failure.
    expect(screen.getByText('You stopped this response')).toBeInTheDocument()
    expect(screen.queryByText(/couldn’t be read/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/conversation is safe/i)).not.toBeInTheDocument()
  })

  it('lets the conversation continue straight after a stop', async () => {
    await startRun()
    emit({ type: 'text.delta', delta: 'Half an answ' } as Partial<RuntimeEvent> & { type: 'text.delta' }, listener!)
    await screen.findByText('Half an answ')
    await userEvent.click(screen.getByRole('button', { name: /stop generating/i }))

    messages = [
      message('m1', 'user', 'Tell me about bicycles'),
      { ...message('m2', 'assistant', 'Half an answ'), status: 'cancelled' }
    ]
    emit({ type: 'run.cancelled' } as Partial<RuntimeEvent> & { type: 'run.cancelled' }, listener!)
    await waitFor(() => expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument())

    // The composer is usable again immediately, in the same session.
    const composer = screen.getByRole('textbox', { name: /message/i })
    expect(composer).not.toBeDisabled()
    await userEvent.type(composer, 'Carry on then')
    await userEvent.click(screen.getByRole('button', { name: /send/i }))
    await waitFor(() => expect(api.messages.send).toHaveBeenCalledTimes(2))
    expect(vi.mocked(api.messages.send).mock.calls[1]![0]).toMatchObject({
      conversationId: 'conversation_1',
      content: 'Carry on then'
    })
  })

  it('does not let a failure that follows a stop overwrite the interruption', async () => {
    // The exact race: Stop kills agy, agy's death is then reported as a
    // transport failure. The interruption must stand.
    await startRun()
    await userEvent.click(screen.getByRole('button', { name: /stop generating/i }))

    messages = [
      message('m1', 'user', 'Tell me about bicycles'),
      { ...message('m2', 'assistant', ''), status: 'cancelled' }
    ]
    emit({ type: 'run.cancelled' } as Partial<RuntimeEvent> & { type: 'run.cancelled' }, listener!)
    await waitFor(() => expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument())

    // A late failure for the same run arrives. The runtime drops it (the run
    // is already terminal), so nothing further is stored — the transcript
    // still shows the stop, and never an error.
    emit(
      { type: 'run.failed', error: { code: 'provider.exited', message: 'exit 143', retryable: false } } as Partial<RuntimeEvent> & {
        type: 'run.failed'
      },
      listener!
    )
    await waitFor(() => expect(screen.getByText('You stopped this response')).toBeInTheDocument())
    expect(screen.queryByText(/session ended unexpectedly/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument()
  })

  it('keeps activity that arrived before the send round trip came back', async () => {
    // The provider starts working the moment `send` is dispatched in main,
    // so its first activity events can land while the renderer is still
    // awaiting the run. Seeding the run's activity unconditionally on the
    // way back threw those away, and the turn showed the fallback for work
    // Antigravity had already reported.
    let releaseSend: (() => void) | null = null
    api.messages.send = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseSend = resolve
      })
      return RUN
    })

    render(<App />)
    await screen.findByText('Projects')
    await userEvent.type(screen.getByRole('textbox', { name: /message/i }), 'Build it')
    await userEvent.click(screen.getByRole('button', { name: /send/i }))
    await waitFor(() => expect(releaseSend).not.toBe(null))

    // Activity arrives while the send is still in flight.
    emit(
      {
        type: 'tool.activity',
        label: 'run_command',
        status: 'running',
        providerStepId: '1',
        kind: 'running',
        command: 'npm run build'
      } as Partial<RuntimeEvent> & { type: 'tool.activity' },
      listener!
    )
    releaseSend!()

    // It survives, and it is what the turn says it is doing.
    expect(await screen.findByText('Running')).toBeInTheDocument()
    expect(screen.getAllByText('npm run build').length).toBeGreaterThan(0)
    expect(screen.queryByText('Working…')).not.toBeInTheDocument()
  })

  it('shows what Antigravity is doing, then the text, in that order', async () => {
    await startRun()

    // No evidence yet: the restrained fallback, never a claim to be replying.
    expect(screen.getByText('Working…')).toBeInTheDocument()

    emit(
      {
        type: 'tool.activity',
        label: 'view_file',
        status: 'running',
        providerStepId: '1',
        kind: 'reading',
        target: '/ws/src/App.tsx'
      } as Partial<RuntimeEvent> & { type: 'tool.activity' },
      listener!
    )
    expect(await screen.findByText('Reading App.tsx')).toBeInTheDocument()
    expect(screen.queryByText('Working…')).not.toBeInTheDocument()

    // Once text arrives it takes the bubble over, and the activity moves to
    // its own subordinate line rather than competing with the answer.
    emit({ type: 'text.delta', delta: 'Here is what I found.' } as Partial<RuntimeEvent> & { type: 'text.delta' }, listener!)
    expect(await screen.findByText('Here is what I found.')).toBeInTheDocument()
    expect(screen.getByText('Reading App.tsx')).toBeInTheDocument()
  })

  it('clears the live run once the refreshed transcript has taken over', async () => {
    await startRun()
    emit({ type: 'text.delta', delta: 'Answer.' } as Partial<RuntimeEvent> & { type: 'text.delta' }, listener!)
    messages = [message('m1', 'user', 'Tell me about bicycles'), message('m2', 'assistant', 'Answer.')]
    emit({ type: 'run.completed', finalText: 'Answer.', nativeConversationId: null } as Partial<RuntimeEvent> & { type: 'run.completed' }, listener!)

    // The composer goes back to Send rather than staying stuck on Stop.
    await waitFor(() => expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument())
    expect(screen.getAllByText('Answer.')).toHaveLength(1)
  })
})
