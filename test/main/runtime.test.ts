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
  listModels = vi.fn(async () => [])
  cancelRun = vi.fn(async () => undefined)
  respondToInteraction = vi.fn(async () => undefined)
  releaseConversation = vi.fn(async () => undefined)
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

/** Mirrors what the structured transport really does when agy skips an
 *  interaction it could not present headlessly. */
class HeadlessDenialProvider extends FakeProvider {
  override async sendMessage(input: ProviderSendInput, onEvent: (event: RuntimeEvent) => void): Promise<void> {
    const base = {
      projectId: input.projectId,
      conversationId: input.conversationId,
      runId: input.runId,
      providerId: 'antigravity' as const,
      createdAt: new Date().toISOString()
    }
    onEvent({
      ...base,
      type: 'interaction.required',
      interactionId: `${input.runId}:headless-denial`,
      kind: 'permission',
      prompt: 'Antigravity requested an interaction that headless mode could not present.',
      options: [],
      transport: 'structured-followup',
      canRespond: false,
      sourceEvidence: 'headless-denial'
    })
    onEvent({ ...base, type: 'run.failed', error: { code: 'provider.interaction_denied', message: 'Interaction denied.', retryable: false } })
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

  it('sends transport to the provider and never silently downgrades a pty conversation back to structured', async () => {
    const project = runtime.createProject('Transport')
    const conversation = runtime.openProject(project.id).conversations[0]!
    expect(conversation.transport).toBe('structured')

    const asPty = runtime.setConversationTransport(conversation.id, 'pty')
    expect(asPty.transport).toBe('pty')

    const stillPty = runtime.setConversationTransport(conversation.id, 'structured')
    expect(stillPty.transport).toBe('pty')

    await runtime.sendMessage({ projectId: project.id, conversationId: conversation.id, content: 'Hi' })
    expect(provider.lastInput?.transport).toBe('pty')
  })

  it('rejects an interaction response for a run that is not waiting on one', async () => {
    const project = runtime.createProject('Interaction guard')
    const conversation = runtime.openProject(project.id).conversations[0]!
    const run = store.createRun({ projectId: project.id, conversationId: conversation.id })
    await expect(
      runtime.respondToInteraction({ conversationId: conversation.id, runId: run.id, interactionId: 'bogus', optionId: '1' })
    ).rejects.toThrow(/no pending interaction/i)
    expect(provider.respondToInteraction).not.toHaveBeenCalled()
  })

  it('rejects an interaction response whose run belongs to a different conversation', async () => {
    const project = runtime.createProject('Interaction cross-check')
    const conversationA = runtime.openProject(project.id).conversations[0]!
    const conversationB = runtime.createConversation(project.id, 'Second')
    const run = store.createRun({ projectId: project.id, conversationId: conversationA.id })
    store.updateRunState(run.id, 'waiting_for_interaction')
    await expect(
      runtime.respondToInteraction({ conversationId: conversationB.id, runId: run.id, interactionId: 'bogus', optionId: '1' })
    ).rejects.toThrow(/does not belong/i)
    expect(provider.respondToInteraction).not.toHaveBeenCalled()
  })

  it('escalates a conversation to the live transport automatically when an image is attached', async () => {
    const project = runtime.createProject('Auto escalate')
    const conversation = runtime.openProject(project.id).conversations[0]!
    expect(conversation.transport).toBe('structured')

    const imagePath = path.join(dir, 'shot.png')
    fs.writeFileSync(imagePath, Buffer.from('89504e470d0a1a0a', 'hex'))
    const [file] = runtime.attachFiles(project.id, [imagePath])

    await runtime.sendMessage({ projectId: project.id, conversationId: conversation.id, content: 'What is this?', attachmentFileIds: [file!.id] })

    // The user never chose a transport — attaching media escalated it.
    expect(provider.lastInput?.transport).toBe('pty')
    expect(runtime.openProject(project.id).conversations[0]?.transport).toBe('pty')
  })

  it('leaves a text-only conversation on the default transport', async () => {
    const project = runtime.createProject('No escalation')
    const conversation = runtime.openProject(project.id).conversations[0]!
    await runtime.sendMessage({ projectId: project.id, conversationId: conversation.id, content: 'Just text' })
    expect(provider.lastInput?.transport).toBe('structured')
    expect(runtime.openProject(project.id).conversations[0]?.transport).toBe('structured')
  })

  it('escalates after a headless denial so the next turn can ask directly', async () => {
    runtime = new OrbitRuntime(store, new ArtifactService(store, new FileStorage(dir)), new HeadlessDenialProvider(), dir, '0.1.0')
    const project = runtime.createProject('Denial escalation')
    const conversation = runtime.openProject(project.id).conversations[0]!

    const run = await runtime.sendMessage({ projectId: project.id, conversationId: conversation.id, content: 'Run something' })
    await vi.waitFor(() => expect(store.requireRun(run.id).state).toBe('failed'))

    // The user is never asked to pick a transport — the denial escalates it.
    expect(runtime.openProject(project.id).conversations[0]?.transport).toBe('pty')
  })

  it('serves a managed image as a data URL, because the renderer CSP forbids file:', () => {
    const project = runtime.createProject('Thumbnails')
    const imagePath = path.join(dir, 'shot.png')
    // A minimal but real PNG so the mime/type checks operate on genuine bytes.
    fs.writeFileSync(
      imagePath,
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
    )
    const [file] = runtime.attachFiles(project.id, [imagePath])

    const thumbnail = runtime.getProjectFileThumbnail(file!.id)
    expect(thumbnail).toMatch(/^data:image\/png;base64,/)
  })

  it('returns no thumbnail for a non-image or unknown file rather than leaking a path', () => {
    const project = runtime.createProject('Thumbnails 2')
    const textPath = path.join(dir, 'notes.txt')
    fs.writeFileSync(textPath, 'not an image')
    const [file] = runtime.attachFiles(project.id, [textPath])

    expect(runtime.getProjectFileThumbnail(file!.id)).toBeNull()
    expect(runtime.getProjectFileThumbnail('file_does-not-exist')).toBeNull()
  })

  it('deletes a conversation, releasing any live provider session first', async () => {
    const project = runtime.createProject('Delete')
    const first = runtime.openProject(project.id).conversations[0]!
    const second = runtime.createConversation(project.id, 'Second')

    await runtime.deleteConversation(second.id)

    expect(provider.releaseConversation).toHaveBeenCalledWith(second.id)
    const remaining = runtime.openProject(project.id).conversations
    expect(remaining.map((conversation) => conversation.id)).toEqual([first.id])
  })

  it('forwards a valid interaction response to the provider', async () => {
    const project = runtime.createProject('Interaction forward')
    const conversation = runtime.openProject(project.id).conversations[0]!
    const run = store.createRun({ projectId: project.id, conversationId: conversation.id })
    store.updateRunState(run.id, 'waiting_for_interaction')
    await runtime.respondToInteraction({ conversationId: conversation.id, runId: run.id, interactionId: 'int-1', optionId: '1' })
    expect(provider.respondToInteraction).toHaveBeenCalledWith({ conversationId: conversation.id, runId: run.id, interactionId: 'int-1', optionId: '1' })
  })
})
