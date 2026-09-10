// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/app/App'
import type { OrbitApi } from '../../src/shared/contracts'
import type { Conversation, Message, ModelOption, OrbitPreferences, Project, ProjectSnapshot, ProviderStatus, Run } from '../../src/shared/domain'
import type { RuntimeEvent } from '../../src/shared/runtime-events'

/** Every Orbit launch opens a new blank chat.
 *
 *  Two rules are being held here at once, and they pull against each other:
 *  the user must never be dropped back into a half-finished conversation
 *  they did not ask to resume, and Orbit must not litter their history with
 *  an empty session every time they open the app. The blank chat is
 *  therefore a renderer-side draft with no database row behind it, and the
 *  row is created by the first message and nothing else. */

const PROJECT: Project = { id: 'project_1', name: 'Orbit', rootPath: '/home/dev/orbit', createdAt: 'now', updatedAt: 'now' }
const OTHER: Project = { id: 'project_2', name: 'Sandbox', rootPath: '/home/dev/sandbox', createdAt: 'now', updatedAt: 'now' }

const MODELS: ModelOption[] = [
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', supportedReasoningEfforts: ['low', 'medium', 'high'] },
  { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', supportedReasoningEfforts: ['low', 'high'] },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' }
]

function conversation(overrides: Partial<Conversation> & { id: string; projectId: string; title: string }): Conversation {
  return {
    providerId: 'antigravity',
    nativeConversationId: null,
    status: 'idle',
    transport: 'structured',
    model: 'gemini-3.8-flash',
    reasoningEffort: 'medium',
    workingDirectory: null,
    createdAt: 'now',
    updatedAt: 'now',
    ...overrides
  }
}

const YESTERDAY = conversation({ id: 'conversation_1', projectId: 'project_1', title: 'Yesterday’s work' })
const OLDER = conversation({ id: 'conversation_2', projectId: 'project_1', title: 'Older thread' })

function message(conversationId: string, content: string): Message {
  return {
    id: `m-${conversationId}`,
    projectId: 'project_1',
    conversationId,
    runId: null,
    role: 'user',
    content,
    status: 'completed',
    sequence: 1,
    createdAt: 'now',
    updatedAt: 'now'
  }
}

