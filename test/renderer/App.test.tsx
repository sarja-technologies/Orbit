// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/app/App'
import type { OrbitApi } from '../../src/shared/contracts'
import type { Conversation, ModelOption, OrbitPreferences, Project, ProjectSnapshot, ProviderStatus, Run } from '../../src/shared/domain'

const WEBSITE: Project = { id: 'project_1', name: 'AgentDock Website', rootPath: '/home/dev/agentdock', createdAt: 'now', updatedAt: 'now' }
const RENDERER: Project = { id: 'project_2', name: 'Renderer Check', rootPath: null, createdAt: 'now', updatedAt: 'now' }

function conversation(overrides: Partial<Conversation> & { id: string; projectId: string; title: string }): Conversation {
  return {
    providerId: 'antigravity',
    nativeConversationId: null,
    status: 'idle',
    transport: 'structured',
    model: null,
    reasoningEffort: null,
    workingDirectory: null,
    createdAt: 'now',
    updatedAt: 'now',
    ...overrides
  }
}

const IMPROVE = conversation({ id: 'conversation_1', projectId: 'project_1', title: 'Improve Orbit UI', reasoningEffort: 'medium' })
const HYBRID = conversation({ id: 'conversation_2', projectId: 'project_1', title: 'Explore hybrid mode', reasoningEffort: 'medium' })
const CHECK = conversation({ id: 'conversation_3', projectId: 'project_2', title: 'Main', reasoningEffort: 'medium' })

const MODELS: ModelOption[] = [
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', supportedReasoningEfforts: ['low', 'medium', 'high'] },
  { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', supportedReasoningEfforts: ['low', 'high'] },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' }
]

