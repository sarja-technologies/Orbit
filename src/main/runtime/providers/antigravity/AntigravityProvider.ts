// Native Antigravity provider, adapted from AgentDock Pro's production
// `agy --print --output-format stream-json` transport. Authentication stays
// in the installed Antigravity CLI; Orbit never handles API keys or tokens.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { ID, ModelOption, ProviderStatus } from '@shared/domain'
import type { RuntimeEvent } from '@shared/runtime-events'
import type { AgentProvider, GeneratedOutput, GeneratedOutputQuery, ProviderSendInput, RespondToInteractionInput } from '@main/runtime/provider'
import { nowIso } from '@main/util/ids'
import { AntigravityPtySession, type PtySessionDeps } from './AntigravityPtySession'
import { checkClipboardCapability } from './clipboardCapability'
import { fetchModels, normalizeModels, resolveInvocation } from './modelCatalog'
import { describeToolActivity } from './toolActivity'
import { defaultBrainRoot, findGeneratedOutputs } from './generatedOutputs'
import { permissionArgs } from '@shared/permissionMode'
import { terminateExecution, type TerminateOptions, type TerminationReport } from '@main/process/processTree'

type AgyEvent = {
  event: 'init' | 'step_update' | 'result'
  conversation_id?: string
  step_update?: { step_index?: number; state?: string; step_type?: string; text_delta?: string; tool_name?: string; tool_info?: { parameters?: Record<string, unknown>; error?: { message?: string } } }
  result?: { conversation_id?: string; status?: string; response?: string; error?: string; usage?: Record<string, unknown>; denied_actions?: Array<{ action?: string; display_name?: string }> }
}
interface ActiveRun {
  child: ChildProcessWithoutNullStreams; input: ProviderSendInput; onEvent: (event: RuntimeEvent) => void
  text: string; nativeConversationId: string | null; cancelled: boolean; settled: boolean; stderr: string[]; headlessDenials: string[]
  /** The one in-flight Stop for this run. A second Stop joins it. */
  stopping: Promise<void> | null
  /** Resolves when the agy process has really exited. */
  exited: Promise<void>
}

/** Terminates an execution's process tree. Overridable for tests. */
export type TerminateExecution = (options: TerminateOptions) => Promise<TerminationReport>

/** How long a stopped agy is given to exit after its tree was terminated,
 *  before the run is reported cancelled anyway. The tree termination has
 *  already force-killed it by then; this only bounds a wedged exit event. */
const STOP_EXIT_TIMEOUT_MS = 3000
/** How long quitting waits for live PTY sessions' process trees to be torn
 *  down. Bounded so quitting is never held hostage by a wedged process. */
const SHUTDOWN_WAIT_MS = 8000

export class AntigravityProvider implements AgentProvider {
  private readonly activeRuns = new Map<string, ActiveRun>()
  /** PTY-owned conversations get exactly one persistent session each —
   *  the single point of transport ownership guaranteeing two PTY
   *  transports never simultaneously own the same conversation. */
  private readonly ptySessions = new Map<ID, AntigravityPtySession>()
  private executable: string | null | undefined
  /** The raw (un-normalized) `agy models` catalogue. resolveInvocation needs
   *  the raw combined ids to tell a real id from a normalized base id, so
   *  this is cached rather than the normalized view. */
  private rawModels: ModelOption[] = []
  private modelsLoaded = false

  /** `createPtySession` is overridable for tests — defaults to a real
   *  AntigravityPtySession per conversation. */
  constructor(
    private readonly createPtySession: (deps: PtySessionDeps, conversationId: ID) => AntigravityPtySession = (deps, conversationId) =>
      new AntigravityPtySession(deps, conversationId),
    /** Overridable for tests — the default spawns the real `agy models`,
     *  which unit tests must not do. */
    private readonly fetchModelCatalog: (executable: string) => Promise<ModelOption[]> = fetchModels,
    /** agy's per-conversation output folder root. Overridable for tests. */
    private readonly brainRoot: () => string = defaultBrainRoot,
    /** Process-tree termination. Overridable for tests. */
    private readonly terminate: TerminateExecution = terminateExecution
  ) {}

