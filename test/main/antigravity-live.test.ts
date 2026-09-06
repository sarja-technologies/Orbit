import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AntigravityProvider } from '../../src/main/runtime/providers/antigravity/AntigravityProvider'
import type { ProviderSendInput } from '../../src/main/runtime/provider'
import type { InteractionRequiredEvent, RuntimeEvent } from '../../src/shared/runtime-events'

// Explicitly opt-in: this calls the user's signed-in Antigravity account.
// It proves the actual Orbit provider path, while keeping normal unit tests
// deterministic and credential-free.
const live = process.env.ORBIT_REAL_AGY === '1'
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

describe('AntigravityProvider live integration', () => {
  it.runIf(live)('uses the installed signed-in agy runtime without SDK credentials', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-agy-live-'))
    dirs.push(dir)
    const provider = new AntigravityProvider()
    const result = await run(provider, input(dir, 'Reply with exactly: ORBIT_AGENTDOCK_AGY_OK'))
    expect(result.text.trim()).toBe('ORBIT_AGENTDOCK_AGY_OK')
    expect(result.nativeConversationId).toMatch(/^[0-9a-f-]{20,}$/i)
    await provider.shutdown()
  }, 120_000)
})

// Real, live PTY session tests against the installed signed-in `agy` CLI.
// A fresh workspace always shows agy's own workspace-trust prompt as the
// very first interaction, so every turn below exercises real native
// interaction detection/approval before it exercises anything else.
describe('AntigravityProvider live PTY integration', () => {
  it.runIf(live)(
    'answers native questions, approves and denies real permission prompts, all in one persistent session',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-agy-pty-live-'))
      dirs.push(dir)
      const provider = new AntigravityProvider()
      const conversationId = 'pty-conversation-live'
      let nativeConversationId: string | null = null
      let turnCounter = 0

      const driveTurn = (prompt: string, decide: (interaction: InteractionRequiredEvent) => string | null) =>
        new Promise<RuntimeEvent[]>((resolve, reject) => {
          const runId = `pty-run-${++turnCounter}`
          const turnEvents: RuntimeEvent[] = []
          const onEvent = (event: RuntimeEvent) => {
            turnEvents.push(event)
            if (event.type === 'run.started' && event.nativeConversationId) nativeConversationId = event.nativeConversationId
            if (event.type === 'run.completed' && event.nativeConversationId) nativeConversationId = event.nativeConversationId
            if (event.type === 'interaction.required' && event.canRespond) {
              const optionId = decide(event)
              if (optionId === null) return // this test wants to observe it without responding
              void provider.respondToInteraction({ conversationId, runId, interactionId: event.interactionId, optionId }).catch(reject)
            }
            if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') resolve(turnEvents)
          }
          void provider
            .sendMessage({ ...input(dir, prompt), conversationId, runId, nativeConversationId, transport: 'pty' }, onEvent)
            .catch(reject)
        })

      // Turn 1: a fresh workspace normally shows agy's own workspace-trust
      // prompt first (confirmed live — always approved here, never
      // auto-approved by Orbit itself: the test acts as the human). Once a
      // path has been trusted once on this machine, agy does not ask again
      // for it, so this interaction is opportunistic, not guaranteed — the
      // test asserts on it only when it actually appears. The turn then
      // asks a free-text clarifying question and stops. agy's interactive
      // TUI has no distinct "question" modal (confirmed live): the
      // question is ordinary turn-ending assistant text, answered by the
      // next normal message — see docs/antigravity-transports.md.
      const turn1 = await driveTurn(
        'Do not run any shell commands yet. First ask me one short clarifying question: what filename should you use for a test file? Then stop and wait for my answer.',
        () => 'arrow:0' // "Yes, I trust this folder" (if a trust prompt appears at all)
      )
      const trustPrompt = turn1.find((e) => e.type === 'interaction.required' && /trust/i.test(e.prompt))
      if (trustPrompt) expect((trustPrompt as InteractionRequiredEvent).transport).toBe('pty')
      expect(turn1.some((e) => e.type === 'run.completed')).toBe(true)
      const questionCompletion = turn1.find((e) => e.type === 'run.completed') as { finalText?: string } | undefined
      expect(questionCompletion?.finalText, 'expected the native question text to be captured from the screen').toMatch(/\?/)
      // agy's own history.jsonl (see nativeConversationHistory.ts) does not
      // gain a conversationId for a workspace until its SECOND prompt —
      // confirmed live — so turn 1 alone is not expected to capture one.
      expect(nativeConversationId).toBeNull()

      // Turn 2 (SAME session): answers the question from turn 1 and asks
      // for a shell command that needs a real permission prompt — proves
      // both that the answer reached the same live process (the file gets
      // created with the exact name from this reply, not a generic one)
      // and Test B (real permission approval).
      const turn2 = await driveTurn(
        'The filename is permission-approved.txt. Run the shell command `touch permission-approved.txt` to create it.',
        (interaction) => (interaction.options[0] ? interaction.options[0].id : null)
      )
      const approval = turn2.find((e) => e.type === 'interaction.required') as InteractionRequiredEvent | undefined
      expect(approval, 'expected a real permission prompt for the shell command').toBeDefined()
      expect(approval?.transport).toBe('pty')
      expect(turn2.some((e) => e.type === 'run.completed')).toBe(true)
      expect(fs.existsSync(path.join(dir, 'permission-approved.txt')), 'approved command should have actually run').toBe(true)
      // From the second prompt of a conversation onward, agy's own
      // history.jsonl carries the real native conversation id (confirmed
      // live) — Orbit's PTY session captures it opportunistically here.
      expect(nativeConversationId).toMatch(/^[0-9a-f-]{20,}$/i)

      // Turn 3 (SAME session): denies a second permission prompt — proves
      // Test C (the command must NOT run) and that a denial doesn't kill
      // the live session (the turn still completes normally).
      const turn3 = await driveTurn('Run the shell command `touch permission-denied.txt` to create it.', (interaction) => {
        const denyOption = interaction.options.find((o) => /no|deny/i.test(o.label))
        return denyOption?.id ?? interaction.options[interaction.options.length - 1]?.id ?? null
      })
      const denial = turn3.find((e) => e.type === 'interaction.required') as InteractionRequiredEvent | undefined
      expect(denial, 'expected a real permission prompt for the second shell command').toBeDefined()
      expect(turn3.some((e) => e.type === 'run.completed' || e.type === 'run.failed')).toBe(true)
      expect(fs.existsSync(path.join(dir, 'permission-denied.txt')), 'denied command must not have run').toBe(false)

      // Test D — a stale/duplicate response to the (already-resolved) turn
      // 3 interaction must be rejected, not silently accepted.
      await expect(
        provider.respondToInteraction({ conversationId, runId: 'pty-run-3', interactionId: denial!.interactionId, optionId: denial!.options[0]!.id })
      ).rejects.toThrow()

      await provider.shutdown()
    },
    600_000
  )

  // Proves real native PTY resume across a simulated app restart: a fresh
  // AntigravityProvider (standing in for a new Orbit process) with only the
  // native conversation id captured from a previous provider's live
  // session — no in-memory state, no prompt replay — must still recall
  // real context from that earlier session via `--conversation <id>`.
  it.runIf(live)(
    'resumes a real native conversation via --conversation after the PTY process is gone',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-agy-pty-resume-'))
      dirs.push(dir)
      const secretWord = 'ZEBRA-QUASAR-42'
      let capturedNativeId: string | null = null

      const providerA = new AntigravityProvider()
      const conversationId = 'pty-resume-conversation'

      const driveTurn = (provider: AntigravityProvider, runId: string, nativeConversationId: string | null, prompt: string) =>
        new Promise<RuntimeEvent[]>((resolve, reject) => {
          const events: RuntimeEvent[] = []
          const onEvent = (event: RuntimeEvent) => {
            events.push(event)
            if (event.type === 'interaction.required' && event.canRespond) {
              void provider.respondToInteraction({ conversationId, runId, interactionId: event.interactionId, optionId: event.options[0]!.id }).catch(reject)
            }
            if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') resolve(events)
          }
          void provider
            .sendMessage({ ...input(dir, prompt), conversationId, runId, nativeConversationId, transport: 'pty' }, onEvent)
            .catch(reject)
        })

      // Turn 1 establishes a fact only visible to this native conversation.
      await driveTurn(providerA, 'resume-run-1', null, `Remember this secret word for later: ${secretWord}. Do not run any shell commands. Just acknowledge you noted it.`)
      // Turn 2 is required for agy's history.jsonl to gain a conversationId
      // for this workspace (confirmed live — see nativeConversationHistory.ts).
      const turn2 = await driveTurn(providerA, 'resume-run-2', null, 'Just reply with the word "noted", nothing else.')
      const completed2 = turn2.find((e) => e.type === 'run.completed') as { nativeConversationId?: string | null } | undefined
      capturedNativeId = completed2?.nativeConversationId ?? null
      expect(capturedNativeId, 'expected a native conversation id to be captured by the second turn').toMatch(/^[0-9a-f-]{20,}$/i)

      // Simulate the PTY process being gone (crash or Orbit restart): kill
      // everything providerA owns, then build a completely fresh provider
      // with NO in-memory session state — only the persisted native id, the
      // same way OrbitRuntime would pass it back from the stored Conversation.
      await providerA.shutdown()

      const providerB = new AntigravityProvider()
      const turn3 = await driveTurn(providerB, 'resume-run-3', capturedNativeId, 'What secret word did I ask you to remember earlier in this conversation? Reply with only that word.')
      const completed3 = turn3.find((e) => e.type === 'run.completed') as { finalText?: string } | undefined
      expect(turn3.some((e) => e.type === 'run.completed')).toBe(true)
      expect(completed3?.finalText ?? '').toContain(secretWord)

      await providerB.shutdown()
    },
    300_000
  )
})

function input(workspacePath: string, prompt: string): ProviderSendInput {
  return {
    projectId: 'project',
    conversationId: 'conversation',
    runId: `run-${Date.now()}`,
    prompt,
    nativeConversationId: null,
    workspacePath,
    saveDir: workspacePath,
    attachments: [],
    referencedArtifacts: [],
    transport: 'structured'
  }
}
function run(provider: AntigravityProvider, value: ProviderSendInput): Promise<{ text: string; nativeConversationId: string | null }> {
  return new Promise((resolve, reject) => {
    let text = ''; let nativeConversationId: string | null = null
    const onEvent = (event: RuntimeEvent) => {
      if (event.type === 'run.started') nativeConversationId = event.nativeConversationId ?? null
      if (event.type === 'text.delta') text += event.delta
      if (event.type === 'run.completed') resolve({ text: event.finalText || text, nativeConversationId: event.nativeConversationId ?? nativeConversationId })
      if (event.type === 'run.failed') reject(new Error(event.error.message))
      if (event.type === 'run.cancelled') reject(new Error('unexpected cancellation'))
    }
    void provider.sendMessage(value, onEvent).catch(reject)
  })
}
