// Owns exactly one live, persistent `agy` PTY process for one Orbit
// conversation — the single point of transport ownership PTY-owned
// conversations get. A conversation transitions through:
//
//   idle -> bootstrapping -> running -> waiting_for_interaction -> running
//        -> ready -> running (next turn) -> ... -> idle (process exited)
//
// 'bootstrapping' covers a freshly spawned, bare (`-i`-less) process before
// its very first prompt has been written — the session may show agy's own
// workspace-trust prompt during this phase, which is surfaced as an
// ordinary 'permission' interaction like any other, never auto-approved.
// 'ready' means the live process is idle between turns; a later send()
// reuses the SAME process (this is what makes a native free-text question
// "just work" — see AntigravityPtyTransport's module comment — and what
// lets a later turn answer a still-open permission/trust prompt).
import { dirname } from 'node:path'
import type { ID, ProjectFile } from '@shared/domain'
import type { RuntimeEvent } from '@shared/runtime-events'
import type { ProviderSendInput } from '@main/runtime/provider'
import { nowIso } from '@main/util/ids'
import { extractResponseText, progressiveAppendIndex, promptHasBeenSubmitted, readScreenActivity, type ScreenActivity } from '@main/terminal/TerminalInteractionDetector'
import { AntigravityPtyTransport, type IAntigravityPtyTransport, type PtyInteraction } from './AntigravityPtyTransport'
import { checkClipboardCapability, type ClipboardCapability } from './clipboardCapability'
import { restoreClipboard, saveCurrentClipboard, writeImageToClipboard, type SavedClipboard } from './nativeClipboardImage'
import { findRecentConversationId } from './nativeConversationHistory'

type SessionState = 'idle' | 'bootstrapping' | 'ready' | 'running' | 'retiring' | 'waiting_for_interaction'

/** A handover in progress: the previous process is being terminated, and
 *  until it is confirmed gone it is still this conversation's owner.
 *
 *  ONE RULE governs every path in this file: a conversation has exactly one
 *  owner at a time, an owner is an active process (`transport`) OR a
 *  retiring one (`retirement.transport`), and ownership is released by
 *  exactly one event — the owner's genuine exit. A new process may spawn
 *  only when there is no owner and the session is still valid for sends. */
interface Retirement {
  /** Still the conversation's owner, alive or dying. */
  readonly transport: IAntigravityPtyTransport
  /** Resolves true if it genuinely exited, false if it never did. */
  readonly done: Promise<boolean>
  /** Set the moment it is known to have survived every escalation. */
  blocked: boolean
}

const MEDIA_PASTE_CONFIRM_TIMEOUT_MS = 8000
const MEDIA_PASTE_POLL_INTERVAL_MS = 200
const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
/** How long a retired process gets to exit after a polite request, and then
 *  again after SIGKILL. A replacement is only ever spawned once the
 *  predecessor is *proven* gone. */
const RETIRE_TIMEOUT_MS = 4_000
const RETIRE_FORCE_TIMEOUT_MS = 2_000
const RETIRE_FAILED_MESSAGE =
  'Orbit could not stop this session\u2019s previous Antigravity process, and will not run a second one against the same conversation. It will recover on its own if that process exits; otherwise close and reopen this session, or restart Orbit.'

/** Orbit application policy, not a proven `agy`/clipboard limit — see
 *  docs/antigravity-transports.md. Reused from AgentDock Pro's identical
 *  application-level cap. */
const MAX_NATIVE_IMAGE_BYTES = 15 * 1024 * 1024
/** How many consecutive frames may fail to line up with what has already
 *  been streamed before the reader gives up on matching and resynchronizes
 *  on the current screen. One or two is an ordinary redraw caught
 *  mid-write, which recovers by itself; a longer run means agy has
 *  rewritten text it had already drawn (it resolves markdown emphasis a
 *  beat after the raw `**` appears), and continuing to wait would freeze
 *  streaming for the rest of the turn. */
const STREAM_RESYNC_AFTER_FRAMES = 3
/** How long a turn may go without agy showing it as submitted before the
 *  "has this turn started?" guard stops blocking. The real race that guard
 *  exists for resolves in about a second; this is far above that and far
 *  below any wait a user would tolerate. It exists purely so a guard can
 *  never strand a turn: without it, a screen that somehow never shows the
 *  submitted prompt would leave the run open forever. */
const TURN_START_GRACE_MS = 10_000

interface PendingInteraction {
  interactionId: string
  ptyInteraction: PtyInteraction
}

interface ImageAttachment {
  storedPath: string
  name: string
}

export interface PtySessionDeps {
  executable: string
  /** Real `--model`/`--effort` args for this conversation's persisted
   *  choice, supplied by the provider so both transports resolve
   *  identically. */
  invocationArgs?: (input: ProviderSendInput) => string[]
  /** Overridable for tests — defaults to spawning a real AntigravityPtyTransport. */
  createTransport?: (executable: string, cwd: string, args: string[]) => IAntigravityPtyTransport
  /** Overridable for tests — defaults to the real findRecentConversationId,
   *  which reads agy's own history file and would otherwise make unit
   *  tests depend on the real machine's home directory. */
  findConversationId?: (workspacePath: string) => string | null
  /** Overridable for tests — defaults to the real checkClipboardCapability,
   *  which would otherwise make unit tests depend on the real machine's
   *  installed clipboard helpers. */
  checkClipboardCapability?: () => ClipboardCapability
  /** Overridable for tests — defaults to the real writeImageToClipboard,
   *  which talks to Electron's real clipboard and always fails under
   *  plain Node/vitest, making the "successfully loaded, awaiting paste
   *  confirmation" path otherwise impossible to exercise in a unit test. */
  writeImageToClipboard?: (imagePath: string) => boolean
}

