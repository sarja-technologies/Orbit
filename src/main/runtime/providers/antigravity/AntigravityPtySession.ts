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
import { extractResponseText } from '@main/terminal/TerminalInteractionDetector'
import { AntigravityPtyTransport, type IAntigravityPtyTransport, type PtyInteraction } from './AntigravityPtyTransport'
import { checkClipboardCapability, type ClipboardCapability } from './clipboardCapability'
import { restoreClipboard, saveCurrentClipboard, writeImageToClipboard, type SavedClipboard } from './nativeClipboardImage'
import { findRecentConversationId } from './nativeConversationHistory'

type SessionState = 'idle' | 'bootstrapping' | 'ready' | 'running' | 'waiting_for_interaction'

const MEDIA_PASTE_CONFIRM_TIMEOUT_MS = 8000
const MEDIA_PASTE_POLL_INTERVAL_MS = 200
const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
/** Orbit application policy, not a proven `agy`/clipboard limit — see
 *  docs/antigravity-transports.md. Reused from AgentDock Pro's identical
 *  application-level cap. */
const MAX_NATIVE_IMAGE_BYTES = 15 * 1024 * 1024

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
  private queuedPrompt: string | null = null
  private queuedImages: ImageAttachment[] = []
  private lastScreenLines: string[] = []
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

  send(input: ProviderSendInput, onEvent: (event: RuntimeEvent) => void): void {
    if (this.isBusy) {
      const error = Object.assign(new Error('This conversation already has an Antigravity turn in progress.'), {
        code: 'provider.session_busy'
      })
      throw error
    }
    this.currentRunId = input.runId
    this.currentInput = input
    this.onEvent = onEvent
    this.text = ''
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

    if (this.transport?.isRunning && this.state === 'ready') {
      this.state = 'running'
      this.emit({ type: 'run.started', nativeConversationId: this.nativeConversationId })
      void this.deliverPrompt(input.prompt, images)
      return
    }

    // Fresh spawn — bare (no `-i`), so images and long/multi-line prompts
    // never hit an argv length limit; the real prompt is written once the
    // process reaches its first ready-for-input transition (bootstrap).
    const args = ['--add-dir', input.workspacePath]
    if (this.nativeConversationId) args.push('--conversation', this.nativeConversationId)
    for (const dir of unique(input.attachments.map((file) => dirname(file.storedPath)))) args.push('--add-dir', dir)

    const createTransport = this.deps.createTransport ?? ((executable, cwd, transportArgs) => new AntigravityPtyTransport(executable, cwd, transportArgs))
    this.transport = createTransport(this.deps.executable, input.workspacePath, args)
    this.state = 'bootstrapping'
    this.queuedPrompt = input.prompt
    this.queuedImages = images
    this.transport.start({
      onInteraction: (interaction) => this.handleInteraction(interaction),
      onReadyForInput: () => this.handleReady(),
      onBusy: () => this.handleBusy(),
      onExit: (code, signal) => this.handleExit(code, signal),
      onScreenText: (lines) => { this.lastScreenLines = lines }
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
    if (this.state === 'idle' || !this.transport?.isRunning) return
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

  shutdown(): void {
    this.transport?.kill()
    this.state = 'idle'
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
      this.transport?.sendPrompt(appendSkippedImageHint(prompt, images, this.clipboardCapability))
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
    if (!this.cancelRequested && this.state === 'running' && this.transport?.isRunning) this.transport.sendPrompt(prompt)
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
    if (this.state === 'running') this.settleTurn()
  }

  private settleTurn(): void {
    if (this.cancelRequested) {
      this.cancelRequested = false
      this.state = 'ready'
      this.emit({ type: 'run.cancelled' })
      return
    }
    this.state = 'ready'
    this.text = extractResponseText(this.lastScreenLines)
    if (!this.nativeConversationId && this.currentInput) {
      const lookup = this.deps.findConversationId ?? findRecentConversationId
      this.nativeConversationId = lookup(this.currentInput.workspacePath)
    }
    this.emit({ type: 'run.completed', finalText: this.text, nativeConversationId: this.nativeConversationId })
  }

  private handleExit(code: number, signal?: number): void {
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

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}
