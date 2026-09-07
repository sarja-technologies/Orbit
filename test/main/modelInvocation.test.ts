import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ID, ModelOption } from '../../src/shared/domain'
import type { ProviderSendInput } from '../../src/main/runtime/provider'
import type { AntigravityPtyHandlers, IAntigravityPtyTransport } from '../../src/main/runtime/providers/antigravity/AntigravityPtyTransport'

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
  sendPrompt(): void {}
  respond(): boolean {
    return true
  }
  pasteClipboardImage(): void {}
  cancelTurn(): void {}
  kill(): void {
    this.isRunning = false
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

describe('a live pty session honours a later model change', () => {
  it('retires the running process so the next turn respawns with the new flags', async () => {
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

    await instance.sendMessage(input({ transport: 'pty', runId: 'run_2', model: 'gemini-3.8-flash', reasoningEffort: 'low' }), () => undefined)
    await new Promise((resolve) => setTimeout(resolve, 120))

    expect(spawns).toHaveLength(2)
    expect(spawns[0]).toContain('claude-sonnet-4-6')
    expect(spawns[1]?.[spawns[1].indexOf('--model') + 1]).toBe('gemini-3.8-flash')
    expect(spawns[1]?.[spawns[1].indexOf('--effort') + 1]).toBe('low')
    expect(transports[0]?.isRunning).toBe(false)
  })

  it('does not fail the new run when the retired process exits late', async () => {
    const transports: NoopTransport[] = []
    const events: string[] = []
    const instance = new AntigravityProvider(
      (deps, conversationId) =>
        new AntigravityPtySession(
          {
            ...deps,
            createTransport: () => {
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

    await instance.sendMessage(input({ transport: 'pty', runId: 'run_2', model: 'gemini-3.8-flash', reasoningEffort: 'low' }), (event) =>
      events.push(event.type)
    )
    await new Promise((resolve) => setTimeout(resolve, 120))

    // The old process only notices it was killed after the replacement is
    // already live; that must be silent, not a failed run.
    transports[0]?.handlers?.onExit(0)
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
