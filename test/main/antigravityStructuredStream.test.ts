import fs from 'node:fs'
import * as childProcess from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AntigravityProvider } from '../../src/main/runtime/providers/antigravity/AntigravityProvider'
import type { ProviderSendInput } from '../../src/main/runtime/provider'
import type { RuntimeEvent } from '../../src/shared/runtime-events'
import { ORBIT_DEFAULT_MODEL_ID } from '../../src/shared/defaultModel'

// Real `agy 1.1.27 --print … --output-format stream-json` output, captured
// from live turns while investigating issue #2 (see
// docs/antigravity-transports.md). Field-for-field the shapes agy actually
// emits — only the prose is shortened. The decisive property they encode:
// the incremental `agent_response` deltas concatenate to EXACTLY
// `result.response`, and the last of them (state DONE, arriving in the same
// millisecond as the result) carries whatever agy had not yet flushed.
const CONVERSATION_ID = '0f204da1-ec9e-4c45-b26d-b08129c88bfa'

const INIT = {
  event: 'init',
  conversation_id: CONVERSATION_ID,
  init: { cwd: '/tmp/workspace', tools: ['ask_permission', 'ask_question', 'run_command'], permission_mode: 'request-review' }
}
const USER_INPUT_STEP = {
  event: 'step_update',
  step_update: { conversation_id: CONVERSATION_ID, step_index: 0, state: 'DONE', step_type: 'user_input' }
}
const activeDelta = (text: string) => ({
  event: 'step_update',
  step_update: { conversation_id: CONVERSATION_ID, step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: text }
})
const doneDelta = (text: string) => ({
  event: 'step_update',
  step_update: {
    conversation_id: CONVERSATION_ID,
    step_index: 1,
    state: 'DONE',
    step_type: 'agent_response',
    text_delta: text,
    duration_seconds: 13.6,
    usage: { input_tokens: 6524, output_tokens: 606, total_tokens: 7130 }
  }
})
const success = (response: string) => ({
  event: 'result',
  result: {
    conversation_id: CONVERSATION_ID,
    status: 'SUCCESS',
    response,
    duration_seconds: 21.9,
    num_turns: 1,
    usage: { input_tokens: 9767, output_tokens: 792, total_tokens: 10559 }
  }
})

/** A stand-in `agy` that replays captured NDJSON. Nothing here talks to a
 *  real account, but everything downstream of it — argv handling, line
 *  framing, the event normalizer — is the real provider. */
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})
const { spawn: realSpawn } = await vi.importActual<typeof childProcess>('node:child_process')
const children: { child: childProcess.ChildProcess; closed: Promise<void> }[] = []
let scriptDir: string
let previousPath: string | undefined

