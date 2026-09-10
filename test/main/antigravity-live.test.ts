import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AntigravityProvider } from '../../src/main/runtime/providers/antigravity/AntigravityProvider'
import type { ProviderSendInput } from '../../src/main/runtime/provider'
import type { InteractionRequiredEvent, RuntimeEvent } from '../../src/shared/runtime-events'
import { ORBIT_DEFAULT_MODEL_ID } from '../../src/shared/defaultModel'

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
// Whether agy raises a workspace-trust or command-permission prompt at all
// depends on the machine it is signed in on (its own settings file can grant
// a standing allow-list — see permissionPromptsUnavailableReason below), so
// every prompt below is asserted on when it appears and explained when it
// does not. Deterministic coverage of the detection itself lives in
// test/main/terminalInteractionDetector.test.ts.
describe('AntigravityProvider live PTY integration', () => {
  it.runIf(live)(
    'answers native questions, and approves/denies any real permission prompt agy raises, all in one persistent session',
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
      // for a shell command — proving both that the answer reached the same
      // live process (the file gets the exact name from this reply, not a
      // generic one) and, where this machine's agy still asks, real
      // permission approval.
      const turn2 = await driveTurn(
        'The filename is permission-approved.txt. Run the shell command `touch permission-approved.txt` to create it.',
        (interaction) => (interaction.options[0] ? interaction.options[0].id : null)
      )
      const approval = turn2.find((e) => e.type === 'interaction.required') as InteractionRequiredEvent | undefined
      // Whether agy asks at all is a property of the machine agy is signed
      // in on, not of Orbit — see `permissionPromptsUnavailableReason` below. When it
      // does ask, everything about that prompt is still asserted; when it
      // does not, there is no prompt on screen for anything to detect, and
      // pretending otherwise would only make this test lie. A prompt that
      // appeared and was *missed* cannot slip through here: the turn would
      // stall waiting for a response that never comes, and the test would
      // time out rather than pass.
      if (approval) expect(approval.transport).toBe('pty')
      else expect(permissionPromptsUnavailableReason(), 'agy raised no permission prompt and this machine has no allow-list explaining why').not.toBeNull()
      expect(turn2.some((e) => e.type === 'run.completed')).toBe(true)
      expect(fs.existsSync(path.join(dir, 'permission-approved.txt')), 'approved command should have actually run').toBe(true)
      // From the second prompt of a conversation onward, agy's own
      // history.jsonl carries the real native conversation id (confirmed
      // live) — Orbit's PTY session captures it opportunistically here.
      expect(nativeConversationId).toMatch(/^[0-9a-f-]{20,}$/i)

      // Turn 3 (SAME session): denies a second permission prompt — proves
      // the command must NOT run, and that a denial doesn't kill the live
      // session (the turn still completes normally). Only meaningful where
      // agy actually prompts; where it does not, the command is simply
      // allowed to run and there is nothing to deny.
      const turn3 = await driveTurn('Run the shell command `touch permission-denied.txt` to create it.', (interaction) => {
        const denyOption = interaction.options.find((o) => /no|deny/i.test(o.label))
        return denyOption?.id ?? interaction.options[interaction.options.length - 1]?.id ?? null
      })
      const denial = turn3.find((e) => e.type === 'interaction.required') as InteractionRequiredEvent | undefined
      expect(turn3.some((e) => e.type === 'run.completed' || e.type === 'run.failed')).toBe(true)
      if (denial) {
        expect(fs.existsSync(path.join(dir, 'permission-denied.txt')), 'denied command must not have run').toBe(false)
        // A stale/duplicate response to the (already-resolved) interaction
        // must be rejected, not silently accepted.
        await expect(
          provider.respondToInteraction({ conversationId, runId: 'pty-run-3', interactionId: denial.interactionId, optionId: denial.options[0]!.id })
        ).rejects.toThrow()
      } else {
        console.warn(`[live] permission approve/deny not exercised: ${permissionPromptsUnavailableReason()}`)
      }

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

// Issue #2. Both transports are asserted on the same property: real
// assistant prose reaches Orbit as `text.delta` *while the turn is still
// running*, not in one lump at completion. The evidence these were built
// from — raw `stream-json` traces and 200 ms PTY screen samples from real
// turns — is written up in docs/antigravity-transports.md.
describe('AntigravityProvider live streaming', () => {
  it.runIf(live)(
    'streams a long structured answer progressively instead of only at the result',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-agy-stream-live-'))
      dirs.push(dir)
      const provider = new AntigravityProvider()
      const subjects = [
        'Write a detailed 600-word essay about the history of the bicycle. Do not use any tools.',
        'Write a detailed 600-word essay about the history of the printing press. Do not use any tools.'
      ]

      // agy decides when to flush its `agent_response` deltas, and a turn it
      // flushes in one go has nothing incremental in it — see
      // docs/antigravity-transports.md, where the captured traces show
      // 62-73% of a long answer arriving in the final delta. So, as with the
      // PTY test below, two turns are asked and one must stream. What every
      // turn must satisfy regardless is the invariant the normalizer is
      // responsible for: the deltas concatenate to exactly the final text.
      const traces: StreamingTrace[] = []
      for (const [index, subject] of subjects.entries()) {
        traces.push(await traceStreaming(provider, { ...input(dir, subject), runId: `structured-stream-run-${index + 1}`, transport: 'structured' }))
        const latest = traces.at(-1)!
        expect(latest.deltas.join(''), 'deltas must concatenate to the final response').toBe(latest.finalText)
        if (latest.deltas.length > 1) break
      }

      const streaming = traces.find((trace) => trace.deltas.length > 1)
      expect(streaming, `no turn produced more than one incremental delta (${traces.length} attempted)`).toBeDefined()
      expect(streaming!.firstDeltaAtMs, 'expected text before the run completed').toBeLessThan(streaming!.completedAtMs)
      // The gap between the first visible text and the end of the turn is
      // the streaming window the user actually sees.
      expect(streaming!.completedAtMs - streaming!.firstDeltaAtMs).toBeGreaterThan(300)
      await provider.shutdown()
    },
    300_000
  )

  it.runIf(live)(
    'streams a long PTY answer progressively from the live terminal screen',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-agy-stream-pty-live-'))
      dirs.push(dir)
      const provider = new AntigravityProvider()
      const subjects = [
        'Write a detailed 1200-word essay about the history of the bicycle, with several sections. Do not use any tools.',
        'Now write a detailed 1200-word essay about the history of the printing press, with several sections. Do not use any tools.'
      ]

      // agy paints its answer into the terminal at its own pace, and
      // occasionally paints an entire one in a single repaint — in which
      // case there is genuinely nothing incremental for Orbit to read, and
      // `run.completed` carries the whole thing (see
      // docs/antigravity-transports.md). Measured live: roughly one turn in
      // eight. So this asks two consecutive turns of the same live session
      // for progressive output and requires at least one to deliver it —
      // enough that a real regression (which would stream nothing, ever)
      // still fails, without pinning the suite to agy's pacing. The
      // multi-delta, no-duplication and no-chrome guarantees are asserted
      // deterministically against recorded frames in
      // antigravityPtyStreaming.test.ts.
      const traces: StreamingTrace[] = []
      for (const [index, subject] of subjects.entries()) {
        traces.push(
          await traceStreaming(provider, {
            ...input(dir, subject),
            conversationId: 'pty-streaming-live',
            runId: `pty-streaming-run-${index + 1}`,
            transport: 'pty'
          })
        )
        if (traces.at(-1)!.deltas.length > 0) break
      }

      // Every turn must produce a complete answer either way.
      for (const trace of traces) expect(trace.finalText.length, 'expected a complete answer').toBeGreaterThan(500)

      const streaming = traces.find((trace) => trace.deltas.length > 0)
      expect(streaming, `no turn streamed any text (${traces.length} attempted)`).toBeDefined()
      expect(streaming!.firstDeltaAtMs, 'expected text before the run completed').toBeLessThan(streaming!.completedAtMs)
      expect(streaming!.completedAtMs - streaming!.firstDeltaAtMs).toBeGreaterThan(200)
      // No terminal chrome, tip line or account details ever reached the transcript.
      const streamed = traces.flatMap((trace) => trace.deltas).join('')
      expect(streamed).not.toMatch(/[⠀-⣿]/)
      expect(streamed).not.toContain('for shortcuts')
      expect(streamed).not.toContain('Antigravity CLI')
      expect(streamed).not.toContain('└ Tip:')
      await provider.shutdown()
    },
    300_000
  )
})

// Issue: changing the model on a live PTY conversation must never silently
// start that conversation over. agy records no conversation id for a
// workspace until its SECOND prompt, so a change requested after turn one
// has nothing to resume with — Orbit defers it rather than killing the only
// process carrying the context. This drives the whole sequence against the
// real CLI and checks the context actually survives.
describe('AntigravityProvider live model change', () => {
  it.runIf(live)(
    'defers a model change until the conversation can be resumed, then applies it without losing context',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-agy-model-live-'))
      dirs.push(dir)
      const secret = 'BANANA-COMET-7'
      const conversationId = 'pty-model-change-live'
      const provider = new AntigravityProvider()
      let turn = 0

      const drive = (prompt: string, model: string, effort: 'low' | 'medium' | 'high' | null) =>
        new Promise<{ text: string; notices: string[]; nativeConversationId: string | null }>((resolve, reject) => {
          const notices: string[] = []
          let nativeConversationId: string | null = null
          void provider
            .sendMessage(
              { ...input(dir, prompt), conversationId, runId: `model-run-${++turn}`, transport: 'pty', model, reasoningEffort: effort },
              (event) => {
                if (event.type === 'run.notice') notices.push(event.code)
                if (event.type === 'run.completed') {
                  nativeConversationId = event.nativeConversationId ?? null
                  resolve({ text: event.finalText, notices, nativeConversationId })
                }
                if (event.type === 'run.failed') reject(new Error(event.error.message))
                if (event.type === 'run.cancelled') reject(new Error('unexpected cancellation'))
              }
            )
            .catch(reject)
        })

      // Turn 1 establishes context. agy has no conversation id for this
      // workspace yet.
      const first = await drive(`Remember this secret word for later: ${secret}. Do not run any shell commands. Just acknowledge you noted it.`, 'claude-sonnet-4-6', null)
      expect(first.nativeConversationId, 'agy records no id until the second prompt').toBeNull()

      // Turn 2 changes the model. There is still nothing to resume with, so
      // the change must be deferred rather than destroying the only process
      // holding the conversation — and the context must survive.
      const second = await drive('What secret word did I ask you to remember? Reply with only that word.', 'gemini-3.8-flash', 'low')
      expect(second.notices, 'the deferred model change must be reported honestly').toContain('model.deferred')
      expect(second.text, 'context must survive a model change requested too early').toContain(secret)
      expect(second.nativeConversationId, 'the second prompt gives agy an id').toMatch(/^[0-9a-f-]{20,}$/i)

      // Turn 3: an id now exists, so the change is applied for real — the
      // old process is retired and the same native conversation resumed.
      const third = await drive('Once more: what was that secret word? Reply with only that word.', 'gemini-3.8-flash', 'low')
      expect(third.text, 'context must survive the retire-and-resume').toContain(secret)

      await provider.shutdown()
    },
    600_000
  )

  it.runIf(live)(
    'stops a run that is waiting on a real model-change retirement, and never runs the prompt it cancelled',
    async () => {
      // The same window the deterministic tests cover, against a real agy
      // process: the predecessor is genuinely being terminated by the OS when
      // Stop arrives, so nothing about the timing is simulated.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-agy-cancel-live-'))
      dirs.push(dir)
      const secret = 'PELICAN-QUASAR-4'
      const conversationId = 'pty-cancel-live'
      const provider = new AntigravityProvider()
      let turn = 0

      const drive = (prompt: string, model: string, effort: 'low' | 'medium' | 'high' | null) =>
        new Promise<{ text: string; nativeConversationId: string | null }>((resolve, reject) => {
          let nativeConversationId: string | null = null
          void provider
            .sendMessage(
              { ...input(dir, prompt), conversationId, runId: `cancel-run-${++turn}`, transport: 'pty', model, reasoningEffort: effort },
              (event) => {
                if (event.type === 'run.completed') {
                  nativeConversationId = event.nativeConversationId ?? null
                  resolve({ text: event.finalText, nativeConversationId })
                }
                if (event.type === 'run.failed') reject(new Error(event.error.message))
                if (event.type === 'run.cancelled') reject(new Error('unexpected cancellation'))
              }
            )
            .catch(reject)
        })

      // Two settled turns give agy a conversation id, so the next model
      // change is really applied rather than deferred.
      await drive(`Remember this secret word for later: ${secret}. Do not run any shell commands. Just acknowledge you noted it.`, 'claude-sonnet-4-6', null)
      const second = await drive('What secret word did I ask you to remember? Reply with only that word.', 'claude-sonnet-4-6', null)
      expect(second.nativeConversationId, 'the second prompt gives agy an id to resume').toMatch(/^[0-9a-f-]{20,}$/i)

      // The model change retires the live process. `sendMessage` returns once
      // the session is in `retiring` with the retirement installed, so Stop
      // here always lands inside the window rather than racing it.
      const cancelledPrompt = 'Write a 900 word essay about the history of the bicycle.'
      const cancelledRunId = 'cancel-run-stopped'
      const cancelledEvents: RuntimeEvent[] = []
      await provider.sendMessage(
        { ...input(dir, cancelledPrompt), conversationId, runId: cancelledRunId, transport: 'pty', model: 'gemini-3.8-flash', reasoningEffort: 'low' },
        (event) => cancelledEvents.push(event)
      )
      // Sampled across the whole retirement+cancellation window: the
      // single-owner invariant has to hold while a process is being killed
      // and a replacement is (not) being started.
      let peakProcesses = agyProcessesFor(dir)
      const sampler = setInterval(() => {
        peakProcesses = Math.max(peakProcesses, agyProcessesFor(dir))
      }, 100)

      await provider.cancelRun(cancelledRunId)

      expect(cancelledEvents.filter((event) => event.type === 'run.cancelled'), 'Stop must be acknowledged exactly once').toHaveLength(1)

      // Let the real predecessor finish exiting and the replacement spawn, if
      // it were ever going to. It must not.
      await new Promise((resolve) => setTimeout(resolve, 8_000))
      clearInterval(sampler)
      // Exactly one, not merely "at most one": a counter that saw nothing
      // would make an at-most assertion pass vacuously.
      expect(peakProcesses, 'exactly one agy process owns this conversation throughout').toBe(1)
      expect(cancelledEvents.filter((event) => event.type === 'run.cancelled'), 'no duplicate cancellation').toHaveLength(1)
      expect(cancelledEvents.some((event) => event.type === 'run.completed'), 'a cancelled run must never complete').toBe(false)
      expect(cancelledEvents.some((event) => event.type === 'run.failed'), 'a cancelled run must not be reported as failed').toBe(false)
      expect(cancelledEvents.some((event) => event.type === 'text.delta'), 'the cancelled prompt must never have run').toBe(false)

      // Ownership was released by the predecessor's genuine exit, so the
      // conversation is usable again — with its context intact.
      const later = await drive('Once more: what was that secret word? Reply with only that word.', 'gemini-3.8-flash', 'low')
      expect(later.text, 'the conversation must survive a cancelled model change').toContain(secret)

      await provider.shutdown()
    },
    600_000
  )
})

