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
import { DEFAULT_SESSION_TITLE } from '../../src/shared/sessionTitle'

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

/** Mirrors the real race a Stop creates: the run is acknowledged as
 *  cancelled, and then the transport closing reports its own ending a beat
 *  later. Both are genuine transport events; only the first is the run's
 *  real outcome. */
class LateSecondEndingProvider extends FakeProvider {
  private pending: { input: ProviderSendInput; onEvent: (event: RuntimeEvent) => void } | null = null
  /** The ending that arrives after the run is already over. */
  late: RuntimeEvent['type'] = 'run.failed'

  override async sendMessage(input: ProviderSendInput, onEvent: (event: RuntimeEvent) => void): Promise<void> {
    this.pending = { input, onEvent }
  }

  override cancelRun = vi.fn(async (runId: string) => {
    const pending = this.pending
    if (!pending || pending.input.runId !== runId) return
    const base = {
      projectId: pending.input.projectId,
      conversationId: pending.input.conversationId,
      runId: pending.input.runId,
      providerId: 'antigravity' as const,
      createdAt: new Date().toISOString()
    }
    pending.onEvent({ ...base, type: 'run.cancelled' })
    // …and now the stream/PTY closes, as it always does after a kill.
    if (this.late === 'run.failed') {
      pending.onEvent({
        ...base,
        type: 'run.failed',
        error: { code: 'provider.exited', message: 'Antigravity exited before returning a result (SIGTERM).', retryable: false }
      })
    } else {
      pending.onEvent({ ...base, type: 'run.completed', finalText: 'A late answer', nativeConversationId: null })
    }
    return undefined
  })
}

/** Mirrors the PTY session's deferred cancellation: the run is stopped while
 *  it is waiting on a model-change retirement, so there is no live process to
 *  interrupt and `run.cancelled` is emitted synchronously from cancelRun,
 *  while OrbitRuntime is still inside its own cancelRun. */
class DeferredCancelProvider implements AgentProvider {
  private pending: { input: ProviderSendInput; onEvent: (event: RuntimeEvent) => void } | null = null
  listModels = vi.fn(async () => [])
  respondToInteraction = vi.fn(async () => undefined)
  releaseConversation = vi.fn(async () => undefined)
  shutdown = vi.fn(async () => undefined)

  async getStatus(): Promise<ProviderStatus> {
    return { id: 'antigravity', state: 'ready', sdkAvailable: true, authConfigured: true, message: null, details: {} }
  }

  /** Deliberately silent, like the real thing: a model-change retirement
   *  emits no `run.started` — the replacement that would have emitted it is
   *  never spawned — so the run's only event is its cancellation. */
  async sendMessage(input: ProviderSendInput, onEvent: (event: RuntimeEvent) => void): Promise<void> {
    this.pending = { input, onEvent }
  }

  async cancelRun(runId: string): Promise<void> {
    const pending = this.pending
    if (!pending || pending.input.runId !== runId) return
    this.pending = null
    pending.onEvent({ ...this.base(pending.input), type: 'run.cancelled' })
  }