function fakeAgy(lines: unknown[]): string {
  const file = path.join(scriptDir, `agy-${Math.random().toString(36).slice(2)}.mjs`)
  const payload = lines.map((line) => JSON.stringify(line)).join('\n')
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(`${payload}\n`)})\n`,
    { mode: 0o755 }
  )
  return file
}

function input(overrides: Partial<ProviderSendInput> = {}): ProviderSendInput {
  return {
    projectId: 'project_1',
    conversationId: 'conversation_1',
    runId: 'run_1',
    prompt: 'Write a detailed explanation of how TCP congestion control works.',
    nativeConversationId: null,
    workspacePath: path.join(scriptDir, 'workspace'),
    saveDir: path.join(scriptDir, 'workspace'),
    attachments: [],
    referencedArtifacts: [],
    transport: 'structured',
    model: ORBIT_DEFAULT_MODEL_ID,
    reasoningEffort: null,
    ...overrides
  }
}

async function replay(lines: unknown[]): Promise<RuntimeEvent[]> {
  process.env.ORBIT_AGY_PATH = fakeAgy(lines)
  // Never spawn the real `agy models` from a unit test.
  const provider = new AntigravityProvider(undefined, async () => [])
  const events: RuntimeEvent[] = []
  await new Promise<void>((resolve, reject) => {
    void provider
      .sendMessage(input(), (event) => {
        events.push(event)
        if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') resolve()
      })
      .catch(reject)
  })
  return events
}

const deltasOf = (events: RuntimeEvent[]): string[] =>
  events.filter((event): event is Extract<RuntimeEvent, { type: 'text.delta' }> => event.type === 'text.delta').map((event) => event.delta)

beforeEach(() => {
  scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-agy-fake-'))
  fs.mkdirSync(path.join(scriptDir, 'workspace'), { recursive: true })
  previousPath = process.env.ORBIT_AGY_PATH
  // Windows cannot execute a shebang .mjs directly. Launch the fixture with
  // this Node on every OS; retain real pipes, framing, events and cancellation.
  vi.mocked(childProcess.spawn).mockImplementation(((executable: string, args: readonly string[], options: SpawnOptions) => {
    expect(path.dirname(executable)).toBe(scriptDir)
    const child = realSpawn(process.execPath, [executable, ...args], options)
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    children.push({ child, closed })
    return child
  }) as typeof childProcess.spawn)
})

afterEach(async () => {
  // A protocol result can precede OS exit. Windows locks the child's cwd
  // until exit; always reap fixture processes before deleting their workspace.
  for (const { child } of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
  await Promise.all(children.splice(0).map(({ closed }) => closed))
  vi.mocked(childProcess.spawn).mockReset()
  if (previousPath === undefined) delete process.env.ORBIT_AGY_PATH
  else process.env.ORBIT_AGY_PATH = previousPath
  fs.rmSync(scriptDir, { recursive: true, force: true })
})

describe('structured transport streaming (real captured agy event shapes)', () => {
  it('turns every incremental agent_response into a text.delta, in order, without duplicating the final response', async () => {
    const chunks = ['TCP congestion control is a vital ', 'distributed mechanism designed to ', 'prevent transport-level traffic ']
    const tail = 'from overwhelming the network.\n'
    const response = `${chunks.join('')}${tail}`
    const events = await replay([INIT, USER_INPUT_STEP, ...chunks.map(activeDelta), doneDelta(tail), success(response)])

    expect(deltasOf(events), JSON.stringify(events)).toEqual([...chunks, tail])
    expect(deltasOf(events).join('')).toBe(response)

    const completed = events.find((event) => event.type === 'run.completed')
    expect(completed).toMatchObject({ finalText: response, nativeConversationId: CONVERSATION_ID })
  })

  it('emits run.started with the native conversation id from init before any text', async () => {
    const events = await replay([INIT, USER_INPUT_STEP, doneDelta('Paris.\n'), success('Paris.\n')])
    expect(events[0]).toMatchObject({ type: 'run.started', nativeConversationId: CONVERSATION_ID })
    expect(events.findIndex((event) => event.type === 'text.delta')).toBeGreaterThan(0)
  })

  it('keeps the final-response-only fallback: a turn with no deltas still renders its answer', async () => {
    // Real shape: an `agent_response` step that carries no `text_delta` at
    // all (captured live on a tool-using turn), so the only prose Orbit
    // ever sees is `result.response`.
    const emptyStep = {
      event: 'step_update',
      step_update: { conversation_id: CONVERSATION_ID, step_index: 1, state: 'DONE', step_type: 'agent_response', duration_seconds: 16.9 }
    }
    const events = await replay([INIT, USER_INPUT_STEP, emptyStep, success('The capital of France is Paris.\n')])

    expect(deltasOf(events)).toEqual(['The capital of France is Paris.\n'])
    expect(events.find((event) => event.type === 'run.completed')).toMatchObject({ finalText: 'The capital of France is Paris.\n' })
  })

  it('streams only the part of result.response the deltas had not delivered yet', async () => {
    const events = await replay([INIT, USER_INPUT_STEP, activeDelta('Half a sentence'), success('Half a sentence and its ending.')])
    expect(deltasOf(events)).toEqual(['Half a sentence', ' and its ending.'])
    expect(deltasOf(events).join('')).toBe('Half a sentence and its ending.')
  })

  it('never appends a contradictory second copy when result.response diverges from what streamed', async () => {
    const events = await replay([INIT, USER_INPUT_STEP, activeDelta('Draft text'), success('A completely different answer.')])
    expect(deltasOf(events)).toEqual(['Draft text'])
    // finalText stays authoritative — it is what gets persisted.
    expect(events.find((event) => event.type === 'run.completed')).toMatchObject({ finalText: 'A completely different answer.' })
  })

  it('reports a failed result as run.failed rather than a completed answer', async () => {
    const failure = {
      event: 'result',
      result: { conversation_id: CONVERSATION_ID, status: 'ERROR', error: 'model overloaded' }
    }
    const events = await replay([INIT, USER_INPUT_STEP, activeDelta('Starting'), failure])
    expect(deltasOf(events)).toEqual(['Starting'])
    expect(events.some((event) => event.type === 'run.completed')).toBe(false)
    expect(events.find((event) => event.type === 'run.failed')).toMatchObject({ error: { code: 'provider.failed', message: 'model overloaded' } })
  })

  it('reports a cancelled run as run.cancelled, keeping whatever had streamed', async () => {
    // A long replay that never reaches its result, so the run is still open
    // when cancelRun kills it.
    process.env.ORBIT_AGY_PATH = fakeAgy([INIT, USER_INPUT_STEP, activeDelta('Partial answer')])
    const file = process.env.ORBIT_AGY_PATH
    fs.appendFileSync(file, 'setTimeout(() => {}, 60_000)\n')
    const provider = new AntigravityProvider(undefined, async () => [])
    const events: RuntimeEvent[] = []
    const settled = new Promise<void>((resolve) => {
      void provider.sendMessage(input(), (event) => {
        events.push(event)
        if (event.type === 'text.delta') void provider.cancelRun('run_1')
        if (event.type === 'run.cancelled' || event.type === 'run.completed' || event.type === 'run.failed') resolve()
      })
    })
    await settled
    expect(deltasOf(events)).toEqual(['Partial answer'])
    expect(events.at(-1)).toMatchObject({ type: 'run.cancelled' })
    await provider.shutdown()
  })

  it('stays cancelled when agy answers the interrupt with an error result', async () => {
    // THE REAL BUG. SIGTERM makes agy tear its turn down, and what it
    // writes on the way out races the exit handler. Here it wins that
    // race with `status: "ERROR"`, which used to be reported as
    // `provider.failed` — rendered as "Antigravity's response couldn't be
    // read", a crash report for something the user asked for.
    const interrupted = {
      event: 'result',
      result: { conversation_id: CONVERSATION_ID, status: 'ERROR', error: 'Turn interrupted by signal' }
    }
    process.env.ORBIT_AGY_PATH = fakeAgy([INIT, USER_INPUT_STEP, activeDelta('Partial answer')])
    fs.appendFileSync(
      process.env.ORBIT_AGY_PATH,
      `process.on('SIGTERM', () => { process.stdout.write(${JSON.stringify(`${JSON.stringify(interrupted)}\n`)}); setTimeout(() => process.exit(0), 50) })\n` +
        'setTimeout(() => {}, 60_000)\n'
    )
    const provider = new AntigravityProvider(undefined, async () => [])
    const events: RuntimeEvent[] = []
    await new Promise<void>((resolve) => {
      void provider.sendMessage(input(), (event) => {
        events.push(event)
        if (event.type === 'text.delta') void provider.cancelRun('run_1')
        if (event.type === 'run.cancelled' || event.type === 'run.completed' || event.type === 'run.failed') resolve()
      })
    })

    expect(events.some((event) => event.type === 'run.failed'), JSON.stringify(events)).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'run.cancelled' })
    await provider.shutdown()
  })

  it('still reports a genuine failure as a failure when nothing was cancelled', async () => {
    // The guard above must not swallow real errors: an untouched run that
    // dies still ends as run.failed, with agy's own message intact.
    const events = await replay([INIT, USER_INPUT_STEP, activeDelta('Starting')])
    expect(events.some((event) => event.type === 'run.cancelled')).toBe(false)
    expect(events.find((event) => event.type === 'run.failed')).toMatchObject({ error: { code: 'provider.exited' } })
  })

  it('reports the real command a tool step is running, not just the tool’s name', async () => {
    const toolStep = (state: string) => ({
      event: 'step_update',
      step_update: {
        conversation_id: CONVERSATION_ID,
        step_index: 2,
        state,
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: { parameters: { command: 'npm run build' } }
      }
    })
    const events = await replay([INIT, USER_INPUT_STEP, toolStep('ACTIVE'), toolStep('DONE'), success('Built.')])
    const activity = events.filter((event) => event.type === 'tool.activity')

    expect(activity).toHaveLength(2)
    expect(activity[0]).toMatchObject({ label: 'Running npm run build', status: 'running', kind: 'command', detail: 'npm run build' })
    expect(activity[1]).toMatchObject({ label: 'Running npm run build', status: 'completed', kind: 'command' })
  })

  it('reports the real file a read or edit step is touching', async () => {
    const step = (index: number, tool: string, parameters: Record<string, unknown>) => ({
      event: 'step_update',
      step_update: {
        conversation_id: CONVERSATION_ID,
        step_index: index,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: tool,
        tool_info: { parameters }
      }
    })
    const events = await replay([
      INIT,
      USER_INPUT_STEP,
      step(2, 'read_file', { path: 'src/components/WorkSession.tsx' }),
      step(3, 'write_file', { path: 'styles.css' }),
      success('Done.')
    ])
    const labels = events.filter((event) => event.type === 'tool.activity').map((event) => (event as { label: string }).label)

    expect(labels).toEqual(['Reading src/components/WorkSession.tsx', 'Editing styles.css'])
  })
})
