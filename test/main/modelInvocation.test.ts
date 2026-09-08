import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ID, ModelOption } from '../../src/shared/domain'
import type { ProviderSendInput } from '../../src/main/runtime/provider'
import type { AntigravityPtyHandlers, IAntigravityPtyTransport } from '../../src/main/runtime/providers/antigravity/AntigravityPtyTransport'
import type { RuntimeEvent } from '../../src/shared/runtime-events'

const spawnCalls: { command: string; args: string[] }[] = []

// Both launch paths must agree on model/effort, so the structured path is
// exercised through a stubbed spawn rather than a real `agy` process.
vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[]) => {
    spawnCalls.push({ command, args })
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.stdin = new PassThrough()
    child.kill = () => true
    setImmediate(() => child.emit('close', 0))
    return child
  }
}))

const { AntigravityProvider } = await import('../../src/main/runtime/providers/antigravity/AntigravityProvider')
const { AntigravityPtySession } = await import('../../src/main/runtime/providers/antigravity/AntigravityPtySession')

/** The real shape of `agy models`: variant-only Gemini families, plain
 *  Claude ids with no tiers, and a single-tier GPT-OSS entry. */
const RAW_CATALOG: ModelOption[] = [
  { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
  { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
  { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
  { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' },
  { id: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro (Low)' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' }
]

function input(overrides: Partial<ProviderSendInput> = {}): ProviderSendInput {
  return {
    projectId: 'project_1',
    conversationId: 'conversation_1' as ID,
    runId: 'run_1',
    prompt: 'hello',
    nativeConversationId: null,
    workspacePath: '/tmp/workspace',
    saveDir: '/tmp/workspace',
    attachments: [],
    referencedArtifacts: [],
    transport: 'structured',
    model: null,
    reasoningEffort: null,
    ...overrides
  }
}

class NoopTransport implements IAntigravityPtyTransport {
  isRunning = true
  mediaAttachedCount = 0
  handlers: AntigravityPtyHandlers | null = null
  start(handlers: AntigravityPtyHandlers): void {
    this.handlers = handlers
  }
  sentPrompts: string[] = []
  sendPrompt(prompt: string): void {
    this.sentPrompts.push(prompt)
    // Real agy goes busy once a prompt is submitted; a fake that never does
    // lets a test settle a turn the session has no evidence ever ran.
    this.handlers?.onBusy()
  }
  respond(): boolean {
    return true
  }
  pasteClipboardImage(): void {}
  cancelTurn(): void {}
  /** Mirrors the real transport: `kill()` only *requests* termination, and
   *  `isRunning` stays true until `exit()` is called to simulate the OS
   *  process actually going away. Tests that flip `isRunning` synchronously
   *  here cannot see the retirement race this models. */
  killCalls = 0
  killSignals: (string | undefined)[] = []
  private markExited: () => void = () => undefined
  private exited: Promise<void> = new Promise<void>((resolve) => {
    this.markExited = resolve
  })
  kill(signal?: string): void {
    this.killCalls++
    this.killSignals.push(signal)
  }
  whenExited(): Promise<void> {
    return this.exited
  }
  /** Simulates the OS process finally exiting. */
  exit(code = 0): void {
    this.isRunning = false
    this.markExited()
    this.handlers?.onExit(code)
  }
  resize(): void {}
}

/** Walks a bootstrapped transport through one complete turn: ready (deliver
 *  the queued prompt), busy, ready again (turn settles). */
async function settleTurn(transport: NoopTransport): Promise<void> {
  transport.handlers?.onReadyForInput()
  await new Promise((resolve) => setTimeout(resolve, 0))
  transport.handlers?.onBusy()
  transport.handlers?.onReadyForInput()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** settleTurn under fake timers: the same sequence, awaiting the timer
 *  queue rather than real time. */
async function settleTurnFake(transport: NoopTransport): Promise<void> {
  transport.handlers?.onReadyForInput()
  await vi.advanceTimersByTimeAsync(1)
  transport.handlers?.onBusy()
  transport.handlers?.onReadyForInput()
  await vi.advanceTimersByTimeAsync(1)
}

function provider(): InstanceType<typeof AntigravityProvider> {
  return new AntigravityProvider(undefined, async () => RAW_CATALOG)
}

/** The flags `agy` was actually launched with, minus the prompt plumbing. */
async function structuredArgs(overrides: Partial<ProviderSendInput>): Promise<string[]> {
  spawnCalls.length = 0
  const instance = provider()
  await instance.sendMessage(input({ transport: 'structured', ...overrides }), () => undefined)
  const call = spawnCalls.at(-1)
  return call?.args ?? []
}

describe('model and effort reach the structured launch', () => {
  beforeEach(() => {
    spawnCalls.length = 0
  })

  it('passes neither flag when the conversation has no selection', async () => {
    const args = await structuredArgs({})
    expect(args).not.toContain('--model')
    expect(args).not.toContain('--effort')
  })

  it('passes a single-tier model without an effort flag', async () => {
    const args = await structuredArgs({ model: 'claude-sonnet-4-6', reasoningEffort: 'high' })
    expect(args.slice(args.indexOf('--model'))).toEqual(['--model', 'claude-sonnet-4-6'])
    expect(args).not.toContain('--effort')
  })

  it('passes a base model together with a tier it supports', async () => {
    const args = await structuredArgs({ model: 'gemini-3.8-flash', reasoningEffort: 'medium' })
    expect(args).toContain('--model')
    expect(args[args.indexOf('--model') + 1]).toBe('gemini-3.8-flash')
    expect(args[args.indexOf('--effort') + 1]).toBe('medium')
  })

  it('never guesses a tier for a multi-tier model left on default effort', async () => {
    const args = await structuredArgs({ model: 'gemini-3.1-pro', reasoningEffort: null })
    expect(args).not.toContain('--model')
    expect(args).not.toContain('--effort')
  })
})

describe('model and effort reach the interactive PTY launch', () => {
  it('spawns the pty with the same flags the structured path would use', async () => {
    let ptyArgs: string[] = []
    const instance = new AntigravityProvider(
      (deps, conversationId) =>
        new AntigravityPtySession(
          {
            ...deps,
            createTransport: (_executable: string, _cwd: string, args: string[]) => {
              ptyArgs = args
              return new NoopTransport()
            },
            findConversationId: () => null
          },
          conversationId
        ),
      async () => RAW_CATALOG
    )

    await instance.sendMessage(input({ transport: 'pty', model: 'gemini-3.8-flash', reasoningEffort: 'low' }), () => undefined)

    expect(ptyArgs).toContain('--add-dir')
    expect(ptyArgs[ptyArgs.indexOf('--model') + 1]).toBe('gemini-3.8-flash')
    expect(ptyArgs[ptyArgs.indexOf('--effort') + 1]).toBe('low')
  })
})

/** Mirrors agy's real history.jsonl behaviour: a workspace gains a
 *  conversation id only from its SECOND prompt onward (confirmed live — see
 *  nativeConversationHistory.ts), so a conversation that has had exactly one
 *  turn has no id to resume with. */
function conversationIdFromSecondTurn(): () => string | null {
  let turns = 0
  return () => (++turns >= 2 ? 'ffffffff-1111-2222-3333-444444444444' : null)
}

function ptyHarness(findConversationId: () => string | null) {
  const spawns: string[][] = []
  const transports: NoopTransport[] = []
  const instance = new AntigravityProvider(
    (deps, conversationId) =>
      new AntigravityPtySession(
        {
          ...deps,
          createTransport: (_executable: string, _cwd: string, args: string[]) => {
            spawns.push(args)
            const transport = new NoopTransport()
            transports.push(transport)
            return transport
          },
          findConversationId
        },
        conversationId
      ),
    async () => RAW_CATALOG
  )
  return { instance, spawns, transports }
}

describe('a live pty session honours a later model change', () => {
  it('does not discard conversation context when the model changes before a resumable id exists', async () => {
    // The dangerous sequence: a brand-new conversation has had exactly one
    // turn, so agy has recorded no conversation id for it, and the live
    // process is the ONLY thing carrying its context. Retiring it here would
    // silently start the conversation over under the new model.
    const { instance, spawns, transports } = ptyHarness(() => null)
    const events: RuntimeEvent[] = []

    await instance.sendMessage(input({ transport: 'pty', model: 'claude-sonnet-4-6' }), () => undefined)
    await settleTurn(transports[0]!)

    await instance.sendMessage(input({ transport: 'pty', runId: 'run_2', model: 'gemini-3.8-flash', reasoningEffort: 'low' }), (event) =>
      events.push(event)
    )
    await new Promise((resolve) => setTimeout(resolve, 120))

    // No second process, and the first one is untouched and still serving.
    expect(spawns).toHaveLength(1)
    expect(transports).toHaveLength(1)
    expect(transports[0]!.killCalls).toBe(0)
    expect(transports[0]!.isRunning).toBe(true)
    // The turn still runs — on the model the session already had.
    expect(transports[0]!.sentPrompts.length).toBeGreaterThan(0)
    // And the user is told, rather than being shown a model that is not
    // actually in use.
    const notice = events.find((event) => event.type === 'run.notice')
    expect(notice, 'expected an honest notice that the model change was deferred').toBeDefined()
    expect((notice as { code: string }).code).toBe('model.deferred')
    expect(events.some((event) => event.type === 'run.failed')).toBe(false)
  })

  it('applies the deferred model on the next turn, once a resumable id exists', async () => {
    const { instance, spawns, transports } = ptyHarness(conversationIdFromSecondTurn())

    await instance.sendMessage(input({ transport: 'pty', model: 'claude-sonnet-4-6' }), () => undefined)
    await settleTurn(transports[0]!)

    // Turn 2: no id yet, so the change is deferred and this turn reuses the
    // live process. Settling it is what gives agy a second prompt, and
    // therefore an id.
    await instance.sendMessage(input({ transport: 'pty', runId: 'run_2', model: 'gemini-3.8-flash', reasoningEffort: 'low' }), () => undefined)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await settleTurn(transports[0]!)
    expect(spawns).toHaveLength(1)

    // Turn 3: an id exists, so the change is finally applied — by retiring
    // the old process and resuming the same native conversation.
    await instance.sendMessage(input({ transport: 'pty', runId: 'run_3', model: 'gemini-3.8-flash', reasoningEffort: 'low' }), () => undefined)
    await new Promise((resolve) => setTimeout(resolve, 20))
    transports[0]!.exit(0)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(spawns).toHaveLength(2)
    expect(spawns[1]![spawns[1]!.indexOf('--model') + 1]).toBe('gemini-3.8-flash')
    expect(spawns[1]![spawns[1]!.indexOf('--effort') + 1]).toBe('low')
    // Context is carried over rather than abandoned.
    expect(spawns[1]).toContain('--conversation')
    expect(spawns[1]![spawns[1]!.indexOf('--conversation') + 1]).toBe('ffffffff-1111-2222-3333-444444444444')
  })

  it('does not spawn the replacement until the retired process has really exited', async () => {
    // The regression the review caught: `kill()` only requests termination.
    // Until the OS process is genuinely gone, a second agy must not exist
    // against the same native conversation.
    const { instance, spawns, transports } = ptyHarness(() => 'aaaaaaaa-1111-2222-3333-444444444444')

    await instance.sendMessage(input({ transport: 'pty', model: 'claude-sonnet-4-6' }), () => undefined)
    await settleTurn(transports[0]!)

    await instance.sendMessage(input({ transport: 'pty', runId: 'run_2', model: 'gemini-3.8-flash', reasoningEffort: 'low' }), () => undefined)
    await new Promise((resolve) => setTimeout(resolve, 200))

    // Termination was requested, the process is deliberately still alive —
    // and crucially no replacement has been created.
    expect(transports[0]!.killCalls).toBe(1)
    expect(transports[0]!.isRunning).toBe(true)
    expect(spawns).toHaveLength(1)
    expect(transports).toHaveLength(1)

    // Only the real exit releases the replacement.
    transports[0]!.exit(0)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(spawns).toHaveLength(2)
    expect(transports[1]!.isRunning).toBe(true)
  })

  it('refuses a send that arrives while a model-change retirement is still in flight', async () => {
    // The window the review found: the transport has been detached and the
    // predecessor is still alive, so an `idle` session showed no transport,
    // no retirement and no block — and a concurrent send started a second
    // agy alongside the one still dying.
    const { instance, spawns, transports } = ptyHarness(() => 'eeeeeeee-1111-2222-3333-444444444444')

    await instance.sendMessage(input({ transport: 'pty', model: 'claude-sonnet-4-6' }), () => undefined)
    await settleTurn(transports[0]!)

    // Model change: retirement starts, predecessor deliberately stays alive.
    await instance.sendMessage(input({ transport: 'pty', runId: 'run_2', model: 'gemini-3.8-flash', reasoningEffort: 'low' }), () => undefined)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(transports[0]!.killCalls).toBe(1)
    expect(transports[0]!.isRunning, 'still the owner').toBe(true)
    expect(spawns).toHaveLength(1)

    // A second send arrives *before* the retirement resolves.
    await expect(
      instance.sendMessage(input({ transport: 'pty', runId: 'run_3', model: 'gemini-3.8-flash', reasoningEffort: 'low' }), () => undefined)
    ).rejects.toMatchObject({ code: 'provider.session_busy' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(spawns, 'nothing may spawn or be scheduled while a predecessor is retiring').toHaveLength(1)
    expect(transports).toHaveLength(1)

    // The predecessor finally exits: the replacement promised to run_2 spawns
    // — exactly once.
    transports[0]!.exit(0)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(spawns).toHaveLength(2)
    expect(transports).toHaveLength(2)
    expect(spawns[1]![spawns[1]!.indexOf('--model') + 1]).toBe('gemini-3.8-flash')
  })

  it('fails a send that waited on a retirement which then became unkillable', async () => {
    vi.useFakeTimers()
    try {
      const { instance, spawns, transports } = ptyHarness(() => 'ffffffff-aaaa-2222-3333-444444444444')
      await instance.sendMessage(input({ transport: 'pty', model: 'claude-sonnet-4-6' }), () => undefined)
      await settleTurnFake(transports[0]!)

      // Retire the process out of band (shutdown-style), so a later send has
      // to queue behind the retirement rather than being refused as busy.
      const session = instance as unknown as { ptySessions: Map<string, { shutdown: () => void }> }
      session.ptySessions.get('conversation_1')!.shutdown()
      await vi.advanceTimersByTimeAsync(20)

      const events: RuntimeEvent[] = []
      await instance.sendMessage(input({ transport: 'pty', runId: 'run_2', model: 'claude-sonnet-4-6' }), (event) => events.push(event))
      await vi.advanceTimersByTimeAsync(20)
      expect(spawns, 'the queued send must not spawn while the predecessor lives').toHaveLength(1)

      // TERM bound, then SIGKILL bound, both survived.
      await vi.advanceTimersByTimeAsync(6_200)
      expect(transports[0]!.killSignals).toEqual([undefined, 'SIGKILL'])
      expect(spawns, 'a queued send must never spawn onto an unkillable predecessor').toHaveLength(1)
      const failure = events.find((event) => event.type === 'run.failed')
      expect(failure, 'the queued send must fail, not hang').toBeDefined()
      expect((failure as { error: { code: string } }).error.code).toBe('provider.retire_failed')

      // Genuine exit releases ownership; a retry then works.
      transports[0]!.exit(137)
      await vi.advanceTimersByTimeAsync(20)
      await instance.sendMessage(input({ transport: 'pty', runId: 'run_3', model: 'claude-sonnet-4-6' }), () => undefined)
      await vi.advanceTimersByTimeAsync(20)
      expect(spawns).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a send that arrives once a release is under way', async () => {
    const { instance, spawns, transports } = ptyHarness(() => 'aaaabbbb-1111-2222-3333-444444444444')
    await instance.sendMessage(input({ transport: 'pty', model: 'claude-sonnet-4-6' }), () => undefined)
    await settleTurn(transports[0]!)

    const releasing = instance.releaseConversation('conversation_1')
    // Arrives while the release is still waiting on the predecessor.
    await expect(
      instance.sendMessage(input({ transport: 'pty', runId: 'run_2', model: 'claude-sonnet-4-6' }), () => undefined)
    ).rejects.toMatchObject({ code: 'provider.session_released' })
    expect(spawns).toHaveLength(1)

    transports[0]!.exit(0)
    await releasing
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(spawns, 'nothing may spawn for a released conversation').toHaveLength(1)
    expect(transports).toHaveLength(1)
  })

  it('does not let a send already queued behind a retirement spawn onto a released session', async () => {
    // The orphan case: the send queues while the session is merely shutting
    // down, and the provider releases the conversation before the
    // predecessor exits. When the queued callback finally runs, the session
    // it would spawn on is gone.
    const { instance, spawns, transports } = ptyHarness(() => 'bbbbcccc-1111-2222-3333-444444444444')
    await instance.sendMessage(input({ transport: 'pty', model: 'claude-sonnet-4-6' }), () => undefined)
    await settleTurn(transports[0]!)

    const sessions = (instance as unknown as { ptySessions: Map<string, { shutdown: () => void }> }).ptySessions
    sessions.get('conversation_1')!.shutdown()
    await new Promise((resolve) => setTimeout(resolve, 10))

    // Queued: the retirement is in flight, so this send waits rather than spawning.
    const events: RuntimeEvent[] = []
    await instance.sendMessage(input({ transport: 'pty', runId: 'run_2', model: 'claude-sonnet-4-6' }), (event) => events.push(event))
    expect(spawns).toHaveLength(1)

    // The conversation is released while that send is still waiting.
    const releasing = instance.releaseConversation('conversation_1')
    transports[0]!.exit(0)
    await releasing
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(spawns, 'the queued send must not resurrect a released session').toHaveLength(1)
    expect(transports).toHaveLength(1)
    const failure = events.find((event) => event.type === 'run.failed')
    expect(failure, 'the queued send must be told, not silently dropped').toBeDefined()
    expect((failure as { error: { code: string } }).error.code).toBe('provider.session_released')
  })

  it('escalates to SIGKILL, and refuses to start a second owner if the process still will not exit', async () => {
    vi.useFakeTimers()
    try {
      const { instance, spawns, transports } = ptyHarness(() => 'bbbbbbbb-1111-2222-3333-444444444444')
      const events: RuntimeEvent[] = []

      await instance.sendMessage(input({ transport: 'pty', model: 'claude-sonnet-4-6' }), () => undefined)
      await settleTurnFake(transports[0]!)

      await instance.sendMessage(input({ transport: 'pty', runId: 'run_2', model: 'gemini-3.8-flash', reasoningEffort: 'low' }), (event) =>
        events.push(event)
      )
      await vi.advanceTimersByTimeAsync(20)
      expect(transports[0]!.killSignals).toEqual([undefined])

      // Past the polite bound: escalate.
      await vi.advanceTimersByTimeAsync(4_100)
      expect(transports[0]!.killSignals).toEqual([undefined, 'SIGKILL'])
      expect(spawns).toHaveLength(1)

      // Past the forced bound with the process still alive: fail the turn
      // rather than run two agy processes against one conversation.
      await vi.advanceTimersByTimeAsync(2_100)
      expect(spawns, 'a second owner must never be created').toHaveLength(1)
      const failure = events.find((event) => event.type === 'run.failed')
      expect(failure).toBeDefined()
      expect((failure as { error: { code: string; retryable: boolean } }).error.code).toBe('provider.retire_failed')
      expect((failure as { error: { retryable: boolean } }).error.retryable).toBe(true)

      // The predecessor is still alive. Refusing once is not enough — the
      // session must keep owning it, or the very next turn quietly becomes
      // the second owner it just refused to be.
      expect(transports[0]!.isRunning).toBe(true)
      // The turn is refused with a coded error — which OrbitRuntime turns
      // into the same retryable `run.failed` the user sees.
      await expect(
        instance.sendMessage(input({ transport: 'pty', runId: 'run_3', model: 'gemini-3.8-flash', reasoningEffort: 'low' }), () => undefined)
      ).rejects.toMatchObject({ code: 'provider.retire_failed' })
      await vi.advanceTimersByTimeAsync(50)
      expect(spawns, 'no new process while the predecessor is alive').toHaveLength(1)
      expect(transports).toHaveLength(1)

      // 6-8. The stubborn process finally exits; ownership is released and a
      // retry spawns normally, still resuming the same native conversation.
      transports[0]!.exit(137)
      await vi.advanceTimersByTimeAsync(50)
      await instance.sendMessage(input({ transport: 'pty', runId: 'run_4', model: 'gemini-3.8-flash', reasoningEffort: 'low' }), () => undefined)
      await vi.advanceTimersByTimeAsync(50)
      expect(spawns, 'a replacement is fine once the predecessor is really gone').toHaveLength(2)
      expect(spawns[1]![spawns[1]!.indexOf('--model') + 1]).toBe('gemini-3.8-flash')
      expect(spawns[1]).toContain('--conversation')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps owning a process that survives shutdown, and releases it on its real exit', async () => {
    // shutdown() escalates the same way; if the process still will not die,
    // forgetting it would let the next send() start a second owner just as
    // surely as the model-change path would.
    vi.useFakeTimers()
    try {
      const { instance, spawns, transports } = ptyHarness(() => 'dddddddd-1111-2222-3333-444444444444')

      await instance.sendMessage(input({ transport: 'pty', model: 'claude-sonnet-4-6' }), () => undefined)
      await settleTurnFake(transports[0]!)

      // Release the conversation: shutdown asks the process to stop, and it
      // refuses through both bounds. The release cannot be awaited before
      // the timers move — it is waiting on them.
      const released = instance.releaseConversation('conversation_1')
      await vi.advanceTimersByTimeAsync(6_200)
      await released
      expect(transports[0]!.killSignals).toEqual([undefined, 'SIGKILL'])
      expect(transports[0]!.isRunning).toBe(true)

      // A brand-new session for the same conversation must not spawn on top
      // of it. (releaseConversation drops the session, so this is the
      // provider creating a fresh one — the invariant has to survive that.)
      // A released conversation is closed, so the honest reason is that —
      // and either way no second process may exist.
      await expect(
        instance.sendMessage(input({ transport: 'pty', runId: 'run_2', model: 'claude-sonnet-4-6' }), () => undefined)
      ).rejects.toMatchObject({ code: 'provider.session_released' })
      await vi.advanceTimersByTimeAsync(50)
      expect(spawns.length, 'no second owner while the shut-down process lives').toBe(1)

      transports[0]!.exit(137)
      await vi.advanceTimersByTimeAsync(50)
      await instance.sendMessage(input({ transport: 'pty', runId: 'run_3', model: 'claude-sonnet-4-6' }), () => undefined)
      await vi.advanceTimersByTimeAsync(50)
      expect(spawns.length, 'once it is gone, a fresh session is fine').toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not fail the new run when the retired process exits late', async () => {
    const { instance, transports } = ptyHarness(() => 'cccccccc-1111-2222-3333-444444444444')
    const events: string[] = []

    await instance.sendMessage(input({ transport: 'pty', model: 'claude-sonnet-4-6' }), () => undefined)
    await settleTurn(transports[0]!)

    await instance.sendMessage(input({ transport: 'pty', runId: 'run_2', model: 'gemini-3.8-flash', reasoningEffort: 'low' }), (event) =>
      events.push(event.type)
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    // The old process exits, releasing the replacement; its exit callback
    // must be silent rather than failing the new run.
    transports[0]!.exit(0)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(events).not.toContain('run.failed')
    await settleTurn(transports[1]!)
    expect(events).toContain('run.completed')
  })

  it('keeps the same process when the selection has not changed', async () => {
    const spawns: string[][] = []
    const transports: NoopTransport[] = []
    const instance = new AntigravityProvider(
      (deps, conversationId) =>
        new AntigravityPtySession(
          {
            ...deps,
            createTransport: (_executable: string, _cwd: string, args: string[]) => {
              spawns.push(args)
              const transport = new NoopTransport()
              transports.push(transport)
              return transport
            },
            findConversationId: () => null
          },
          conversationId
        ),
      async () => RAW_CATALOG
    )

    await instance.sendMessage(input({ transport: 'pty', model: 'claude-sonnet-4-6' }), () => undefined)
    await settleTurn(transports[0]!)

    await instance.sendMessage(input({ transport: 'pty', runId: 'run_2', model: 'claude-sonnet-4-6' }), () => undefined)
    await new Promise((resolve) => setTimeout(resolve, 120))

    expect(spawns).toHaveLength(1)
    expect(transports[0]?.isRunning).toBe(true)
  })
})

describe('listModels', () => {
  it('exposes the normalized catalogue, not the raw variant ids', async () => {
    const models = await provider().listModels()
    expect(models.map((model) => model.id)).toEqual(['gemini-3.8-flash', 'gemini-3.1-pro', 'claude-sonnet-4-6'])
    expect(models[0]?.supportedReasoningEfforts).toEqual(['low', 'medium', 'high'])
    expect(models[2]?.supportedReasoningEfforts).toBeUndefined()
  })
})
