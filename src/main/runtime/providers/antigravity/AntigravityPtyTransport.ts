// Orbit-owned persistent PTY transport for one Antigravity conversation.
// Owns exactly one `agy` process for the conversation's lifetime and emits
// normalized observations to AntigravityProvider — it has no renderer or
// runtime concerns of its own. Screen state is reconstructed with a real
// VT parser (TerminalScreenBuffer, @xterm/headless) rather than regexing
// raw chunks: `agy`'s interactive TUI redraws lines, animates spinners, and
// repeats content, which a naive ANSI-strip/concatenate buffer cannot
// interpret reliably. Interaction detection, the "esc to cancel" / "? for
// shortcuts" footer transitions, and the "N media attached" clipboard-paste
// marker are all adapted from AgentDock Pro's proven, live-verified
// AntigravityAdapter/TerminalInteractionDetector — see
// docs/antigravity-transports.md for the real captured evidence behind
// each pattern used here.
import * as pty from 'node-pty'
import { TerminalScreenBuffer } from '@main/terminal/TerminalScreenBuffer'
import {
  detectGenericInteraction,
  isBusy,
  isReadyForInput,
  readMediaAttachedCount,
  type GenericInteractionGuess,
  type InteractionOption
} from '@main/terminal/TerminalInteractionDetector'

const IDLE_DEBOUNCE_MS = 450
/** How often the live screen is read for progressive response text while
 *  output is still flowing. The idle-debounced classification snapshot
 *  below cannot do this job: agy streams a long answer continuously, so
 *  the debounce never fires until the turn is already over (confirmed
 *  live — a 14-second answer produced exactly one snapshot, after
 *  completion). This is a read-only second reader; it never classifies the
 *  screen and never touches the ready/busy/interaction edge state.
 *
 *  The interval is deliberately short: agy draws a whole answer in about a
 *  second once the model starts writing (the thinking phase before it
 *  shows nothing at all), so a slower cadence turns that second into one
 *  or two jumps rather than a reply that visibly grows. */
const STREAM_SAMPLE_MS = 120
/** Real, verified cancel-current-turn key (agy's own on-screen hint is
 *  "esc to cancel"). NOT Ctrl+C — that is reserved for exiting the whole
 *  interactive session and needs a second press. */
const ESCAPE = '\x1b'
/** Real, verified clipboard-image-paste key. */
const CTRL_V = '\x16'
const ARROW_DOWN = '\x1b[B'

export interface PtyInteraction {
  /** Stable while the same on-screen menu is showing — used to deduplicate
   *  a redraw (spinner tick, cursor blink) from a genuinely new menu. */
  signature: string
  kind: GenericInteractionGuess['kind']
  prompt: string
  options: InteractionOption[]
}

export interface AntigravityPtyHandlers {
  /** A new, distinct interaction appeared (never fired twice in a row for
   *  the same on-screen menu). */
  onInteraction(interaction: PtyInteraction): void
  /** The process is idle and ready for the next prompt. Fired once per
   *  ready transition — the caller decides whether this means "turn
   *  completed" (a turn was in flight) or "ready for the first prompt"
   *  (fresh bootstrap), since the transport has no notion of turns. */
  onReadyForInput(): void
  /** The process is actively working (footer shows "esc to cancel").
   *  Fired once per busy transition, not on every redraw. */
  onBusy(): void
  onExit(code: number, signal?: number): void
  /** Fires on a throttled cadence *while output is still arriving*, with
   *  the full current screen. Purely for progressively reading the
   *  response as it is drawn — this handler must never be used to decide
   *  readiness, busyness, or interactions, which stay the exclusive job of
   *  the idle-debounced snapshot below. Optional. */
  onStreamText?(lines: string[]): void
  /** Fires on every idle snapshot with the full current screen text —
   *  independent of ready/busy/interaction classification. Used for
   *  one-off scraping (e.g. capturing the native conversation id from a
   *  scripted `/help` round trip) that doesn't fit the ready/interaction
   *  vocabulary above. Optional: most callers never need raw screen text. */
  onScreenText?(lines: string[]): void
}

/** Structural interface the PTY session programs against — lets tests
 *  inject a fake transport without spawning a real `agy` process. */
export interface IAntigravityPtyTransport {
  readonly isRunning: boolean
  readonly mediaAttachedCount: number
  start(handlers: AntigravityPtyHandlers): void
  sendPrompt(prompt: string): void
  respond(pending: PtyInteraction, optionId: string): boolean
  pasteClipboardImage(): void
  cancelTurn(): void
  kill(): void
  resize(cols: number, rows: number): void
}

export class AntigravityPtyTransport implements IAntigravityPtyTransport {
  private proc: pty.IPty | null = null
  private readonly screen = new TerminalScreenBuffer(120, 32)
  private running = false
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private handlers: AntigravityPtyHandlers | null = null
  private wasReady = false
  private wasBusy = false
  private pendingSignature: string | null = null
  private lastRespondedSignature: string | null = null
  private lastRespondedAtMs = 0
  private mediaAttached = 0
  private lastStreamSampleAtMs = 0

  constructor(
    private readonly executable: string,
    private readonly cwd: string,
    private readonly args: string[]
  ) {}

