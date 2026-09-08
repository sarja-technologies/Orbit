// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
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