export class AntigravityPtySession {
  private transport: IAntigravityPtyTransport | null = null
  private state: SessionState = 'idle'
  private resumeStateAfterInteraction: 'bootstrapping' | 'running' = 'running'
  private currentRunId: ID | null = null
  private currentInput: ProviderSendInput | null = null
  private onEvent: ((event: RuntimeEvent) => void) | null = null
  private text = ''
  /** agy's interactive TUI never prints its conversation id anywhere in the
   *  normal chat flow (an earlier `/help`-scrape approach, modeled on
   *  AgentDock Pro's, was tried and reliably hung the whole session live
   *  against agy 1.1.27 — removed, see docs/antigravity-transports.md).
   *  Captured instead, opportunistically and safely, from agy's own local
   *  history file after each turn settles — see
   *  nativeConversationHistory.ts. KNOWN LIMITATION: that file only gains
   *  a conversationId for a workspace from the conversation's SECOND
   *  prompt onward (confirmed live), so a PTY session that dies after
   *  exactly one turn has no id to resume with — the next send() starts a
   *  fresh native conversation instead of resuming. From the second turn
   *  onward, resume across an Orbit restart is expected to work (see
   *  docs/antigravity-transports.md for the live verification). */
  private nativeConversationId: string | null = null
  private pending: PendingInteraction | null = null
  private interactionCounter = 0
  private cancelRequested = false
  /** Runs whose *deferred* work must never happen — see
   *  `awaitingDeferredSpawn`. A run lands here when the user stops it while
   *  it is waiting on a retirement rather than on a process of its own: the
   *  only window in which a run is owed an agy process that does not exist
   *  yet, and so the only window in which `cancelRequested` (which is read
   *  by a live transport's own settle path) has nothing to act on.
   *
   *  Deliberately keyed by run id rather than by session state: the
   *  retirement outcome arrives asynchronously, by which time a later run
   *  may legitimately own the session, and that run must not inherit its
   *  predecessor's cancellation — nor be able to consume it. Entries are
   *  removed as they are consumed at the boundary, which always runs
   *  because a retirement always settles within its bounds. */
  private readonly cancelledDeferredRuns = new Set<ID>()
  private queuedPrompt: string | null = null
  private queuedImages: ImageAttachment[] = []
  private lastScreenLines: string[] = []
  /** Exactly what was written into the PTY for the turn in flight. The
   *  progressive reader anchors on this echo, so it can tell this turn's
   *  answer from the previous turn's, which is still on screen for a
   *  moment after a new prompt is submitted. */
  private deliveredPrompt: string | null = null
  /** The response text already delivered to the renderer as `text.delta`
   *  for the turn in flight. agy's TUI is a full-redraw display, so this
   *  is compared against each new frame rather than assumed to be a
   *  prefix of it — see progressiveAppendIndex. */
  private streamedText = ''
  /** Consecutive sampled frames that did not line up with `streamedText`.
   *  See STREAM_RESYNC_AFTER_FRAMES. */
  private divergedFrames = 0
  /** Activity already reported to the runtime for the turn in flight, keyed
   *  by the screen key that produced it. agy redraws its whole screen many
   *  times a second, so the same work is seen over and over; only a genuine
   *  change is emitted. The insertion order is the order the work appeared
   *  in, which is what lets a step that has left the screen be reported as
   *  finished. */
  private readonly reportedActivity = new Map<string, { status: 'running' | 'completed'; signature: string }>()
  /** The last full description seen for each reported key, so a step that
   *  has scrolled off screen can still be completed with its own details
   *  rather than a placeholder. */
  private readonly lastActivity = new Map<string, ScreenActivity>()
  /** Latched once this turn's own prompt has been seen echoed on screen.
   *  Until then, a ready footer belongs to the screen as it was *before*
   *  the prompt was submitted — see `turnHasStartedOnScreen`. */
  private sawPromptEcho = false
  /** A ready footer was refused because the turn had not started yet. The
   *  transport is edge-triggered and will not report that same footer
   *  again, so the refusal is remembered and settled from the grace timer
   *  if nothing else resolves it. */
  private refusedReady = false
  /** Latched when agy showed its busy footer during this turn. */
  private sawBusy = false
  private turnStartTimer: ReturnType<typeof setTimeout> | null = null
  private graceExpired = false
  /** The handover in progress, if any — see `Retirement`. Non-null means
   *  this conversation still has an owner even though `transport` is null,
   *  which is precisely the window a second send used to slip through. */
  private retirement: Retirement | null = null
  /** Set once the provider has released this conversation. The session may
   *  still be retained (to keep owning a process that would not die), but it
   *  must never spawn again — the conversation it belonged to is gone. */
  private released = false
  /** Checked once per session (the answer can't meaningfully change while
   *  Orbit is running) rather than on every attachment attempt. */
  private clipboardCapability: ClipboardCapability | null = null
  /** True for the whole clipboard-paste sequence in deliverPrompt below.
   *  CRITICAL (real bug, confirmed live): attaching an image via Ctrl+V
   *  does NOT start generation — the screen shows "N media attached" and
   *  immediately returns to the same ready-for-input footer used for a
   *  genuinely completed turn. Without this flag, that footer is
   *  indistinguishable from real completion and settles the run before
   *  the actual text prompt is ever sent. */
  private deliveringImages = false

  constructor(private readonly deps: PtySessionDeps, private readonly conversationId: ID) {}

  get isBusy(): boolean {
    return this.state !== 'idle' && this.state !== 'ready'
  }

  get currentRun(): ID | null {
    return this.currentRunId
  }

  /** The `--model`/`--effort` flags the live transport was launched with, so
   *  a later selection change is detectable. */
  private spawnedInvocation = ''