  /** Nothing follows a cancellation — the replacement never spawns, so the
   *  run neither completes nor fails afterwards. */
  private base(input: ProviderSendInput) {
    return {
      projectId: input.projectId,
      conversationId: input.conversationId,
      runId: input.runId,
      providerId: 'antigravity' as const,
      createdAt: new Date().toISOString()
    }
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

  it('runs Antigravity in the project folder the user chose', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-root-'))
    const project = runtime.createProject('Real folder', workspace)
    const conversation = runtime.openProject(project.id).conversations[0]!

    await runtime.sendMessage({ projectId: project.id, conversationId: conversation.id, content: 'Hi' })
    await vi.waitFor(() => expect(provider.lastInput).not.toBeNull())
    expect(provider.lastInput?.workspacePath).toBe(workspace)
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  it('lets a session override its project folder', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-root-'))
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-session-'))
    const project = runtime.createProject('Override', projectDir)
    const conversation = runtime.createConversation(project.id, 'Docs', sessionDir)

    await runtime.sendMessage({ projectId: project.id, conversationId: conversation.id, content: 'Hi' })
    await vi.waitFor(() => expect(provider.lastInput?.conversationId).toBe(conversation.id))
    expect(provider.lastInput?.workspacePath).toBe(sessionDir)
    fs.rmSync(projectDir, { recursive: true, force: true })
    fs.rmSync(sessionDir, { recursive: true, force: true })
  })

  it('falls back to the managed workspace when a chosen folder has gone away', async () => {
    const gone = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-gone-'))
    const project = runtime.createProject('Missing folder', gone)
    const conversation = runtime.openProject(project.id).conversations[0]!
    fs.rmSync(gone, { recursive: true, force: true })

    await runtime.sendMessage({ projectId: project.id, conversationId: conversation.id, content: 'Hi' })
    await vi.waitFor(() => expect(provider.lastInput).not.toBeNull())
    // A deleted folder must not fail the turn — the session keeps working in
    // Orbit's own workspace for that project.
    expect(provider.lastInput?.workspacePath).toBe(path.join(dir, 'projects', project.id, 'workspace'))
  })

  it('creates a session that needs nothing configured: default name, project folder', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-root-'))
    const project = runtime.createProject('Instant', projectDir)
    const session = runtime.createConversation(project.id)

    expect(session.projectId).toBe(project.id)
    expect(session.title).toBe(DEFAULT_SESSION_TITLE)
    // No folder of its own means "the project's" — resolved at send time.
    expect(session.workingDirectory).toBeNull()
    await runtime.sendMessage({ projectId: project.id, conversationId: session.id, content: 'Hi' })
    await vi.waitFor(() => expect(provider.lastInput?.conversationId).toBe(session.id))
    expect(provider.lastInput?.workspacePath).toBe(projectDir)
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it('seeds a brand-new project with a session under the same default name', () => {
    const project = runtime.createProject('Fresh')
    expect(runtime.openProject(project.id).conversations.map((item) => item.title)).toEqual([DEFAULT_SESSION_TITLE])
  })

  it('names a session from its first prompt', async () => {
    const project = runtime.createProject('Naming')
    const session = runtime.createConversation(project.id)

    await runtime.sendMessage({
      projectId: project.id,
      conversationId: session.id,
      content: 'build me a futuristic robotics landing page'
    })

    expect(runtime.openProject(project.id).conversations[0]?.title).toBe('Futuristic Robotics Landing Page')
  })

  it('names a session once and then leaves it alone', async () => {
    const project = runtime.createProject('Naming')
    const session = runtime.createConversation(project.id)
    const send = (content: string): Promise<unknown> =>
      runtime.sendMessage({ projectId: project.id, conversationId: session.id, content })

    await send('build me a futuristic robotics landing page')
    await send('now make the hero section darker')
    await send('and add a pricing table underneath')

    expect(runtime.openProject(project.id).conversations[0]?.title).toBe('Futuristic Robotics Landing Page')
  })

  it('never renames a session the user named themselves', async () => {
    const project = runtime.createProject('Naming')
    const session = runtime.createConversation(project.id)
    runtime.renameConversation(session.id, 'Ship checklist')

    await runtime.sendMessage({
      projectId: project.id,
      conversationId: session.id,
      content: 'build me a futuristic robotics landing page'
    })

    expect(runtime.openProject(project.id).conversations[0]?.title).toBe('Ship checklist')
  })

  it('keeps the default name when the first prompt says nothing worth naming, and lets the next one name it', async () => {
    const project = runtime.createProject('Naming')
    const session = runtime.createConversation(project.id)
    const send = (content: string): Promise<unknown> =>
      runtime.sendMessage({ projectId: project.id, conversationId: session.id, content })

    await send('hi')
    expect(runtime.openProject(project.id).conversations[0]?.title).toBe(DEFAULT_SESSION_TITLE)

    await send('refactor the payment service')
    expect(runtime.openProject(project.id).conversations[0]?.title).toBe('Refactor the Payment Service')
  })

  it('sends the prompt even when it cannot be turned into a title', async () => {
    const project = runtime.createProject('Naming')
    const session = runtime.createConversation(project.id)

    const run = await runtime.sendMessage({ projectId: project.id, conversationId: session.id, content: 'hi' })

    // Titling is never a gate on the turn: the message is stored, the run
    // exists, and the provider got it.
    await vi.waitFor(() => expect(provider.lastInput?.runId).toBe(run.id))
    expect(runtime.openProject(project.id).messages.some((message) => message.content === 'hi')).toBe(true)
  })

  it('leaves a session named after its first prompt renameable by the user', async () => {
    const project = runtime.createProject('Naming')
    const session = runtime.createConversation(project.id)
    await runtime.sendMessage({
      projectId: project.id,
      conversationId: session.id,
      content: 'build me a futuristic robotics landing page'
    })

    runtime.renameConversation(session.id, 'Landing page v2')
    await runtime.sendMessage({ projectId: project.id, conversationId: session.id, content: 'design a dark mode palette' })

    expect(runtime.openProject(project.id).conversations[0]?.title).toBe('Landing page v2')
  })

  it('starts a session on the reasoning tier the user last chose', () => {
    store.writePreferences({ lastReasoningEffort: 'high', modelReasoningEfforts: {} })
    const project = runtime.createProject('Seeded')
    expect(runtime.openProject(project.id).conversations[0]?.reasoningEffort).toBe('high')
    expect(runtime.createConversation(project.id, 'Another').reasoningEffort).toBe('high')
  })

  it('starts a session on medium before the user has ever chosen a tier', () => {
    const project = runtime.createProject('Fresh')
    expect(runtime.openProject(project.id).conversations[0]?.reasoningEffort).toBe('medium')
  })

  it('round trips preferences through the runtime', () => {
    expect(runtime.getPreferences().lastReasoningEffort).toBeNull()
    runtime.setPreferences({ lastReasoningEffort: 'low', modelReasoningEfforts: { 'gemini-3.8-flash': 'low' } })
    expect(runtime.getPreferences()).toEqual({ lastReasoningEffort: 'low', modelReasoningEfforts: { 'gemini-3.8-flash': 'low' } })
  })

  it('passes cancellation to the provider', async () => {
    const project = runtime.createProject('Cancel')
    const conversation = runtime.openProject(project.id).conversations[0]!
    const run = store.createRun({ projectId: project.id, conversationId: conversation.id })
    await runtime.cancelRun(run.id)
    expect(provider.cancelRun).toHaveBeenCalledWith(run.id)
    expect(store.requireRun(run.id).state).toBe('cancelling')
  })

  it('settles a run the provider cancels synchronously, rather than leaving it stopping forever', async () => {
    // A PTY run stopped while it is waiting on a model-change retirement has
    // no process to interrupt, so `run.cancelled` arrives while cancelRun is
    // still on the stack. The run must end up cancelled — not stuck in the
    // 'cancelling' state the Stop request set on its way in.
    runtime = new OrbitRuntime(store, new ArtifactService(store, new FileStorage(dir)), new DeferredCancelProvider(), dir, '0.1.0')
    const project = runtime.createProject('Deferred cancel')
    const conversation = runtime.openProject(project.id).conversations[0]!

    const run = await runtime.sendMessage({ projectId: project.id, conversationId: conversation.id, content: 'Change the model and stop me' })
    const returned = await runtime.cancelRun(run.id)

    expect(returned.state, 'cancelRun must report what the store really holds').toBe('cancelled')
    expect(store.requireRun(run.id).state).toBe('cancelled')

    // Exactly one cancellation message, and no completion alongside it.
    const messages = store.listMessages(project.id).filter((message) => message.runId === run.id)
    expect(messages.filter((message) => message.status === 'cancelled')).toHaveLength(1)
    expect(messages.some((message) => message.status === 'completed')).toBe(false)

    // The cancelled run is no longer tracked as active, so a later run for
    // the same conversation is unaffected by it.
    expect((runtime as unknown as { activeRuns: Map<string, unknown> }).activeRuns.has(run.id)).toBe(false)

    runtime = new OrbitRuntime(store, new ArtifactService(store, new FileStorage(dir)), new FakeProvider(), dir, '0.1.0')
    const next = await runtime.sendMessage({ projectId: project.id, conversationId: conversation.id, content: 'A later message' })
    await vi.waitFor(() => expect(store.requireRun(next.id).state).toBe('completed'))
  })

  it('keeps a stopped run stopped when the transport reports its own ending afterwards', async () => {
    // THE REAL RACE. Stop kills the process; the stream then closes and the
    // transport reports `provider.exited`. Handling that second ending
    // appended a failed assistant message and rewrote the run as failed —
    // so a cancellation the user asked for became "Antigravity's session
    // ended unexpectedly" a beat later.
    const provider = new LateSecondEndingProvider()
    runtime = new OrbitRuntime(store, new ArtifactService(store, new FileStorage(dir)), provider, dir, '0.1.0')
    const project = runtime.createProject('Late ending')
    const conversation = runtime.openProject(project.id).conversations[0]!

    const run = await runtime.sendMessage({ projectId: project.id, conversationId: conversation.id, content: 'Do something long' })
    await runtime.cancelRun(run.id)

    expect(store.requireRun(run.id).state).toBe('cancelled')
    expect(store.requireRun(run.id).error).toBeNull()

    const messages = store.listMessages(project.id).filter((message) => message.runId === run.id)
    expect(messages, JSON.stringify(messages)).toHaveLength(1)
    expect(messages[0]!.status).toBe('cancelled')
    expect(messages.some((message) => message.status === 'failed')).toBe(false)
  })

  it('keeps a stopped run stopped even when a late completion arrives', async () => {
    const provider = new LateSecondEndingProvider()
    provider.late = 'run.completed'
    runtime = new OrbitRuntime(store, new ArtifactService(store, new FileStorage(dir)), provider, dir, '0.1.0')
    const project = runtime.createProject('Late completion')
    const conversation = runtime.openProject(project.id).conversations[0]!

    const run = await runtime.sendMessage({ projectId: project.id, conversationId: conversation.id, content: 'Do something long' })
    await runtime.cancelRun(run.id)

    // The user's decision stands: a turn they stopped does not quietly
    // finish and present an answer they chose not to wait for.
    expect(store.requireRun(run.id).state).toBe('cancelled')
    const messages = store.listMessages(project.id).filter((message) => message.runId === run.id)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.status).toBe('cancelled')
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
