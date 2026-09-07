// Native Antigravity provider, adapted from AgentDock Pro's production
// `agy --print --output-format stream-json` transport. Authentication stays
// in the installed Antigravity CLI; Orbit never handles API keys or tokens.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { ID, ModelOption, ProviderStatus } from '@shared/domain'
import type { RuntimeEvent } from '@shared/runtime-events'
import type { AgentProvider, ProviderSendInput, RespondToInteractionInput } from '@main/runtime/provider'
import { nowIso } from '@main/util/ids'
import { AntigravityPtySession, type PtySessionDeps } from './AntigravityPtySession'
import { checkClipboardCapability } from './clipboardCapability'
import { fetchModels, normalizeModels, resolveInvocation } from './modelCatalog'

type AgyEvent = {
  event: 'init' | 'step_update' | 'result'
  conversation_id?: string
  step_update?: { step_index?: number; state?: string; step_type?: string; text_delta?: string; tool_name?: string; tool_info?: { parameters?: Record<string, unknown>; error?: { message?: string } } }
  result?: { conversation_id?: string; status?: string; response?: string; error?: string; usage?: Record<string, unknown>; denied_actions?: Array<{ action?: string; display_name?: string }> }
}
interface ActiveRun {
  child: ChildProcessWithoutNullStreams; input: ProviderSendInput; onEvent: (event: RuntimeEvent) => void
  text: string; nativeConversationId: string | null; cancelled: boolean; settled: boolean; stderr: string[]; headlessDenials: string[]
}

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
    private readonly fetchModelCatalog: (executable: string) => Promise<ModelOption[]> = fetchModels
  ) {}

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
        session = this.createPtySession({ executable, invocationArgs: (send) => this.invocationArgs(send) }, input.conversationId)
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
    const child = spawn(executable, args, { cwd: input.workspacePath, stdio: 'pipe', shell: false })
    const active: ActiveRun = { child, input, onEvent, text: '', nativeConversationId: input.nativeConversationId, cancelled: false, settled: false, stderr: [], headlessDenials: [] }
    this.activeRuns.set(input.runId, active)
    createInterface({ input: child.stdout }).on('line', (line) => this.handleLine(active, line))
    child.stderr.on('data', (chunk: Buffer) => { active.stderr.push(chunk.toString('utf8').trim()); if (active.stderr.length > 10) active.stderr.shift() })
    child.on('error', (error) => this.fail(active, 'provider.start_failed', `Antigravity failed to start: ${error.message}`))
    child.on('exit', (code, signal) => {
      if (active.settled) return
      if (active.cancelled) return this.cancelled(active)
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
    return args
  }

  async cancelRun(runId: string): Promise<void> {
    const active = this.activeRuns.get(runId)
    if (active && !active.settled) {
      active.cancelled = true
      active.child.kill('SIGTERM')
      setTimeout(() => { if (!active.settled) this.cancelled(active) }, 250)
      return
    }
    const session = [...this.ptySessions.values()].find((candidate) => candidate.currentRun === runId)
    session?.cancel()
  }

  async respondToInteraction(input: RespondToInteractionInput): Promise<void> {
    const session = this.ptySessions.get(input.conversationId)
    if (!session) throw codedError('interaction.not_pending', 'This conversation has no active interactive session.')
    await session.respondToInteraction(input.runId, input.interactionId, input.optionId)
  }

  async releaseConversation(conversationId: ID): Promise<void> {
    const session = this.ptySessions.get(conversationId)
    if (!session) return
    session.shutdown()
    this.ptySessions.delete(conversationId)
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.activeRuns.keys()].map((runId) => this.cancelRun(runId)))
    for (const session of this.ptySessions.values()) session.shutdown()
    this.ptySessions.clear()
  }

  private handleLine(active: ActiveRun, line: string): void {
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
        const label = step.tool_name ?? 'Antigravity tool'
        this.emit(active, { type: 'tool.activity', label, status, providerStepId: String(step.step_index ?? '') })
        this.discoverArtifact(active, label, step.tool_info?.parameters)
      }
      // agy 1.1.27 represents headless ask_question/ask_permission as an
      // opaque unknown step, then completes after skipping it. Record the
      // evidence; do not falsely report that terminal SUCCESS as success.
      if (step.step_type === 'unknown') active.headlessDenials.push('Antigravity requested an interaction that headless mode could not present.')
      const toolError = (step as { tool_info?: { error?: { message?: unknown } } }).tool_info?.error?.message
      if (typeof toolError === 'string' && /denied|permission/i.test(toolError)) active.headlessDenials.push(toolError)
    } else if (raw.event === 'result' && raw.result) {
      const result = raw.result
      active.nativeConversationId = result.conversation_id ?? active.nativeConversationId
      const deniedActions = result.denied_actions?.map((action) => action.display_name ?? action.action ?? 'Antigravity action') ?? []
      if (deniedActions.length) active.headlessDenials.push(`Antigravity denied: ${deniedActions.join(', ')}.`)
      if (active.headlessDenials.length > 0) {
        const prompt = unique(active.headlessDenials).join('\n')
        const interactionId = `${active.input.runId}:headless-denial`
        this.emit(active, { type: 'interaction.required', interactionId, kind: 'permission', prompt, options: [], transport: 'structured-followup', canRespond: false, sourceEvidence: 'headless-denial' })
        this.fail(active, 'provider.interaction_denied', prompt)
      } else if (result.status === 'SUCCESS') {
        const finalText = result.response ?? active.text
        if (result.response && !active.text) this.emit(active, { type: 'text.delta', delta: result.response })
        this.complete(active, finalText, result.usage)
      } else this.fail(active, 'provider.failed', result.error ?? 'Antigravity reported an error.')
    }
  }
  private discoverArtifact(active: ActiveRun, tool: string, parameters: Record<string, unknown> | undefined): void {
    if (!/(write|create|edit|save)/i.test(tool) || !parameters) return
    const candidate = [parameters.path, parameters.file_path, parameters.filename].find((value): value is string => typeof value === 'string')
    if (!candidate) return
    const sourcePath = resolve(active.input.workspacePath, candidate)
    const workspace = `${resolve(active.input.workspacePath)}/`
    if (sourcePath.startsWith(workspace) && existsSync(sourcePath)) this.emit(active, { type: 'artifact.discovered', sourcePath, metadata: { tool } })
  }
  private complete(active: ActiveRun, finalText: string, usage?: Record<string, unknown>): void {
    if (active.settled) return
    active.settled = true
    this.emit(active, { type: 'run.completed', finalText, nativeConversationId: active.nativeConversationId, ...(usage ? { usage } : {}) })
    this.activeRuns.delete(active.input.runId)
  }
  private fail(active: ActiveRun, code: string, message: string): void {
    if (active.settled) return
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
