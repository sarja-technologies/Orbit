// Fallback prompt detection for the Antigravity PTY transport's screen
// classification: numbered/lettered menus, y/n confirmations, and
// cursor-marker arrow menus (agy's own workspace-trust dialog uses this
// shape). Adapted from AgentDock Pro's proven TerminalInteractionDetector,
// confirmed against real captured `agy` terminal output (see this repo's
// docs/antigravity-transports.md for the live evidence). agy's interactive
// TUI has no distinct "free-text question" modal of its own — a native
// question is just ordinary turn-ending assistant text, answered by the
// user's next composer message in the same live session — so there is
// deliberately no 'question' kind here.
import type { ActivityKind } from '@shared/runtime-events'
import { classifyToolName } from '@main/runtime/activityMapping'

export interface InteractionOption {
  id: string
  label: string
}

export type GenericInteractionKind = 'permission' | 'choice' | 'confirm_enter'

export interface GenericInteractionGuess {
  kind: GenericInteractionKind
  prompt: string
  options: InteractionOption[]
  /** Index, within the `tail` window this was detected from, where the
   *  menu's own content genuinely begins. */
  menuStartIndex: number
}

const NUMBERED_OPTION = /^\s*(?:[›❯>]\s*)?(\d{1,2})[.)]\s+(?:\(selected\)\s+)?(.+?)\s*$/
const LETTERED_OPTION = /^\s*([yn])[.)]\s+(.+?)\s*$/i
const ARROW_MARKER_OPTION = /^\s*[›❯>]\s+(\S.*?)\s*$/
const ARROW_PLAIN_OPTION = /^\s{2,}(\S.*?)\s*$/
const ARROW_FOOTER = /(↑\s*\/\s*↓|arrow keys?)\s*.*(navigate|select)/i
const QUESTION_LINE = /\?\s*(\([^)]*\))?\s*$/
export const TAIL_WINDOW = 14
// Real captured shape: "Requesting permission for:\n<command>\n\nDo you
// want to proceed?" — the command/target lives between these two anchors.
const REQUEST_LABEL_LINE = /^(Requesting (permission|approval) for)[:.]?\s*$/i

// Real captured agy footer text: "esc to cancel" while a turn is in flight,
// replaced by "? for shortcuts" once the process is idle and ready for the
// next prompt (also true right after the workspace-trust prompt resolves).
export const BUSY_FOOTER = /esc to cancel/i
export const READY_FOOTER = /\?\s*for shortcuts/i
// Real captured confirmation marker for a successful clipboard image paste:
// "▸ 📎 1 media attached (clipboard, 141 B, image/png)".
export const MEDIA_ATTACHED_PATTERN = /📎\s*(\d+)\s*media attached/

function lastNonEmpty(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]?.trim()) return lines[i]!.trim()
  }
  return null
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i]!)) return i
  }
  return -1
}

function findFirstIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = 0; i < items.length; i++) {
    if (predicate(items[i]!)) return i
  }
  return -1
}

function findPromptLine(tail: string[], fallback: string): string {
  const questionIdx = findLastIndex(tail, (l) => QUESTION_LINE.test(l.trim()))
  const requestIdx = findLastIndex(tail, (l) => REQUEST_LABEL_LINE.test(l.trim()))
  if (requestIdx !== -1 && questionIdx !== -1 && requestIdx < questionIdx) {
    const detail = tail
      .slice(requestIdx, questionIdx + 1)
      .map((l) => l.trim())
      .filter(Boolean)
    if (detail.length > 1) return detail.join('\n')
  }
  if (questionIdx !== -1) return tail[questionIdx]!.trim()
  return lastNonEmpty(tail) ?? fallback
}

function computeMenuStartIndex(tail: string[], firstOptionIndex: number): number {
  const requestIdx = findFirstIndex(tail, (l) => REQUEST_LABEL_LINE.test(l.trim()))
  const questionIdx = findFirstIndex(tail, (l) => QUESTION_LINE.test(l.trim()))
  const candidates = [requestIdx, questionIdx, firstOptionIndex].filter((i) => i !== -1)
  return candidates.length > 0 ? Math.min(...candidates) : firstOptionIndex
}