  send(input: ProviderSendInput, onEvent: (event: RuntimeEvent) => void): void {
    // Checked before everything else: a closed conversation should say so
    // rather than report itself busy with work nobody can see.
    if (this.released) throw codedError('provider.session_released', 'This Antigravity session has been closed.')
    if (this.isBusy) {
      const error = Object.assign(new Error('This conversation already has an Antigravity turn in progress.'), {
        code: 'provider.session_busy'
      })
      throw error
    }
    // A predecessor that refused to die still owns this conversation. Refuse
    // rather than become its second owner; the block lifts by itself the
    // moment that process really exits, so retrying works.
    if (this.retirement?.blocked) throw codedError('provider.retire_failed', RETIRE_FAILED_MESSAGE)
    this.currentRunId = input.runId
    this.currentInput = input
    this.onEvent = onEvent
    this.text = ''
    this.streamedText = ''
    this.deliveredPrompt = null
    this.cancelRequested = false
    this.nativeConversationId = input.nativeConversationId ?? this.nativeConversationId
    const images: ImageAttachment[] = (input.attachments ?? [])
      .filter((file) => {
        if (!isSupportedImage(file)) return false
        if (file.byteSize > MAX_NATIVE_IMAGE_BYTES) {
          console.warn(`[antigravity-pty] "${file.name}" (${file.byteSize} bytes) exceeds Orbit's ${MAX_NATIVE_IMAGE_BYTES}-byte native image policy — skipped.`)
          return false
        }
        return true
      })
      .map((file) => ({ storedPath: file.storedPath, name: file.name }))

    // A live agy process is bound to the model/effort it was launched with,
    // so a selection change has to retire it. The conversation itself is not
    // lost: the replacement resumes with `--conversation`.
    const invocation = (this.deps.invocationArgs?.(input) ?? []).join(' ')
    if (this.transport?.isRunning && this.state === 'ready' && this.spawnedInvocation !== invocation) {
      // CRITICAL: retiring this process is only safe if the conversation can
      // actually be resumed afterwards. agy does not record a conversation
      // id for a workspace until its SECOND prompt (confirmed live — see
      // nativeConversationHistory.ts), so a conversation that has had
      // exactly one turn has none, and the live process is the *only* thing
      // carrying its context. Killing it there would silently start the
      // conversation over under the new model. The selection is kept, and
      // applied on a later turn once there is an id to resume with.
      if (!this.nativeConversationId) {
        // `spawnedInvocation` is deliberately left alone, so the mismatch
        // is re-evaluated — and acted on — on the next turn.
        this.state = 'running'
        this.emit({ type: 'run.started', nativeConversationId: this.nativeConversationId })
        this.emit({
          type: 'run.notice',
          code: 'model.deferred',
          message:
            'Antigravity is still using the model this session started with. A new model can only be applied once this conversation can be resumed, which takes one more turn — it will apply automatically from the next message.'
        })
        void this.deliverPrompt(input.prompt, images)
        return
      }
      const retired = this.transport
      // Detach first: its exit callback must not be read as this session
      // dying, and the screen it leaves behind must not be mistaken for the
      // next turn's answer.
      this.transport = null
      // 'retiring', NOT 'idle'. The predecessor still owns this conversation
      // and a replacement is already promised to this run — an idle session
      // here let a concurrent send see no transport, no retirement and no
      // block, and start a second agy alongside the one still dying.
      this.state = 'retiring'
      this.lastScreenLines = []
      // Two agy processes must never hold the same native conversation at
      // once — the replacement resumes it, and a still-exiting predecessor
      // makes that resume replay into a screen the extractor then reads as
      // the answer. The replacement is spawned only once the old process is
      // proven gone; if it cannot be, the turn fails rather than creating a
      // second owner.
      void this.retireThenSpawn(retired, input, images, invocation)
      return
    }

    if (this.transport?.isRunning && this.state === 'ready') {
      this.state = 'running'
      this.emit({ type: 'run.started', nativeConversationId: this.nativeConversationId })
      void this.deliverPrompt(input.prompt, images)
      return
    }

    const retirement = this.retirement
    if (retirement) {
      // A process this session detached is still being retired (see
      // shutdown). It owns the conversation until it is confirmed gone, so
      // claim the session — making any further send busy — and wait for the
      // outcome rather than spawning alongside it.
      this.state = 'bootstrapping'
      void retirement.done.then((exited) => this.spawnAfterRetirement(exited, input, images, invocation))
      return
    }
    this.spawn(input, images, invocation)
  }

  /** Decides a send that had to wait for a retirement. It may only spawn if
   *  the predecessor genuinely exited *and* this session is still valid —
   *  otherwise it would either become a second owner, or strand a process on
   *  a session the provider has already discarded. */
  private spawnAfterRetirement(exited: boolean, input: ProviderSendInput, images: ImageAttachment[], invocation: string): void {
    // Same rule as retireThenSpawn: a run stopped while it waited here must
    // not spawn, and must not be reported as anything but cancelled. `state`
    // is deliberately left alone on this path — a later run may already own
    // the session, and this boundary belongs to a run that no longer does.
    if (this.deferredRunWasCancelled(input.runId)) return
    if (exited && !this.released) {
      this.spawn(input, images, invocation)
      return
    }
    this.state = 'idle'
    this.emit({
      type: 'run.failed',
      error: exited
        ? { code: 'provider.session_released', message: 'This Antigravity session was closed before the message could be sent.', retryable: false }
        : { code: 'provider.retire_failed', message: RETIRE_FAILED_MESSAGE, retryable: true }
    })
  }

