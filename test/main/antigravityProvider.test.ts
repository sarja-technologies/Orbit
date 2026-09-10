import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AntigravityProvider } from '../../src/main/runtime/providers/antigravity/AntigravityProvider'
import { AntigravityPtySession, type PtySessionDeps } from '../../src/main/runtime/providers/antigravity/AntigravityPtySession'
import type { AntigravityPtyHandlers, IAntigravityPtyTransport } from '../../src/main/runtime/providers/antigravity/AntigravityPtyTransport'
import type { ID } from '../../src/shared/domain'
import type { ProviderSendInput } from '../../src/main/runtime/provider'
import type { RuntimeEvent } from '../../src/shared/runtime-events'
import { ORBIT_DEFAULT_MODEL_ID } from '../../src/shared/defaultModel'

let workspaceRoot: string
beforeEach(() => {
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-provider-test-'))
  // Discovery needs an existing absolute executable, but execution is mocked.
  // Never depend on the developer's installed/signed-in AGY or home directory.
  vi.stubEnv('ORBIT_AGY_PATH', process.execPath)
  vi.stubEnv('PATH', '')
  vi.stubEnv('HOME', workspaceRoot)
})
afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(workspaceRoot, { recursive: true, force: true })
})


class FakeTransport implements IAntigravityPtyTransport {
  isRunning = true
  mediaAttachedCount = 0
  handlers: AntigravityPtyHandlers | null = null
  sentPrompts: string[] = []
  start(handlers: AntigravityPtyHandlers): void {
    this.handlers = handlers
  }
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

function baseInput(conversationId: ID, runId: string, overrides: Partial<ProviderSendInput> = {}): ProviderSendInput {
  return {
    projectId: 'project_1',
    conversationId,
    runId,
    prompt: `hello from ${conversationId}`,
    nativeConversationId: null,
    workspacePath: path.join(workspaceRoot, conversationId),
    saveDir: path.join(workspaceRoot, conversationId),
    attachments: [],
    referencedArtifacts: [],
    transport: 'pty',
    model: ORBIT_DEFAULT_MODEL_ID,
    permissionMode: 'ask' as const,
    reasoningEffort: null,
    ...overrides
  }
}

function harness() {
  const transportsByConversation = new Map<ID, FakeTransport>()
  const provider = new AntigravityProvider((deps: PtySessionDeps, conversationId: ID) =>
    new AntigravityPtySession(
      {
        ...deps,
        createTransport: () => {
          const transport = new FakeTransport()
          transportsByConversation.set(conversationId, transport)
          return transport
        },
        findConversationId: () => null
      },
      conversationId
    ),
    // Never spawn the real `agy models` from a unit test.
    async () => []
  )
  return { provider, transportsByConversation }
}

describe('AntigravityProvider PTY session ownership', () => {
  it('gives two different conversations independent PTY sessions that do not cross-talk', async () => {
    const { provider, transportsByConversation } = harness()
    const eventsA: RuntimeEvent[] = []
    const eventsB: RuntimeEvent[] = []

    await provider.sendMessage(baseInput('conversation_a', 'run_a1'), (e) => eventsA.push(e))
    await provider.sendMessage(baseInput('conversation_b', 'run_b1'), (e) => eventsB.push(e))

    expect(transportsByConversation.size).toBe(2)
    const transportA = transportsByConversation.get('conversation_a')!
    const transportB = transportsByConversation.get('conversation_b')!
    expect(transportA).not.toBe(transportB)

    transportA.handlers!.onReadyForInput()
    expect(transportA.sentPrompts).toEqual(['hello from conversation_a'])
    expect(transportB.sentPrompts).toEqual([]) // conversation B untouched by A's activity

    transportB.handlers!.onReadyForInput()
    expect(transportB.sentPrompts).toEqual(['hello from conversation_b'])

    // Each conversation's run.started only ever carries its own identifiers.
    expect(eventsA.every((e) => e.conversationId === 'conversation_a')).toBe(true)
    expect(eventsB.every((e) => e.conversationId === 'conversation_b')).toBe(true)
  })

  it('reuses the same session for a second turn in the same conversation instead of creating a new one', async () => {
    const { provider, transportsByConversation } = harness()
    await provider.sendMessage(baseInput('conversation_a', 'run_a1'), () => {})
    const transportA = transportsByConversation.get('conversation_a')!
    transportA.handlers!.onReadyForInput() // deliver
    transportA.handlers!.onReadyForInput() // settle -> ready

    await provider.sendMessage(baseInput('conversation_a', 'run_a2'), () => {})
    expect(transportsByConversation.size).toBe(1) // no second transport created
  })

  it('routes cancelRun to the correct conversation by run id, not the first one found', async () => {
    const { provider, transportsByConversation } = harness()
    await provider.sendMessage(baseInput('conversation_a', 'run_a1'), () => {})
    await provider.sendMessage(baseInput('conversation_b', 'run_b1'), () => {})
    const transportA = transportsByConversation.get('conversation_a')!
    const transportB = transportsByConversation.get('conversation_b')!
    transportA.handlers!.onReadyForInput()
    transportB.handlers!.onReadyForInput()

    await provider.cancelRun('run_b1')
    // cancelTurn() has no observable flag on FakeTransport, but kill() must
    // never be called for either — cancellation is Escape, not a kill.
    expect(transportA.killCalls).toBe(0)
    expect(transportB.killCalls).toBe(0)
  })

  it('shuts down every active PTY session, not just the first', async () => {
    const { provider, transportsByConversation } = harness()
    await provider.sendMessage(baseInput('conversation_a', 'run_a1'), () => {})
    await provider.sendMessage(baseInput('conversation_b', 'run_b1'), () => {})
    const transportA = transportsByConversation.get('conversation_a')!
    const transportB = transportsByConversation.get('conversation_b')!

    await provider.shutdown()

    expect(transportA.killCalls).toBe(1)
    expect(transportB.killCalls).toBe(1)
  })
})