  /** Images agy's `generate_image` tool saved into its own conversation
   *  folder during a turn — see generatedOutputs.ts for the live evidence
   *  and why the workspace never sees them. */
  findGeneratedOutputs(query: GeneratedOutputQuery): GeneratedOutput[] {
    try {
      return findGeneratedOutputs(query, this.brainRoot())
    } catch {
      return []
    }
  }

  async getStatus(): Promise<ProviderStatus> {
    const executable = await this.resolveExecutable()
    if (!executable) return { id: 'antigravity', state: 'unavailable', sdkAvailable: false, authConfigured: false, message: 'Antigravity is not installed. Install and sign in to the agy CLI, then restart Orbit.', details: {} }
    try {
      await probe(executable, ['--version'])
      // `nativeMedia` lets the composer explain up front that an image will
      // be shared as a workspace reference on this machine, instead of the
      // user discovering it only after a failed attach.
      const clipboard = checkClipboardCapability()
      return {
        id: 'antigravity',
        state: 'ready',
        sdkAvailable: true,
        authConfigured: true,
        message: 'Antigravity · Ready',
        details: { executable, nativeMedia: clipboard.available, nativeMediaReason: clipboard.reason }
      }
    } catch (error) {
      return { id: 'antigravity', state: 'failed', sdkAvailable: false, authConfigured: false, message: `Antigravity failed to start: ${messageOf(error)}`, details: { executable } }
    }
  }

  /** Normalized catalogue for the UI: one entry per base model carrying
   *  exactly the reasoning tiers Antigravity genuinely lists for it. */
  async listModels(): Promise<ModelOption[]> {
    await this.loadModels()
    return normalizeModels(this.rawModels)
  }

  private async loadModels(): Promise<void> {
    if (this.modelsLoaded) return
    const executable = await this.resolveExecutable()
    if (!executable) return
    this.rawModels = await this.fetchModelCatalog(executable)
    // Only latch once a real catalogue was read, so a transient failure is
    // retried rather than caching an empty list forever.
    if (this.rawModels.length > 0) this.modelsLoaded = true
  }

  async sendMessage(input: ProviderSendInput, onEvent: (event: RuntimeEvent) => void): Promise<void> {
    const executable = await this.resolveExecutable()
    if (!executable) throw codedError('provider.not_installed', 'Antigravity is not installed. Install and sign in to the agy CLI.')
    mkdirSync(input.workspacePath, { recursive: true })
    // Resolve the model/effort choice against the real catalogue before
    // either transport spawns, so both launch paths agree.
    await this.loadModels()
    if (input.transport === 'pty') {
      let session = this.ptySessions.get(input.conversationId)
      if (!session) {
        session = this.createPtySession({ executable, invocationArgs: (send) => this.invocationArgs(send), terminate: this.terminate }, input.conversationId)
        this.ptySessions.set(input.conversationId, session)
      }
      session.send(input, onEvent)
      return
    }
    const args = ['--print', input.prompt, '--output-format', 'stream-json', '--add-dir', input.workspacePath, ...this.invocationArgs(input)]
    // `--conversation` is the real Antigravity session-resume mechanism.
    if (input.nativeConversationId) args.push('--conversation', input.nativeConversationId)
    // Attachments are scoped additional roots, never arbitrary filesystem access.
    for (const dir of unique(input.attachments.map((file) => dirname(file.storedPath)))) args.push('--add-dir', dir)
    // A process group of its own on POSIX, so Stop can address this
    // execution as a unit without ever touching Orbit's own group. (Not on
    // Windows, where `detached` means a new console window; the tree is
    // terminated through `taskkill /T` there instead.)
    const child = spawn(executable, args, { cwd: input.workspacePath, stdio: 'pipe', shell: false, detached: process.platform !== 'win32' })
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    const active: ActiveRun = { child, input, onEvent, text: '', nativeConversationId: input.nativeConversationId, cancelled: false, settled: false, stderr: [], headlessDenials: [], stopping: null, exited }
    this.activeRuns.set(input.runId, active)
    createInterface({ input: child.stdout }).on('line', (line) => this.handleLine(active, line))
    child.stderr.on('data', (chunk: Buffer) => { if (active.cancelled) return; active.stderr.push(chunk.toString('utf8').trim()); if (active.stderr.length > 10) active.stderr.shift() })
    child.on('error', (error) => this.fail(active, 'provider.start_failed', `Antigravity failed to start: ${error.message}`))
    child.on('exit', (code, signal) => {
      if (active.settled) return
      // A stopped run is settled by its Stop, once the whole tree is gone —
      // not by agy exiting, which happens before its commands are dealt with.
      if (active.cancelled) return
      this.fail(active, 'provider.exited', `Antigravity exited before returning a result (${code ?? signal ?? 'unknown'}). ${active.stderr.join(' ').trim()}`.trim())
    })
  }

