// A run records the model it actually ran on.
//
// Without it the transcript had only the session's *current* selection to
// label past turns with, so switching a session's model silently
// re-attributed every earlier reply to a model that never saw it.
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
import type { AgentProvider, ProviderSendInput } from '../../src/main/runtime/provider'
import type { ModelOption, ProviderStatus } from '../../src/shared/domain'
import type { RuntimeEvent } from '../../src/shared/runtime-events'

const CATALOGUE: ModelOption[] = [
  { id: ORBIT_DEFAULT_MODEL_ID, label: 'Gemini 3.8 Flash', supportedReasoningEfforts: ['low', 'medium', 'high'] },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' }
]

class RecordingProvider implements AgentProvider {
  inputs: ProviderSendInput[] = []
  listModels = vi.fn(async () => CATALOGUE)
  cancelRun = vi.fn(async () => undefined)
  respondToInteraction = vi.fn(async () => undefined)
  releaseConversation = vi.fn(async () => undefined)
  shutdown = vi.fn(async () => undefined)
  async getStatus(): Promise<ProviderStatus> {
    return { id: 'antigravity', state: 'ready', sdkAvailable: true, authConfigured: true, message: null, details: {} }
  }
  async sendMessage(input: ProviderSendInput, _onEvent: (event: RuntimeEvent) => void): Promise<void> {
    this.inputs.push(input)
  }
}

describe('what a run records about the model', () => {
  let dir: string
  let db: OrbitDatabase
  let store: OrbitStore
  let provider: RecordingProvider
  let runtime: OrbitRuntime

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-runmodel-'))
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

  const session = () => {
    const project = runtime.createProject('Recording')
    return { project, conversation: runtime.openProject(project.id).conversations[0]! }
  }

  it('records the model the turn was launched on', async () => {
    const { project, conversation } = session()
    const run = await runtime.sendMessage({ projectId: project.id, conversationId: conversation.id, content: 'Go' })

    expect(store.requireRun(run.id).metadata.model).toBe(ORBIT_DEFAULT_MODEL_ID)
  })

  it('records exactly what was handed to the provider, not a second opinion', async () => {
    const { project, conversation } = session()
    runtime.setConversationModel(conversation.id, 'claude-opus-4-6', null)
    const run = await runtime.sendMessage({ projectId: project.id, conversationId: conversation.id, content: 'Go' })

    expect(store.requireRun(run.id).metadata.model).toBe(provider.inputs.at(-1)?.model)
    expect(store.requireRun(run.id).metadata.model).toBe('claude-opus-4-6')
  })

  it('records the reasoning tier alongside it', async () => {
    const { project, conversation } = session()
    runtime.setConversationModel(conversation.id, ORBIT_DEFAULT_MODEL_ID, 'high')
    const run = await runtime.sendMessage({ projectId: project.id, conversationId: conversation.id, content: 'Go' })

    expect(store.requireRun(run.id).metadata.reasoningEffort).toBe('high')
  })

  it('leaves an earlier turn’s record alone when the session switches model', async () => {
    // THE BUG this exists for: the first turn genuinely ran on Gemini and
    // must keep saying so after the session moves to Claude.
    const { project, conversation } = session()
    const first = await runtime.sendMessage({ projectId: project.id, conversationId: conversation.id, content: 'One' })

    runtime.setConversationModel(conversation.id, 'claude-opus-4-6', null)
    const second = await runtime.sendMessage({ projectId: project.id, conversationId: conversation.id, content: 'Two' })

    expect(store.requireRun(first.id).metadata.model).toBe(ORBIT_DEFAULT_MODEL_ID)
    expect(store.requireRun(second.id).metadata.model).toBe('claude-opus-4-6')
  })

  it('keeps the record across a restart, so a reopened session still attributes correctly', async () => {
    const { project, conversation } = session()
    const run = await runtime.sendMessage({ projectId: project.id, conversationId: conversation.id, content: 'Go' })
    db.close()

    const reopened = new OrbitDatabase({ dataDir: dir })
    await reopened.init()
    try {
      expect(new OrbitStore(reopened).requireRun(run.id).metadata.model).toBe(ORBIT_DEFAULT_MODEL_ID)
    } finally {
      reopened.close()
    }
  })

  it('still records the attachment and reference ids it always did', async () => {
    const { project, conversation } = session()
    const run = await runtime.sendMessage({ projectId: project.id, conversationId: conversation.id, content: 'Go' })

    const metadata = store.requireRun(run.id).metadata
    expect(metadata.attachmentFileIds).toEqual([])
    expect(metadata.referencedArtifactIds).toEqual([])
  })
})