  /** Retires the previous process and only then spawns its replacement.
   *
   *  Waiting is on the transport's real exit acknowledgement, not on a
   *  request-to-terminate: `kill()` returns long before the OS process is
   *  gone. A polite request is given RETIRE_TIMEOUT_MS, then SIGKILL is
   *  given RETIRE_FORCE_TIMEOUT_MS. If the process still has not exited,
   *  Orbit refuses to spawn a second owner of the same native conversation
   *  and fails the turn instead — a failed turn is recoverable, two agy
   *  processes writing into one conversation is not. */
  private async retireThenSpawn(
    retired: IAntigravityPtyTransport,
    input: ProviderSendInput,
    images: ImageAttachment[],
    invocation: string
  ): Promise<void> {
    const exited = await this.beginRetirement(retired)
    // Stop was pressed while the predecessor was still being retired. It was
    // acknowledged then, so this run is already cancelled: the replacement
    // it was promised must never spawn, its prompt must never be delivered,
    // and nothing further may be emitted for it — including the
    // `retire_failed` below, which would otherwise convert a run the user
    // cancelled into a failed one. Checked before the retirement outcome
    // precisely so a blocked retirement cannot do that.
    if (this.deferredRunWasCancelled(input.runId)) return
    if (!exited) {
      this.state = 'idle'
      this.emit({ type: 'run.failed', error: { code: 'provider.retire_failed', message: RETIRE_FAILED_MESSAGE, retryable: true } })
      return
    }
    if (this.released) {
      this.state = 'idle'
      return
    }
    this.spawn(input, images, invocation)
  }

  /** Records a handover and runs it. From this moment the conversation has
   *  an owner again — visible to `send()` — even though `transport` is
   *  already null. That window is exactly where a second agy used to be
   *  able to start. */
  private beginRetirement(retired: IAntigravityPtyTransport): Promise<boolean> {
    let settle!: (exited: boolean) => void
    const record: Retirement = { transport: retired, blocked: false, done: new Promise<boolean>((resolve) => { settle = resolve }) }
    this.retirement = record
    void this.forceRetire(retired, record).then((exited) => {
      // Ownership is released by exactly one event: the real exit.
      if (exited && this.retirement === record) this.retirement = null
      settle(exited)
    })
    return record.done
  }

  /** Terminates a detached process, escalating once, and reports whether it
   *  is genuinely gone.
   *
   *  A process that survives everything keeps its `Retirement` record, so
   *  it keeps owning the conversation. The bounded waits exist so a caller
   *  is never left hanging, not so the session can pretend a live process
   *  stopped existing. */
  private async forceRetire(retired: IAntigravityPtyTransport, record: Retirement): Promise<boolean> {
    retired.kill()
    if (await this.awaitExit(retired, RETIRE_TIMEOUT_MS)) return true
    console.warn('[antigravity-pty] the previous agy process did not exit when asked; escalating to SIGKILL.')
    retired.kill('SIGKILL')
    if (await this.awaitExit(retired, RETIRE_FORCE_TIMEOUT_MS)) return true
    console.warn('[antigravity-pty] the previous agy process survived SIGKILL; this conversation is blocked until it exits.')
    record.blocked = true
    void retired.whenExited().then(() => {
      // The only thing that releases ownership: the predecessor is really
      // gone, so the next send() may spawn normally again.
      if (this.retirement === record) this.retirement = null
    })
    return false
  }

