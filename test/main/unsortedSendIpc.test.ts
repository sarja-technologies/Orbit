import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrbitDatabase } from '../../src/main/persistence/database'
import { OrbitStore } from '../../src/main/persistence/store'
import { FileStorage } from '../../src/main/files/fileStorage'
import { ArtifactService } from '../../src/main/artifacts/artifactService'
import { OrbitRuntime } from '../../src/main/runtime/orbitRuntime'
import { attachFilesSchema, createConversationSchema, sendMessageSchema } from '../../src/main/ipc/validation'
import { ORBIT_DEFAULT_MODEL_ID } from '../../src/shared/defaultModel'
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

describe('the send validator, at the boundary the renderer actually hits', () => {
  it('accepts an Unsorted send, where there is no project', () => {
    // The reported failure: this shape came straight from the composer of a
    // fresh launch session and was rejected before the runtime saw it.
    const parsed = sendMessageSchema.safeParse({ projectId: null, conversationId: 'conversation_1', content: 'hello' })

    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.projectId).toBeNull()
  })

  it('accepts the field being omitted, and normalizes it to null', () => {
    const parsed = sendMessageSchema.safeParse({ conversationId: 'conversation_1', content: 'hello' })

    expect(parsed.success).toBe(true)
    // One representation downstream, rather than null-or-undefined.
    expect(parsed.success && parsed.data.projectId).toBeNull()
  })

  it('still accepts a real project id, unchanged', () => {
    const parsed = sendMessageSchema.safeParse({ projectId: 'project_1', conversationId: 'conversation_1', content: 'hello' })

    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.projectId).toBe('project_1')
  })

  it('still rejects nonsense in that field', () => {
    expect(sendMessageSchema.safeParse({ projectId: 42, conversationId: 'c', content: 'hi' }).success).toBe(false)
    expect(sendMessageSchema.safeParse({ projectId: '', conversationId: 'c', content: 'hi' }).success).toBe(false)
    // And the rest of the shape is as strict as it was.
    expect(sendMessageSchema.safeParse({ projectId: null, conversationId: 'c', content: '' }).success).toBe(false)
    expect(sendMessageSchema.safeParse({ projectId: null, content: 'hi' }).success).toBe(false)
  })

  it('agrees with the schema that already allowed Unsorted sessions to exist', () => {
    // createConversationSchema permitted null from the start; the send path
    // is what drifted away from it.
    const made = createConversationSchema.safeParse({ projectId: null })
    expect(made.success && made.data.projectId).toBeNull()
  })

  it('keeps attachments project-scoped, because their storage really is', () => {
    // Not an oversight: a stored file row requires a project. The composer
    // disables the control rather than failing here.
    expect(attachFilesSchema.safeParse({ projectId: null, category: 'files' }).success).toBe(false)
    expect(attachFilesSchema.safeParse({ projectId: 'project_1', category: 'files' }).success).toBe(true)
  })
})

describe('sending from an Unsorted session, through validation into the runtime', () => {
  let dir: string
  let db: OrbitDatabase
  let store: OrbitStore
  let provider: RecordingProvider
  let runtime: OrbitRuntime

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-unsorted-ipc-'))
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

  /** Exactly what the IPC handler does: validate, normalize the optional
   *  arrays, then hand it to the runtime — see registerIpc's messagesSend. */
  const sendThroughIpc = async (input: unknown) => {
    const parsed = sendMessageSchema.parse(input)
    return runtime.sendMessage({
      projectId: parsed.projectId,
      conversationId: parsed.conversationId,
      content: parsed.content,
      attachmentFileIds: parsed.attachmentFileIds ?? [],
      referencedArtifactIds: parsed.referencedArtifactIds ?? []
    })
  }

  it('reaches the runtime and runs the turn', async () => {
    const session = runtime.createConversation(null)

    const run = await sendThroughIpc({
      projectId: null,
      conversationId: session.id,
      content: 'Reply with the exact model name you are running as, then say hello.'
    })
    await settle()

    expect(run.id).toBeTruthy()
    expect(provider.lastInput).not.toBeNull()
    expect(provider.lastInput!.projectId).toBeNull()
    expect(store.requireRun(run.id).state).toBe('completed')
  })

  it('persists the message and the run with no project', async () => {
    const session = runtime.createConversation(null)
    await sendThroughIpc({ projectId: null, conversationId: session.id, content: 'hello' })
    await settle()

    const snapshot = runtime.openUnsorted()
    expect(snapshot.messages.length).toBeGreaterThan(0)
    expect(snapshot.messages.every((message) => message.projectId === null)).toBe(true)
    expect(snapshot.runs.every((run) => run.projectId === null)).toBe(true)
  })

  it('runs it in the Orbit-managed workspace for that session', async () => {
    const session = runtime.createConversation(null)
    await sendThroughIpc({ projectId: null, conversationId: session.id, content: 'hello' })
    await settle()

    expect(provider.lastInput!.workspacePath).toBe(path.join(dir, 'workspaces', session.id))
    expect(fs.existsSync(provider.lastInput!.workspacePath)).toBe(true)
  })

  it('introduces no project to make that work', async () => {
    const session = runtime.createConversation(null)
    await sendThroughIpc({ projectId: null, conversationId: session.id, content: 'hello' })
    await settle()

    // Unsorted means genuinely no project — not a hidden one standing in.
    expect(runtime.listProjects()).toHaveLength(0)
    expect(store.requireConversation(session.id).projectId).toBeNull()
  })

  it('sends from a project session exactly as before', async () => {
    const project = runtime.createProject('AgentDock')
    const session = runtime.openProject(project.id).conversations[0]!

    await sendThroughIpc({ projectId: project.id, conversationId: session.id, content: 'hello' })
    await settle()

    expect(provider.lastInput!.projectId).toBe(project.id)
    expect(runtime.openProject(project.id).messages.length).toBeGreaterThan(0)
  })

  it('still refuses a session sent under the wrong project', async () => {
    const project = runtime.createProject('AgentDock')
    const other = runtime.createProject('Sidecar')
    const session = runtime.openProject(project.id).conversations[0]!

    await expect(sendThroughIpc({ projectId: other.id, conversationId: session.id, content: 'hello' })).rejects.toThrow(
      /does not belong to this project/i
    )
  })

  it('refuses a project session claimed as Unsorted', async () => {
    // Null is not a wildcard: it asserts the session has no project.
    const project = runtime.createProject('AgentDock')
    const session = runtime.openProject(project.id).conversations[0]!

    const run = await sendThroughIpc({ projectId: null, conversationId: session.id, content: 'hello' })
    await settle()

    // Null is "unstated" rather than a contradiction, so the runtime falls
    // back to the session's own project — which is the authoritative owner.
    expect(provider.lastInput!.projectId).toBe(project.id)
    expect(store.requireRun(run.id).conversationId).toBe(session.id)
  })
})
