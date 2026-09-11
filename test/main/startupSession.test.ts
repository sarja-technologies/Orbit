import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrbitDatabase } from '../../src/main/persistence/database'
import { OrbitStore } from '../../src/main/persistence/store'
import { FileStorage } from '../../src/main/files/fileStorage'
import { ArtifactService } from '../../src/main/artifacts/artifactService'
import { OrbitRuntime } from '../../src/main/runtime/orbitRuntime'
import { StartupSessionResolver, startupProjectFor, type StartupSessionHost } from '../../src/main/startup/startupSession'
import { ORBIT_DEFAULT_MODEL_ID } from '../../src/shared/defaultModel'
import { DEFAULT_PERMISSION_MODE } from '../../src/shared/permissionMode'
import { DEFAULT_SESSION_TITLE } from '../../src/shared/sessionTitle'
import type { AgentProvider, ProviderSendInput } from '../../src/main/runtime/provider'
import type { ModelOption, Project, ProjectGroup, ProviderStatus } from '../../src/shared/domain'
import type { RuntimeEvent } from '../../src/shared/runtime-events'

const CATALOGUE: ModelOption[] = [
  { id: ORBIT_DEFAULT_MODEL_ID, label: 'Gemini 3.8 Flash', supportedReasoningEfforts: ['low', 'medium', 'high'] }
]

class QuietProvider implements AgentProvider {
  listModels = vi.fn(async () => CATALOGUE)
  cancelRun = vi.fn(async () => undefined)
  respondToInteraction = vi.fn(async () => undefined)
  releaseConversation = vi.fn(async () => undefined)
  shutdown = vi.fn(async () => undefined)
  async getStatus(): Promise<ProviderStatus> {
    return { id: 'antigravity', state: 'ready', sdkAvailable: true, authConfigured: true, message: null, details: {} }
  }
  async sendMessage(_input: ProviderSendInput, _onEvent: (event: RuntimeEvent) => void): Promise<void> {}
}

function project(id: string, name: string): Project {
  return { id, name, rootPath: null, createdAt: 'now', updatedAt: 'now' }
}

function groupsOf(...projects: Project[]): ProjectGroup[] {
  return projects.map((item) => ({ project: item, conversations: [] }))
}

describe('where a launch session starts', () => {
  const WEBSITE = project('project_1', 'AgentDock')
  const RENDERER = project('project_2', 'Renderer')

  it('starts in no project at all, whatever was open last', () => {
    // Unsorted by design: launching Orbit and typing must not require
    // picking a project, and the last one used is not a decision the user
    // made about this session.
    expect(startupProjectFor(groupsOf(WEBSITE, RENDERER), 'project_2')).toBeNull()
    expect(startupProjectFor(groupsOf(WEBSITE, RENDERER), 'project_1')).toBeNull()
    expect(startupProjectFor(groupsOf(WEBSITE, RENDERER), null)).toBeNull()
  })

  it('needs no project to exist first', () => {
    expect(startupProjectFor([], null)).toBeNull()
  })
})

describe('exactly one launch session per application launch', () => {
  let host: StartupSessionHost & { createConversation: ReturnType<typeof vi.fn> }
  let groups: ProjectGroup[]
  let lastActive: string | null

  beforeEach(() => {
    groups = groupsOf(project('project_1', 'AgentDock'), project('project_2', 'Renderer'))
    lastActive = null
    let made = 0
    host = {
      listProjectTree: () => groups,
      readLastActiveProjectId: () => lastActive,
      createConversation: vi.fn((projectId: string | null) => {
        made += 1
        return { id: `conversation_${made}`, projectId }
      })
    }
  })

  it('creates one Unsorted session on the first call', async () => {
    const session = await new StartupSessionResolver(host).ensure()

    expect(session).toEqual({ projectId: null, conversationId: 'conversation_1' })
    expect(host.createConversation).toHaveBeenCalledTimes(1)
    expect(host.createConversation).toHaveBeenCalledWith(null)
  })

  it('hands the same session back however many times it is asked for', async () => {
    // A React remount, an HMR reload, a reconnecting bridge, a second
    // window: all of these ask again, and none of them is a new launch.
    const resolver = new StartupSessionResolver(host)
    const first = await resolver.ensure()
    const again = await resolver.ensure()
    const third = await resolver.ensure()

    expect(again).toEqual(first)
    expect(third).toEqual(first)
    expect(host.createConversation).toHaveBeenCalledTimes(1)
  })

  it('creates one session even when several callers race before the first resolves', async () => {
    const resolver = new StartupSessionResolver(host)
    const [a, b, c] = await Promise.all([resolver.ensure(), resolver.ensure(), resolver.ensure()])

    expect(b).toEqual(a)
    expect(c).toEqual(a)
    expect(host.createConversation).toHaveBeenCalledTimes(1)
  })

  it('creates another session on the next launch, because that is a new resolver', async () => {
    // Quitting Orbit ends the main process; launching it builds a new one.
    const first = await new StartupSessionResolver(host).ensure()
    const second = await new StartupSessionResolver(host).ensure()

    expect(second).not.toEqual(first)
    expect(host.createConversation).toHaveBeenCalledTimes(2)
  })

  it('does not put the session in the last-used project', async () => {
    lastActive = 'project_2'
    await expect(new StartupSessionResolver(host).ensure()).resolves.toEqual({
      projectId: null,
      conversationId: 'conversation_1'
    })
  })

  it('still produces a session on first run, with no project in existence', async () => {
    groups = []
    await expect(new StartupSessionResolver(host).ensure()).resolves.toEqual({
      projectId: null,
      conversationId: 'conversation_1'
    })
  })
})