  start(handlers: AntigravityPtyHandlers): void {
    this.handlers = handlers
    this.proc = pty.spawn(this.executable, this.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      cwd: this.cwd,
      env: process.env as Record<string, string>,
      useConpty: true
    })
    this.running = true
    this.proc.onData((chunk) => {
      // The callback runs once xterm has actually parsed this chunk, so a
      // progressive read never observes a half-applied redraw.
      this.screen.write(chunk, () => this.sampleStreamText())
      this.scheduleSnapshot()
    })
    this.proc.onExit(({ exitCode, signal }) => {
      this.running = false
      if (this.idleTimer) clearTimeout(this.idleTimer)
      this.screen.dispose()
      handlers.onExit(exitCode, signal)
    })
  }

  get isRunning(): boolean {
    return this.running
  }

  get mediaAttachedCount(): number {
    return this.mediaAttached
  }

  /** Delivers a real user prompt (first turn or a follow-up in the same
   *  live session — this is what makes a native free-text question "just
   *  work": the answer is written into the very same process). */
  sendPrompt(prompt: string): void {
    this.pendingSignature = null
    this.write(`${prompt}\r`)
  }

  /** Translates a semantic interaction response into the correct native
   *  keystrokes for the option's menu shape. Returns false if there is no
   *  live process to write into, or the option id is not one of the
   *  currently pending interaction's own options (never accepts an
   *  arbitrary renderer-supplied payload). */
  respond(pending: PtyInteraction, optionId: string): boolean {
    if (!this.running || this.pendingSignature !== pending.signature) return false
    const option = pending.options.find((candidate) => candidate.id === optionId)
    if (!option) return false
    this.lastRespondedSignature = pending.signature
    this.lastRespondedAtMs = Date.now()
    this.pendingSignature = null
    if (pending.kind === 'confirm_enter') {
      this.write('\r')
      return true
    }
    const arrowMatch = /^arrow:(\d+)$/.exec(option.id)
    if (arrowMatch) {
      const downPresses = Number(arrowMatch[1])
      this.write(`${ARROW_DOWN.repeat(downPresses)}\r`)
      return true
    }
    // Numbered ("1", "2", ...) and lettered ("y", "n") menus accept the
    // literal key directly, confirmed against real captured agy prompts.
    this.write(`${option.id}\r`)
    return true
  }

  /** Real, verified clipboard-paste keystroke — pairs with the caller
   *  writing an image onto the OS clipboard immediately beforehand. */
  pasteClipboardImage(): void {
    this.write(CTRL_V)
  }

  cancelTurn(): void {
    this.write(ESCAPE)
  }

  kill(): void {
    this.proc?.kill()
    this.running = false
  }

  resize(cols: number, rows: number): void {
    try {
      this.proc?.resize(cols, rows)
      this.screen.resize(cols, rows)
    } catch {
      // process may be exiting
    }
  }

  private write(value: string): void {
    if (!this.running) return
    // CRITICAL (real bug, confirmed live against agy 1.1.27): whenever we
    // write anything, the terminal is expected to change and the NEXT
    // observed ready-for-input footer must count as a fresh transition —
    // without this, a turn whose response streams continuously (no idle
    // gap while generating, so no intermediate "busy" snapshot ever
    // resets the edge below) leaves `wasReady` stuck `true` from the
    // PREVIOUS ready state, so the real completion is silently never
    // reported and the run hangs forever.
    this.wasReady = false
    this.proc?.write(value)
  }

  /** Throttled, read-only look at the live screen for progressive
   *  response text. Skipped entirely while any write is still being
   *  parsed, so callers only ever see complete frames. */
  private sampleStreamText(): void {
    const onStreamText = this.handlers?.onStreamText
    if (!onStreamText || !this.running) return
    if (!this.screen.isDrained) return
    const now = Date.now()
    if (now - this.lastStreamSampleAtMs < STREAM_SAMPLE_MS) return
    this.lastStreamSampleAtMs = now
    onStreamText(this.screen.peekLines())
  }

  private scheduleSnapshot(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.handleSnapshot(), IDLE_DEBOUNCE_MS)
  }

  private handleSnapshot(): void {
    this.idleTimer = null
    const handlers = this.handlers
    if (!handlers) return
    const { lines } = this.screen.snapshot()
    if (process.env.ORBIT_PTY_DEBUG) {
      console.error(`[pty-debug] snapshot lines=${lines.length} tail=${JSON.stringify(lines.slice(-6))}`)
    }

    handlers.onScreenText?.(lines)

    const attached = readMediaAttachedCount(lines)
    if (attached > this.mediaAttached) this.mediaAttached = attached

    // CRITICAL (real bug, confirmed live against agy 1.1.27): the edge
    // flag must be latched to its NEW value *before* the handler runs, not
    // after. A handler call is synchronous and can itself write into the
    // PTY (e.g. onReadyForInput -> session sends the next prompt), which
    // resets `wasReady`/`wasBusy` via write() below — assigning the stale
    // pre-handler value afterward would silently clobber that reset right
    // back, so the real next transition would never be seen as new again
    // and the run would hang forever.
    const busy = isBusy(lines)
    const busyEdge = busy && !this.wasBusy
    this.wasBusy = busy
    if (busyEdge) handlers.onBusy()

    const guess = detectGenericInteraction(lines)
    if (guess) {
      const signature = `${guess.kind}:${guess.prompt}:${guess.options.map((o) => o.id).join(',')}`
      const recentlyResponded = signature === this.lastRespondedSignature && Date.now() - this.lastRespondedAtMs < 3000
      this.wasReady = false
      if (signature !== this.pendingSignature && !recentlyResponded) {
        this.pendingSignature = signature
        handlers.onInteraction({ signature, kind: guess.kind, prompt: guess.prompt, options: guess.options })
      }
      return
    }

    const ready = isReadyForInput(lines)
    const readyEdge = ready && !this.wasReady
    this.wasReady = ready
    if (readyEdge) handlers.onReadyForInput()
  }
}