  /** True once the transport reports a real exit; false if the bound passed
   *  first. Races the transport's own exit acknowledgement against a timer
   *  rather than polling a flag that termination alone can flip. */
  private async awaitExit(transport: IAntigravityPtyTransport, timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | null = null
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs)
    })
    try {
      const exited = await Promise.race([transport.whenExited().then(() => true as const), timedOut])
      // `whenExited` resolving is the authority, but a transport that
      // resolves early would still be caught by the live flag.
      return exited === true && !transport.isRunning
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private spawn(input: ProviderSendInput, images: ImageAttachment[], invocation: string): void {
    // Fresh spawn — bare (no `-i`), so images and long/multi-line prompts
    // never hit an argv length limit; the real prompt is written once the
    // process reaches its first ready-for-input transition (bootstrap).
    const args = ['--add-dir', input.workspacePath, ...(this.deps.invocationArgs?.(input) ?? [])]
    this.spawnedInvocation = invocation
    if (this.nativeConversationId) args.push('--conversation', this.nativeConversationId)
    for (const dir of unique(input.attachments.map((file) => dirname(file.storedPath)))) args.push('--add-dir', dir)

    const createTransport = this.deps.createTransport ?? ((executable, cwd, transportArgs) => new AntigravityPtyTransport(executable, cwd, transportArgs))
    const spawned = createTransport(this.deps.executable, input.workspacePath, args)
    this.transport = spawned
    this.state = 'bootstrapping'
    this.queuedPrompt = input.prompt
    this.queuedImages = images
    // Every callback is scoped to the transport that raised it. A retired
    // process exits asynchronously, and without this guard its exit would
    // arrive after the replacement had already spawned — failing the new
    // run and tearing down a session that is perfectly healthy.
    const isCurrent = (): boolean => this.transport === spawned
    spawned.start({
      onInteraction: (interaction) => { if (isCurrent()) this.handleInteraction(interaction) },
      onReadyForInput: () => { if (isCurrent()) this.handleReady() },
      onBusy: () => { if (isCurrent()) this.handleBusy() },
      onExit: (code, signal) => { if (isCurrent()) this.handleExit(code, signal) },
      onStreamText: (lines) => { if (isCurrent()) this.handleStreamText(lines) },
      onScreenText: (lines) => { if (isCurrent()) this.observeScreen(lines) }
    })
  }

  async respondToInteraction(runId: ID, interactionId: string, optionId: string): Promise<void> {
    if (this.currentRunId !== runId) throw codedError('interaction.wrong_run', 'This interaction does not belong to the active run.')
    if (!this.pending || this.pending.interactionId !== interactionId) {
      throw codedError('interaction.not_pending', 'This interaction has already been resolved or is no longer active.')
    }
    if (!this.transport?.respond(this.pending.ptyInteraction, optionId)) {
      throw codedError('interaction.invalid_option', 'That option is not valid for the current interaction.')
    }
    const outcome = optionId.toLowerCase() === 'n' || /no|deny|cancel/i.test(this.pending.ptyInteraction.options.find((o) => o.id === optionId)?.label ?? '') ? 'denied' : 'approved'
    const resolvedId = this.pending.interactionId
    this.pending = null
    this.state = this.resumeStateAfterInteraction
    this.emit({ type: 'interaction.resolved', interactionId: resolvedId, outcome })
  }

  cancel(): void {
    // CRITICAL (real bug, review round 4): a run does not always have a
    // process to interrupt. While a model change is retiring the previous
    // agy, `transport` is deliberately null and the replacement is only
    // *promised* to this run — yet `currentRunId` is still its own, so
    // AntigravityProvider.cancelRun routes Stop here. Falling through to
    // the transport-required path below returned silently: no
    // `run.cancelled`, and once the predecessor exited the replacement
    // spawned and delivered the very prompt the user had stopped.
    //
    // Stop is honoured instead by voiding the spawn that run is owed. The
    // predecessor's retirement is not touched and runs to completion
    // normally — reviving it was never an option, and it is still this
    // conversation's owner until it genuinely exits.
    if (this.awaitingDeferredSpawn()) {
      this.cancelDeferredRun()
      return
    }
    // Only a turn genuinely in flight can be stopped. A session sitting at
    // 'ready' between turns has nothing to interrupt, and writing Escape
    // into it would both disturb an idle process and latch a cancellation
    // that belongs to no run.
    if (!this.isBusy) return
    if (!this.transport?.isRunning) {
      // CRITICAL: the process this run was using is already gone, but its
      // exit has not been handled yet. Returning silently here left the
      // Stop unanswered and let `handleExit` report the very exit the user
      // caused as `provider.exited` — "Antigravity's interactive session
      // exited unexpectedly". Latching the request instead makes that exit
      // read as the cancellation it is.
      this.cancelRequested = true
      return
    }
    this.cancelRequested = true
    if (this.pending) {
      const resolvedId = this.pending.interactionId
      this.pending = null
      // Restore the pre-interaction state (mirrors respondToInteraction) so
      // the next ready-for-input transition is correctly read as "this
      // turn is done" rather than silently ignored.
      this.state = this.resumeStateAfterInteraction
      this.emit({ type: 'interaction.resolved', interactionId: resolvedId, outcome: 'cancelled' })
    }
    this.transport.cancelTurn()
  }

  /** True while the current run has no process of its own and is waiting on
   *  a retirement to hand one over. There are exactly two such windows, and
   *  both promise this run a process that does not exist yet:
   *
   *  - `'retiring'`: this run's own model change is retiring the predecessor
   *    (`retireThenSpawn`).
   *  - `'bootstrapping'` with no transport: this run arrived while some
   *    other retirement was in flight and queued behind it
   *    (`spawnAfterRetirement`). Once it really spawns, `spawn()` sets
   *    `transport` before `state`, so an ordinary bootstrap never matches. */
  private awaitingDeferredSpawn(): boolean {
    if (this.currentRunId === null || this.transport !== null) return false
    return this.state === 'retiring' || this.state === 'bootstrapping'
  }

  /** Marks the current run cancelled across the asynchronous boundary it is
   *  waiting on, and acknowledges the Stop immediately.
   *
   *  Immediately, not on the predecessor's exit: the run has nothing left to
   *  do, and a predecessor that survives every escalation would otherwise
   *  leave the Stop unanswered forever. Emitting here also makes
   *  `run.cancelled` exactly-once by construction — the boundary consumes
   *  the record and emits nothing, so there is only ever one emitter.
   *
   *  The session returns to `'idle'`, not `'ready'`: the promised
   *  replacement is void so nothing is busy on this run's behalf, while the
   *  `Retirement` record still holds ownership — so a later send waits on
   *  it (or is refused if it became blocked) rather than spawning alongside
   *  a predecessor that is still alive. */
  private cancelDeferredRun(): void {
    const runId = this.currentRunId
    if (runId === null || this.cancelledDeferredRuns.has(runId)) return
    this.cancelledDeferredRuns.add(runId)
    this.clearTurnStartTimer()
    this.state = 'idle'
    this.emit({ type: 'run.cancelled' })
  }

  /** Whether `runId`'s deferred work was cancelled, consuming the record.
   *
   *  Every asynchronous boundary that could still spawn a process or
   *  deliver a prompt for a run passes through here first, so a cancelled
   *  run cannot cross one — and because the answer is keyed by run id, a
   *  stale boundary belonging to a cancelled run can neither spawn for
   *  itself nor disturb the run that has since taken the session over. */
  private deferredRunWasCancelled(runId: ID): boolean {
    return this.cancelledDeferredRuns.delete(runId)
  }

  /** Shuts the session down and reports whether it is safe to forget.
   *
   *  False means a process this session owns is still alive after every
   *  escalation. The caller must keep the session — dropping it would put a
   *  fresh one, with no knowledge of that process, in charge of the same
   *  native conversation. */
  async release(): Promise<boolean> {
    // Set before shutting down, so a send already waiting on a retirement
    // cannot spawn onto a session the provider is about to discard.
    this.released = true
    this.shutdown()
    const retirement = this.retirement
    return retirement ? retirement.done : true
  }

  /** Resolves once nothing this session owns is still running. */
  async whenOwnershipReleased(): Promise<void> {
    const owner = this.transport ?? this.retirement?.transport
    if (owner) await owner.whenExited()
  }

  shutdown(): void {
    this.clearTurnStartTimer()
    const retired = this.transport
    // Detached and recorded, not just killed: `kill()` returns before the
    // process is gone, and a later send() must not spawn a second owner of
    // the same native conversation on top of it.
    this.transport = null
    this.state = 'idle'
    if (!retired) return
    // Same rule as a model-change retirement: the process keeps owning this
    // conversation until it is confirmed gone, so nothing else can spawn.
    void this.beginRetirement(retired)
  }

  /** Real, verified clipboard-paste choreography (see nativeClipboardImage
   *  and AntigravityPtyTransport's module comments): writes each image
   *  onto the OS clipboard, sends Ctrl+V, and waits for agy's own on-screen
   *  "N media attached" confirmation before moving to the next one — never
   *  a fixed blind delay. The text prompt is written only after every
   *  attachment has been attempted, never before. The user's real
   *  clipboard content is saved once and restored afterward regardless of
   *  how many attachments succeeded. */
  private async deliverPrompt(prompt: string, images: ImageAttachment[]): Promise<void> {
    if (images.length === 0) {
      this.beginStreaming(prompt)
      this.transport?.sendPrompt(prompt)
      return
    }

    // Checked once, before ever touching the clipboard — not discovered
    // only after a paste silently fails inside the live PTY session (see
    // clipboardCapability.ts's module comment for the real evidence this
    // was built from).
    if (!this.clipboardCapability) this.clipboardCapability = (this.deps.checkClipboardCapability ?? checkClipboardCapability)()
    if (!this.clipboardCapability.available) {
      console.warn(`[antigravity-pty] native image attachment unavailable (${this.clipboardCapability.reason}) — falling back to a text hint for ${images.length} image(s).`)
      const hinted = appendSkippedImageHint(prompt, images, this.clipboardCapability)
      this.beginStreaming(hinted)
      this.transport?.sendPrompt(hinted)
      return
    }

    let saved: SavedClipboard | null = null
    this.deliveringImages = true
    try {
      saved = saveCurrentClipboard()
      for (const image of images) {
        // CRITICAL: cancel() during image delivery does not itself change
        // `this.state` (there is no pending interaction for it to resume
        // into), so `cancelRequested` must be checked explicitly here —
        // without it, a mid-sequence cancellation would send Escape into
        // agy but this loop would keep pasting further images regardless.
        if (this.cancelRequested || this.state !== 'running' || !this.transport?.isRunning) break
        const expected = (this.transport.mediaAttachedCount ?? 0) + 1
        const loaded = (this.deps.writeImageToClipboard ?? writeImageToClipboard)(image.storedPath)
        if (!loaded) {
          console.warn(`[antigravity-pty] could not load "${image.storedPath}" as an image — skipped`)
          continue
        }
        this.transport.pasteClipboardImage()
        const confirmed = await this.waitForMediaAttachedAtLeast(expected, MEDIA_PASTE_CONFIRM_TIMEOUT_MS)
        if (!confirmed) {
          console.warn(`[antigravity-pty] paste confirmation for "${image.storedPath}" never appeared within ${MEDIA_PASTE_CONFIRM_TIMEOUT_MS}ms`)
        }
      }
    } finally {
      if (saved) restoreClipboard(saved)
      this.deliveringImages = false
    }
    // A cancellation mid-attachment-sequence must not still deliver the
    // original text prompt afterward — that would silently ignore the
    // user's cancel and start the very turn they just cancelled.
    if (!this.cancelRequested && this.state === 'running' && this.transport?.isRunning) {
      this.beginStreaming(prompt)
      this.transport.sendPrompt(prompt)
    }
  }

  /** Arms progressive reading for the prompt that is about to be written.
   *  Nothing is streamed until this has run, so a screen still showing the
   *  previous turn can never be read as this turn's answer. */
  private beginStreaming(prompt: string): void {
    this.deliveredPrompt = prompt
    this.streamedText = ''
    this.divergedFrames = 0
    this.reportedActivity.clear()
    this.lastActivity.clear()
    this.sawPromptEcho = false
    this.sawBusy = false
    this.refusedReady = false
    this.graceExpired = false
    this.clearTurnStartTimer()
    this.turnStartTimer = setTimeout(() => {
      this.turnStartTimer = null
      this.graceExpired = true
      if (this.refusedReady && this.state === 'running') {
        console.warn('[antigravity-pty] agy never showed this prompt as submitted; settling the turn on the ready footer that was held back.')
        this.refusedReady = false
        this.settleTurn()
      }
    }, TURN_START_GRACE_MS)
    this.turnStartTimer.unref?.()
  }

  private clearTurnStartTimer(): void {
    if (this.turnStartTimer) clearTimeout(this.turnStartTimer)
    this.turnStartTimer = null
  }

  /** Whether the screen shows that agy has actually taken this turn on.
   *
   *  CRITICAL (real bug, captured live against agy 1.1.27): agy leaves its
   *  ready footer on screen for a moment after a prompt is submitted —
   *  sometimes longer than the transport's 450 ms idle debounce — and
   *  `write()` deliberately clears the ready edge so the next footer counts
   *  as a fresh transition. Together those mean the *pre-prompt* screen
   *  could be read as "this turn is finished": the run settled roughly half
   *  a second after being sent, with empty text, and the real answer was
   *  then thrown away when it arrived. Captured evidence: two consecutive
   *  idle snapshots, byte-identical, both the bare compose box and
   *  `? for shortcuts`, with no echo of the prompt anywhere on screen.
   *
   *  A turn that has really started always shows its own prompt echoed
   *  *and* an emptied compose box — agy echoes a prompt into the box as it
   *  is typed, so the echo alone does not mean it was ever submitted (also
   *  captured live: a run settled on exactly that half-typed screen). Once
   *  seen, it is latched, so an answer long enough to scroll its own echo
   *  out of the buffer still settles normally. With no screen to look
   *  at (a transport that reports none), there is no evidence either way and
   *  the previous behaviour stands. */
  /** Whether the ready footer on screen really means *this* turn is over.
   *
   *  Two things have to be true, and each was a real captured failure:
   *
   *  1. agy has taken the prompt on at all (`turnHasStartedOnScreen`).
   *  2. it has actually done something with it — either it was seen working,
   *     or there is a reply on screen to settle with. Captured live on a
   *     freshly resumed process (`--conversation`): agy echoes the submitted
   *     prompt and is still showing the ready footer from the replayed
   *     history, so condition 1 alone settled the turn instantly with an
   *     empty answer and the real reply was thrown away.
   *
   *  Requiring the busy footer *alone* would not do: a turn whose answer
   *  streams continuously never produces an idle snapshot while it works, so
   *  the first one arrives at the end with the whole reply already on it.
   *  Hence "seen working OR has something to say", bounded by the grace
   *  timer so neither can strand the run. */
  private turnMaySettle(): boolean {
    // A cancelled turn is settled by the user, not by evidence of work — it
    // may have been stopped before agy ever started (mid image-paste, say).
    if (this.cancelRequested || this.graceExpired) return true
    if (!this.turnHasStartedOnScreen()) return false
    return this.sawBusy || this.settleText().length > 0
  }

  /** The reply as `settleTurn` will read it, so the decision to settle and
   *  the text settled with can never disagree. */
  private settleText(): string {
    return extractResponseText(this.lastScreenLines, this.deliveredPrompt === null ? {} : { prompt: this.deliveredPrompt })
  }

  private turnHasStartedOnScreen(): boolean {
    if (this.sawPromptEcho || this.graceExpired) return true
    if (this.deliveredPrompt === null || this.lastScreenLines.length === 0) return true
    return this.latchPromptEcho(this.lastScreenLines)
  }

  /** Records the latest idle snapshot, and notices this turn's prompt echo
   *  on it. Every screen the session is shown goes through here so the
   *  latch cannot be missed on the one frame that happened to carry it. */
  private observeScreen(lines: string[]): void {
    this.lastScreenLines = lines
    this.latchPromptEcho(lines)
    // The idle snapshot is the only screen a turn that never streams ever
    // produces, so activity is read from it too. Guarded exactly as the
    // progressive text reader is: never during bootstrap (whose screen is
    // agy's startup banner), never mid image-paste, never after a stop.
    if (this.state === 'running' && !this.deliveringImages && !this.cancelRequested && this.deliveredPrompt !== null) {
      this.reportScreenActivity(lines)
    }
  }

  /** Reports what agy's own screen says it is doing, as ordinary Orbit
   *  `tool.activity` events.
   *
   *  The interactive transport has no structured step channel — the screen
   *  is the only account of the work there is, and `extractResponseText`
   *  was already parsing these rows out of the response body as chrome and
   *  discarding them. This reads the same rows instead of throwing them
   *  away, so an interactive turn can say "Running npm run build" rather
   *  than only "Antigravity is replying".
   *
   *  agy redraws continuously, so only genuine changes are emitted: a step
   *  seen for the first time starts, a step whose details changed updates,
   *  and a step that has left the screen (agy collapses finished work) is
   *  reported completed exactly once. */
  private reportScreenActivity(lines: string[]): void {
    const activities = readScreenActivity(lines)
    const present = new Set(activities.map((activity) => activity.key))

    for (const [key, reported] of this.reportedActivity) {
      if (present.has(key) || reported.status === 'completed') continue
      this.reportedActivity.set(key, { ...reported, status: 'completed' })
      this.emitScreenActivity(this.lastActivityFor(key), 'completed')
    }

    for (const activity of activities) {
      const signature = signatureOf(activity)
      const previous = this.reportedActivity.get(activity.key)
      // `Thought for 11s` describes work that is already over; everything
      // else on screen is happening now.
      const status = activity.kind === 'thinking' ? 'completed' : 'running'
      if (previous && previous.signature === signature && previous.status === status) continue
      this.reportedActivity.set(activity.key, { status, signature })
      this.lastActivity.set(activity.key, activity)
      this.emitScreenActivity(activity, status)
    }
  }

  private lastActivityFor(key: string): ScreenActivity {
    return this.lastActivity.get(key) ?? { key, kind: 'working', label: 'Working' }
  }

  private emitScreenActivity(activity: ScreenActivity, status: 'running' | 'completed'): void {
    this.emit({
      type: 'tool.activity',
      label: activity.label,
      status,
      providerStepId: activity.key,
      kind: activity.kind,
      ...(activity.command ? { command: activity.command } : {}),
      ...(activity.target ? { target: activity.target } : {}),
      ...(activity.durationSeconds !== undefined ? { durationSeconds: activity.durationSeconds } : {})
    })
  }

  private latchPromptEcho(lines: string[]): boolean {
    if (this.sawPromptEcho) return true
    if (this.deliveredPrompt === null) return false
    if (!promptHasBeenSubmitted(lines, this.deliveredPrompt)) return false
    this.sawPromptEcho = true
    return true
  }

  /** Turns the live terminal screen into ordinary Orbit `text.delta`
   *  events, so a PTY turn's answer appears while agy is still writing it
   *  instead of arriving whole at completion.
   *
   *  Only genuinely new text is ever emitted: `progressiveAppendIndex`
   *  ignores the re-wrapping and padding a redraw introduces, and returns
   *  -1 for a frame that is not a continuation at all (a redraw sampled
   *  mid-write, or another turn's screen), which is skipped rather than
   *  guessed at. `run.completed`'s `finalText` remains the authoritative
   *  response either way, so a skipped frame costs nothing but a beat of
   *  streaming. */
  private handleStreamText(lines: string[]): void {
    if (this.state !== 'running' || this.deliveringImages || this.cancelRequested) return
    const prompt = this.deliveredPrompt
    if (prompt === null) return
    this.latchPromptEcho(lines)
    this.reportScreenActivity(lines)
    const candidate = extractResponseText(lines, { prompt, requirePromptEcho: true })
    if (!candidate || candidate === this.streamedText) return
    const appendAt = progressiveAppendIndex(this.streamedText, candidate)
    if (appendAt === -1) {
      this.divergedFrames += 1
      // Resynchronizing silently means the rewritten stretch is not shown
      // twice and not shown late — it simply arrives with `run.completed`,
      // which carries the authoritative answer either way. Freezing the
      // stream instead would cost the rest of the turn.
      if (this.divergedFrames >= STREAM_RESYNC_AFTER_FRAMES && candidate.length > this.streamedText.length) {
        this.streamedText = candidate
        this.divergedFrames = 0
      }
      return
    }
    this.divergedFrames = 0
    const delta = candidate.slice(appendAt)
    if (!delta) return
    this.streamedText = candidate
    this.emit({ type: 'text.delta', delta })
  }

  private async waitForMediaAttachedAtLeast(count: number, timeoutMs: number): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if ((this.transport?.mediaAttachedCount ?? 0) >= count) return true
      await wait(MEDIA_PASTE_POLL_INTERVAL_MS)
    }
    return (this.transport?.mediaAttachedCount ?? 0) >= count
  }

  private handleInteraction(interaction: PtyInteraction): void {
    if (this.state === 'waiting_for_interaction') return // same-signature redraw; transport already dedupes
    this.resumeStateAfterInteraction = this.state === 'bootstrapping' ? 'bootstrapping' : 'running'
    this.state = 'waiting_for_interaction'
    const interactionId = `${this.currentRunId}:pty:${++this.interactionCounter}`
    this.pending = { interactionId, ptyInteraction: interaction }
    this.emit({
      type: 'interaction.required',
      interactionId,
      kind: interaction.kind === 'confirm_enter' ? 'permission' : interaction.kind === 'choice' ? 'selection' : 'permission',
      prompt: interaction.prompt,
      options: interaction.options.map((option) => ({ id: option.id, label: option.label })),
      transport: 'pty',
      canRespond: true,
      sourceEvidence: 'native-prompt'
    })
  }

  private handleBusy(): void {
    this.sawBusy = true
    if (this.state === 'bootstrapping') this.state = 'running'
  }

  private handleReady(): void {
    if (this.deliveringImages) return // mid clipboard-paste sequence — not a real turn boundary
    if (this.state === 'bootstrapping') {
      this.state = 'ready'
      const prompt = this.queuedPrompt
      const images = this.queuedImages
      this.queuedPrompt = null
      this.queuedImages = []
      if (prompt !== null) {
        this.state = 'running'
        this.emit({ type: 'run.started', nativeConversationId: this.nativeConversationId })
        void this.deliverPrompt(prompt, images)
      }
      return
    }
    if (this.state === 'running') {
      if (!this.turnMaySettle()) {
        this.refusedReady = true
        return
      }
      this.settleTurn()
    }
  }

  private settleTurn(): void {
    this.clearTurnStartTimer()
    if (this.cancelRequested) {
      this.cancelRequested = false
      this.state = 'ready'
      this.emit({ type: 'run.cancelled' })
      return
    }
    this.state = 'ready'
    this.text = this.settleText()
    if (!this.nativeConversationId && this.currentInput) {
      const lookup = this.deps.findConversationId ?? findRecentConversationId
      this.nativeConversationId = lookup(this.currentInput.workspacePath)
    }
    this.emit({ type: 'run.completed', finalText: this.text, nativeConversationId: this.nativeConversationId })
  }

  private handleExit(code: number, signal?: number): void {
    this.clearTurnStartTimer()
    const wasCancelled = this.cancelRequested
    this.cancelRequested = false
    this.transport = null
    this.state = 'idle'
    if (this.pending) {
      const resolvedId = this.pending.interactionId
      this.pending = null
      this.emit({ type: 'interaction.resolved', interactionId: resolvedId, outcome: 'cancelled' })
    }
    if (wasCancelled) {
      this.emit({ type: 'run.cancelled' })
      return
    }
    this.emit({
      type: 'run.failed',
      error: { code: 'provider.exited', message: `Antigravity's interactive session exited unexpectedly (code=${code}, signal=${signal ?? 'none'}).`, retryable: false }
    })
  }

  private emit(event: Record<string, unknown>): void {
    if (!this.onEvent || !this.currentInput || !this.currentRunId) return
    this.onEvent({
      ...event,
      projectId: this.currentInput.projectId,
      conversationId: this.conversationId,
      runId: this.currentRunId,
      providerId: 'antigravity',
      createdAt: nowIso()
    } as RuntimeEvent)
  }
}

