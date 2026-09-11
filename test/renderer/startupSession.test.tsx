// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../src/renderer/app/App'
import type { OrbitApi, StartupSession } from '../../src/shared/contracts'
import type { Conversation, ModelOption, OrbitPreferences, Project, ProjectSnapshot, ProviderStatus } from '../../src/shared/domain'
import { ORBIT_DEFAULT_MODEL_ID } from '../../src/shared/defaultModel'
import { EMPTY_PREFERENCES } from '../../src/shared/reasoningPolicy'
import { DEFAULT_SESSION_TITLE } from '../../src/shared/sessionTitle'

const AGENTDOCK: Project = { id: 'project_1', name: 'AgentDock', rootPath: '/home/dev/agentdock', createdAt: 'now', updatedAt: 'now' }
const SIDECAR: Project = { id: 'project_2', name: 'Sidecar', rootPath: null, createdAt: 'now', updatedAt: 'now' }

const MODELS: ModelOption[] = [
  { id: ORBIT_DEFAULT_MODEL_ID, label: 'Gemini 3.8 Flash', supportedReasoningEfforts: ['low', 'medium', 'high'] }
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

/** Orbit opens on one brand-new session per application launch.
 *
 *  These tests drive the renderer against a stand-in for the main process
 *  that keeps the real invariant: the launch session is created once and
 *  handed back to every later caller, so only quitting and launching again
 *  produces another one. */
describe('opening Orbit', () => {
  let api: OrbitApi
  let preferences: OrbitPreferences
  let projects: Project[]
  let sessions: Record<string, Conversation[]>
  let created: number
  /** The memoized launch session, exactly as the main process holds it. */
  let launch: Promise<StartupSession | null> | null

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
        setRoot: vi.fn()
      },
      dialog: { pickFolder: vi.fn(async () => '/home/dev/chosen') },
      // The main process, faithfully: resolve the project, create exactly one
      // session there through the ordinary path, and memoize it for the rest
      // of this launch.
      startup: {
        session: vi.fn(async () => {
          launch ??= (async (): Promise<StartupSession | null> => {
            const target = projects.find((item) => item.id === preferences.lastActiveProjectId) ?? projects[0]
            if (!target) return null
            const made = await api.conversations.create({ projectId: target.id })
            return { projectId: target.id, conversationId: made.id }
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
        rename: vi.fn(),
        delete: vi.fn(),
        setTransport: vi.fn(),
        setModel: vi.fn(),
        setPermissionMode: vi.fn(),
        setWorkingDirectory: vi.fn()
      },
      data: { clearAll: vi.fn() },
      defaults: { modelStatus: vi.fn(async () => ({ modelId: ORBIT_DEFAULT_MODEL_ID, source: 'factory' as const, missingModelId: null })) },
      clipboard: { writeText: vi.fn(async () => true) },
      models: { list: vi.fn(async () => MODELS) },
      messages: { send: vi.fn() },
      runs: { cancel: vi.fn(), onEvent: vi.fn(() => () => undefined) },
      interactions: { respond: vi.fn() },
      files: { attach: vi.fn(), attachPaths: vi.fn(), attachImage: vi.fn(), thumbnail: vi.fn(async () => null), pathForFile: vi.fn(() => null) },
      artifacts: { list: vi.fn(), import: vi.fn(), getContent: vi.fn(), reveal: vi.fn() },
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

  it('lands in a brand-new session, created for this launch', async () => {
    await open()

    await waitFor(() => expect(api.conversations.create).toHaveBeenCalledTimes(1))
    expect(api.conversations.create).toHaveBeenCalledWith({ projectId: 'project_1' })
    await waitFor(() => expect(within(header()).getByText(DEFAULT_SESSION_TITLE)).toBeInTheDocument())
  })

  it('selects that new session, and hands the composer over ready to type', async () => {
    await open()

    const row = await screen.findByRole('button', { name: /^New Session/ })
    await waitFor(() => expect(row).toHaveAttribute('aria-current', 'true'))
    await waitFor(() => expect(screen.getByLabelText('Message Antigravity')).toHaveFocus())
  })

  it('does not reopen the conversation that was active last time', async () => {
    preferences = { ...EMPTY_PREFERENCES, lastActiveProjectId: 'project_1', lastActiveConversationId: 'conversation_1' }
    await open()

    await waitFor(() => expect(within(header()).getByText(DEFAULT_SESSION_TITLE)).toBeInTheDocument())
    expect(within(header()).queryByText('Fix Login Bug')).not.toBeInTheDocument()
  })

  it('keeps every earlier conversation in the sidebar, and lets one be opened by hand', async () => {
    preferences = { ...EMPTY_PREFERENCES, lastActiveProjectId: 'project_1', lastActiveConversationId: 'conversation_1' }
    await open()

    // Still listed, none of them deleted.
    expect(screen.getByRole('button', { name: /^Fix Login Bug/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Older Work/ })).toBeInTheDocument()

    // And still selectable after the launch session has taken the floor.
    await userEvent.click(screen.getByRole('button', { name: /^Fix Login Bug/ }))
    await waitFor(() => expect(within(header()).getByText('Fix Login Bug')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /^Fix Login Bug/ })).toHaveAttribute('aria-current', 'true')
  })

  it('creates one session for the launch, however many times the renderer asks', async () => {
    // Standing in for a remount, an HMR reload or a reconnecting bridge:
    // the renderer starts over, the application has not.
    let view = await open()
    view.unmount()
    view = await open()
    view.unmount()
    await open()

    expect(api.startup.session).toHaveBeenCalledTimes(3)
    expect(api.conversations.create).toHaveBeenCalledTimes(1)
    expect(sessions.project_1).toHaveLength(3)
  })

  it('creates no extra session when the renderer merely re-renders', async () => {
    const view = await open()
    view.rerender(<App />)
    view.rerender(<App />)

    await waitFor(() => expect(api.conversations.create).toHaveBeenCalledTimes(1))
  })

  it('creates another fresh session the next time Orbit is launched', async () => {
    const first = await open()
    await waitFor(() => expect(api.conversations.create).toHaveBeenCalledTimes(1))
    first.unmount()

    relaunch()
    await open()

    await waitFor(() => expect(api.conversations.create).toHaveBeenCalledTimes(2))
    // The earlier launch session is still there — nothing is cleaned up.
    expect(sessions.project_1).toHaveLength(4)
    expect(screen.getByRole('button', { name: /^Fix Login Bug/ })).toBeInTheDocument()
  })

  it('puts the fresh session in the project the user was last in', async () => {
    preferences = { ...EMPTY_PREFERENCES, lastActiveProjectId: 'project_2', lastActiveConversationId: 'conversation_3' }
    await open()

    expect(api.conversations.create).toHaveBeenCalledWith({ projectId: 'project_2' })
    await waitFor(() => expect(api.projects.open).toHaveBeenCalledWith('project_2'))
    await waitFor(() => expect(within(header()).getByText('Sidecar')).toBeInTheDocument())
  })

  it('falls back to the most recent project when the remembered one is gone', async () => {
    preferences = { ...EMPTY_PREFERENCES, lastActiveProjectId: 'project_deleted', lastActiveConversationId: 'conversation_gone' }
    await open()

    expect(api.conversations.create).toHaveBeenCalledWith({ projectId: 'project_1' })
  })

  it('creates no project when one already exists', async () => {
    await open()

    expect(api.projects.create).not.toHaveBeenCalled()
    expect(projects).toHaveLength(2)
  })

  it('creates nothing on first run, and offers to make the first project', async () => {
    projects = []
    sessions = {}
    await open()

    expect(api.conversations.create).not.toHaveBeenCalled()
    expect(api.projects.create).not.toHaveBeenCalled()
    expect(await screen.findByText('No projects yet.')).toBeInTheDocument()
  })

  it('opens the launch session on Orbit’s concrete default model, not “Default model”', async () => {
    await open()

    const trigger = await screen.findByLabelText('Model and reasoning')
    await waitFor(() => expect(trigger).toBeEnabled())
    expect(trigger).toHaveTextContent('3.8 Flash')
    expect(trigger).not.toHaveTextContent('Default model')
  })

  it('gives the launch session the ordinary permission default', async () => {
    await open()

    const permissions = await screen.findByLabelText('Permissions')
    expect(permissions).toHaveTextContent(/Ask first/i)
  })

  it('inherits the project’s working folder for the launch session', async () => {
    await open()

    // The session has no folder of its own, so the project's is what shows.
    await waitFor(() => expect(within(header()).getByText('/home/dev/agentdock')).toBeInTheDocument())
  })

  it('still makes a session in one click after landing in the launch one', async () => {
    await open()
    await waitFor(() => expect(api.conversations.create).toHaveBeenCalledTimes(1))

    await userEvent.click(screen.getByLabelText('New session in AgentDock'))

    await waitFor(() => expect(api.conversations.create).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
