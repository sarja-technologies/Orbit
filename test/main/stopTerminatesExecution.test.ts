// Stop means stopped: nothing a cancelled turn started may survive it, and
// nothing it would have produced may be attributed to a later turn.
//
// Reproduced live before this fix (agy 1.2.2): agy ran a Python script, Stop
// was pressed, the script kept running and kept writing after the turn was
// marked stopped — so a file it finished during the NEXT turn would have been
// registered as that turn's output. These tests drive real processes arranged
// exactly the way agy arranges them (a command in a process group of its
// own), through the real provider and runtime.
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrbitDatabase } from '../../src/main/persistence/database'
import { OrbitStore } from '../../src/main/persistence/store'
import { FileStorage } from '../../src/main/files/fileStorage'
import { ArtifactService } from '../../src/main/artifacts/artifactService'
import { OrbitRuntime } from '../../src/main/runtime/orbitRuntime'
import { AntigravityProvider } from '../../src/main/runtime/providers/antigravity/AntigravityProvider'
import { AntigravityPtySession } from '../../src/main/runtime/providers/antigravity/AntigravityPtySession'
import type { AntigravityPtyHandlers, IAntigravityPtyTransport, PtyInteraction } from '../../src/main/runtime/providers/antigravity/AntigravityPtyTransport'
import type { ProviderSendInput } from '../../src/main/runtime/provider'
import type { RuntimeEvent } from '../../src/shared/runtime-events'
import { ORBIT_DEFAULT_MODEL_ID } from '../../src/shared/defaultModel'

const FAKE_AGY = path.join(__dirname, 'fixtures', 'fakeAgy.cjs')
const isPosix = process.platform !== 'win32'

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Pids reported by the fake agy's `run_command` steps, for cleanup and
 *  assertions. */
function writerPids(events: RuntimeEvent[]): number[] {
  return events
    .filter((event): event is Extract<RuntimeEvent, { type: 'tool.activity' }> => event.type === 'tool.activity')
    .map((event) => Number(/writer (\d+)/.exec(event.label)?.[1] ?? event.detail?.match(/writer (\d+)/)?.[1]))
    .filter((pid) => Number.isFinite(pid) && pid > 0)
}

