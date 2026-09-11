import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrbitDatabase } from '../../src/main/persistence/database'
import { OrbitStore } from '../../src/main/persistence/store'
import { FileStorage } from '../../src/main/files/fileStorage'
import { ArtifactService } from '../../src/main/artifacts/artifactService'
import { OrbitRuntime } from '../../src/main/runtime/orbitRuntime'
import { transportForTurn } from '../../src/shared/transportPolicy'
import { permissionArgs } from '../../src/shared/permissionMode'
import { ORBIT_DEFAULT_MODEL_ID } from '../../src/shared/defaultModel'
import type { AgentProvider, ProviderSendInput, RespondToInteractionInput } from '../../src/main/runtime/provider'
import type { ModelOption, ProviderStatus } from '../../src/shared/domain'
import type { RuntimeEvent } from '../../src/shared/runtime-events'

const CATALOGUE: ModelOption[] = [
  { id: ORBIT_DEFAULT_MODEL_ID, label: 'Gemini 3.8 Flash', supportedReasoningEfforts: ['low', 'medium', 'high'] }
]

/** Stands in for the live PTY: it asks before it acts, and only acts if the
 *  answer says so — which is the whole contract Ask First depends on. */
class ApprovalProvider implements AgentProvider {
  lastInput: ProviderSendInput | null = null
  /** Set when the protected action was actually carried out. */
  actionPerformed = false
  interactionsRaised = 0
  listModels = vi.fn(async () => CATALOGUE)
  cancelRun = vi.fn(async () => undefined)
  releaseConversation = vi.fn(async () => undefined)
  shutdown = vi.fn(async () => undefined)
  private pending: { input: ProviderSendInput; onEvent: (event: RuntimeEvent) => void; interactionId: string } | null = null

  async getStatus(): Promise<ProviderStatus> {
    return { id: 'antigravity', state: 'ready', sdkAvailable: true, authConfigured: true, message: null, details: {} }
  }

  private base(input: ProviderSendInput) {
    return {
      projectId: input.projectId,
      conversationId: input.conversationId,
      runId: input.runId,
      providerId: 'antigravity' as const,
      createdAt: new Date().toISOString()
    }
  }

  async sendMessage(input: ProviderSendInput, onEvent: (event: RuntimeEvent) => void): Promise<void> {
    this.lastInput = input
    onEvent({ ...this.base(input), type: 'run.started', nativeConversationId: 'native-1' })

    // Skip approvals launches with --dangerously-skip-permissions, so agy
    // never asks: the action simply happens.
    if (input.permissionMode === 'skip') {
      this.actionPerformed = true
      onEvent({ ...this.base(input), type: 'run.completed', finalText: 'Done.', nativeConversationId: 'native-1' })
      return
    }

    const interactionId = `${input.runId}:pty:1`
    this.pending = { input, onEvent, interactionId }
    this.interactionsRaised += 1
    onEvent({
      ...this.base(input),
      type: 'interaction.required',
      interactionId,
      kind: 'permission',
      prompt: 'Create scratch.txt in the workspace?',
      options: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' }
      ],
      transport: 'pty',
      canRespond: true,
      sourceEvidence: 'native-prompt'
    })
  }

  async respondToInteraction(input: RespondToInteractionInput): Promise<void> {
    const pending = this.pending
    if (!pending || pending.interactionId !== input.interactionId) throw new Error('No such interaction.')
    const approved = input.optionId === 'yes'
    if (approved) this.actionPerformed = true
    pending.onEvent({
      ...this.base(pending.input),
      type: 'interaction.resolved',
      interactionId: input.interactionId,
      outcome: approved ? 'approved' : 'denied'
    })
    pending.onEvent({
      ...this.base(pending.input),
      type: 'run.completed',
      finalText: approved ? 'Created it.' : 'Left it alone.',
      nativeConversationId: 'native-1'
    })
    this.pending = null
  }
}

describe('which transport a turn runs on', () => {
  it('puts an Ask First session on the interactive path', () => {
    // The headless path cannot present an approval, so asking has to be
    // possible before anything runs.
    expect(transportForTurn({ current: 'structured', permissionMode: 'ask', hasImageAttachment: false })).toBe('pty')
  })

  it('leaves a Skip approvals session on the headless path', () => {
    expect(transportForTurn({ current: 'structured', permissionMode: 'skip', hasImageAttachment: false })).toBe('structured')
  })

  it('keeps a conversation that already owns a live session on it', () => {
    // PTY ownership is deliberately sticky — it is never handed back.
    expect(transportForTurn({ current: 'pty', permissionMode: 'skip', hasImageAttachment: false })).toBe('pty')
    expect(transportForTurn({ current: 'pty', permissionMode: 'ask', hasImageAttachment: false })).toBe('pty')
  })

  it('still escalates for an image, whatever the permission mode', () => {
    expect(transportForTurn({ current: 'structured', permissionMode: 'skip', hasImageAttachment: true })).toBe('pty')
  })
})