  /** Real `--model`/`--effort` flags for this turn, or none. Never emits a
   *  combination agy would reject, and never guesses a tier — see
   *  modelCatalog.resolveInvocation. */
  private invocationArgs(input: ProviderSendInput): string[] {
    const invocation = resolveInvocation(input.model, input.reasoningEffort, this.rawModels)
    const args: string[] = []
    if (invocation.model) args.push('--model', invocation.model)
    if (invocation.effort) args.push('--effort', invocation.effort)
    // Permission handling is a launch flag like the others, so it lands
    // here and both transports inherit it — there is no second place a
    // session's permission state could be applied differently.
    args.push(...permissionArgs(input.permissionMode))
    return args
  }

  /** Stops a run and everything it started.
   *
   *  Resolves only once the execution is really over: agy and every process
   *  its tools launched have been terminated (politely, then forcibly), and
   *  `run.cancelled` has been emitted. Idempotent — a second Stop, or agy
   *  exiting on its own meanwhile, joins the one already under way. */
  async cancelRun(runId: string): Promise<void> {
    const active = this.activeRuns.get(runId)
    if (active && !active.settled) {
      active.cancelled = true
      active.stopping ??= this.stopStructuredRun(active)
      return active.stopping
    }
    // A PTY Stop returns once Escape is delivered. agy acknowledges it on its
    // own schedule; the run stays 'cancelling' — busy, and shown as stopping
    // — and `run.cancelled` is emitted only after the turn's processes are
    // gone (see AntigravityPtySession.finishCancelledTurn).
    const session = [...this.ptySessions.values()].find((candidate) => candidate.currentRun === runId)
    void session?.cancel()
  }