describe.runIf(isPosix)('Stop on the structured transport, through the real runtime', () => {
  let dir = ''
  let workspace = ''
  let db: OrbitDatabase
  let store: OrbitStore
  let runtime: OrbitRuntime
  let provider: AntigravityProvider
  const events: RuntimeEvent[] = []
  const previousAgyPath = process.env.ORBIT_AGY_PATH

  beforeAll(() => {
    fs.chmodSync(FAKE_AGY, 0o755)
    process.env.ORBIT_AGY_PATH = FAKE_AGY
  })
  afterAll(() => {
    if (previousAgyPath === undefined) delete process.env.ORBIT_AGY_PATH
    else process.env.ORBIT_AGY_PATH = previousAgyPath
  })

  beforeEach(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-stop-')))
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-stop-ws-')))
    db = new OrbitDatabase({ dataDir: dir })
    await db.init()
    store = new OrbitStore(db)
    provider = new AntigravityProvider(undefined, async () => [], () => path.join(dir, 'no-brain'))
    runtime = new OrbitRuntime(store, new ArtifactService(store, new FileStorage(dir)), provider, dir, '0.1.0')
    events.length = 0
    runtime.on('event', (event: RuntimeEvent) => events.push(event))
  })

  afterEach(async () => {
    for (const pid of writerPids(events)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* gone, as it should be */
      }
    }
    await provider.shutdown()
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  /** A Bypass-permissions session, which runs on the structured transport. */
  function session(): { projectId: string; conversationId: string } {
    const project = runtime.createProject('Stop', workspace)
    const conversation = runtime.openProject(project.id).conversations[0]!
    runtime.setConversationPermissionMode(conversation.id, 'skip')
    return { projectId: project.id, conversationId: conversation.id }
  }

  it('turn A’s delayed writer is killed by Stop, and its file never appears under turn B', async () => {
    const { projectId, conversationId } = session()
    const lateFile = path.join(workspace, 'late-render.png')

    // Turn A: a command that would write a complete PNG after 2.5 s.
    const runA = await runtime.sendMessage({ projectId, conversationId, content: `DELAYED_WRITER ${lateFile} 2500` })
    await vi.waitFor(() => expect(writerPids(events)).toHaveLength(1), { timeout: 5000 })
    const [writer] = writerPids(events)
    expect(alive(writer!)).toBe(true)

    // Stop A. The request resolves only once the execution is really over.
    const stopped = await runtime.cancelRun(runA.id)
    expect(stopped.state).toBe('cancelled')
    expect(alive(writer!), 'the command agy started must not survive Stop').toBe(false)
    expect(events.filter((event) => event.type === 'run.cancelled' && event.runId === runA.id)).toHaveLength(1)

    // Turn B runs for longer than the writer would have taken.
    const runB = await runtime.sendMessage({ projectId, conversationId, content: 'SLOW_REPLY 3500' })
    await vi.waitFor(() => expect(store.requireRun(runB.id).state).toBe('completed'), { timeout: 10_000 })

    expect(fs.existsSync(lateFile), 'the stopped writer must never have written its file').toBe(false)
    const artifacts = runtime.openProject(projectId).artifacts
    expect(artifacts.filter((artifact) => artifact.creatorRunId === runB.id)).toEqual([])
    expect(artifacts).toEqual([])
  }, 20_000)

  it('force-kills an agy that ignores SIGTERM, and still reports the run cancelled exactly once', async () => {
    const { projectId, conversationId } = session()
    const run = await runtime.sendMessage({ projectId, conversationId, content: `STUBBORN ${path.join(workspace, 'never.png')} 60000` })
    await vi.waitFor(() => expect(writerPids(events)).toHaveLength(1), { timeout: 5000 })

    const first = runtime.cancelRun(run.id)
    const second = runtime.cancelRun(run.id) // pressed twice
    await Promise.all([first, second])

    expect(store.requireRun(run.id).state).toBe('cancelled')
    expect(alive(writerPids(events)[0]!)).toBe(false)
    expect(events.filter((event) => event.type === 'run.cancelled')).toHaveLength(1)
    expect(events.some((event) => event.type === 'run.failed')).toBe(false)
    // A third Stop, after it is over, changes nothing.
    await expect(runtime.cancelRun(run.id)).resolves.toMatchObject({ state: 'cancelled' })
    expect(events.filter((event) => event.type === 'run.cancelled')).toHaveLength(1)
  }, 20_000)

  it('leaves a turn that finishes on its own completely alone', async () => {
    const { projectId, conversationId } = session()
    const run = await runtime.sendMessage({ projectId, conversationId, content: 'hello' })
    await vi.waitFor(() => expect(store.requireRun(run.id).state).toBe('completed'), { timeout: 5000 })
    await expect(runtime.cancelRun(run.id)).resolves.toMatchObject({ state: 'completed' })
    expect(events.some((event) => event.type === 'run.cancelled')).toBe(false)
  })
})