export function detectGenericInteraction(lines: string[]): GenericInteractionGuess | null {
  const tail = lines.slice(-TAIL_WINDOW)
  const joined = tail.join('\n')

  // CRITICAL (real bug, confirmed live against agy 1.1.27): an ordinary
  // assistant response that happens to end in a numbered list ("1. ...",
  // "2. ...") — an extremely common shape for AI output — was matching
  // the numbered-menu branch below and getting treated as a real
  // interaction requiring a response, corrupting the conversation (the
  // "menu" had no real options, and writing a keystroke into what was
  // actually finished prose sent it as garbage chat input instead). Every
  // real captured menu (trust prompt, command-permission prompt) never
  // coexists on screen with the ready-for-input footer — only a genuinely
  // settled, completed turn shows that footer — so its presence rules out
  // every interaction shape below, not just the numbered one.
  if (READY_FOOTER.test(joined)) return null

  const numberedIndexed = tail
    .map((l, i) => ({ m: l.match(NUMBERED_OPTION), i }))
    .filter((e): e is { m: RegExpMatchArray; i: number } => e.m !== null)
  if (numberedIndexed.length >= 2) {
    const seen = new Set<string>()
    const options: InteractionOption[] = []
    let hasCursorMarker = false
    for (const { m } of numberedIndexed) {
      if (/^\s*[›❯>]/.test(m[0])) hasCursorMarker = true
      if (seen.has(m[1]!)) continue
      seen.add(m[1]!)
      options.push({ id: m[1]!, label: m[2]!.trim() })
    }
    const isPermissionShaped = /permission required|do you want to|do you trust|would you like to/i.test(joined)
    // Real captured menus always highlight one option with a cursor marker
    // (`> 1. Yes`) — a plain numbered list in ordinary assistant prose
    // (e.g. summarizing steps) never does. Requiring one of these two
    // signals, on top of the ready-footer exclusion above, is what closes
    // the false-positive gap during a busy/mid-stream pause, when the
    // ready footer isn't there yet to rule it out on its own.
    if (options.length >= 2 && (hasCursorMarker || isPermissionShaped)) {
      return {
        kind: isPermissionShaped ? 'permission' : 'choice',
        prompt: findPromptLine(tail, 'Choose an option'),
        options,
        menuStartIndex: computeMenuStartIndex(tail, numberedIndexed[0]!.i)
      }
    }
  }

  const letteredIndexed = tail
    .map((l, i) => ({ m: l.match(LETTERED_OPTION), i }))
    .filter((e): e is { m: RegExpMatchArray; i: number } => e.m !== null)
  if (letteredIndexed.length >= 1 && /\by\/n\b|\byes\/no\b/i.test(joined)) {
    const yLine = letteredIndexed.find((e) => e.m[1]!.toLowerCase() === 'y')
    const nLine = letteredIndexed.find((e) => e.m[1]!.toLowerCase() === 'n')
    return {
      kind: 'permission',
      prompt: findPromptLine(tail, 'Confirm?'),
      options: [
        { id: 'y', label: yLine ? yLine.m[2]!.trim() : 'Yes' },
        { id: 'n', label: nLine ? nLine.m[2]!.trim() : 'No' }
      ],
      menuStartIndex: computeMenuStartIndex(tail, letteredIndexed[0]!.i)
    }
  }

  const footerIdx = findLastIndex(tail, (l) => ARROW_FOOTER.test(l))
  if (footerIdx !== -1) {
    const collected: { label: string; selected: boolean }[] = []
    let idx = footerIdx - 1
    while (idx >= 0) {
      const raw = tail[idx]!
      const trimmed = raw.trim()
      if (!trimmed) {
        idx -= 1
        continue
      }
      const markerMatch = raw.match(ARROW_MARKER_OPTION)
      const plainMatch = !markerMatch ? raw.match(ARROW_PLAIN_OPTION) : null
      const label = markerMatch?.[1] ?? plainMatch?.[1]
      if (!label || /[.:?]\s*$/.test(label)) break
      collected.unshift({ label: label.trim(), selected: Boolean(markerMatch) })
      idx -= 1
    }
    if (collected.length >= 2) {
      const options: InteractionOption[] = collected.map((c, i) => ({ id: `arrow:${i}`, label: c.label }))
      const isPermissionShaped = /do you want to|do you trust|permission/i.test(joined)
      return {
        kind: isPermissionShaped ? 'permission' : 'choice',
        prompt: findPromptLine(tail.slice(0, footerIdx), 'Choose an option'),
        options,
        menuStartIndex: computeMenuStartIndex(tail, idx + 1)
      }
    }
  }

  if (/press enter to continue/i.test(joined) || /^\s*Enter to continue/i.test(joined)) {
    const enterIdx = findFirstIndex(tail, (l) => /press enter to continue/i.test(l) || /^\s*Enter to continue/i.test(l))
    return {
      kind: 'confirm_enter',
      prompt: findPromptLine(tail, 'Press Enter to continue'),
      options: [{ id: 'enter', label: 'Continue' }],
      menuStartIndex: computeMenuStartIndex(tail, enterIdx === -1 ? tail.length - 1 : enterIdx)
    }
  }

  return null
}