  private async stopStructuredRun(active: ActiveRun): Promise<void> {
    const pid = active.child.pid
    if (pid !== undefined && active.child.exitCode === null && active.child.signalCode === null) {
      // agy's commands run in process groups of their own, which outlive agy
      // (captured live) — so the whole tree is terminated, not just agy.
      const report = await this.terminate({ rootPid: pid, includeRoot: true }).catch(() => null)
      if (report && report.targeted > 0) {
        console.info(`[antigravity] Stop terminated ${report.targeted} process(es) for run ${active.input.runId}${report.survivors.length ? `; ${report.survivors.length} survived` : ''}.`)
      }
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    await Promise.race([active.exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, STOP_EXIT_TIMEOUT_MS) })])
    if (timer) clearTimeout(timer)
    this.cancelled(active)
  }

  async respondToInteraction(input: RespondToInteractionInput): Promise<void> {
    const session = this.ptySessions.get(input.conversationId)
    if (!session) throw codedError('interaction.not_pending', 'This conversation has no active interactive session.')
    await session.respondToInteraction(input.runId, input.interactionId, input.optionId)
  }

  async releaseConversation(conversationId: ID): Promise<void> {
    const session = this.ptySessions.get(conversationId)
    if (!session) return
    // Kept rather than dropped when it still owns a live process: a fresh
    // session for this conversation would know nothing about that process
    // and would happily become its second owner. A released session refuses
    // to spawn either way, so the retained one is inert — it exists purely
    // to hold ownership until the process is genuinely gone, and is dropped
    // then.
    if (await session.release()) {
      this.ptySessions.delete(conversationId)
      return
    }
    void session.whenOwnershipReleased().then(() => {
      if (this.ptySessions.get(conversationId) === session) this.ptySessions.delete(conversationId)
    })
  }

  async shutdown(): Promise<void> {
    const sessions = [...this.ptySessions.values()]
    this.ptySessions.clear()
    for (const session of sessions) session.shutdown()
    let timer: ReturnType<typeof setTimeout> | null = null
    await Promise.all([
      ...[...this.activeRuns.keys()].map((runId) => this.cancelRun(runId)),
      // Each session's retirement terminates its agy and everything under it.
      Promise.race([Promise.all(sessions.map((session) => session.whenProcessTreeRetired())), new Promise<void>((resolve) => { timer = setTimeout(resolve, SHUTDOWN_WAIT_MS) })])
    ])
    if (timer) clearTimeout(timer)
  }

  private handleLine(active: ActiveRun, line: string): void {
    // A stopped run's late output — including the `result` agy writes while
    // it is torn down — is not this run's answer and reaches nobody.
    if (active.cancelled || active.settled) return
    let raw: AgyEvent
    try { raw = JSON.parse(line) as AgyEvent } catch { return }
    if (raw.event === 'init') {
      active.nativeConversationId = raw.conversation_id ?? active.nativeConversationId
      this.emit(active, { type: 'run.started', nativeConversationId: active.nativeConversationId })
    } else if (raw.event === 'step_update' && raw.step_update) {
      const step = raw.step_update
      if (step.step_type === 'agent_response' && step.text_delta) { active.text += step.text_delta; this.emit(active, { type: 'text.delta', delta: step.text_delta }) }
      if (step.step_type === 'tool') {
        const status = step.state === 'ACTIVE' ? 'running' : step.state === 'ERROR' ? 'failed' : 'completed'
        // The real command line / path / query agy reported, not just the
        // tool's name — this is the whole difference between "Antigravity
        // is working" and "Running npm run build".
        const described = describeToolActivity(step.tool_name, step.tool_info?.parameters, active.input.workspacePath)
        this.emit(active, {
          type: 'tool.activity',
          label: described.label,
          status,
          kind: described.kind,
          ...(described.detail ? { detail: described.detail } : {}),
          providerStepId: String(step.step_index ?? '')
        })
      }
      // agy 1.1.27 represents headless ask_question/ask_permission as an
      // opaque unknown step, then completes after skipping it. That is agy's
      // own structural marker, so it still counts as evidence — but only
      // when agy could actually have been asking. Under
      // --dangerously-skip-permissions its own init reports
      // permission_mode=always-proceed (verified live), so it never asks,
      // and anything opaque there is something else entirely.
      //
      // Deliberately NOT recorded any more: a tool error whose text happens
      // to contain "permission" or "denied". That matched arbitrary prose —
      // `ls: cannot open directory '/root': Permission denied`, a git
      // publickey failure, a linter message — and turned every one of them
      // into "Antigravity needed permission it could not ask for", on a
      // turn where nothing had been asked and the tools had run fine. A
      // failing tool is a failing tool; the model reports it in its own
      // answer, and the activity rail already shows the step failing.
      if (step.step_type === 'unknown' && active.input.permissionMode !== 'skip') {
        active.headlessDenials.push('Antigravity requested an interaction that headless mode could not present.')
      }
    } else if (raw.event === 'result' && raw.result) {
      const result = raw.result
      active.nativeConversationId = result.conversation_id ?? active.nativeConversationId
      const deniedActions = result.denied_actions?.map((action) => action.display_name ?? action.action ?? 'Antigravity action') ?? []
      // agy's own report of what it would not do. Structural, so it is
      // trusted in both modes — but it means two different things.
      if (deniedActions.length) active.headlessDenials.push(`Antigravity denied: ${deniedActions.join(', ')}.`)
      if (active.headlessDenials.length > 0) {
        const prompt = unique(active.headlessDenials).join('\n')
        // Under always-proceed there is no approval to present and none was
        // withheld for want of one, so this cannot be "a permission Orbit
        // could not ask for". Whatever agy refused, it refused on its own
        // terms — a restriction no approval would have lifted. It gets its
        // own code so the UI can say that instead of blaming a missing
        // prompt (see errorCopy.ts).
        const bypassed = active.input.permissionMode === 'skip'
        const interactionId = `${active.input.runId}:headless-denial`
        if (!bypassed) {
          this.emit(active, { type: 'interaction.required', interactionId, kind: 'permission', prompt, options: [], transport: 'structured-followup', canRespond: false, sourceEvidence: 'headless-denial' })
        }
        this.fail(active, bypassed ? 'provider.action_restricted' : 'provider.interaction_denied', prompt)
      } else if (result.status === 'SUCCESS') {
        const finalText = result.response ?? active.text
        // Verified against every captured agy 1.1.27 turn: the concatenated
        // `agent_response` deltas are exactly `result.response`, and the
        // last of them (state DONE) carries whatever agy had not flushed
        // yet — typically most of a long answer. So the final response is
        // streamed only for the part the deltas have not already
        // delivered: the whole thing when nothing streamed (the
        // final-response-only fallback, deliberately kept), the tail when
        // it continues what streamed, and nothing at all when it merely
        // repeats it. A response that diverges from what streamed is left
        // to `finalText`, which is authoritative, rather than appended as
        // a contradictory second copy.
        if (result.response) {
          const remainder = result.response.startsWith(active.text) ? result.response.slice(active.text.length) : ''
          if (remainder) {
            active.text += remainder
            this.emit(active, { type: 'text.delta', delta: remainder })
          }
        }
        this.complete(active, finalText, result.usage)
      } else this.fail(active, 'provider.failed', result.error ?? 'Antigravity reported an error.')
    }
  }
  // Artifact discovery does not live in the stream handler. agy's tool
  // events carry no output path (`generate_image` reports only ImageName and
  // Prompt, captured live on 1.2.2), a file written by `run_command` never
  // appears as a write at all, and a PTY turn has no tool stream. Outputs
  // are established from the filesystem when the turn ends instead: the
  // runtime diffs the workspace, and `findGeneratedOutputs` above reads
  // agy's own conversation folder. See main/artifacts/outputScan.ts.
  private complete(active: ActiveRun, finalText: string, usage?: Record<string, unknown>): void {
    if (active.settled) return
    active.settled = true
    this.emit(active, { type: 'run.completed', finalText, nativeConversationId: active.nativeConversationId, ...(usage ? { usage } : {}) })
    this.activeRuns.delete(active.input.runId)
  }
  /** CRITICAL (real bug): once the user has pressed Stop, this run has
   *  exactly one honest outcome — cancelled. SIGTERM makes agy tear its
   *  turn down, and what it writes on the way out is a losing race against
   *  the exit handler: a `result` line with a non-SUCCESS status, or a
   *  broken pipe. Both used to arrive here first and end the turn as
   *  `provider.failed`, which the UI renders as "Antigravity's response
   *  couldn't be read" — a crash report for something the user asked for.
   *  A user-requested cancellation is a lifecycle state, so every failure
   *  path after a cancellation is redirected to it rather than each caller
   *  having to remember to check. */
  private fail(active: ActiveRun, code: string, message: string): void {
    if (active.settled) return
    // A stopped run is settled by stopStructuredRun once its tree is gone.
    if (active.cancelled) return
    active.settled = true; this.emit(active, { type: 'run.failed', error: { code, message, retryable: false } }); this.activeRuns.delete(active.input.runId)
  }
  private cancelled(active: ActiveRun): void {
    if (active.settled) return
    active.settled = true; this.emit(active, { type: 'run.cancelled' }); this.activeRuns.delete(active.input.runId)
  }
  // RuntimeEvent is a discriminated union; a distributive Omit would be
  // unnecessarily awkward here because this is the single normalization
  // point for all provider event variants.
  private emit(active: ActiveRun, event: Record<string, unknown>): void {
    active.onEvent({ ...event, projectId: active.input.projectId, conversationId: active.input.conversationId, runId: active.input.runId, providerId: 'antigravity', createdAt: nowIso() } as RuntimeEvent)
  }
  private async resolveExecutable(): Promise<string | null> {
    if (this.executable !== undefined) return this.executable
    const binary = process.platform === 'win32' ? 'agy.exe' : 'agy'
    const configured = process.env.ORBIT_AGY_PATH
    const candidates = configured ? [configured] : [...(process.env.PATH?.split(delimiter).map((dir) => join(dir, binary)) ?? []), join(process.env.HOME ?? '', '.local', 'bin', binary)]
    this.executable = candidates.find((candidate) => isAbsolute(candidate) && existsSync(candidate)) ?? null
    return this.executable
  }
}
function unique(values: string[]): string[] { return [...new Set(values)] }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function codedError(code: string, message: string): Error { return Object.assign(new Error(message), { code }) }
function probe(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => { const child = spawn(command, args, { shell: false, stdio: 'ignore' }); child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`exit ${code ?? 'unknown'}`))) })
}