interface StreamingTrace {
  deltas: string[]
  firstDeltaAtMs: number
  completedAtMs: number
  finalText: string
}

/** Records when each `text.delta` actually arrived, which is the whole
 *  question issue #2 asks. */
function traceStreaming(provider: AntigravityProvider, value: ProviderSendInput): Promise<StreamingTrace> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const deltas: string[] = []
    let firstDeltaAtMs = Number.POSITIVE_INFINITY
    const onEvent = (event: RuntimeEvent) => {
      if (event.type === 'text.delta') {
        if (deltas.length === 0) firstDeltaAtMs = Date.now() - startedAt
        deltas.push(event.delta)
      }
      if (event.type === 'run.completed') {
        resolve({ deltas, firstDeltaAtMs, completedAtMs: Date.now() - startedAt, finalText: event.finalText || deltas.join('') })
      }
      if (event.type === 'run.failed') reject(new Error(event.error.message))
      if (event.type === 'run.cancelled') reject(new Error('unexpected cancellation'))
    }
    void provider.sendMessage(value, onEvent).catch(reject)
  })
}

/** Why this machine's agy would not raise a command-permission prompt, or
 *  null if nothing explains it.
 *
 *  agy keeps a user-level standing allow-list in its own settings file, and
 *  an entry like `command(*)` grants every shell command up front — so it
 *  never asks, and there is nothing on screen for Orbit to detect. Confirmed
 *  live on this machine: with `command(*)` present, `touch`, `rm -rf` on a
 *  path outside the workspace, and a network `curl` all ran with no prompt
 *  and no trust dialog anywhere in the captured terminal output.
 *
 *  This is read only to explain a skip honestly. Orbit never writes this
 *  file, never passes `--dangerously-skip-permissions`, and never
 *  auto-approves anything itself — when agy does ask, the user answers. */