/** True once the footer shows agy is idle and ready for the next prompt
 *  (also fires right after a permission/trust menu resolves). */
export function isReadyForInput(lines: string[]): boolean {
  const tail = lines.slice(-TAIL_WINDOW)
  return tail.some((l) => READY_FOOTER.test(l))
}

export function isBusy(lines: string[]): boolean {
  const tail = lines.slice(-TAIL_WINDOW)
  return tail.some((l) => BUSY_FOOTER.test(l))
}

const PROMPT_ECHO_LINE = /^>\s+\S/
const BORDER_LINE = /^─+$/
/** The compose box agy draws under every screen is boxed by a rule as wide
 *  as the terminal itself; a markdown horizontal rule inside a response is
 *  drawn short and indented, so width is what separates chrome from
 *  content (real captured screens: 120-column box rules vs. a 6-column
 *  `──────` inside prose). */
const WIDE_BORDER_LINE = /^─{40,}$/
const TOOL_ACTIVITY_LINE = /^\s*[●▸]/
/** Real captured progress lines — a Braille spinner frame followed by the
 *  current activity ("⣽  Working...", "⢿  Verifying Requirements
 *  Thoroughly..."). They sit at the end of the response body and are
 *  rewritten on every frame, so they are chrome, not prose. */
const SPINNER_LINE = /^\s*[⠀-⣿](\s|$)/
/** Real captured hint line agy hangs off its working indicator — e.g.
 *  `└ Tip: Use /model to switch between available models.` It rotates
 *  through different tips while a turn runs, which is exactly the kind of
 *  churn that must never reach the transcript. */
const STATUS_HINT_LINE = /^\s*└/

export interface ExtractResponseOptions {
  /** The prompt actually written into the PTY for this turn. When given,
   *  the echoed prompt is consumed by matching it (across however many
   *  rows it word-wrapped onto) rather than by the blank-line heuristic
   *  below — which silently eats real response text whenever the terminal
   *  has scrolled the blank separator away. */
  prompt?: string
  /** Return '' unless the anchor echo really is this turn's prompt. Used
   *  by progressive reading, where the screen briefly still shows the
   *  PREVIOUS turn's echo and answer after a new prompt is submitted. */
  requirePromptEcho?: boolean
}

const squashWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim()

/** Drops everything from agy's compose box down. The box is unmistakable:
 *  a terminal-width rule, the input line, another terminal-width rule —
 *  and cutting at it (rather than walking up from the last row) is what
 *  keeps whatever agy prints *below* it out of the response. Real captured
 *  example: `└ Tip: You can switch conversations with /resume.`, printed
 *  under the footer, which a backwards walk stops at and then reports as
 *  the assistant's reply. Falls back to trimming the trailing chrome when
 *  no box is on screen. */
