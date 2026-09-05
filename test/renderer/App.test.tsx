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
        setTransport: vi.fn()
      },
      messages: {
        send: vi.fn(async () => run)
      },
      runs: {
        cancel: vi.fn(),
        onEvent: vi.fn(() => () => undefined)
      },
      interactions: { respond: vi.fn() },
      files: { attach: vi.fn() },
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

  it('mounts the startup shell without an existing project', async () => {
    render(<App />)

    expect(await screen.findByText('Orbit')).toBeInTheDocument()
    expect(screen.getByText('by AgentDock')).toBeInTheDocument()
    expect(screen.getByText('Conversations')).toBeInTheDocument()
    expect(screen.getByText('Project Assets')).toBeInTheDocument()
    expect(screen.getByText('Artifacts')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Ask Orbit...')).toBeInTheDocument()
    expect(screen.getByText('Create a project to begin')).toBeInTheDocument()
  })

  it('creates a project and shows its main conversation', async () => {
    render(<App />)
    await userEvent.type(screen.getByPlaceholderText('New project'), 'Launch')
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(screen.getAllByText('Main').length).toBeGreaterThan(0))
    expect(screen.getAllByText('Launch').length).toBeGreaterThan(0)
  })

  it('shows a startup diagnostic when the preload API is missing', async () => {
    Object.defineProperty(window, 'orbit', { value: undefined, configurable: true })

    render(<App />)

    expect(await screen.findByText('Orbit failed to start')).toBeInTheDocument()
    expect(screen.getByText(/preload API is unavailable/i)).toBeInTheDocument()
    expect(screen.queryByText('Conversations')).not.toBeInTheDocument()
  })

  it('shows a startup diagnostic when runtime initialization fails', async () => {
    vi.mocked(api.providers.status).mockRejectedValueOnce(new Error('Provider startup failed'))

    render(<App />)

    expect(await screen.findByText('Orbit failed to start')).toBeInTheDocument()
    expect(screen.getByText('Provider startup failed')).toBeInTheDocument()
  })
})