describe('every launch opens a new blank chat', () => {
  let api: OrbitApi
  let sessions: Record<string, Conversation[]>
  let messages: Message[]
  let created: number
  let preferences: OrbitPreferences

  const RUN: Run = {
    id: 'run_1',
    projectId: 'project_1',
    conversationId: 'conversation_new_1',
    providerId: 'antigravity',
    state: 'running',
    startedAt: 'now',
    endedAt: null,
    cancellationRequestedAt: null,
    nativeRunId: null,
    error: null,
    metadata: {}
  }

  const snapshotFor = (project: Project): ProjectSnapshot => ({
    project,
    conversations: sessions[project.id] ?? [],
    messages: messages.filter((item) => (sessions[project.id] ?? []).some((session) => session.id === item.conversationId)),
    runs: [],
    artifacts: [],
    artifactVersions: [],
    projectFiles: [],
    references: []
  })

  beforeEach(() => {
    window.localStorage.clear()
    created = 0
    preferences = { defaultModel: null, lastReasoningEffort: null, modelReasoningEfforts: {} }
    sessions = { project_1: [YESTERDAY, OLDER], project_2: [] }
    messages = [message('conversation_1', 'What we talked about yesterday'), message('conversation_2', 'An older thread')]
    const providerStatus: ProviderStatus = {
      id: 'antigravity',
      state: 'ready',
      sdkAvailable: true,
      authConfigured: true,
      message: null,
      details: {}
    }
    api = {
      system: { status: vi.fn() },
      providers: { status: vi.fn(async () => providerStatus) },
      projects: {
        list: vi.fn(async () => [PROJECT, OTHER]),
        tree: vi.fn(async () => [
          { project: PROJECT, conversations: sessions.project_1 ?? [] },
          { project: OTHER, conversations: sessions.project_2 ?? [] }
        ]),
        create: vi.fn(),
        open: vi.fn(async (projectId) => snapshotFor(projectId === 'project_2' ? OTHER : PROJECT)),
        setRoot: vi.fn()
      },
      dialog: { pickFolder: vi.fn() },
      preferences: {
        get: vi.fn(async () => preferences),
        set: vi.fn(async (next) => {
          preferences = next
          return next
        })
      },
      conversations: {
        create: vi.fn(async (input) => {
          created += 1
          const made = conversation({
            id: `conversation_new_${created}`,
            projectId: input.projectId,
            title: 'New Session',
            model: null,
            reasoningEffort: null
          })
          sessions[input.projectId] = [made, ...(sessions[input.projectId] ?? [])]
          return made
        }),
        rename: vi.fn(),
        delete: vi.fn(),
        setTransport: vi.fn(async () => YESTERDAY),
        setModel: vi.fn(async (input) => {
          const list = sessions[PROJECT.id] ?? []
          const index = list.findIndex((item) => item.id === input.conversationId)
          if (index !== -1) list[index] = { ...list[index]!, model: input.model, reasoningEffort: input.reasoningEffort }
          return list[index] ?? YESTERDAY
        }),
        setWorkingDirectory: vi.fn()
      },
      models: { list: vi.fn(async () => MODELS) },
      messages: { send: vi.fn(async () => RUN) },
      runs: { cancel: vi.fn(), onEvent: vi.fn((_next: (event: RuntimeEvent) => void) => () => undefined) },
      interactions: { respond: vi.fn() },
      files: {
        attach: vi.fn(),
        attachPaths: vi.fn(),
        attachImage: vi.fn(),
        thumbnail: vi.fn(async () => null),
        pathForFile: vi.fn(() => null)
      },
      artifacts: { list: vi.fn(), import: vi.fn(), getContent: vi.fn(), reveal: vi.fn() },
      references: { create: vi.fn() }
    }
    Object.defineProperty(window, 'orbit', { value: api, configurable: true })
  })

  /** One launch of the app, composer ready. */
  const launch = async (): Promise<void> => {
    render(<App />)
    await screen.findByText('Projects')
    await screen.findByLabelText('Message Antigravity')
  }

  it('opens on a blank new chat rather than the conversation last being read', async () => {
    await launch()

    expect(screen.getByRole('heading', { name: 'What should we work on?' })).toBeInTheDocument()
    // Nothing from any stored conversation is on screen.
    expect(screen.queryByText('What we talked about yesterday')).not.toBeInTheDocument()
    expect(screen.queryByText('An older thread')).not.toBeInTheDocument()
  })

  it('does not auto-select the most recent conversation', async () => {
    await launch()

    for (const title of [/^Yesterday’s work/, /^Older thread/]) {
      expect(screen.getByRole('button', { name: title })).not.toHaveAttribute('aria-current')
    }
    expect(document.querySelector('.session-row.active')).toBeNull()
  })

  it('keeps the whole history visible in the sidebar', async () => {
    await launch()

    expect(screen.getByRole('button', { name: /^Yesterday’s work/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Older thread/ })).toBeInTheDocument()
    expect(sessions.project_1).toHaveLength(2)
  })

  it('creates nothing at all on launch — an untouched blank chat leaves no trace', async () => {
    await launch()

    expect(api.conversations.create).not.toHaveBeenCalled()
    expect(api.messages.send).not.toHaveBeenCalled()
    expect(sessions.project_1).toHaveLength(2)
  })

  it('leaves no junk behind across repeated launches', async () => {
    for (let run = 0; run < 3; run++) {
      await launch()
      expect(screen.getByRole('heading', { name: 'What should we work on?' })).toBeInTheDocument()
      cleanup()
    }

    // Three launches, no messages sent, no history growth.
    expect(api.conversations.create).not.toHaveBeenCalled()
    expect(sessions.project_1).toHaveLength(2)
  })

  it('opens an existing conversation when the user asks for it, and only then', async () => {
    await launch()
    await userEvent.click(screen.getByRole('button', { name: /^Yesterday’s work/ }))

    expect(await screen.findByText('What we talked about yesterday')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'What should we work on?' })).not.toBeInTheDocument()
    // Resuming a conversation is not a reason to create one.
    expect(api.conversations.create).not.toHaveBeenCalled()
  })

  it('persists the conversation on the first message, and only on the first message', async () => {
    await launch()
    expect(api.conversations.create).not.toHaveBeenCalled()

    await userEvent.type(screen.getByLabelText('Message Antigravity'), 'start something new')
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => expect(api.conversations.create).toHaveBeenCalledWith({ projectId: 'project_1' }))
    await waitFor(() =>
      expect(api.messages.send).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'project_1', conversationId: 'conversation_new_1', content: 'start something new' })
      )
    )
    expect(api.conversations.create).toHaveBeenCalledTimes(1)
  })

  it('gives the session it creates a concrete model, never the retired no-model state', async () => {
    await launch()
    await userEvent.type(screen.getByLabelText('Message Antigravity'), 'start something new')
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() =>
      expect(api.conversations.setModel).toHaveBeenCalledWith({
        conversationId: 'conversation_new_1',
        model: 'gemini-3.8-flash',
        reasoningEffort: 'medium'
      })
    )
  })

  it('carries a model chosen before the first word onto the session that gets created', async () => {
    await launch()
    const trigger = screen.getByLabelText('Model and reasoning')
    await waitFor(() => expect(trigger).toBeEnabled())
    await userEvent.click(trigger)
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Gemini 3\.1 Pro/ }))
    // Chosen on a session that does not exist yet, so nothing is written.
    expect(api.conversations.setModel).not.toHaveBeenCalled()
    expect(trigger).toHaveTextContent('3.1 Pro')

    await userEvent.type(screen.getByLabelText('Message Antigravity'), 'go')
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() =>
      expect(api.conversations.setModel).toHaveBeenCalledWith({
        conversationId: 'conversation_new_1',
        model: 'gemini-3.1-pro',
        // Pro publishes no medium, and Orbit refuses to invent one.
        reasoningEffort: 'low'
      })
    )
  })

  it('carries an approval escalation chosen before the first word too', async () => {
    await launch()
    await userEvent.click(screen.getByLabelText('Approvals: No approval prompts'))
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Ask when needed/ }))
    expect(api.conversations.setTransport).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Approvals: Ask when needed')).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText('Message Antigravity'), 'go')
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() =>
      expect(api.conversations.setTransport).toHaveBeenCalledWith({ conversationId: 'conversation_new_1', transport: 'pty' })
    )
  })

  it('keeps the project context the blank chat was started in', async () => {
    await launch()

    // A fresh conversation is not a forgotten working folder.
    const trigger = screen.getByLabelText('Project: Orbit')
    expect(trigger).toHaveTextContent('Orbit')
    await userEvent.click(trigger)
    expect(within(screen.getByRole('dialog', { name: 'Project' })).getByText('/home/dev/orbit')).toBeInTheDocument()
  })

  it('creates the conversation in the project the blank chat belongs to', async () => {
    await launch()
    // Move to the other project first, then send.
    await userEvent.click(screen.getByLabelText('Project: Orbit'))
    const popover = screen.getByRole('dialog', { name: 'Project' })
    await userEvent.click(within(popover).getByRole('button', { name: /Sandbox/ }))
    await waitFor(() => expect(screen.getByLabelText('Project: Sandbox')).toBeInTheDocument())
    // Sandbox has no sessions at all, so the blank chat has to survive the
    // move rather than leaving nothing to type into.
    expect(screen.getByLabelText('Message Antigravity')).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText('Message Antigravity'), 'in the sandbox')
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => expect(api.conversations.create).toHaveBeenCalledWith({ projectId: 'project_2' }))
  })

  it('still creates a session immediately from New session, which is an explicit ask', async () => {
    await launch()
    await userEvent.click(screen.getByLabelText('New session in Orbit'))

    await waitFor(() => expect(api.conversations.create).toHaveBeenCalledWith({ projectId: 'project_1' }))
    expect(await screen.findByRole('button', { name: /^New Session/ })).toBeInTheDocument()
    // And the blank draft has given way to it.
    expect(screen.queryByRole('heading', { name: 'What should we work on?' })).toBeInTheDocument()
  })

  it('settles a legacy session that names no model onto a concrete one when opened', async () => {
    const legacy = conversation({ id: 'conversation_3', projectId: 'project_1', title: 'Legacy', model: null, reasoningEffort: null })
    sessions.project_1 = [legacy]
    messages = []
    await launch()
    await userEvent.click(screen.getByRole('button', { name: /^Legacy/ }))

    await waitFor(() =>
      expect(api.conversations.setModel).toHaveBeenCalledWith({
        conversationId: 'conversation_3',
        model: 'gemini-3.8-flash',
        reasoningEffort: 'medium'
      })
    )
  })
})
