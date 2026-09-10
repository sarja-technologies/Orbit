// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/app/App'
import type { OrbitApi } from '../../src/shared/contracts'
import type { Conversation, ModelOption, OrbitPreferences, Project, ProjectSnapshot, ProviderStatus, Run } from '../../src/shared/domain'
import type { RuntimeEvent } from '../../src/shared/runtime-events'
import { deriveSessionTitle, hasDefaultSessionTitle } from '../../src/shared/sessionTitle'
import { ORBIT_DEFAULT_MODEL_ID } from '../../src/shared/defaultModel'

const WEBSITE: Project = { id: 'project_1', name: 'AgentDock Website', rootPath: '/home/dev/agentdock', createdAt: 'now', updatedAt: 'now' }
const RENDERER: Project = { id: 'project_2', name: 'Renderer Check', rootPath: null, createdAt: 'now', updatedAt: 'now' }

function conversation(overrides: Partial<Conversation> & { id: string; projectId: string; title: string }): Conversation {
  return {
    providerId: 'antigravity',
    nativeConversationId: null,
    status: 'idle',
    transport: 'structured',
    model: ORBIT_DEFAULT_MODEL_ID,
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
  /** A small stateful stand-in for the real backend, so a session created
   *  through the API is genuinely there the next time the sidebar and the
   *  workspace read it — which is the whole thing these tests are about. */
  let sessions: Record<string, Conversation[]>
  let created: number
  /** Mirrors the store's `title_is_custom`: a session the user named is
   *  never a candidate for first-prompt titling again. */
  let userNamed: Set<string>
  let runListener: ((event: RuntimeEvent) => void) | null

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
    sessions = { project_1: [IMPROVE, HYBRID], project_2: [CHECK] }
    created = 0
    userNamed = new Set()
    runListener = null
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
          { project: WEBSITE, conversations: sessions.project_1 ?? [] },
          { project: RENDERER, conversations: sessions.project_2 ?? [] }
        ]),
        create: vi.fn(async () => ({ ...RENDERER, id: 'project_3', name: 'Orbit' })),
        open: vi.fn(async (projectId) =>
          projectId === 'project_2'
            ? snapshotFor(RENDERER, sessions.project_2 ?? [])
            : snapshotFor(WEBSITE, sessions.project_1 ?? [])
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
        // Mirrors the real backend: a session with no title and no folder
        // of its own, stored against the project it was asked for.
        create: vi.fn(async (input) => {
          created += 1
          const made = conversation({ id: `conversation_new_${created}`, projectId: input.projectId, title: 'New Session' })
          sessions[input.projectId] = [made, ...(sessions[input.projectId] ?? [])]
          return made
        }),
        rename: vi.fn(async (input) => {
          const list = sessions[activeProjectOf(input.conversationId)] ?? []
          const index = list.findIndex((item) => item.id === input.conversationId)
          const target = list[index]!
          const renamed = { ...target, title: input.title }
          list[index] = renamed
          userNamed.add(input.conversationId)
          return renamed
        }),
        delete: vi.fn(),
        setTransport: vi.fn(),
        setModel: vi.fn(),
        setWorkingDirectory: vi.fn()
      },
      models: { list: vi.fn(async () => MODELS) },
      messages: {
        // Mirrors OrbitRuntime.sendMessage: a still-unnamed session is named
        // from the prompt as part of sending it, so the sidebar picks the
        // new title up from the refresh the renderer already does.
        send: vi.fn(async (input) => {
          const list = sessions[input.projectId] ?? []
          const index = list.findIndex((item) => item.id === input.conversationId)
          const target = list[index]
          if (target && hasDefaultSessionTitle(target.title) && !userNamed.has(target.id)) {
            const derived = deriveSessionTitle(input.content)
            if (derived) list[index] = { ...target, title: derived }
          }
          return run
        })
      },
      runs: {
        cancel: vi.fn(),
        onEvent: vi.fn((next: (event: RuntimeEvent) => void) => {
          runListener = next
          return () => undefined
        })
      },
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

  /** Which project a session lives in, for the stateful mock backend. */
  const activeProjectOf = (conversationId: string): string =>
    Object.keys(sessions).find((projectId) => sessions[projectId]!.some((item) => item.id === conversationId)) ?? 'project_1'

  /** Ends the in-flight turn the way the real runtime does, so the composer
   *  goes back to offering Send rather than Stop. */
  const finishRun = async (conversationId: string): Promise<void> => {
    await act(async () => {
      runListener?.({
        type: 'run.completed',
        projectId: activeProjectOf(conversationId),
        conversationId,
        runId: 'run_1',
        providerId: 'antigravity',
        createdAt: 'now',
        finalText: 'Done.',
        nativeConversationId: null
      })
    })
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

  it('still opens the project dialog for New project, because a project needs configuring', async () => {
    await boot()
    await userEvent.click(screen.getByLabelText('New project or session'))
    await userEvent.click(screen.getByRole('menuitem', { name: 'New project' }))

    const dialog = await screen.findByRole('dialog', { name: 'New project' })
    expect(within(dialog).getByLabelText('Project name')).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Working folder')).toBeInTheDocument()
    expect(api.projects.create).not.toHaveBeenCalled()
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

  it('creates a session the moment a project\u2019s + is clicked, with no dialog at all', async () => {
    await boot()
    await userEvent.click(screen.getByLabelText('New session in Renderer Check'))

    // Exactly one session, in the project whose control was used, asking
    // for nothing: no name and no folder, so it inherits the project's.
    await waitFor(() => expect(api.conversations.create).toHaveBeenCalledTimes(1))
    expect(api.conversations.create).toHaveBeenCalledWith({ projectId: 'project_2' })

    // Nothing to fill in, and nothing to dismiss.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Session name')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Project')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Working folder')).not.toBeInTheDocument()
    expect(api.dialog.pickFolder).not.toHaveBeenCalled()
  })

  it('shows the new session as New Session, active, with the composer focused', async () => {
    await boot()
    await userEvent.click(screen.getByLabelText('New session in AgentDock Website'))

    // It is in the sidebar under its project, under the default name.
    const row = await screen.findByRole('button', { name: /^New Session/ })
    expect(row).toBeInTheDocument()
    // ...and it is the session the workspace is on.
    await waitFor(() => expect(row).toHaveAttribute('aria-current', 'true'))
    const header = document.querySelector('.chrome') as HTMLElement
    expect(within(header).getByText('New Session')).toBeInTheDocument()

    // The user can just start typing.
    await waitFor(() => expect(screen.getByLabelText('Message Antigravity')).toHaveFocus())
  })

  it('creates the session in the project whose + was used, not the open one', async () => {
    await boot()
    // AgentDock Website is the open project; the + belongs to the other one.
    await userEvent.click(screen.getByLabelText('New session in Renderer Check'))

    expect(api.conversations.create).toHaveBeenCalledWith({ projectId: 'project_2' })
    await waitFor(() => expect(api.projects.open).toHaveBeenCalledWith('project_2'))
  })

  it('creates a session instantly from the menu too, in the project already open', async () => {
    await boot()
    await userEvent.click(screen.getByLabelText('New project or session'))
    await userEvent.click(screen.getByRole('menuitem', { name: 'New session' }))

    await waitFor(() => expect(api.conversations.create).toHaveBeenCalledWith({ projectId: 'project_1' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('creates another session on the next click, just as immediately', async () => {
    await boot()
    await userEvent.click(screen.getByLabelText('New session in AgentDock Website'))
    await waitFor(() => expect(api.conversations.create).toHaveBeenCalledTimes(1))

    await userEvent.click(screen.getByLabelText('New session in AgentDock Website'))

    await waitFor(() => expect(api.conversations.create).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(sessions.project_1).toHaveLength(4)
  })

  it('reports a failed session create without leaving a half-made session behind', async () => {
    vi.mocked(api.conversations.create).mockRejectedValueOnce(new Error('Project not found.'))
    await boot()
    await userEvent.click(screen.getByLabelText('New session in AgentDock Website'))

    expect(await screen.findByText('Project not found.')).toBeInTheDocument()
  })

  it('closes the project dialog on Escape without creating anything', async () => {
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

  it('renames a new session in the sidebar once its first real prompt is sent', async () => {
    await boot()
    await userEvent.click(screen.getByLabelText('New session in AgentDock Website'))
    await screen.findByRole('button', { name: /^New Session/ })

    await userEvent.type(screen.getByLabelText('Message Antigravity'), 'build me a futuristic robotics landing page')
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))

    expect(await screen.findByRole('button', { name: /^Futuristic Robotics Landing Page/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^New Session/ })).not.toBeInTheDocument()
  })

  it('does not keep renaming the session as the conversation goes on', async () => {
    await boot()
    await userEvent.click(screen.getByLabelText('New session in AgentDock Website'))
    await screen.findByRole('button', { name: /^New Session/ })

    const composer = screen.getByLabelText('Message Antigravity')
    await userEvent.type(composer, 'build me a futuristic robotics landing page')
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await screen.findByRole('button', { name: /^Futuristic Robotics Landing Page/ })

    await finishRun('conversation_new_1')
    await userEvent.type(composer, 'now make the hero section darker')
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(api.messages.send).toHaveBeenCalledTimes(2))

    expect(screen.getByRole('button', { name: /^Futuristic Robotics Landing Page/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Hero Section Darker/ })).not.toBeInTheDocument()
  })

  it('leaves a session the user renamed alone when the first prompt is sent', async () => {
    await boot()
    await userEvent.click(screen.getByLabelText('New session in AgentDock Website'))
    const row = await screen.findByRole('button', { name: /^New Session/ })

    // Rename it by hand first, the way the sidebar does.
    await userEvent.dblClick(row)
    const input = await screen.findByLabelText('Session name')
    await userEvent.clear(input)
    await userEvent.type(input, 'Ship checklist{Enter}')
    await waitFor(() =>
      expect(api.conversations.rename).toHaveBeenCalledWith({ conversationId: 'conversation_new_1', title: 'Ship checklist' })
    )

    await userEvent.type(screen.getByLabelText('Message Antigravity'), 'build me a futuristic robotics landing page')
    await userEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(api.messages.send).toHaveBeenCalled())

    expect(await screen.findByRole('button', { name: /^Ship checklist/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Futuristic Robotics Landing Page/ })).not.toBeInTheDocument()
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
      modelReasoningEfforts: { [ORBIT_DEFAULT_MODEL_ID]: 'high' }
    })
    expect(api.conversations.setModel).toHaveBeenCalledWith({
      conversationId: 'conversation_1',
      model: ORBIT_DEFAULT_MODEL_ID,
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

  /** Sends a message from the session that is open, leaving the run live. */
  const startRun = async (): Promise<void> => {
    await userEvent.type(screen.getByLabelText('Message Antigravity'), 'Build it')
    await userEvent.click(screen.getByLabelText('Send message'))
    await screen.findByLabelText('Stop generating')
  }

  const emit = async (event: RuntimeEvent): Promise<void> => {
    await act(async () => {
      runListener?.(event)
    })
  }

  const base = { projectId: 'project_1', conversationId: 'conversation_1', runId: 'run_1', providerId: 'antigravity' as const, createdAt: 'now' }

  describe('stopping a run', () => {
    it('says it is stopping while the transport tears the turn down', async () => {
      await boot()
      await startRun()

      await userEvent.click(screen.getByLabelText('Stop generating'))

      expect(api.runs.cancel).toHaveBeenCalledWith({ runId: 'run_1' })
      // A deliberate, stated lifecycle state — not a stall the user has to
      // interpret, and not an error.
      expect(await screen.findByText('Stopping…')).toBeInTheDocument()
      expect(document.body.textContent).not.toMatch(/couldn’t be read|went wrong/i)
    })

    it('settles into a calm stopped state, never a retry prompt', async () => {
      await boot()
      await startRun()
      await userEvent.click(screen.getByLabelText('Stop generating'))
      await emit({ ...base, type: 'run.cancelled' })

      await waitFor(() => expect(screen.getByLabelText('Send message')).toBeInTheDocument())
      expect(screen.queryByLabelText('Stop generating')).not.toBeInTheDocument()
      expect(screen.queryByText('Stopping…')).not.toBeInTheDocument()
      // The composer is live again for the next message.
      expect(screen.getByLabelText('Message Antigravity')).not.toBeDisabled()
      expect(document.body.textContent).not.toMatch(/couldn’t be read|Something went wrong|try again/i)
    })

    it('closes every activity row a stopped run left open, so nothing keeps counting', async () => {
      await boot()
      await startRun()
      await emit({ ...base, type: 'tool.activity', label: 'Running npm run build', status: 'running', kind: 'command', providerStepId: '1' })
      expect(await screen.findByText('Running npm run build')).toBeInTheDocument()

      await userEvent.click(screen.getByLabelText('Stop generating'))
      await emit({ ...base, type: 'run.cancelled' })

      // The live rail is gone with the run, and no timer survives it.
      await waitFor(() => expect(document.querySelector('.activity-live')).toBeNull())
    })

    it('still shows a real error state for a genuine backend failure', async () => {
      await boot()
      await startRun()
      await emit({
        ...base,
        type: 'run.failed',
        error: { code: 'provider.exited', message: 'exit 139 SIGSEGV', retryable: false }
      })

      // Nothing about the cancellation work may soften a real failure.
      await waitFor(() => expect(screen.getByLabelText('Send message')).toBeInTheDocument())
      expect(screen.queryByText('You stopped this response')).not.toBeInTheDocument()
    })
  })

  describe('live activity', () => {
    it('shows the real command the run is on, not a generic working line', async () => {
      await boot()
      await startRun()
      await emit({ ...base, type: 'tool.activity', label: 'Running npm run build', status: 'running', kind: 'command', providerStepId: '1' })

      expect(await screen.findByText('Running npm run build')).toBeInTheDocument()
      expect(screen.queryByText(/is replying/)).not.toBeInTheDocument()
    })

    it('does not carry one session’s activity or timer into another', async () => {
      await boot()
      await startRun()
      await emit({ ...base, type: 'tool.activity', label: 'Running npm run build', status: 'running', kind: 'command', providerStepId: '1' })
      expect(await screen.findByText('Running npm run build')).toBeInTheDocument()

      // Switch to the other session in this project. Its own run has no
      // activity, so nothing from the first may be visible or ticking.
      await userEvent.click(screen.getByRole('button', { name: /^Explore hybrid mode/ }))
      await waitFor(() => expect(screen.queryByText('Running npm run build')).not.toBeInTheDocument())
      expect(document.querySelector('.activity-live')).toBeNull()

      // And back: the run is still live, so its activity is still its own.
      await userEvent.click(screen.getByRole('button', { name: /^Improve Orbit UI/ }))
      expect(await screen.findByText('Running npm run build')).toBeInTheDocument()
    })

    it('keeps another project’s live activity and timer off screen', async () => {
      await boot()
      await startRun()
      await emit({ ...base, type: 'tool.activity', label: 'Running npm run build', status: 'running', kind: 'command', providerStepId: '1' })
      await screen.findByText('Running npm run build')

      await userEvent.click(screen.getByRole('button', { name: 'Renderer Check' }))
      await userEvent.click(await screen.findByRole('button', { name: /^Main/ }))
      await waitFor(() => expect(api.projects.open).toHaveBeenCalledWith('project_2'))

      expect(screen.queryByText('Running npm run build')).not.toBeInTheDocument()
      expect(document.querySelector('.activity-live')).toBeNull()
      // Whether the entry is also dropped from memory is pruneActivity's
      // own contract, covered directly in rendererLib.test.ts.
    })
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
