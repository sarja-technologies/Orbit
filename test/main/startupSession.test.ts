import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrbitDatabase } from '../../src/main/persistence/database'
import { OrbitStore } from '../../src/main/persistence/store'
import { FileStorage } from '../../src/main/files/fileStorage'
import { ArtifactService } from '../../src/main/artifacts/artifactService'
import { OrbitRuntime } from '../../src/main/runtime/orbitRuntime'
import { StartupSessionResolver, resolveStartupSession, type StartupSessionHost } from '../../src/main/startup/startupSession'
import { ORBIT_DEFAULT_MODEL_ID } from '../../src/shared/defaultModel'
import { DEFAULT_PERMISSION_MODE } from '../../src/shared/permissionMode'
import { DEFAULT_SESSION_TITLE } from '../../src/shared/sessionTitle'
import type { AgentProvider, ProviderSendInput } from '../../src/main/runtime/provider'
import type { Conversation, ModelOption, ProviderStatus } from '../../src/shared/domain'
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

function conversation(id: string, projectId: string | null, updatedAt = '2026-09-13T10:00:00.000Z'): Conversation {
  return {
    id,
    projectId,
    title: id,
    providerId: 'antigravity',
    nativeConversationId: null,
    status: 'idle',
    transport: 'structured',
    model: ORBIT_DEFAULT_MODEL_ID,
    permissionMode: DEFAULT_PERMISSION_MODE,
    reasoningEffort: 'medium',
    workingDirectory: null,
    createdAt: updatedAt,
    updatedAt
  }
}

