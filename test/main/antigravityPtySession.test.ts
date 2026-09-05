import { describe, expect, it, vi } from 'vitest'
import { AntigravityPtySession } from '../../src/main/runtime/providers/antigravity/AntigravityPtySession'
import type { AntigravityPtyHandlers, IAntigravityPtyTransport, PtyInteraction } from '../../src/main/runtime/providers/antigravity/AntigravityPtyTransport'
import type { ProviderSendInput } from '../../src/main/runtime/provider'
import type { RuntimeEvent } from '../../src/shared/runtime-events'

class FakeTransport implements IAntigravityPtyTransport {
  isRunning = true
  mediaAttachedCount = 0
  handlers: AntigravityPtyHandlers | null = null
  sentPrompts: string[] = []
  respondCalls: Array<{ pending: PtyInteraction; optionId: string }> = []
  respondResult = true
  cancelCalls = 0
  killCalls = 0

  start(handlers: AntigravityPtyHandlers): void {
    this.handlers = handlers
  }
  sendPrompt(prompt: string): void {
    this.sentPrompts.push(prompt)
  }
  respond(pending: PtyInteraction, optionId: string): boolean {
    this.respondCalls.push({ pending, optionId })
    return this.respondResult
  }
  pasteClipboardImage(): void {}
  cancelTurn(): void {
    this.cancelCalls++
  }
  kill(): void {
    this.killCalls++
    this.isRunning = false
  }
  resize(): void {}
}

function baseInput(overrides: Partial<ProviderSendInput> = {}): ProviderSendInput {
  return {
    projectId: 'project_1',
    conversationId: 'conversation_1',
    runId: 'run_1',
    prompt: 'Hello Antigravity',
    nativeConversationId: null,
    workspacePath: '/tmp/workspace',
    saveDir: '/tmp/workspace',
    attachments: [],
    referencedArtifacts: [],
    transport: 'pty',
    ...overrides
  }
}

function harness() {
  const transports: FakeTransport[] = []
  const session = new AntigravityPtySession(
    {
      executable: 'agy',
      createTransport: () => {
        const transport = new FakeTransport()
        transports.push(transport)
        return transport
      }
    },
    'conversation_1'
  )
  const events: RuntimeEvent[] = []
  const onEvent = (event: RuntimeEvent) => events.push(event)
  return { session, transports, events, onEvent }
}

