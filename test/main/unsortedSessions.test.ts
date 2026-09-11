import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrbitDatabase } from '../../src/main/persistence/database'
import { OrbitStore } from '../../src/main/persistence/store'
import { FileStorage } from '../../src/main/files/fileStorage'
import { ArtifactService } from '../../src/main/artifacts/artifactService'
import { OrbitRuntime } from '../../src/main/runtime/orbitRuntime'
import { ORBIT_DEFAULT_MODEL_ID } from '../../src/shared/defaultModel'
import { DEFAULT_SESSION_TITLE } from '../../src/shared/sessionTitle'
import type { AgentProvider, ProviderSendInput } from '../../src/main/runtime/provider'
import type { ModelOption, ProviderStatus } from '../../src/shared/domain'
import type { RuntimeEvent } from '../../src/shared/runtime-events'

const CATALOGUE: ModelOption[] = [
  { id: ORBIT_DEFAULT_MODEL_ID, label: 'Gemini 3.8 Flash', supportedReasoningEfforts: ['low', 'medium', 'high'] }
]

class RecordingProvider implements AgentProvider {
  lastInput: ProviderSendInput | null = null
  listModels = vi.fn(async () => CATALOGUE)
  cancelRun = vi.fn(async () => undefined)
  respondToInteraction = vi.fn(async () => undefined)
  releaseConversation = vi.fn(async () => undefined)
  shutdown = vi.fn(async () => undefined)
  async getStatus(): Promise<ProviderStatus> {
    return { id: 'antigravity', state: 'ready', sdkAvailable: true, authConfigured: true, message: null, details: {} }
  }
  async sendMessage(input: ProviderSendInput, onEvent: (event: RuntimeEvent) => void): Promise<void> {
    this.lastInput = input
    const base = {
      projectId: input.projectId,
      conversationId: input.conversationId,
      runId: input.runId,
      providerId: 'antigravity' as const,
      createdAt: new Date().toISOString()
    }
    onEvent({ ...base, type: 'run.started', nativeConversationId: 'native-1' })
    onEvent({ ...base, type: 'run.completed', finalText: 'Done.', nativeConversationId: 'native-1' })
  }
}