function stripComposeChrome(body: string[]): string[] {
  for (let i = body.length - 3; i >= 0; i--) {
    if (!WIDE_BORDER_LINE.test(body[i]!.trim())) continue
    if (!body[i + 1]!.trim().startsWith('>')) continue
    if (!WIDE_BORDER_LINE.test(body[i + 2]!.trim())) continue
    return body.slice(0, i)
  }
  let end = body.length
  while (end > 0 && body[end - 1]!.trim() === '') end--
  // Only the box's lower half is on screen (the echo itself was the input
  // line): the footer sits directly under its closing rule.
  if (end >= 2 && WIDE_BORDER_LINE.test(body[end - 2]!.trim())) end--
  while (end > 0) {
    const trimmed = body[end - 1]!.trim()
    if (trimmed === '' || WIDE_BORDER_LINE.test(trimmed)) { end--; continue }
    break
  }
  return body.slice(0, end)
}

/** Locates the on-screen echo of a known prompt: the `> ...` row it starts
 *  on, and the first row after however many rows it word-wrapped onto.
 *  Returns null when the screen's last echo is some *other* prompt — which
 *  is how a screen still showing the previous turn, or one showing no turn
 *  at all yet, is told apart from this turn's.
 *
 *  Comparison is whitespace-insensitive (the terminal re-wraps and pads) and
 *  accepts a partially drawn echo, since a prompt is rendered a chunk at a
 *  time. */
export function findPromptEcho(lines: string[], prompt: string): { echoIdx: number; bodyStart: number } | null {
  const echoIdx = findLastIndex(lines, (l) => PROMPT_ECHO_LINE.test(l))
  if (echoIdx === -1) return null
  const wanted = squashWhitespace(prompt)
  let seen = squashWhitespace(lines[echoIdx]!.replace(/^>\s*/, ''))
  if (!wanted.startsWith(seen)) return null
  let bodyStart = echoIdx + 1
  while (seen.length < wanted.length && bodyStart < lines.length) {
    const next = squashWhitespace(lines[bodyStart]!)
    if (!next) break
    const merged = squashWhitespace(`${seen} ${next}`)
    if (!wanted.startsWith(merged)) break
    seen = merged
    bodyStart++
  }
  return { echoIdx, bodyStart }
}

/** Whether the screen shows that `prompt` has actually been submitted, as
 *  opposed to still sitting in the compose box waiting for Enter.
 *
 *  The two look alike — agy echoes a prompt into the box as it is typed, so
 *  `> Write a detailed…` is on screen either way — and telling them apart
 *  matters because a screen where nothing has been submitted yet still
 *  carries the *previous* state's ready footer. Real captured difference:
 *  once a prompt is submitted the input clears, so the last input row is a
 *  bare `>`; while it is being typed, that same row still holds the text. */
export function promptHasBeenSubmitted(lines: string[], prompt: string): boolean {
  if (!findPromptEcho(lines, prompt)) return false
  const lastInputIdx = findLastIndex(lines, (l) => l.trim().startsWith('>'))
  return lastInputIdx !== -1 && lines[lastInputIdx]!.trim() === '>'
}

/** Best-effort extraction of "what agy actually said back" from the
 *  visible screen. agy's interactive TUI is a full-redraw display, not a
 *  text stream, so this reconstructs the reply from the screen: everything
 *  after the echoed prompt line ("> ..."), minus UI chrome (the compose
 *  box, borders, footers, tool-activity and spinner rows). Good enough for
 *  ordinary prose; not a pixel-perfect transcript of complex formatting —
 *  see docs/antigravity-transports.md.
 *
 *  Returns '' when the screen contains no prompt echo to anchor against.
 *  CRITICAL (real bug, caught by inspecting the running app): this used to
 *  fall back to returning the WHOLE screen, which on a freshly spawned
 *  session is agy's startup banner — its ASCII logo, version, the signed-in
 *  account's email address, and the workspace path — all of which were then
 *  persisted and displayed as if Antigravity had said them. Without an echo
 *  anchor the response boundary is genuinely unknown, so reporting nothing
 *  is both honest and the only way to avoid leaking that banner. */