describe('AntigravityPtySession state machine', () => {
  it('bootstraps a fresh process, waits for ready, then delivers the queued prompt', () => {
    const { session, transports, events, onEvent } = harness()
    session.send(baseInput(), onEvent)
    expect(transports).toHaveLength(1)
    expect(transports[0]!.sentPrompts).toEqual([]) // not yet ready

    transports[0]!.handlers!.onReadyForInput() // bootstrap -> ready -> running
    expect(transports[0]!.sentPrompts).toEqual(['Hello Antigravity'])
    expect(events.some((e) => e.type === 'run.started')).toBe(true)
  })

  it('completes the run once the process becomes ready again after a native conversation id is known', () => {
    const { session, transports, events, onEvent } = harness()
    session.send(baseInput({ nativeConversationId: 'existing-native-id' }), onEvent)
    transports[0]!.handlers!.onReadyForInput() // deliver prompt
    transports[0]!.handlers!.onBusy()
    transports[0]!.handlers!.onReadyForInput() // turn completed
    const completed = events.find((e) => e.type === 'run.completed')
    expect(completed).toBeDefined()
  })

  it('settles the turn as soon as the process is ready again, without any extra round trip', () => {
    const { session, transports, events, onEvent } = harness()
    session.send(baseInput(), onEvent)
    transports[0]!.handlers!.onReadyForInput() // deliver prompt
    transports[0]!.sentPrompts = []
    transports[0]!.handlers!.onReadyForInput() // turn completed
    expect(transports[0]!.sentPrompts).toEqual([]) // no extra commands sent
    expect(events.some((e) => e.type === 'run.completed')).toBe(true)
  })

  it('surfaces a native interaction as interaction.required with canRespond true and pauses the run', () => {
    const { session, transports, events, onEvent } = harness()
    session.send(baseInput(), onEvent)
    transports[0]!.handlers!.onReadyForInput()

    transports[0]!.handlers!.onInteraction({
      signature: 'permission:Do you trust this folder?:arrow:0,arrow:1',
      kind: 'permission',
      prompt: 'Do you trust this folder?',
      options: [
        { id: 'arrow:0', label: 'Yes, I trust this folder' },
        { id: 'arrow:1', label: 'No, exit' }
      ]
    })

    const required = events.find((e) => e.type === 'interaction.required')
    expect(required).toBeDefined()
    expect((required as { canRespond?: boolean }).canRespond).toBe(true)
    expect((required as { transport?: string }).transport).toBe('pty')
  })

  it('deduplicates a redrawn interaction with the same signature', () => {
    const { transports, session, events, onEvent } = harness()
    session.send(baseInput(), onEvent)
    transports[0]!.handlers!.onReadyForInput()
    const interaction: PtyInteraction = { signature: 'sig-1', kind: 'permission', prompt: 'Proceed?', options: [{ id: '1', label: 'Yes' }] }
    transports[0]!.handlers!.onInteraction(interaction)
    transports[0]!.handlers!.onInteraction(interaction) // simulated redraw
    expect(events.filter((e) => e.type === 'interaction.required')).toHaveLength(1)
  })

  it('resolves an interaction, resumes the run, and rejects a stale duplicate response', async () => {
    const { session, transports, events, onEvent } = harness()
    session.send(baseInput({ nativeConversationId: 'known-id' }), onEvent)
    transports[0]!.handlers!.onReadyForInput()
    transports[0]!.handlers!.onInteraction({
      signature: 'sig-1',
      kind: 'permission',
      prompt: 'Proceed?',
      options: [
        { id: '1', label: 'Yes' },
        { id: '2', label: 'No' }
      ]
    })
    const required = events.find((e) => e.type === 'interaction.required') as { interactionId: string }

    await session.respondToInteraction('run_1', required.interactionId, '1')
    expect(transports[0]!.respondCalls).toEqual([{ pending: expect.objectContaining({ signature: 'sig-1' }), optionId: '1' }])
    const resolved = events.find((e) => e.type === 'interaction.resolved')
    expect((resolved as { outcome?: string }).outcome).toBe('approved')

    // Same interaction answered twice must be rejected, not silently accepted.
    await expect(session.respondToInteraction('run_1', required.interactionId, '1')).rejects.toMatchObject({ code: 'interaction.not_pending' })

    // The run must resume and be able to complete normally afterward.
    transports[0]!.handlers!.onReadyForInput()
    expect(events.some((e) => e.type === 'run.completed')).toBe(true)
  })

  it('rejects a response for the wrong run id', async () => {
    const { session, transports, onEvent } = harness()
    session.send(baseInput({ nativeConversationId: 'known-id' }), onEvent)
    transports[0]!.handlers!.onReadyForInput()
    transports[0]!.handlers!.onInteraction({ signature: 'sig-1', kind: 'permission', prompt: 'Proceed?', options: [{ id: '1', label: 'Yes' }] })

    await expect(session.respondToInteraction('some-other-run', 'run_1:pty:1', '1')).rejects.toMatchObject({ code: 'interaction.wrong_run' })
  })

  it('rejects an option id that is not part of the pending interaction', async () => {
    const { session, transports, events, onEvent } = harness()
    session.send(baseInput({ nativeConversationId: 'known-id' }), onEvent)
    transports[0]!.handlers!.onReadyForInput()
    transports[0]!.handlers!.onInteraction({ signature: 'sig-1', kind: 'permission', prompt: 'Proceed?', options: [{ id: '1', label: 'Yes' }] })
    transports[0]!.respondResult = false
    const required = events.find((e) => e.type === 'interaction.required') as { interactionId: string }

    await expect(session.respondToInteraction('run_1', required.interactionId, '99')).rejects.toMatchObject({ code: 'interaction.invalid_option' })
  })

  it('rejects a second send() while a turn is already in progress', () => {
    const { session, transports, onEvent } = harness()
    session.send(baseInput(), onEvent)
    expect(() => session.send(baseInput({ runId: 'run_2' }), onEvent)).toThrow(expect.objectContaining({ code: 'provider.session_busy' }))
    void transports
  })

  it('reuses the same live process across turns instead of respawning', () => {
    const { session, transports, onEvent } = harness()
    session.send(baseInput({ nativeConversationId: 'known-id' }), onEvent)
    transports[0]!.handlers!.onReadyForInput()
    transports[0]!.handlers!.onBusy()
    transports[0]!.handlers!.onReadyForInput() // first turn completes -> 'ready'

    session.send(baseInput({ runId: 'run_2', prompt: 'Follow-up question answer' }), onEvent)
    expect(transports).toHaveLength(1) // no second process spawned
    expect(transports[0]!.sentPrompts).toContain('Follow-up question answer')
  })

  it('cancels a pending interaction and reports run.cancelled once the process settles', () => {
    const { session, transports, events, onEvent } = harness()
    session.send(baseInput({ nativeConversationId: 'known-id' }), onEvent)
    transports[0]!.handlers!.onReadyForInput()
    transports[0]!.handlers!.onInteraction({ signature: 'sig-1', kind: 'permission', prompt: 'Proceed?', options: [{ id: '1', label: 'Yes' }] })

    session.cancel()
    expect(transports[0]!.cancelCalls).toBe(1)
    const resolvedCancelled = events.find((e) => e.type === 'interaction.resolved')
    expect((resolvedCancelled as { outcome?: string }).outcome).toBe('cancelled')

    transports[0]!.handlers!.onReadyForInput()
    const cancelledRun = events.filter((e) => e.type === 'run.cancelled')
    expect(cancelledRun).toHaveLength(1)
    expect(events.some((e) => e.type === 'run.completed')).toBe(false)
  })

  it('reports run.failed with a pending interaction cancelled when the process exits unexpectedly', () => {
    const { session, transports, events, onEvent } = harness()
    session.send(baseInput({ nativeConversationId: 'known-id' }), onEvent)
    transports[0]!.handlers!.onReadyForInput()
    transports[0]!.handlers!.onInteraction({ signature: 'sig-1', kind: 'permission', prompt: 'Proceed?', options: [{ id: '1', label: 'Yes' }] })

    transports[0]!.handlers!.onExit(1, undefined)

    expect(events.some((e) => e.type === 'run.failed')).toBe(true)
    const resolved = events.filter((e) => e.type === 'interaction.resolved')
    expect(resolved.some((e) => (e as { outcome?: string }).outcome === 'cancelled')).toBe(true)
  })

  it('resumes a dead process for the next turn via --conversation instead of failing the whole conversation', () => {
    const { session, transports, onEvent } = harness()
    session.send(baseInput({ nativeConversationId: 'known-id' }), onEvent)
    transports[0]!.handlers!.onExit(1, undefined) // crash

    session.send(baseInput({ runId: 'run_2', nativeConversationId: 'known-id' }), onEvent)
    expect(transports).toHaveLength(2) // fresh process spawned to resume
  })

  void vi // keep vi import even if unused by a given subset of tests
})