describe('sessions that belong to no project', () => {
  let dir: string
  let db: OrbitDatabase
  let store: OrbitStore
  let provider: RecordingProvider
  let runtime: OrbitRuntime

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-unsorted-'))
    db = new OrbitDatabase({ dataDir: dir })
    await db.init()
    store = new OrbitStore(db)
    provider = new RecordingProvider()
    runtime = new OrbitRuntime(store, new ArtifactService(store, new FileStorage(dir)), provider, dir, '0.1.0')
    await runtime.listModels()
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  it('creates a session with no project, and no hidden project behind it', () => {
    const session = runtime.createConversation(null)

    expect(session.projectId).toBeNull()
    // The whole point: Unsorted is an absence, not a project the user
    // cannot see.
    expect(runtime.listProjects()).toHaveLength(0)
    expect(runtime.listUnsortedConversations().map((item) => item.id)).toEqual([session.id])
  })

  it('gives it every ordinary new-session default', () => {
    const session = runtime.createConversation(null)

    expect(session.title).toBe(DEFAULT_SESSION_TITLE)
    expect(session.model).toBe(ORBIT_DEFAULT_MODEL_ID)
    expect(session.reasoningEffort).toBe('medium')
    expect(session.permissionMode).toBe('ask')
    expect(session.transport).toBe('structured')
    expect(session.nativeConversationId).toBeNull()
    expect(session.workingDirectory).toBeNull()
  })

  it('sends without a project or a folder ever being chosen', async () => {
    const session = runtime.createConversation(null)

    await runtime.sendMessage({ conversationId: session.id, content: 'write me a python script' })
    await settle()

    expect(provider.lastInput).not.toBeNull()
    expect(provider.lastInput!.projectId).toBeNull()
    // A real directory of its own, under Orbit's data — not /tmp, and not
    // some other session's.
    expect(provider.lastInput!.workspacePath).toBe(path.join(dir, 'workspaces', session.id))
    expect(fs.existsSync(provider.lastInput!.workspacePath)).toBe(true)
  })

  it('keeps that workspace for the session, across turns', async () => {
    const session = runtime.createConversation(null)
    await runtime.sendMessage({ conversationId: session.id, content: 'one' })
    await settle()
    const first = provider.lastInput!.workspacePath
    fs.writeFileSync(path.join(first, 'scratch.txt'), 'still here')

    await runtime.sendMessage({ conversationId: session.id, content: 'two' })
    await settle()

    expect(provider.lastInput!.workspacePath).toBe(first)
    expect(fs.readFileSync(path.join(first, 'scratch.txt'), 'utf8')).toBe('still here')
  })

  it('gives two unsorted sessions separate workspaces', async () => {
    const a = runtime.createConversation(null)
    const b = runtime.createConversation(null)

    await runtime.sendMessage({ conversationId: a.id, content: 'one' })
    await settle()
    const first = provider.lastInput!.workspacePath
    await runtime.sendMessage({ conversationId: b.id, content: 'two' })
    await settle()

    expect(provider.lastInput!.workspacePath).not.toBe(first)
  })

  it('names itself from its first prompt like any other session', async () => {
    const session = runtime.createConversation(null)

    await runtime.sendMessage({ conversationId: session.id, content: 'fix the login form' })
    await settle()

    expect(store.requireConversation(session.id).title).toBe('Fix the Login Form')
  })

  it('keeps unsorted sessions out of a project’s own list', () => {
    const project = runtime.createProject('AgentDock')
    const inProject = runtime.openProject(project.id).conversations[0]!
    const loose = runtime.createConversation(null)

    expect(runtime.openProject(project.id).conversations.map((item) => item.id)).toEqual([inProject.id])
    expect(runtime.listUnsortedConversations().map((item) => item.id)).toEqual([loose.id])
  })

  it('opens an Unsorted workspace with no project behind it', async () => {
    const session = runtime.createConversation(null)
    await runtime.sendMessage({ conversationId: session.id, content: 'hello there' })
    await settle()

    const snapshot = runtime.openUnsorted()

    expect(snapshot.project).toBeNull()
    expect(snapshot.conversations.map((item) => item.id)).toEqual([session.id])
    expect(snapshot.messages.length).toBeGreaterThan(0)
    expect(snapshot.messages.every((message) => message.projectId === null)).toBe(true)
    expect(snapshot.runs.every((run) => run.projectId === null)).toBe(true)
  })
})

