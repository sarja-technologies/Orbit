// @vitest-environment jsdom
import { NO_REPOSITORY } from '../../src/shared/repositoryActions'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/app/App'
import type { OrbitApi, StartupSession } from '../../src/shared/contracts'
import type { Conversation, ModelOption, OrbitPreferences, Project, ProjectSnapshot, ProviderStatus } from '../../src/shared/domain'
import { ORBIT_DEFAULT_MODEL_ID } from '../../src/shared/defaultModel'
import { EMPTY_PREFERENCES } from '../../src/shared/reasoningPolicy'
import { DEFAULT_SESSION_TITLE } from '../../src/shared/sessionTitle'

/** The Unsorted workspace: no project behind it, and only the sessions that
 *  belong to none. */
const EMPTY_UNSORTED_SNAPSHOT: ProjectSnapshot = {
  project: null,
  conversations: [],
  messages: [],
  runs: [],
  artifacts: [],
  artifactVersions: [],
  projectFiles: [],
  references: []
}
const snapshotForUnsorted = (): ProjectSnapshot => ({ ...EMPTY_UNSORTED_SNAPSHOT })


const AGENTDOCK: Project = { id: 'project_1', name: 'AgentDock', rootPath: '/home/dev/agentdock', createdAt: 'now', updatedAt: 'now' }
const SIDECAR: Project = { id: 'project_2', name: 'Sidecar', rootPath: null, createdAt: 'now', updatedAt: 'now' }