function permissionPromptsUnavailableReason(): string | null {
  const settingsPath = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json')
  let allow: unknown
  try {
    allow = (JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as { permissions?: { allow?: unknown } }).permissions?.allow
  } catch {
    return null // no settings file, or unreadable — nothing to explain the absence
  }
  if (!Array.isArray(allow)) return null
  const blanket = allow.filter((entry): entry is string => typeof entry === 'string').filter((entry) => /^command\(\*\)$|^\*$/.test(entry.trim()))
  if (blanket.length === 0) return null
  return `agy's own settings (${settingsPath}) grant a standing allow-list including ${blanket.join(', ')}, so it approves shell commands without asking`
}

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
    transport: 'structured',
    model: ORBIT_DEFAULT_MODEL_ID,
    reasoningEffort: null
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

/** Live agy processes launched for one workspace, counted from the real
 *  process table. Scoped by `--add-dir <workspace>` so an unrelated agy the
 *  user happens to be running is never counted. */
function agyProcessesFor(workspacePath: string): number {
  try {
    const listing = execFileSync('ps', ['-eo', 'args='], { encoding: 'utf8' })
    return listing.split('\n').filter((line) => /(^|\/)agy\b/.test(line) && line.includes(`--add-dir ${workspacePath}`)).length
  } catch {
    return 0 // `ps` unavailable — the assertion this feeds is best-effort
  }
}