describe('filing an unsorted session into a project', () => {
  let dir: string
  let db: OrbitDatabase
  let store: OrbitStore
  let provider: RecordingProvider
  let runtime: OrbitRuntime

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-assign-'))
    db = new OrbitDatabase({ dataDir: dir })
    await db.init()
    store = new OrbitStore(db)
    provider = new RecordingProvider()
    runtime = new OrbitRuntime(store, new ArtifactService(store, new FileStorage(dir)), provider, dir, '0.1.0')
    await runtime.listModels()
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  it('moves the same session, keeping everything it carries', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-real-project-'))
    const project = runtime.createProject('AgentDock', projectRoot)
    const session = runtime.createConversation(null)
    runtime.setConversationPermissionMode(session.id, 'skip')
    runtime.setConversationModel(session.id, 'gemini-3.1-pro', 'low')
    await runtime.sendMessage({ conversationId: session.id, content: 'refactor the payment service' })
    await settle()
    const before = store.requireConversation(session.id)

    const moved = runtime.assignConversationToProject(session.id, project.id)

    expect(moved.id).toBe(session.id)
    expect(moved.projectId).toBe(project.id)
    const after = store.requireConversation(session.id)
    expect(after.title).toBe(before.title)
    expect(after.nativeConversationId).toBe(before.nativeConversationId)
    expect(after.model).toBe('gemini-3.1-pro')
    expect(after.reasoningEffort).toBe('low')
    expect(after.permissionMode).toBe('skip')
    expect(after.transport).toBe(before.transport)
    fs.rmSync(projectRoot, { recursive: true, force: true })
  })

  it('does not duplicate the session, and brings its transcript with it', async () => {
    const project = runtime.createProject('AgentDock')
    const session = runtime.createConversation(null)
    await runtime.sendMessage({ conversationId: session.id, content: 'hello there' })
    await settle()
    const messagesBefore = runtime.openUnsorted().messages.length

    runtime.assignConversationToProject(session.id, project.id)

    expect(runtime.listUnsortedConversations()).toHaveLength(0)
    const conversations = runtime.openProject(project.id).conversations
    expect(conversations.filter((item) => item.id === session.id)).toHaveLength(1)
    // The project's own views find the history, rather than it being
    // stranded in a workspace nothing opens.
    expect(runtime.openProject(project.id).messages.filter((m) => m.conversationId === session.id)).toHaveLength(messagesBefore)
    expect(runtime.openUnsorted().messages).toHaveLength(0)
  })

  it('never moves or deletes what the session already wrote, and never touches the project’s files', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-real-project-'))
    fs.writeFileSync(path.join(projectRoot, 'README.md'), '# Real work')
    const project = runtime.createProject('AgentDock', projectRoot)
    const session = runtime.createConversation(null)
    await runtime.sendMessage({ conversationId: session.id, content: 'one' })
    await settle()
    const scratch = provider.lastInput!.workspacePath
    fs.writeFileSync(path.join(scratch, 'draft.txt'), 'scratch work')

    runtime.assignConversationToProject(session.id, project.id)
    await runtime.sendMessage({ conversationId: session.id, content: 'two' })
    await settle()

    // The scratch files stay where they were made...
    expect(fs.readFileSync(path.join(scratch, 'draft.txt'), 'utf8')).toBe('scratch work')
    // ...the project's own files are untouched...
    expect(fs.readFileSync(path.join(projectRoot, 'README.md'), 'utf8')).toBe('# Real work')
    expect(fs.existsSync(path.join(projectRoot, 'draft.txt'))).toBe(false)
    // ...and the session keeps running where it was, rather than being
    // silently pointed at the user's real project folder.
    expect(provider.lastInput!.workspacePath).toBe(scratch)
    fs.rmSync(projectRoot, { recursive: true, force: true })
  })

  it('refuses a project that does not exist', () => {
    const session = runtime.createConversation(null)
    expect(() => runtime.assignConversationToProject(session.id, 'project_nope')).toThrow(/not found/i)
    expect(store.requireConversation(session.id).projectId).toBeNull()
  })
})

describe('migrating a database that predates unsorted sessions', () => {
  it('keeps every session in the project it was in, and allows null afterwards', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-migrate-'))
    let db = new OrbitDatabase({ dataDir: dir })
    await db.init()
    let store = new OrbitStore(db)
    const project = store.createProject('Legacy')
    const kept = store.createConversation(project.id, 'Fix Login Bug')
    store.createMessage({ projectId: project.id, conversationId: kept.id, runId: null, role: 'user', content: 'hi', status: 'completed' })
    // Put the constraint back, so the next open has to migrate it again.
    db.exec('PRAGMA foreign_keys = OFF')
    db.exec('CREATE TABLE conversations_old AS SELECT * FROM conversations')
    db.close()

    db = new OrbitDatabase({ dataDir: dir })
    await db.init()
    store = new OrbitStore(db)

    expect(store.requireConversation(kept.id).projectId).toBe(project.id)
    expect(store.requireConversation(kept.id).title).toBe('Fix Login Bug')
    expect(store.openProjectSnapshot(project.id).messages).toHaveLength(1)
    // And the relaxed column really is relaxed.
    const loose = store.createConversation(null, 'Unsorted one')
    expect(loose.projectId).toBeNull()

    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