describe('stale output after a run has ended', () => {
  it('is kept for diagnostics but reaches no transcript and no listener', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-stale-'))
    const db = new OrbitDatabase({ dataDir: dir })
    await db.init()
    const store = new OrbitStore(db)
    let emitLate: ((event: RuntimeEvent) => void) | null = null
    const fake = {
      getStatus: async () => ({ id: 'antigravity' as const, state: 'ready' as const, sdkAvailable: true, authConfigured: true, message: null, details: {} }),
      listModels: async () => [],
      cancelRun: async () => undefined,
      respondToInteraction: async () => undefined,
      releaseConversation: async () => undefined,
      shutdown: async () => undefined,
      async sendMessage(input: ProviderSendInput, onEvent: (event: RuntimeEvent) => void) {
        const base = { projectId: input.projectId, conversationId: input.conversationId, runId: input.runId, providerId: 'antigravity' as const, createdAt: new Date().toISOString() }
        onEvent({ ...base, type: 'run.cancelled' })
        emitLate = (event) => onEvent({ ...base, ...event } as RuntimeEvent)
      }
    }
    const runtime = new OrbitRuntime(store, new ArtifactService(store, new FileStorage(dir)), fake, dir, '0.1.0')
    const heard: RuntimeEvent[] = []
    runtime.on('event', (event: RuntimeEvent) => heard.push(event))
    const conversation = runtime.createConversation(null)
    const run = await runtime.sendMessage({ conversationId: conversation.id, content: 'go' })
    await vi.waitFor(() => expect(store.requireRun(run.id).state).toBe('cancelled'))

    emitLate!({ type: 'text.delta', delta: 'a stale tail' } as RuntimeEvent)
    emitLate!({ type: 'tool.activity', label: 'Running late', status: 'running' } as RuntimeEvent)

    expect(heard.map((event) => event.type)).toEqual(['run.cancelled'])
    expect(runtime.openUnsorted().messages.map((message) => message.content)).not.toContain('a stale tail')
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

/** A transport over a real OS process, with the session's screen-driven
 *  state machine driven by the test. */
class RealProcessTransport implements IAntigravityPtyTransport {
  isRunning = true
  mediaAttachedCount = 0
  handlers: AntigravityPtyHandlers | null = null
  readonly child: ChildProcess
  private readonly lines: string[] = []
  private readonly exitedPromise: Promise<void>
  constructor() {
    this.child = spawn(process.execPath, [FAKE_AGY, '--control'], { stdio: ['pipe', 'pipe', 'ignore'] })
    this.child.stdout!.on('data', (chunk: Buffer) => this.lines.push(...chunk.toString().trim().split('\n')))
    this.exitedPromise = new Promise((resolve) =>
      this.child.once('exit', (code) => {
        this.isRunning = false
        resolve()
        this.handlers?.onExit(code ?? 0)
      })
    )
  }
  get pid(): number | undefined {
    return this.child.pid
  }
  start(handlers: AntigravityPtyHandlers): void {
    this.handlers = handlers
  }
  sendPrompt(): void {
    this.handlers?.onBusy()
  }
  respond(_pending: PtyInteraction, _optionId: string): boolean {
    return false
  }
  pasteClipboardImage(): void {}
  cancelTurn(): void {}
  kill(signal?: string): void {
    this.child.kill((signal as NodeJS.Signals) ?? 'SIGHUP')
  }
  whenExited(): Promise<void> {
    return this.exitedPromise
  }
  resize(): void {}
  async command(line: string, reply: string): Promise<number> {
    this.child.stdin!.write(`${line}\n`)
    let found: string | undefined
    await vi.waitFor(() => {
      found = this.lines.find((candidate) => candidate.startsWith(reply))
      expect(found).toBeDefined()
    })
    this.lines.splice(this.lines.indexOf(found!), 1)
    return Number(found!.split(' ')[1])
  }
}

describe.runIf(isPosix)('Stop on the PTY transport, against a real process tree', () => {
  let workspace = ''
  let transport: RealProcessTransport | null = null
  const cleanup: number[] = []

  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-pty-stop-')))
  })
  afterEach(async () => {
    for (const pid of cleanup.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* gone */
      }
    }
    transport?.kill('SIGKILL')
    await transport?.whenExited()
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  function input(runId: string, prompt: string): ProviderSendInput {
    return {
      projectId: null,
      conversationId: 'conversation_pty',
      runId,
      prompt,
      nativeConversationId: null,
      workspacePath: workspace,
      saveDir: workspace,
      attachments: [],
      referencedArtifacts: [],
      transport: 'pty',
      model: ORBIT_DEFAULT_MODEL_ID,
      permissionMode: 'ask',
      reasoningEffort: null
    }
  }

  it('kills what the stopped turn started, keeps agy and what was already running, then reports cancelled', async () => {
    const session = new AntigravityPtySession(
      {
        executable: 'agy',
        createTransport: () => (transport = new RealProcessTransport()),
        findConversationId: () => null
      },
      'conversation_pty'
    )
    const events: RuntimeEvent[] = []
    session.send(input('run_a', 'turn A'), (event) => events.push(event))
    // A helper agy keeps across turns (like an MCP server), started before
    // the turn: it must survive the Stop.
    const helper = await transport!.command('helper', 'helper')
    cleanup.push(helper)
    transport!.handlers!.onReadyForInput() // bootstrap → the prompt is delivered; baseline taken
    await sleep(300)

    // During the turn, agy starts a command that would write after 2 s.
    const lateFile = path.join(workspace, 'late.png')
    const writer = await transport!.command(`writer ${lateFile} 2000`, 'writer')
    cleanup.push(writer)

    const stopped = session.cancel()
    session.cancel() // a second press joins the first
    transport!.handlers!.onReadyForInput() // agy acknowledges the Escape
    expect(events.some((event) => event.type === 'run.cancelled'), 'not reported until the tree is dealt with').toBe(false)
    await stopped

    expect(events.filter((event) => event.type === 'run.cancelled')).toHaveLength(1)
    expect(alive(writer), 'the turn’s command must be gone').toBe(false)
    expect(alive(helper), 'what was running before the turn is not the turn’s').toBe(true)
    expect(alive(transport!.pid!), 'agy itself stays: it is the live session').toBe(true)
    expect(session.isBusy).toBe(false)

    // The next turn runs past the writer's delay; nothing appears.
    session.send(input('run_b', 'turn B'), (event) => events.push(event))
    await sleep(2600)
    expect(fs.existsSync(lateFile)).toBe(false)
  }, 20_000)
})

describe('a turn interrupted by Orbit itself closing', () => {
  function world() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-interrupted-'))
    const db = new OrbitDatabase({ dataDir: dir })
    const provider = {
      getStatus: async () => ({ id: 'antigravity' as const, state: 'ready' as const, sdkAvailable: true, authConfigured: true, message: null, details: {} }),
      listModels: async () => [],
      cancelRun: async () => undefined,
      respondToInteraction: async () => undefined,
      releaseConversation: async () => undefined,
      shutdown: vi.fn(async () => undefined),
      // Starts, and never ends on its own.
      async sendMessage(input: ProviderSendInput, onEvent: (event: RuntimeEvent) => void) {
        onEvent({ type: 'run.started', projectId: input.projectId, conversationId: input.conversationId, runId: input.runId, providerId: 'antigravity', createdAt: new Date().toISOString() })
      }
    }
    return { dir, db, provider }
  }

  it('quitting stops the execution and gives the running turn its ending', async () => {
    const { dir, db, provider } = world()
    await db.init()
    const store = new OrbitStore(db)
    const runtime = new OrbitRuntime(store, new ArtifactService(store, new FileStorage(dir)), provider, dir, '0.1.0')
    const conversation = runtime.createConversation(null)
    const run = await runtime.sendMessage({ conversationId: conversation.id, content: 'long task' })

    await runtime.shutdown()

    expect(provider.shutdown).toHaveBeenCalled()
    expect(store.requireRun(run.id).state).toBe('cancelled')
    expect(store.requireConversation(conversation.id).status).toBe('idle')
    expect(runtime.openUnsorted().messages.filter((message) => message.runId === run.id).map((message) => message.status)).toEqual(['cancelled'])
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('a turn left unfinished by a crash is settled at the next launch, honestly, and only that turn', async () => {
    const { dir, db, provider } = world()
    await db.init()
    let store = new OrbitStore(db)
    const conversation = store.createConversation(null, 'Crashed')
    const finished = store.createRun({ projectId: null, conversationId: conversation.id })
    store.updateRunState(finished.id, 'completed')
    const orphaned = store.createRun({ projectId: null, conversationId: conversation.id })
    db.close() // the process dies here, with the run still 'running'

    const reopened = new OrbitDatabase({ dataDir: dir })
    await reopened.init()
    store = new OrbitStore(reopened)
    const runtime = new OrbitRuntime(store, new ArtifactService(store, new FileStorage(dir)), provider, dir, '0.1.0')

    expect(runtime.recoverInterruptedRuns()).toBe(1)
    expect(store.requireRun(orphaned.id)).toMatchObject({ state: 'failed', error: { code: 'app.interrupted' } })
    expect(store.requireRun(finished.id).state).toBe('completed')
    expect(store.requireConversation(conversation.id).status).not.toBe('running')
    expect(runtime.recoverInterruptedRuns()).toBe(0)
    reopened.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