describe('which session a launch opens on', () => {
  let rows: Conversation[]
  let remembered: string | null
  let host: StartupSessionHost & { createConversation: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    rows = []
    remembered = null
    let made = 0
    host = {
      readLastActiveConversationId: () => remembered,
      getConversation: (id) => rows.find((row) => row.id === id) ?? null,
      mostRecentConversation: () => [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null,
      createConversation: vi.fn((projectId: string | null) => {
        made += 1
        const row = conversation(`conversation_new_${made}`, projectId)
        rows.push(row)
        return row
      })
    }
  })

  it('reopens the session the user was last in, and creates nothing', () => {
    rows = [conversation('recent', 'project_1', '2026-09-13T12:00:00.000Z'), conversation('mine', 'project_2', '2026-09-01T00:00:00.000Z')]
    remembered = 'mine'
    expect(resolveStartupSession(host)).toEqual({ projectId: 'project_2', conversationId: 'mine', source: 'remembered' })
    expect(host.createConversation).not.toHaveBeenCalled()
  })

  it('reopens a remembered Unsorted session', () => {
    rows = [conversation('loose', null)]
    remembered = 'loose'
    expect(resolveStartupSession(host)).toMatchObject({ projectId: null, conversationId: 'loose' })
  })

  it('takes the project from the session as it is now, not as it was remembered', () => {
    // Remembered while Unsorted, filed into a project since.
    rows = [conversation('moved', 'project_9')]
    remembered = 'moved'
    expect(resolveStartupSession(host)).toMatchObject({ projectId: 'project_9', conversationId: 'moved' })
  })

  it('falls back to the most recent session when the remembered one was deleted', () => {
    rows = [conversation('older', 'project_1', '2026-09-01T00:00:00.000Z'), conversation('newest', null, '2026-09-13T00:00:00.000Z')]
    remembered = 'deleted'
    expect(resolveStartupSession(host)).toEqual({ projectId: null, conversationId: 'newest', source: 'most-recent' })
    expect(host.createConversation).not.toHaveBeenCalled()
  })

  it('opens the most recent session when nothing was ever remembered', () => {
    rows = [conversation('only', 'project_1')]
    expect(resolveStartupSession(host)).toMatchObject({ conversationId: 'only', source: 'most-recent' })
  })

  it('creates an Unsorted session only when there is no session at all', () => {
    expect(resolveStartupSession(host)).toEqual({ projectId: null, conversationId: 'conversation_new_1', source: 'created' })
    expect(host.createConversation).toHaveBeenCalledWith(null)
  })

  it('resolves once per launch, however many times and however concurrently it is asked', async () => {
    const resolver = new StartupSessionResolver(host)
    const [a, b, c] = await Promise.all([resolver.ensure(), resolver.ensure(), resolver.ensure()])
    const later = await resolver.ensure()
    expect([b, c, later]).toEqual([a, a, a])
    expect(host.createConversation).toHaveBeenCalledTimes(1)
  })

  it('does not create a second session on the next launch of an empty install', async () => {
    const first = await new StartupSessionResolver(host).ensure()
    const second = await new StartupSessionResolver(host).ensure()
    expect(second).toEqual(first)
    expect(host.createConversation).toHaveBeenCalledTimes(1)
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

  /** Quitting and launching again: a new runtime (and so a new resolver)
   *  over the same database. */
  const relaunch = (): OrbitRuntime => new OrbitRuntime(store, new ArtifactService(store, new FileStorage(dir)), new QuietProvider(), dir, '0.1.0')

  it('reopens the conversation last marked active, without creating a session', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-root-'))
    const project = runtime.createProject('AgentDock', workspace)
    const first = runtime.openProject(project.id).conversations[0]!
    const second = runtime.createConversation(project.id, 'Fix Login Bug')
    runtime.markConversationActive(first.id)
    const before = store.listConversations(project.id).length

    const session = await relaunch().ensureStartupSession()

    expect(session).toEqual({ projectId: project.id, conversationId: first.id })
    expect(store.listConversations(project.id)).toHaveLength(before)
    expect(runtime.listUnsortedConversations()).toHaveLength(0)
    expect(second.id).not.toBe(first.id)
  })

  it('makes an explicitly created session the next launch’s target', async () => {
    const project = runtime.createProject('AgentDock')
    runtime.markConversationActive(runtime.openProject(project.id).conversations[0]!.id)
    const created = runtime.createConversation(null)
    runtime.markConversationActive(created.id)

    await expect(relaunch().ensureStartupSession()).resolves.toEqual({ projectId: null, conversationId: created.id })
  })

  it('reopens a session in the project it was moved into', async () => {
    const loose = runtime.createConversation(null)
    runtime.markConversationActive(loose.id)
    const project = runtime.createProject('Filed')
    runtime.assignConversationToProject(loose.id, project.id)

    await expect(relaunch().ensureStartupSession()).resolves.toEqual({ projectId: project.id, conversationId: loose.id })
    expect(store.readPreferences().lastActiveProjectId).toBe(project.id)
  })

  it('falls back to the most recent session when the remembered one is deleted', async () => {
    const project = runtime.createProject('AgentDock')
    const keep = runtime.openProject(project.id).conversations[0]!
    const doomed = runtime.createConversation(null)
    runtime.markConversationActive(doomed.id)
    await runtime.deleteConversation(doomed.id)

    expect(store.readPreferences().lastActiveConversationId).toBeNull()
    await expect(relaunch().ensureStartupSession()).resolves.toEqual({ projectId: project.id, conversationId: keep.id })
    expect(runtime.listUnsortedConversations()).toHaveLength(0)
  })

  it('ignores a remembered id that names nothing, and never trusts a stale project id', async () => {
    const loose = runtime.createConversation(null)
    store.writePreferences({ ...store.readPreferences(), lastActiveProjectId: 'project_gone', lastActiveConversationId: 'conversation_gone' })
    await expect(relaunch().ensureStartupSession()).resolves.toEqual({ projectId: null, conversationId: loose.id })
    // Marking an id that does not exist changes nothing.
    runtime.markConversationActive('conversation_nope')
    expect(store.readPreferences().lastActiveConversationId).toBe('conversation_gone')
  })

  it('reopens a session that holds generated artifacts, with them intact', async () => {
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-root-')))
    const conversation = runtime.createConversation(null)
    const run = store.createRun({ projectId: null, conversationId: conversation.id })
    fs.writeFileSync(path.join(workspace, 'chart.csv'), 'a,b\n1,2\n')
    new ArtifactService(store, new FileStorage(dir)).registerOutput({ projectId: null, conversationId: conversation.id, runId: run.id, sourcePath: path.join(workspace, 'chart.csv'), sourceRoot: workspace })
    runtime.createConversation(null) // a newer, unrelated session
    runtime.markConversationActive(conversation.id)

    const next = relaunch()
    await expect(next.ensureStartupSession()).resolves.toEqual({ projectId: null, conversationId: conversation.id })
    expect(next.openUnsorted().artifacts.map((artifact) => artifact.creatorRunId)).toEqual([run.id])
  })

  it('keeps the active session when the renderer writes an older preferences object', () => {
    const a = runtime.createConversation(null)
    const b = runtime.createConversation(null)
    runtime.markConversationActive(a.id)
    const stale = store.readPreferences()
    runtime.markConversationActive(b.id)

    runtime.setPreferences({ ...stale, sidebarWidth: 300 })

    expect(store.readPreferences()).toMatchObject({ sidebarWidth: 300, lastActiveConversationId: b.id })
  })

  it('opens on a session the user already has when one exists, instead of making a new one', async () => {
    const project = runtime.createProject('AgentDock')
    const first = runtime.openProject(project.id).conversations[0]!
    const second = runtime.createConversation(project.id, 'Fix Login Bug')

    const session = await runtime.ensureStartupSession()

    const ids = runtime.openProject(project.id).conversations.map((item) => item.id)
    expect(ids).toEqual(expect.arrayContaining([first.id, second.id]))
    expect(ids).toHaveLength(2)
    expect([first.id, second.id]).toContain(session!.conversationId)
    expect(runtime.listUnsortedConversations()).toHaveLength(0)
  })

  it('gives a session created for an empty install every ordinary new-session default', async () => {
    const session = await runtime.ensureStartupSession()
    const conversation = store.requireConversation(session!.conversationId)

    expect(conversation.title).toBe(DEFAULT_SESSION_TITLE)
    // Orbit's own concrete model, never a placeholder that leaves agy to pick.
    expect(conversation.model).toBe(ORBIT_DEFAULT_MODEL_ID)
    expect(conversation.reasoningEffort).toBe('medium')
    expect(conversation.permissionMode).toBe(DEFAULT_PERMISSION_MODE)
    expect(conversation.transport).toBe('structured')
    expect(conversation.providerId).toBe('antigravity')
    expect(conversation.nativeConversationId).toBeNull()
    expect(conversation.workingDirectory).toBeNull()
    expect(conversation.projectId).toBeNull()
  })

  it('resolves once per launch, however often it is asked', async () => {
    await runtime.ensureStartupSession()
    await runtime.ensureStartupSession()
    await runtime.ensureStartupSession()

    expect(runtime.listUnsortedConversations()).toHaveLength(1)
    expect(runtime.listProjects()).toHaveLength(0)
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
    const session = await runtime.ensureStartupSession()

    await runtime.sendMessage({
      conversationId: session!.conversationId,
      content: 'build me a futuristic robotics landing page'
    })

    expect(store.requireConversation(session!.conversationId).title).toBe('Futuristic Robotics Landing Page')
  })
})