describe('Ask First', () => {
  let dir: string
  let db: OrbitDatabase
  let store: OrbitStore
  let provider: ApprovalProvider
  let runtime: OrbitRuntime
  let events: RuntimeEvent[]

  const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-askfirst-'))
    db = new OrbitDatabase({ dataDir: dir })
    await db.init()
    store = new OrbitStore(db)
    provider = new ApprovalProvider()
    runtime = new OrbitRuntime(store, new ArtifactService(store, new FileStorage(dir)), provider, dir, '0.1.0')
    events = []
    runtime.on('event', (event: RuntimeEvent) => events.push(event))
    await runtime.listModels()
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const startTurn = async (mode: 'ask' | 'skip') => {
    const project = runtime.createProject('Approvals')
    const conversation = runtime.openProject(project.id).conversations[0]!
    runtime.setConversationPermissionMode(conversation.id, mode)
    const run = await runtime.sendMessage({ projectId: project.id, conversationId: conversation.id, content: 'Create a scratch file' })
    await settle()
    return { project, conversation, run }
  }

  it('chooses the interaction-capable transport before the turn starts', async () => {
    const { project, conversation } = await startTurn('ask')

    // Decided at launch, not discovered mid-turn.
    expect(provider.lastInput?.transport).toBe('pty')
    expect(provider.lastInput?.permissionMode).toBe('ask')
    expect(runtime.openProject(project.id).conversations.find((item) => item.id === conversation.id)?.transport).toBe('pty')
  })

  it('raises an approval the user can actually answer', async () => {
    const { run } = await startTurn('ask')

    const raised = events.filter((event) => event.type === 'interaction.required')
    expect(raised).toHaveLength(1)
    expect(raised[0]).toMatchObject({ canRespond: true, sourceEvidence: 'native-prompt' })
    expect(store.requireRun(run.id).state).toBe('waiting_for_interaction')
  })

  it('does not perform the protected action before the user answers', async () => {
    await startTurn('ask')
    expect(provider.actionPerformed).toBe(false)
  })

  it('never produces the headless "could not ask" denial on the normal path', async () => {
    await startTurn('ask')

    const unanswerable = events.filter((event) => event.type === 'interaction.required' && !event.canRespond)
    expect(unanswerable).toHaveLength(0)
    expect(events.some((event) => event.type === 'interaction.required' && event.sourceEvidence === 'headless-denial')).toBe(false)
  })

  it('carries the action out when the user approves', async () => {
    const { conversation, run } = await startTurn('ask')

    await runtime.respondToInteraction({ conversationId: conversation.id, runId: run.id, interactionId: `${run.id}:pty:1`, optionId: 'yes' })
    await settle()

    expect(provider.actionPerformed).toBe(true)
    expect(events.some((event) => event.type === 'interaction.resolved' && event.outcome === 'approved')).toBe(true)
    expect(store.requireRun(run.id).state).toBe('completed')
  })

  it('prevents the action when the user denies', async () => {
    const { conversation, run } = await startTurn('ask')

    await runtime.respondToInteraction({ conversationId: conversation.id, runId: run.id, interactionId: `${run.id}:pty:1`, optionId: 'no' })
    await settle()

    expect(provider.actionPerformed).toBe(false)
    expect(events.some((event) => event.type === 'interaction.resolved' && event.outcome === 'denied')).toBe(true)
  })

  it('refuses a response that does not belong to the run', async () => {
    const { run } = await startTurn('ask')

    await expect(
      runtime.respondToInteraction({ conversationId: 'conversation_other', runId: run.id, interactionId: `${run.id}:pty:1`, optionId: 'yes' })
    ).rejects.toThrow(/does not belong/i)
  })

  it('keeps Skip approvals on always-proceed, asking nothing', async () => {
    const { run } = await startTurn('skip')

    expect(provider.lastInput?.permissionMode).toBe('skip')
    expect(permissionArgs('skip')).toEqual(['--dangerously-skip-permissions'])
    expect(provider.interactionsRaised).toBe(0)
    expect(provider.actionPerformed).toBe(true)
    expect(store.requireRun(run.id).state).toBe('completed')
  })

  it('honours a permission mode changed after the session was made', async () => {
    const project = runtime.createProject('Switching')
    const conversation = runtime.openProject(project.id).conversations[0]!

    runtime.setConversationPermissionMode(conversation.id, 'skip')
    expect(store.requireConversation(conversation.id).permissionMode).toBe('skip')
    await runtime.sendMessage({ projectId: project.id, conversationId: conversation.id, content: 'One' })
    await settle()
    expect(provider.lastInput?.transport).toBe('structured')

    runtime.setConversationPermissionMode(conversation.id, 'ask')
    expect(store.requireConversation(conversation.id).permissionMode).toBe('ask')
    await runtime.sendMessage({ projectId: project.id, conversationId: conversation.id, content: 'Two' })
    await settle()
    expect(provider.lastInput?.transport).toBe('pty')
  })

  it('does not hand a live session back to the headless path when switched to Skip', async () => {
    // Sticky ownership: the session exists, and taking it away mid-thread
    // would strand its native conversation.
    const { conversation, run } = await startTurn('ask')
    await runtime.respondToInteraction({ conversationId: conversation.id, runId: run.id, interactionId: `${run.id}:pty:1`, optionId: 'yes' })
    await settle()

    runtime.setConversationPermissionMode(conversation.id, 'skip')
    await runtime.sendMessage({ projectId: conversation.projectId, conversationId: conversation.id, content: 'Again' })
    await settle()

    expect(provider.lastInput?.transport).toBe('pty')
    expect(store.requireConversation(conversation.id).transport).toBe('pty')
  })
})