export function extractResponseText(lines: string[], options: ExtractResponseOptions = {}): string {
  const echoIdx = findLastIndex(lines, (l) => PROMPT_ECHO_LINE.test(l))
  if (echoIdx === -1) return ''

  const anchor = options.prompt === undefined ? null : findPromptEcho(lines, options.prompt)
  let bodyStart: number
  if (anchor) {
    bodyStart = anchor.bodyStart
  } else {
    if (options.requirePromptEcho) return ''
    // A long prompt word-wraps across multiple physical rows with no blank
    // line between them (confirmed live) — without the prompt to match
    // against, the real response is assumed to start after the next blank
    // line.
    bodyStart = echoIdx + 1
    while (bodyStart < lines.length && lines[bodyStart]!.trim() !== '') bodyStart++
  }

  const kept = stripComposeChrome(lines.slice(bodyStart)).filter((line) => {
    const trimmed = line.trim()
    if (!trimmed) return true // preserve paragraph breaks
    if (BORDER_LINE.test(trimmed)) return false
    if (trimmed === '>') return false // empty compose box
    if (READY_FOOTER.test(trimmed) || BUSY_FOOTER.test(trimmed)) return false
    if (TOOL_ACTIVITY_LINE.test(line)) return false
    if (SPINNER_LINE.test(line)) return false
    if (STATUS_HINT_LINE.test(line)) return false
    return true
  })
  // Trailing cells keep their padding across a redraw, and that padding
  // shifts from frame to frame — trimming it is what makes successive
  // reads of a growing answer comparable.
  return kept.map((line) => line.replace(/\s+$/, '')).join('\n').trim()
}

/** How much of the already-streamed tail must reappear in a new frame for
 *  it to count as the same answer, still growing. Long enough that it
 *  cannot match somewhere else in the response by chance, short enough to
 *  stay inside one redraw. */
const STREAM_ANCHOR_CHARS = 80

const isSpace = (value: string): boolean => value === ' ' || value === '\n' || value === '\t'

/** Where `candidate` continues on from the text already streamed, or -1
 *  when it is not a continuation at all.
 *
 *  agy's TUI is a full-redraw display, not a text stream: as an answer
 *  grows the terminal scrolls and re-wraps, so the same prose reads back
 *  with a blank line or a trailing space more or fewer than last time, and
 *  agy rewrites its own transient work-title above the answer as the turn
 *  progresses. Matching a whole prefix therefore fails constantly (and
 *  stalls streaming for the rest of the turn), while matching nothing
 *  duplicates words already on screen. So the comparison is anchored on
 *  the *tail* of what has been streamed, over visible characters only:
 *  whatever follows that tail in the new frame is genuinely new, no matter
 *  what changed above it. The last occurrence wins, which is the right
 *  reading of a screen that only ever grows downward.
 *
 *  -1 means the streamed tail is not on this screen at all — a redraw
 *  sampled mid-write, or another turn's screen. Callers skip those frames
 *  rather than guess; `run.completed`'s text stays authoritative. */
export function progressiveAppendIndex(streamed: string, candidate: string): number {
  if (streamed === '') return 0
  const anchor: string[] = []
  for (let i = streamed.length - 1; i >= 0 && anchor.length < STREAM_ANCHOR_CHARS; i--) {
    const character = streamed[i]!
    if (!isSpace(character)) anchor.push(character)
  }
  if (anchor.length === 0) return 0
  const needle = anchor.reverse().join('')

  const visible: string[] = []
  const positions: number[] = []
  for (let i = 0; i < candidate.length; i++) {
    const character = candidate[i]!
    if (isSpace(character)) continue
    visible.push(character)
    positions.push(i)
  }
  const found = visible.join('').lastIndexOf(needle)
  if (found === -1) return -1
  return positions[found + needle.length - 1]! + 1
}

/** One piece of work agy drew on its own interactive screen. */
export interface ScreenActivity {
  /** Stable while the same work is on screen, so a redraw (a spinner tick,
   *  a cursor blink) updates a step rather than appending a new one. */
  key: string
  kind: ActivityKind
  /** agy's own wording, never rewritten here. */
  label: string
  command?: string
  target?: string
  durationSeconds?: number
}

