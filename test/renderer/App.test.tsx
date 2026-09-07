// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/app/App'
import type { OrbitApi } from '../../src/shared/contracts'
import type { ProjectSnapshot, ProviderStatus, Run } from '../../src/shared/domain'

describe('App', () => {
  let api: OrbitApi

  beforeEach(() => {
    const providerStatus: ProviderStatus = {
      id: 'antigravity',
      state: 'unavailable',
      sdkAvailable: false,
      authConfigured: false,
      message: 'Antigravity unavailable - authentication required',
      details: {}
    }
    const snapshot: ProjectSnapshot = {
      project: { id: 'project_1', name: 'Launch', createdAt: 'now', updatedAt: 'now' },
      conversations: [
        {
          id: 'conversation_1',
          projectId: 'project_1',
          title: 'Main',
          providerId: 'antigravity',
          nativeConversationId: null,
          status: 'idle',
          transport: 'structured',
          model: null,
          reasoningEffort: null,
          createdAt: 'now',
          updatedAt: 'now'
        }
      ],
      messages: [],
      runs: [],
      artifacts: [],
      artifactVersions: [],
      projectFiles: [],
      references: []
    }
    const run: Run = {
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
    api = {
      system: { status: vi.fn() },
      providers: {
        status: vi.fn(async () => providerStatus)
      },
      projects: {
        list: vi.fn(async () => []),
        create: vi.fn(async () => ({ id: 'project_1', name: 'Launch', createdAt: 'now', updatedAt: 'now' })),
        open: vi.fn(async () => snapshot)
      },
      conversations: {
        create: vi.fn(),
        rename: vi.fn(),
        delete: vi.fn(),
        setTransport: vi.fn(),
        setModel: vi.fn()
      },
      models: {
        list: vi.fn(async () => [])
      },
      messages: {
        send: vi.fn(async () => run)
      },
      runs: {
        cancel: vi.fn(),
        onEvent: vi.fn(() => () => undefined)
      },
      interactions: { respond: vi.fn() },
      files: {
        attach: vi.fn(),
        attachPaths: vi.fn(),
        attachImage: vi.fn(),
        thumbnail: vi.fn(async () => null),
        pathForFile: vi.fn(() => null)
      },
      artifacts: {
        list: vi.fn(),
        import: vi.fn(),
        getContent: vi.fn(),
        reveal: vi.fn()
      },
      references: { create: vi.fn() }
    }
    Object.defineProperty(window, 'orbit', { value: api, configurable: true })
  })

  it('mounts the product shell with sessions and a compact provider status', async () => {
    render(<App />)

    expect(await screen.findByText('Orbit')).toBeInTheDocument()
    expect(screen.getByText('Sessions')).toBeInTheDocument()
    // Provider identity is a compact status, never a permanent success banner.
    expect(screen.getByText('Antigravity')).toBeInTheDocument()
  })

  it('shows the composer once a session is open', async () => {
    vi.mocked(api.projects.list).mockResolvedValue([{ id: 'project_1', name: 'Launch', createdAt: 'now', updatedAt: 'now' }])
    render(<App />)

    expect(await screen.findByLabelText('Message Antigravity')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
  })

  it('invites the user into an empty session and fills the composer from a starter', async () => {
    vi.mocked(api.projects.list).mockResolvedValue([{ id: 'project_1', name: 'Launch', createdAt: 'now', updatedAt: 'now' }])
    render(<App />)

    expect(await screen.findByRole('heading', { name: 'What should we work on?' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Review my work/ }))

    const composer = screen.getByLabelText('Message Antigravity')
    expect(composer).toHaveValue('Review my recent changes and tell me what you would fix before I ship this.')
    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled()
  })

  it('drops the empty-session invitation once the session has messages', async () => {
    vi.mocked(api.projects.list).mockResolvedValue([{ id: 'project_1', name: 'Launch', createdAt: 'now', updatedAt: 'now' }])
    vi.mocked(api.projects.open).mockResolvedValue({
      ...(await vi.mocked(api.projects.open).getMockImplementation()!('project_1')),
      messages: [
        {
          id: 'message_1',
          projectId: 'project_1',
          conversationId: 'conversation_1',
          runId: null,
          role: 'user',
          content: 'Already talking',
          status: 'completed',
          sequence: 1,
          createdAt: 'now',
          updatedAt: 'now'
        }
      ]
    })
    render(<App />)

    await screen.findByLabelText('Message Antigravity')
    expect(screen.queryByRole('heading', { name: 'What should we work on?' })).not.toBeInTheDocument()
  })

  it('shows the real model catalogue and persists a selection to the conversation', async () => {
    vi.mocked(api.projects.list).mockResolvedValue([{ id: 'project_1', name: 'Launch', createdAt: 'now', updatedAt: 'now' }])
    vi.mocked(api.models.list).mockResolvedValue([
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', supportedReasoningEfforts: ['low', 'medium', 'high'] },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' }
    ])
    render(<App />)

    const trigger = await screen.findByLabelText('Model')
    await waitFor(() => expect(trigger).toBeEnabled())
    await userEvent.click(trigger)
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Claude Sonnet 4\.6/ }))

    expect(api.conversations.setModel).toHaveBeenCalledWith({
      conversationId: 'conversation_1',
      model: 'claude-sonnet-4-6',
      reasoningEffort: null
    })
  })

  it('creates a project from an in-app field, because Electron has no window.prompt', async () => {
    render(<App />)
    await screen.findByText('Sessions')

    await userEvent.click(screen.getByLabelText('Project'))
    await userEvent.click(screen.getByRole('menuitem', { name: /New project/ }))
    await userEvent.type(screen.getByLabelText('New project name'), 'Renderer Check{Enter}')

    expect(api.projects.create).toHaveBeenCalledWith({ name: 'Renderer Check' })
  })

  it('does not render a permanent artifact column — files open on request', async () => {
    render(<App />)
    await screen.findByText('Sessions')

    expect(screen.queryByLabelText('Project files and artifacts')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Files' }))
    expect(await screen.findByLabelText('Project files and artifacts')).toBeInTheDocument()
  })

  it('does not expose a manual transport control', async () => {
    vi.mocked(api.projects.list).mockResolvedValue([{ id: 'project_1', name: 'Launch', createdAt: 'now', updatedAt: 'now' }])
    render(<App />)
    await screen.findByLabelText('Message Antigravity')

    // Transport is escalated automatically; users never choose one.
    expect(screen.queryByText(/interactive mode/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/PTY/i)).not.toBeInTheDocument()
  })

  it('shows a startup diagnostic when the preload API is missing', async () => {
    Object.defineProperty(window, 'orbit', { value: undefined, configurable: true })

    render(<App />)

    expect(await screen.findByText('Orbit failed to start')).toBeInTheDocument()
    expect(screen.getByText(/preload API is unavailable/i)).toBeInTheDocument()
    expect(screen.queryByText('Sessions')).not.toBeInTheDocument()
  })

  it('shows a startup diagnostic when runtime initialization fails', async () => {
    vi.mocked(api.providers.status).mockRejectedValueOnce(new Error('Provider startup failed'))

    render(<App />)

    expect(await screen.findByText('Orbit failed to start')).toBeInTheDocument()
    expect(screen.getByText('Provider startup failed')).toBeInTheDocument()
  })
})