describe('the launch session against the real runtime', () => {
  let dir: string
  let db: OrbitDatabase
  let store: OrbitStore
  let runtime: OrbitRuntime

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-startup-'))
    db = new OrbitDatabase({ dataDir: dir })
    await db.init()
    store = new OrbitStore(db)
    runtime = new OrbitRuntime(store, new ArtifactService(store, new FileStorage(dir)), new QuietProvider(), dir, '0.1.0')
    await runtime.listModels()
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('opens on a brand-new Unsorted session, not the project or conversation last used', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-root-'))
    const project = runtime.createProject('AgentDock', workspace)
    const before = runtime.openProject(project.id).conversations[0]!
    store.writePreferences({ ...store.readPreferences(), lastActiveProjectId: project.id, lastActiveConversationId: before.id })

    const session = await runtime.ensureStartupSession()

    expect(session).not.toBeNull()
    expect(session!.projectId).toBeNull()
    expect(session!.conversationId).not.toBe(before.id)
    expect(store.requireConversation(session!.conversationId).projectId).toBeNull()
  })

  it('leaves every earlier conversation in place and selectable', async () => {
    const project = runtime.createProject('AgentDock')
    const first = runtime.openProject(project.id).conversations[0]!
    const second = runtime.createConversation(project.id, 'Fix Login Bug')

    const session = await runtime.ensureStartupSession()

    // The project's own sessions are untouched; the launch session is
    // Unsorted and sits outside them.
    const ids = runtime.openProject(project.id).conversations.map((item) => item.id)
    expect(ids).toContain(first.id)
    expect(ids).toContain(second.id)
    expect(ids).not.toContain(session!.conversationId)
    expect(runtime.listUnsortedConversations().map((item) => item.id)).toContain(session!.conversationId)
    // Still reachable, which is what selecting one in the sidebar does.
    expect(store.getConversation(second.id)?.title).toBe('Fix Login Bug')
  })

  it('gives the launch session every ordinary new-session default', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-root-'))
    const project = runtime.createProject('AgentDock', workspace)

    const session = await runtime.ensureStartupSession()
    const conversation = store.requireConversation(session!.conversationId)

    expect(conversation.title).toBe(DEFAULT_SESSION_TITLE)
    // Orbit's own concrete model, never a placeholder that leaves agy to pick.
    expect(conversation.model).toBe(ORBIT_DEFAULT_MODEL_ID)
    expect(conversation.reasoningEffort).toBe('medium')
    expect(conversation.permissionMode).toBe(DEFAULT_PERMISSION_MODE)
    expect(conversation.transport).toBe('structured')
    expect(conversation.providerId).toBe('antigravity')
    // Empty until the provider reports one, and null folder means it
    // inherits the project's.
    expect(conversation.nativeConversationId).toBeNull()
    expect(conversation.workingDirectory).toBeNull()
    expect(conversation.projectId).toBeNull()
    expect(store.getProject(project.id)?.rootPath).toBe(workspace)
  })

  it('adds exactly one session per launch, and no project', async () => {
    const project = runtime.createProject('AgentDock')
    const before = runtime.openProject(project.id).conversations.length

    await runtime.ensureStartupSession()
    await runtime.ensureStartupSession()
    await runtime.ensureStartupSession()

    // One Unsorted session, and the project is exactly as it was.
    expect(runtime.listUnsortedConversations()).toHaveLength(1)
    expect(runtime.openProject(project.id).conversations).toHaveLength(before)
    expect(runtime.listProjects()).toHaveLength(1)
  })

  it('still opens on a usable session when no project exists at all', async () => {
    // First run is no longer a dead end: the session needs no project.
    const session = await runtime.ensureStartupSession()

    expect(session).not.toBeNull()
    expect(session!.projectId).toBeNull()
    expect(runtime.listProjects()).toHaveLength(0)
    expect(runtime.listUnsortedConversations()).toHaveLength(1)
  })

  it('still names the launch session from its first prompt', async () => {
    runtime.createProject('AgentDock')
    const session = await runtime.ensureStartupSession()

    await runtime.sendMessage({
      conversationId: session!.conversationId,
      content: 'build me a futuristic robotics landing page'
    })

    expect(store.requireConversation(session!.conversationId).title).toBe('Futuristic Robotics Landing Page')
  })
})
