import { EventEmitter } from 'node:events'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrbitDatabase } from '../../src/main/persistence/database'
import { OrbitStore } from '../../src/main/persistence/store'
import { FileStorage } from '../../src/main/files/fileStorage'
import { ArtifactService } from '../../src/main/artifacts/artifactService'
import { OrbitRuntime } from '../../src/main/runtime/orbitRuntime'
import type { AgentProvider, ProviderSendInput } from '../../src/main/runtime/provider'
import type { ProviderStatus } from '../../src/shared/domain'
import type { RuntimeEvent } from '../../src/shared/runtime-events'

class FakeProvider implements AgentProvider {
  lastInput: ProviderSendInput | null = null
  cancelRun = vi.fn(async () => undefined)
  shutdown = vi.fn(async () => undefined)

  async getStatus(): Promise<ProviderStatus> {
    return { id: 'antigravity', state: 'ready', sdkAvailable: true, authConfigured: true, message: null, details: {} }
  }

  async sendMessage(input: ProviderSendInput, onEvent: (event: RuntimeEvent) => void): Promise<void> {
    this.lastInput = input
    onEvent({
      type: 'run.started',
      projectId: input.projectId,
      conversationId: input.conversationId,
      runId: input.runId,
      providerId: 'antigravity',
      createdAt: new Date().toISOString(),
      nativeConversationId: 'native-1'
    })
    onEvent({
      type: 'text.delta',
      projectId: input.projectId,
      conversationId: input.conversationId,
      runId: input.runId,
      providerId: 'antigravity',
      createdAt: new Date().toISOString(),
      delta: 'Hello'
    })
    onEvent({
      type: 'run.completed',
      projectId: input.projectId,
      conversationId: input.conversationId,
      runId: input.runId,
      providerId: 'antigravity',
      createdAt: new Date().toISOString(),
      finalText: 'Hello',
      nativeConversationId: 'native-1'
    })
  }
}

class FailingProvider extends FakeProvider {
  override async sendMessage(): Promise<void> {
    throw Object.assign(new Error('Antigravity unavailable - authentication required'), { code: 'provider.auth_required' })
  }
}

class ArtifactProvider extends FakeProvider {
  constructor(private readonly artifactPath: string) {
    super()
  }

  override async sendMessage(input: ProviderSendInput, onEvent: (event: RuntimeEvent) => void): Promise<void> {
    onEvent({
      type: 'artifact.discovered',
      projectId: input.projectId,
      conversationId: input.conversationId,
      runId: input.runId,
      providerId: 'antigravity',
      createdAt: new Date().toISOString(),
      sourcePath: this.artifactPath,
      metadata: { tool: 'generate_image' }
    })
    onEvent({
      type: 'run.completed',
      projectId: input.projectId,
      conversationId: input.conversationId,
      runId: input.runId,
      providerId: 'antigravity',
      createdAt: new Date().toISOString(),
      finalText: 'Created an artifact.'
    })
  }
}

let dir = ''
let db: OrbitDatabase
let store: OrbitStore
let provider: FakeProvider
let runtime: OrbitRuntime

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-runtime-'))
  db = new OrbitDatabase({ dataDir: dir })
  await db.init()
  store = new OrbitStore(db)
  provider = new FakeProvider()
  runtime = new OrbitRuntime(store, new ArtifactService(store, new FileStorage(dir)), provider, dir, '0.1.0')
})

afterEach(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('OrbitRuntime', () => {
  it('routes provider events to the correct conversation and persists assistant output', async () => {
    const events: RuntimeEvent[] = []
    runtime.on('event', (event) => events.push(event))
    const project = runtime.createProject('Runtime')
    const snapshot = runtime.openProject(project.id)
    const conversation = snapshot.conversations[0]
    expect(conversation).toBeDefined()
    const run = await runtime.sendMessage({ projectId: project.id, conversationId: conversation!.id, content: 'Hi' })
    await vi.waitFor(() => expect(events.some((event) => event.type === 'run.completed')).toBe(true))
    const after = runtime.openProject(project.id)
    expect(after.messages.some((message) => message.role === 'assistant' && message.content === 'Hello')).toBe(true)
    expect(after.conversations[0]?.nativeConversationId).toBe('native-1')
    expect(run.conversationId).toBe(conversation!.id)
  })

  it('passes cancellation to the provider', async () => {
    const project = runtime.createProject('Cancel')
    const conversation = runtime.openProject(project.id).conversations[0]!
    const run = store.createRun({ projectId: project.id, conversationId: conversation.id })
    await runtime.cancelRun(run.id)
    expect(provider.cancelRun).toHaveBeenCalledWith(run.id)
    expect(store.requireRun(run.id).state).toBe('cancelling')
  })

  it('persists intelligible provider failures as failed assistant messages', async () => {
    runtime = new OrbitRuntime(store, new ArtifactService(store, new FileStorage(dir)), new FailingProvider(), dir, '0.1.0')
    const project = runtime.createProject('Failure')
    const conversation = runtime.openProject(project.id).conversations[0]!
    const run = await runtime.sendMessage({ projectId: project.id, conversationId: conversation.id, content: 'Hello' })
    await vi.waitFor(() => expect(store.requireRun(run.id).state).toBe('failed'))
    const snapshot = runtime.openProject(project.id)
    expect(snapshot.messages.some((message) => message.status === 'failed' && message.content.includes('authentication required'))).toBe(true)
  })

  it('imports explicit provider-discovered artifact paths', async () => {
    const sourcePath = path.join(dir, 'generated.txt')
    fs.writeFileSync(sourcePath, 'generated output')
    runtime = new OrbitRuntime(store, new ArtifactService(store, new FileStorage(dir)), new ArtifactProvider(sourcePath), dir, '0.1.0')
    const project = runtime.createProject('Artifacts')
    const conversation = runtime.openProject(project.id).conversations[0]!
    const run = await runtime.sendMessage({ projectId: project.id, conversationId: conversation.id, content: 'Create a file' })
    await vi.waitFor(() => expect(store.requireRun(run.id).state).toBe('completed'))
    const snapshot = runtime.openProject(project.id)
    expect(snapshot.artifacts[0]?.name).toBe('generated.txt')
    expect(snapshot.artifacts[0]?.creatorRunId).toBe(run.id)
  })

  it('emits only run-attributed events', async () => {
    const emitter = runtime as unknown as EventEmitter
    expect(emitter.listenerCount('event')).toBe(0)
  })
})