const MODELS: ModelOption[] = [
  { id: ORBIT_DEFAULT_MODEL_ID, label: 'Gemini 3.8 Flash', supportedReasoningEfforts: ['low', 'medium', 'high'] },
  { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', supportedReasoningEfforts: ['low', 'high'] }
]

function conversation(overrides: Partial<Conversation> & { id: string; projectId: string; title: string }): Conversation {
  return {
    providerId: 'antigravity',
    nativeConversationId: null,
    status: 'idle',
    transport: 'structured',
    model: ORBIT_DEFAULT_MODEL_ID,
    permissionMode: 'ask' as const,
    reasoningEffort: 'medium',
    workingDirectory: null,
    createdAt: 'now',
    updatedAt: 'now',
    ...overrides
  }
}

const FIX_LOGIN = conversation({ id: 'conversation_1', projectId: 'project_1', title: 'Fix Login Bug' })
const OLDER = conversation({ id: 'conversation_2', projectId: 'project_1', title: 'Older Work' })
const SIDECAR_SESSION = conversation({ id: 'conversation_3', projectId: 'project_2', title: 'Sidecar Notes' })

/** Orbit reopens the session the user was last in.
 *
 *  These tests drive the renderer against a stand-in for the main process
 *  that keeps its real rules (test/main/startupSession.test.ts pins the real
 *  thing): the remembered session if it still exists, else the most recent,
 *  and a new Unsorted session only when there is none — resolved once per
 *  launch and handed back to every later caller. */
describe('opening Orbit', () => {
  let api: OrbitApi
  let preferences: OrbitPreferences
  let projects: Project[]
  let sessions: Record<string, Conversation[]>
  let created: number
  /** The memoized launch session, exactly as the main process holds it. */
  let launch: Promise<StartupSession | null> | null
  let unsortedSessions: Conversation[]

  const snapshotFor = (project: Project): ProjectSnapshot => ({
    project,
    conversations: sessions[project.id] ?? [],
    messages: [],
    runs: [],
    artifacts: [],
    artifactVersions: [],
    projectFiles: [],
    references: []
  })

  /** Ends this application launch and starts the next one: a new main
   *  process, so a new launch session, but the same stored projects and
   *  sessions. */
  const relaunch = (): void => {
    launch = null
  }

  beforeEach(() => {
    window.localStorage.clear()
    preferences = { ...EMPTY_PREFERENCES }
    projects = [AGENTDOCK, SIDECAR]
    sessions = { project_1: [FIX_LOGIN, OLDER], project_2: [SIDECAR_SESSION] }
    created = 0
    launch = null
    unsortedSessions = []

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
        list: vi.fn(async () => projects),
        tree: vi.fn(async () => projects.map((project) => ({ project, conversations: sessions[project.id] ?? [] }))),
        create: vi.fn(async (input) => {
          const made: Project = { id: 'project_new', name: input.name, rootPath: input.rootPath ?? null, createdAt: 'now', updatedAt: 'now' }
          projects = [made, ...projects]
          // The real createProject gives a new project its first session.
          sessions[made.id] = [conversation({ id: 'conversation_first', projectId: made.id, title: DEFAULT_SESSION_TITLE })]
          return made
        }),
        open: vi.fn(async (projectId) => snapshotFor(projects.find((item) => item.id === projectId) ?? AGENTDOCK)),
        openUnsorted: vi.fn(async () => ({ ...snapshotForUnsorted(), conversations: unsortedSessions })),
        setRoot: vi.fn()
      },
      dialog: { pickFolder: vi.fn(async () => '/home/dev/chosen') },
      // The main process, faithfully: resolve the project, create exactly one
      // session there through the ordinary path, and memoize it for the rest
      // of this launch.
      startup: {
        session: vi.fn(async () => {
          launch ??= (async (): Promise<StartupSession | null> => {
            const all = [...unsortedSessions, ...projects.flatMap((project) => sessions[project.id] ?? [])]
            const remembered = all.find((item) => item.id === preferences.lastActiveConversationId)
            if (remembered) return { projectId: remembered.projectId, conversationId: remembered.id }
            // The stand-in's recency order: Unsorted first, then projects.
            if (all[0]) return { projectId: all[0].projectId, conversationId: all[0].id }
            const made = await api.conversations.create({ projectId: null })
            unsortedSessions = [made, ...unsortedSessions]
            return { projectId: null, conversationId: made.id }
          })()
          return launch
        })
      },
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
          const made = conversation({ id: `conversation_new_${created}`, projectId: input.projectId, title: DEFAULT_SESSION_TITLE })
          sessions[input.projectId] = [made, ...(sessions[input.projectId] ?? [])]
          return made
        }),
        listUnsorted: vi.fn(async () => unsortedSessions),
        assignProject: vi.fn(),
        rename: vi.fn(),
        delete: vi.fn(),
        setTransport: vi.fn(),
        // Stateful, like the real store: a refresh after the write must
        // read back the change, not the value the session was created with.
        setModel: vi.fn(async ({ conversationId, model, reasoningEffort }) => {
          unsortedSessions = unsortedSessions.map((item) =>
            item.id === conversationId ? { ...item, model, reasoningEffort } : item
          )
          return unsortedSessions.find((item) => item.id === conversationId)!
        }),
        setPermissionMode: vi.fn(async ({ conversationId, permissionMode }) => {
          unsortedSessions = unsortedSessions.map((item) =>
            item.id === conversationId ? { ...item, permissionMode } : item
          )
          return unsortedSessions.find((item) => item.id === conversationId)!
        }),
        setWorkingDirectory: vi.fn(),
        // The main process records it; the next launch reads it back.
        markActive: vi.fn(async (conversationId: string) => {
          preferences = { ...preferences, lastActiveConversationId: conversationId }
        })
      },
      data: { clearAll: vi.fn() },
      defaults: { modelStatus: vi.fn(async () => ({ modelId: ORBIT_DEFAULT_MODEL_ID, source: 'factory' as const, missingModelId: null })) },
      clipboard: { writeText: vi.fn(async () => true) },
      models: { list: vi.fn(async () => MODELS) },
      messages: {
        send: vi.fn(async () => ({
          id: 'run_1',
          projectId: null,
          conversationId: 'conversation_new_1',
          providerId: 'antigravity' as const,
          state: 'running' as const,
          startedAt: 'now',
          endedAt: null,
          cancellationRequestedAt: null,
          nativeRunId: null,
          error: null,
          metadata: {}
        }))
      },
      runs: { cancel: vi.fn(), onEvent: vi.fn(() => () => undefined) },
      interactions: { respond: vi.fn() },
      files: { attach: vi.fn(), attachPaths: vi.fn(), attachImage: vi.fn(), thumbnail: vi.fn(async () => null), pathForFile: vi.fn(() => null) },
      artifacts: { list: vi.fn(), import: vi.fn(), getContent: vi.fn(), describe: vi.fn(), open: vi.fn(), reveal: vi.fn() },
      repository: { state: vi.fn(async () => NO_REPOSITORY) },
      references: { create: vi.fn() }
    }
    Object.defineProperty(window, 'orbit', { value: api, configurable: true })
  })

  const header = (): HTMLElement => document.querySelector('.chrome') as HTMLElement

  const open = async (): Promise<ReturnType<typeof render>> => {
    const view = render(<App />)
    await screen.findByText('Projects')
    await waitFor(() => expect(api.startup.session).toHaveBeenCalled())
    return view
  }

  it('reopens the conversation that was active last time, without creating one', async () => {
    preferences = { ...EMPTY_PREFERENCES, lastActiveProjectId: 'project_2', lastActiveConversationId: 'conversation_3' }
    await open()

    await waitFor(() => expect(within(header()).getByText('Sidecar Notes')).toBeInTheDocument())
    expect(api.projects.open).toHaveBeenCalledWith('project_2')
    expect(screen.getByRole('button', { name: /^Sidecar Notes/ })).toHaveAttribute('aria-current', 'true')
    expect(api.conversations.create).not.toHaveBeenCalled()
  })

  it('hands the composer over ready to type in the reopened session', async () => {
    preferences = { ...EMPTY_PREFERENCES, lastActiveConversationId: 'conversation_1' }
    await open()

    await waitFor(() => expect(within(header()).getByText('Fix Login Bug')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByLabelText('Message Antigravity')).toHaveFocus())
  })

  it('falls back to an existing session when the remembered one was deleted', async () => {
    preferences = { ...EMPTY_PREFERENCES, lastActiveProjectId: 'project_deleted', lastActiveConversationId: 'conversation_gone' }
    await open()

    await waitFor(() => expect(within(header()).getByText('Fix Login Bug')).toBeInTheDocument())
    expect(api.conversations.create).not.toHaveBeenCalled()
  })

  it('reopens a remembered Unsorted session', async () => {
    unsortedSessions = [conversation({ id: 'conversation_loose', projectId: null as unknown as string, title: 'Loose Thoughts' })]
    preferences = { ...EMPTY_PREFERENCES, lastActiveConversationId: 'conversation_loose' }
    await open()

    await waitFor(() => expect(within(header()).getByText('Loose Thoughts')).toBeInTheDocument())
    expect(api.projects.openUnsorted).toHaveBeenCalled()
    expect(api.conversations.create).not.toHaveBeenCalled()
  })

  it('remembers the session the user moves to, and the next launch reopens it', async () => {
    preferences = { ...EMPTY_PREFERENCES, lastActiveConversationId: 'conversation_1' }
    const first = await open()
    await waitFor(() => expect(within(header()).getByText('Fix Login Bug')).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: /^Older Work/ }))
    await waitFor(() => expect(api.conversations.markActive).toHaveBeenLastCalledWith('conversation_2'))
    first.unmount()

    relaunch()
    await open()
    await waitFor(() => expect(within(header()).getByText('Older Work')).toBeInTheDocument())
    expect(api.conversations.create).not.toHaveBeenCalled()
  })

  it('makes a session the user creates the one the next launch reopens', async () => {
    preferences = { ...EMPTY_PREFERENCES, lastActiveConversationId: 'conversation_1' }
    const first = await open()
    await waitFor(() => expect(within(header()).getByText('Fix Login Bug')).toBeInTheDocument())

    await userEvent.click(screen.getByLabelText('New session in AgentDock'))
    await waitFor(() => expect(api.conversations.markActive).toHaveBeenLastCalledWith('conversation_new_1'))
    first.unmount()

    relaunch()
    await open()
    await waitFor(() => expect(api.projects.open).toHaveBeenLastCalledWith('project_1'))
    await waitFor(() => expect(screen.getByRole('button', { name: /^New Session/ })).toHaveAttribute('aria-current', 'true'))
    expect(api.conversations.create).toHaveBeenCalledTimes(1)
  })

  it('keeps every project conversation in the sidebar, and lets one be opened by hand', async () => {
    preferences = { ...EMPTY_PREFERENCES, lastActiveConversationId: 'conversation_3' }
    await open()

    await userEvent.click(screen.getByRole('button', { name: 'AgentDock' }))
    expect(await screen.findByRole('button', { name: /^Fix Login Bug/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Older Work/ })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /^Fix Login Bug/ }))
    await waitFor(() => expect(within(header()).getByText('Fix Login Bug')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /^Fix Login Bug/ })).toHaveAttribute('aria-current', 'true')
  })

  it('resolves one session for the launch, however many times the renderer asks', async () => {
    projects = []
    sessions = {}
    let view = await open()
    view.unmount()
    view = await open()
    view.unmount()
    await open()

    expect(api.startup.session).toHaveBeenCalledTimes(3)
    expect(api.conversations.create).toHaveBeenCalledTimes(1)
    expect(unsortedSessions).toHaveLength(1)
  })

  it('creates no extra session when the renderer merely re-renders', async () => {
    const view = await open()
    view.rerender(<App />)
    view.rerender(<App />)

    await waitFor(() => expect(api.startup.session).toHaveBeenCalled())
    expect(api.conversations.create).not.toHaveBeenCalled()
  })

  it('does not create a blank session on a relaunch when sessions exist', async () => {
    const first = await open()
    first.unmount()
    relaunch()
    await open()

    expect(api.conversations.create).not.toHaveBeenCalled()
    expect(unsortedSessions).toHaveLength(0)
    expect(sessions.project_1).toHaveLength(2)
  })

  /** A brand-new Unsorted session that the user was last in — the world the
   *  Unsorted-session tests below start from. */
  const rememberFreshUnsorted = (): void => {
    unsortedSessions = [conversation({ id: 'conversation_new_1', projectId: null as unknown as string, title: DEFAULT_SESSION_TITLE })]
    created = 1
    preferences = { ...EMPTY_PREFERENCES, lastActiveConversationId: 'conversation_new_1' }
  }

  it('needs no project to exist at all', async () => {
    projects = []
    sessions = {}
    await open()

    expect(api.conversations.create).toHaveBeenCalledWith({ projectId: null })
    await waitFor(() => expect(screen.getByLabelText('Message Antigravity')).toBeInTheDocument())
  })

  it('creates no project when one already exists', async () => {
    await open()

    expect(api.projects.create).not.toHaveBeenCalled()
    expect(projects).toHaveLength(2)
  })

  it('creates no project on first run, only a session', async () => {
    projects = []
    sessions = {}
    await open()

    expect(api.projects.create).not.toHaveBeenCalled()
    expect(await screen.findByText('No projects yet.')).toBeInTheDocument()
  })

  it('opens the launch session on Orbit’s concrete default model, not “Default model”', async () => {
    rememberFreshUnsorted()
    await open()

    const trigger = await screen.findByRole('button', { name: 'Model and reasoning' })
    await waitFor(() => expect(trigger).toBeEnabled())
    expect(trigger).toHaveTextContent('3.8 Flash')
    expect(trigger).not.toHaveTextContent('Default model')
  })

  it('gives the launch session the ordinary permission default', async () => {
    rememberFreshUnsorted()
    await open()

    const permissions = await screen.findByRole('button', { name: 'Permissions' })
    expect(permissions).toHaveTextContent(/Ask first/i)
  })

  it('changes the model of an Unsorted session, visibly and immediately', async () => {
    rememberFreshUnsorted()
    // The reported bug: the launch session lives in the Unsorted list, and
    // the optimistic update only ever touched the project tree — so picking
    // a model appeared to do nothing at all.
    await open()
    const trigger = await screen.findByRole('button', { name: 'Model and reasoning' })
    await waitFor(() => expect(trigger).toBeEnabled())
    expect(trigger).toHaveTextContent('3.8 Flash')

    await userEvent.click(trigger)
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Gemini 3\.1 Pro/ }))

    // The closed control reflects the choice, without waiting for a reload.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Model and reasoning' })).toHaveTextContent('3.1 Pro'))
    expect(api.conversations.setModel).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conversation_new_1', model: 'gemini-3.1-pro' })
    )
  })

  it('switches the model of an Unsorted session more than once', async () => {
    rememberFreshUnsorted()
    await open()
    const trigger = (): HTMLElement => screen.getByRole('button', { name: 'Model and reasoning' })
    await waitFor(() => expect(trigger()).toBeEnabled())

    /** The popover stays open after a selection, so it is only reopened
     *  when it actually closed. */
    const pick = async (name: RegExp): Promise<void> => {
      if (trigger().getAttribute('aria-expanded') !== 'true') await userEvent.click(trigger())
      await userEvent.click(await screen.findByRole('menuitemradio', { name }))
    }

    await pick(/Gemini 3\.1 Pro/)
    await waitFor(() => expect(trigger()).toHaveTextContent('3.1 Pro'))

    await pick(/Gemini 3\.8 Flash/)
    await waitFor(() => expect(trigger()).toHaveTextContent('3.8 Flash'))

    expect(vi.mocked(api.conversations.setModel).mock.calls.at(-1)?.[0]).toMatchObject({ model: ORBIT_DEFAULT_MODEL_ID })
  })

  it('changes the permission mode of an Unsorted session, visibly and immediately', async () => {
    rememberFreshUnsorted()
    await open()
    const permissions = await screen.findByRole('button', { name: 'Permissions' })
    expect(permissions).toHaveTextContent(/Ask first/i)

    await userEvent.click(permissions)
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Bypass permissions/ }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Permissions' })).toHaveTextContent(/Bypass permissions/i))
    // The label changed; the stored mode is still the internal `skip`.
    expect(api.conversations.setPermissionMode).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conversation_new_1', permissionMode: 'skip' })
    )
  })

  it('switches an Unsorted session back to Ask first', async () => {
    rememberFreshUnsorted()
    await open()
    await userEvent.click(await screen.findByRole('button', { name: 'Permissions' }))
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Bypass permissions/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Permissions' })).toHaveTextContent(/Bypass permissions/i))

    await userEvent.click(screen.getByRole('button', { name: 'Permissions' }))
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Ask first/ }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Permissions' })).toHaveTextContent(/Ask first/i))
    expect(vi.mocked(api.conversations.setPermissionMode).mock.calls.at(-1)?.[0]).toMatchObject({ permissionMode: 'ask' })
  })

  it('sends from the Unsorted session with no project, and says so to the runtime', async () => {
    rememberFreshUnsorted()
    // The reported failure came from here: the composer sent projectId null
    // and the IPC validator rejected it before the runtime was reached.
    await open()
    await userEvent.type(screen.getByLabelText('Message Antigravity'), 'Reply with the exact model name you are running as.')
    await userEvent.click(screen.getByLabelText('Send message'))

    await waitFor(() =>
      expect(api.messages.send).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: null, conversationId: 'conversation_new_1' })
      )
    )
  })

  it('offers no attachment control it cannot honour in an Unsorted session', async () => {
    rememberFreshUnsorted()
    await open()

    // Attachments are stored against a project, so rather than a control
    // that silently does nothing, it is disabled and says why.
    const attach = screen.getByRole('button', { name: 'Add files' })
    expect(attach).toBeDisabled()
    expect(attach).toHaveAttribute('title', expect.stringMatching(/stored in a project/i))
  })

  it('shows the launch session as belonging to no project, and still usable', async () => {
    rememberFreshUnsorted()
    await open()

    // "No project" is a state, not an error: the composer is ready.
    await waitFor(() => expect(screen.getByLabelText('Project and working folder')).toHaveTextContent('No project'))
    expect(screen.getByLabelText('Message Antigravity')).toBeEnabled()
  })

  it('still makes a session inside a project in one click', async () => {
    rememberFreshUnsorted()
    await open()
    await waitFor(() => expect(within(header()).getByText(DEFAULT_SESSION_TITLE)).toBeInTheDocument())

    await userEvent.click(screen.getByLabelText('New session in AgentDock'))

    // A project's own + still puts the session in that project.
    await waitFor(() => expect(api.conversations.create).toHaveBeenLastCalledWith({ projectId: 'project_1' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