describe('App', () => {
  let api: OrbitApi
  let preferences: OrbitPreferences

  const snapshotFor = (project: Project, conversations: Conversation[]): ProjectSnapshot => ({
    project,
    conversations,
    messages: [],
    runs: [],
    artifacts: [],
    artifactVersions: [],
    projectFiles: [],
    references: []
  })

  beforeEach(() => {
    window.localStorage.clear()
    preferences = { lastReasoningEffort: null, modelReasoningEfforts: {} }
    const providerStatus: ProviderStatus = {
      id: 'antigravity',
      state: 'unavailable',
      sdkAvailable: false,
      authConfigured: false,
      message: 'Antigravity unavailable - authentication required',
      details: {}
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
      providers: { status: vi.fn(async () => providerStatus) },
      projects: {
        list: vi.fn(async () => [WEBSITE, RENDERER]),
        tree: vi.fn(async () => [
          { project: WEBSITE, conversations: [IMPROVE, HYBRID] },
          { project: RENDERER, conversations: [CHECK] }
        ]),
        create: vi.fn(async () => ({ ...RENDERER, id: 'project_3', name: 'Orbit' })),
        open: vi.fn(async (projectId) =>
          projectId === 'project_2' ? snapshotFor(RENDERER, [CHECK]) : snapshotFor(WEBSITE, [IMPROVE, HYBRID])
        ),
        setRoot: vi.fn()
      },
      dialog: { pickFolder: vi.fn(async () => '/home/dev/chosen') },
      preferences: {
        get: vi.fn(async () => preferences),
        set: vi.fn(async (next) => {
          preferences = next
          return next
        })
      },
      conversations: {
        create: vi.fn(async () => conversation({ id: 'conversation_9', projectId: 'project_1', title: 'New session' })),
        rename: vi.fn(),
        delete: vi.fn(),
        setTransport: vi.fn(),
        setModel: vi.fn(),
        setWorkingDirectory: vi.fn()
      },
      models: { list: vi.fn(async () => MODELS) },
      messages: { send: vi.fn(async () => run) },
      runs: { cancel: vi.fn(), onEvent: vi.fn(() => () => undefined) },
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

  const boot = async (): Promise<void> => {
    render(<App />)
    await screen.findByText('Projects')
  }

  it('groups sessions under the project they belong to', async () => {
    await boot()

    // Both projects are listed; the active one is open with its sessions
    // nested beneath it, rather than every session in one flat list.
    expect(screen.getByRole('button', { name: 'AgentDock Website' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: /^Improve Orbit UI/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Explore hybrid mode/ })).toBeInTheDocument()

    const collapsed = screen.getByRole('button', { name: 'Renderer Check' })
    expect(collapsed).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: /^Main/ })).not.toBeInTheDocument()
  })

  it('expands and collapses a project group', async () => {
    await boot()
    await userEvent.click(screen.getByRole('button', { name: 'Renderer Check' }))
    expect(await screen.findByRole('button', { name: /^Main/ })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Renderer Check' }))
    expect(screen.queryByRole('button', { name: /^Main/ })).not.toBeInTheDocument()
  })

  it('opens another project when one of its sessions is chosen', async () => {
    await boot()
    await userEvent.click(screen.getByRole('button', { name: 'Renderer Check' }))
    await userEvent.click(await screen.findByRole('button', { name: /^Main/ }))

    await waitFor(() => expect(api.projects.open).toHaveBeenCalledWith('project_2'))
  })

  it('offers one compact creation control for both projects and sessions', async () => {
    await boot()
    await userEvent.click(screen.getByLabelText('New project or session'))

    expect(screen.getByRole('menuitem', { name: 'New project' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'New session' })).toBeInTheDocument()
  })

  it('creates a project with a name and a folder chosen in the native picker', async () => {
    await boot()
    await userEvent.click(screen.getByLabelText('New project or session'))
    await userEvent.click(screen.getByRole('menuitem', { name: 'New project' }))

    await userEvent.click(screen.getByRole('button', { name: 'Choose…' }))
    expect(api.dialog.pickFolder).toHaveBeenCalled()

    // The chosen folder lands in the field, and suggests the project's name.
    await waitFor(() => expect(screen.getByLabelText('Working folder')).toHaveValue('/home/dev/chosen'))
    expect(screen.getByLabelText('Project name')).toHaveValue('chosen')

    await userEvent.clear(screen.getByLabelText('Project name'))
    await userEvent.type(screen.getByLabelText('Project name'), 'Orbit')
    await userEvent.click(screen.getByRole('button', { name: 'Create project' }))

    expect(api.projects.create).toHaveBeenCalledWith({ name: 'Orbit', rootPath: '/home/dev/chosen' })
  })

  it('accepts a folder typed or pasted straight into the field', async () => {
    await boot()
    await userEvent.click(screen.getByLabelText('New project or session'))
    await userEvent.click(screen.getByRole('menuitem', { name: 'New project' }))

    await userEvent.type(screen.getByLabelText('Project name'), 'Pasted')
    await userEvent.type(screen.getByLabelText('Working folder'), '/home/dev/pasted')
    await userEvent.click(screen.getByRole('button', { name: 'Create project' }))

    expect(api.projects.create).toHaveBeenCalledWith({ name: 'Pasted', rootPath: '/home/dev/pasted' })
  })

  it('refuses a relative path rather than letting the create fail later', async () => {
    await boot()
    await userEvent.click(screen.getByLabelText('New project or session'))
    await userEvent.click(screen.getByRole('menuitem', { name: 'New project' }))

    await userEvent.type(screen.getByLabelText('Project name'), 'Relative')
    await userEvent.type(screen.getByLabelText('Working folder'), 'some/where')

    expect(screen.getByText(/full path/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create project' })).toBeDisabled()
    expect(api.projects.create).not.toHaveBeenCalled()
  })

  it('creates a project with no folder, which is a real choice and not an empty one', async () => {
    await boot()
    await userEvent.click(screen.getByLabelText('New project or session'))
    await userEvent.click(screen.getByRole('menuitem', { name: 'New project' }))

    expect(screen.getByLabelText('Working folder')).toHaveAttribute('placeholder', 'Orbit-managed workspace')
    await userEvent.type(screen.getByLabelText('Project name'), 'Scratch')
    await userEvent.click(screen.getByRole('button', { name: 'Create project' }))

    expect(api.projects.create).toHaveBeenCalledWith({ name: 'Scratch', rootPath: null })
  })

  it('preselects the project whose row started the session', async () => {
    await boot()
    await userEvent.click(screen.getByLabelText('New session in Renderer Check'))

    expect(screen.getByLabelText('Project')).toHaveValue('project_2')
    // With no project folder, the session says where it will really run.
    expect(screen.getByLabelText('Working folder')).toHaveAttribute('placeholder', 'Renderer Check · Orbit-managed workspace')
  })

  it('defaults a session to its project folder and allows an override', async () => {
    await boot()
    await userEvent.click(screen.getByLabelText('New session in AgentDock Website'))
    // Empty means "inherit", and the placeholder names the folder that will
    // really be used rather than leaving the field blank and unexplained.
    expect(screen.getByLabelText('Working folder')).toHaveAttribute('placeholder', '/home/dev/agentdock')

    await userEvent.click(screen.getByRole('button', { name: 'Choose…' }))
    await waitFor(() => expect(screen.getByLabelText('Working folder')).toHaveValue('/home/dev/chosen'))

    await userEvent.type(screen.getByLabelText('Session name'), 'Website copy draft')
    await userEvent.click(screen.getByRole('button', { name: 'Create session' }))

    expect(api.conversations.create).toHaveBeenCalledWith({
      projectId: 'project_1',
      title: 'Website copy draft',
      workingDirectory: '/home/dev/chosen'
    })
  })

  it('drops a folder override when the session moves to a different project', async () => {
    await boot()
    await userEvent.click(screen.getByLabelText('New session in AgentDock Website'))
    await userEvent.click(screen.getByRole('button', { name: 'Choose…' }))
    await waitFor(() => expect(screen.getByLabelText('Working folder')).toHaveValue('/home/dev/chosen'))

    await userEvent.selectOptions(screen.getByLabelText('Project'), 'project_2')
    expect(screen.getByLabelText('Working folder')).toHaveValue('')

    await userEvent.click(screen.getByRole('button', { name: 'Create session' }))
    expect(api.conversations.create).toHaveBeenCalledWith({ projectId: 'project_2', workingDirectory: null })
  })

  it('closes a creation dialog on Escape without creating anything', async () => {
    await boot()
    await userEvent.click(screen.getByLabelText('New project or session'))
    await userEvent.click(screen.getByRole('menuitem', { name: 'New project' }))
    await userEvent.keyboard('{Escape}')

    expect(screen.queryByRole('dialog', { name: 'New project' })).not.toBeInTheDocument()
    expect(api.projects.create).not.toHaveBeenCalled()
  })

  it('keeps the project and session breadcrumb, and drops the provider status line', async () => {
    await boot()
    const header = document.querySelector('.chrome') as HTMLElement
    expect(within(header).getByText('AgentDock Website')).toBeInTheDocument()
    expect(within(header).getByText('Improve Orbit UI')).toBeInTheDocument()
    expect(within(header).getByText('/home/dev/agentdock')).toBeInTheDocument()
    expect(screen.queryByText('Antigravity online')).not.toBeInTheDocument()
  })

  it('still reports a real provider problem', async () => {
    await boot()
    expect(screen.getByText('You’re signed out of Antigravity.')).toBeInTheDocument()
  })

  it('opens the drawer from the right-edge control and closes it on the same control', async () => {
    await boot()
    expect(screen.queryByLabelText('Project files and artifacts')).not.toBeInTheDocument()

    const rail = document.querySelector('.workspace-rail') as HTMLElement
    await userEvent.click(within(rail).getByRole('tab', { name: 'Files' }))
    const drawer = await screen.findByLabelText('Project files and artifacts')
    expect(within(drawer).getByRole('tab', { name: 'Files', selected: true })).toBeInTheDocument()

    await userEvent.click(within(rail).getByRole('tab', { name: 'Files' }))
    expect(screen.queryByLabelText('Project files and artifacts')).not.toBeInTheDocument()
  })

  it('switches the drawer straight to Artifacts from the rail', async () => {
    await boot()
    const rail = document.querySelector('.workspace-rail') as HTMLElement
    await userEvent.click(within(rail).getByRole('tab', { name: 'Artifacts' }))

    const drawer = await screen.findByLabelText('Project files and artifacts')
    expect(within(drawer).getByRole('tab', { name: 'Artifacts', selected: true })).toBeInTheDocument()
  })

  it('closes the drawer on Escape', async () => {
    await boot()
    const rail = document.querySelector('.workspace-rail') as HTMLElement
    await userEvent.click(within(rail).getByRole('tab', { name: 'Files' }))
    await screen.findByLabelText('Project files and artifacts')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByLabelText('Project files and artifacts')).not.toBeInTheDocument()
  })

  it('shows the composer once a session is open', async () => {
    await boot()
    expect(await screen.findByLabelText('Message Antigravity')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled()
  })

  it('invites the user into an empty session and fills the composer from a starter', async () => {
    await boot()
    expect(await screen.findByRole('heading', { name: 'What should we work on?' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Review my work/ }))

    expect(screen.getByLabelText('Message Antigravity')).toHaveValue(
      'Review my recent changes and tell me what you would fix before I ship this.'
    )
  })

  it('drops the empty-session invitation once the session has messages', async () => {
    vi.mocked(api.projects.open).mockResolvedValue({
      ...snapshotFor(WEBSITE, [IMPROVE, HYBRID]),
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
    await boot()
    await screen.findByLabelText('Message Antigravity')
    expect(screen.queryByRole('heading', { name: 'What should we work on?' })).not.toBeInTheDocument()
  })

  it('persists a model choice, carrying the remembered reasoning level onto it', async () => {
    preferences = { lastReasoningEffort: 'high', modelReasoningEfforts: {} }
    await boot()

    const trigger = await screen.findByLabelText('Model and reasoning')
    await waitFor(() => expect(trigger).toBeEnabled())
    await userEvent.click(trigger)
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Gemini 3\.8 Flash/ }))

    expect(api.conversations.setModel).toHaveBeenCalledWith({
      conversationId: 'conversation_1',
      model: 'gemini-3.8-flash',
      reasoningEffort: 'high'
    })
  })

  it('maps a remembered level onto a model that does not publish it', async () => {
    preferences = { lastReasoningEffort: 'medium', modelReasoningEfforts: {} }
    await boot()

    const trigger = await screen.findByLabelText('Model and reasoning')
    await waitFor(() => expect(trigger).toBeEnabled())
    await userEvent.click(trigger)
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Gemini 3\.1 Pro/ }))

    // Pro has no medium, and Orbit refuses to invent one.
    expect(api.conversations.setModel).toHaveBeenCalledWith({
      conversationId: 'conversation_1',
      model: 'gemini-3.1-pro',
      reasoningEffort: 'low'
    })
  })

  it('chooses no tier for a model with no reasoning control', async () => {
    preferences = { lastReasoningEffort: 'high', modelReasoningEfforts: {} }
    await boot()

    const trigger = await screen.findByLabelText('Model and reasoning')
    await waitFor(() => expect(trigger).toBeEnabled())
    await userEvent.click(trigger)
    await userEvent.click(screen.getByRole('button', { name: /Other models/ }))
    const modal = await screen.findByRole('dialog', { name: 'All models' })
    await userEvent.click(within(modal).getByRole('menuitemradio', { name: /Claude Sonnet 4\.6/ }))

    expect(api.conversations.setModel).toHaveBeenCalledWith({
      conversationId: 'conversation_1',
      model: 'claude-sonnet-4-6',
      reasoningEffort: null
    })
  })

  it('remembers an explicit tier for next time, globally and against the model', async () => {
    await boot()
    const trigger = await screen.findByLabelText('Model and reasoning')
    await waitFor(() => expect(trigger).toBeEnabled())
    await userEvent.click(trigger)
    await userEvent.click(screen.getByRole('button', { name: 'High' }))

    expect(api.preferences.set).toHaveBeenCalledWith({
      lastReasoningEffort: 'high',
      modelReasoningEfforts: { 'antigravity:default': 'high' }
    })
    expect(api.conversations.setModel).toHaveBeenCalledWith({
      conversationId: 'conversation_1',
      model: null,
      reasoningEffort: 'high'
    })
  })

  it('settles a session carried over with no tier at all, instead of leaving it on Auto', async () => {
    const legacy = conversation({ id: 'conversation_1', projectId: 'project_1', title: 'Improve Orbit UI', model: 'gemini-3.8-flash' })
    vi.mocked(api.projects.tree).mockResolvedValue([{ project: WEBSITE, conversations: [legacy] }])
    vi.mocked(api.projects.open).mockResolvedValue(snapshotFor(WEBSITE, [legacy]))
    preferences = { lastReasoningEffort: 'low', modelReasoningEfforts: {} }

    await boot()
    await waitFor(() =>
      expect(api.conversations.setModel).toHaveBeenCalledWith({
        conversationId: 'conversation_1',
        model: 'gemini-3.8-flash',
        reasoningEffort: 'low'
      })
    )
  })

  it('does not expose a manual transport control', async () => {
    await boot()
    await screen.findByLabelText('Message Antigravity')
    expect(screen.queryByText(/interactive mode/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/PTY/i)).not.toBeInTheDocument()
  })

  it('shows a startup diagnostic when the preload API is missing', async () => {
    Object.defineProperty(window, 'orbit', { value: undefined, configurable: true })
    render(<App />)

    expect(await screen.findByText('Orbit failed to start')).toBeInTheDocument()
    expect(screen.getByText(/preload API is unavailable/i)).toBeInTheDocument()
    expect(screen.queryByText('Projects')).not.toBeInTheDocument()
  })

  it('shows a startup diagnostic when runtime initialization fails', async () => {
    vi.mocked(api.providers.status).mockRejectedValueOnce(new Error('Provider startup failed'))
    render(<App />)

    expect(await screen.findByText('Orbit failed to start')).toBeInTheDocument()
    expect(screen.getByText('Provider startup failed')).toBeInTheDocument()
  })
})