// Electron's nativeImage cannot rasterize SVG for a clipboard paste (it
// only reads raster bitmap formats), so SVG is deliberately excluded even
/** Orbit policy, not silent failure: when native paste genuinely can't
 *  work on this machine, the assistant still learns the attachments exist
 *  and where to find them (mirroring the structured transport's
 *  `view_file` hint) instead of the images just vanishing from the turn. */
function appendSkippedImageHint(prompt: string, images: ImageAttachment[], capability: ClipboardCapability): string {
  const list = images.map((image) => `- ${image.name}: ${image.storedPath}`).join('\n')
  return `${prompt}\n\n(${images.length} image attachment(s) could not be natively attached on this machine — ${capability.reason} Inspect these managed paths with view_file if relevant:\n${list})`
}

// though it's an "image/*" mime type — it falls back to the structured
// view_file hint instead, exactly like a non-image attachment.
function isSupportedImage(file: ProjectFile): boolean {
  if (file.mimeType === 'image/svg+xml') return false
  if (file.mimeType?.startsWith('image/')) return true
  const lower = file.name.toLowerCase()
  for (const ext of SUPPORTED_IMAGE_EXTENSIONS) if (lower.endsWith(ext)) return true
  return false
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Everything about a screen activity that would make it worth re-reporting.
 *  The key alone is not enough: agy revises a row in place (a command's
 *  duration lands after it finishes). */
function signatureOf(activity: ScreenActivity): string {
  return [activity.kind, activity.label, activity.command ?? '', activity.target ?? '', activity.durationSeconds ?? ''].join('\u0000')
}

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}