// Real captured PTY shapes (agy 1.1.27/1.1.28 — see
// docs/antigravity-transports.md and the checked-in frame fixtures):
//
//   "● Bash(npm run build) (ctrl+o to expand)"
//   "▸ Thought for 11s"
//   "⣽  Verifying Requirements Thoroughly..."
//   "⢿  Working..."
//
// These are the interactive transport's ONLY account of what it is doing:
// stream-json's structured `tool` steps do not exist here. They were
// already being parsed out of the response body as chrome and thrown away;
// this reads them instead of discarding them.
const SCREEN_TOOL_CALL = /^\s*[●▸]\s*([A-Za-z][\w .-]*?)\s*\((.*)\)\s*$/
const THOUGHT_LINE = /^\s*[●▸]\s*Thought for\s+(\d+(?:\.\d+)?)\s*s(?:econds?)?\b/i
/** The trailing "(ctrl+o to expand)" affordance agy appends to a tool row —
 *  a keyboard hint, not part of what the tool is doing. */
const EXPAND_HINT = /\s*\((?:ctrl|cmd)\+\w+ to expand\)\s*$/i
/** A Braille spinner frame followed by agy's own title for what it is
 *  currently doing. The glyph itself rotates every frame and is dropped, so
 *  the same work does not read as new work 8 times a second. */
const SPINNER_STATUS = /^\s*[\u2800-\u28ff]\s+(\S.*?)\s*$/

/** What agy says it is doing right now, read from the live PTY screen.
 *
 *  Purely descriptive: every value returned is text agy itself drew. When
 *  the screen says nothing about the work, this returns nothing and the
 *  caller reports nothing — Orbit never manufactures an activity to fill
 *  the silence. */
export function readScreenActivity(lines: string[]): ScreenActivity[] {
  const found: ScreenActivity[] = []
  const seen = new Set<string>()
  const add = (activity: ScreenActivity): void => {
    if (seen.has(activity.key)) return
    seen.add(activity.key)
    found.push(activity)
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // The clipboard-paste confirmation shares the "▸" marker but is a
    // transport receipt, not work — see MEDIA_ATTACHED_PATTERN.
    if (MEDIA_ATTACHED_PATTERN.test(trimmed)) continue

    const thought = THOUGHT_LINE.exec(trimmed)
    if (thought) {
      // agy prints this once the thinking is over and it knows how long it
      // took, so it is reported as the finished step it describes.
      add({ key: 'screen:thinking', kind: 'thinking', label: 'Thought', durationSeconds: Number(thought[1]) })
      continue
    }

    const call = SCREEN_TOOL_CALL.exec(trimmed.replace(EXPAND_HINT, ''))
    if (call) {
      const tool = call[1]!.trim()
      const argument = call[2]!.trim()
      const facts = screenToolFacts(tool, argument)
      add({ key: `screen:tool:${tool}:${argument}`, label: tool, ...facts })
      continue
    }

    const spinner = SPINNER_STATUS.exec(line)
    if (spinner) {
      // "Verifying Requirements Thoroughly..." -> agy's own words, minus
      // the animated ellipsis it redraws them with.
      const title = spinner[1]!.replace(/\.{2,}$/, '').trim()
      if (!title || READY_FOOTER.test(title) || BUSY_FOOTER.test(title)) continue
      add({ key: `screen:status:${title.toLowerCase()}`, kind: 'working', label: title })
    }
  }
  return found
}

/** Classifies a screen-drawn tool row. The argument agy shows in the
 *  parentheses is the literal command or path, so a shell tool's argument
 *  is preserved verbatim as the command rather than described. */
function screenToolFacts(tool: string, argument: string): { kind: ActivityKind; command?: string; target?: string } {
  const kind = classifyToolName(tool)
  if (!argument) return { kind }
  if (kind === 'running') return { kind, command: argument }
  return { kind, target: argument }
}

export function readMediaAttachedCount(lines: string[]): number {
  let max = 0
  for (const line of lines) {
    const match = line.match(MEDIA_ATTACHED_PATTERN)
    if (match) {
      const count = Number(match[1])
      if (count > max) max = count
    }
  }
  return max
}
