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

  const numberedIndexed = tail
    .map((l, i) => ({ m: l.match(NUMBERED_OPTION), i }))
    .filter((e): e is { m: RegExpMatchArray; i: number } => e.m !== null)
  if (numberedIndexed.length >= 2) {
    const seen = new Set<string>()
    const options: InteractionOption[] = []
    for (const { m } of numberedIndexed) {
      if (seen.has(m[1]!)) continue
      seen.add(m[1]!)
      options.push({ id: m[1]!, label: m[2]!.trim() })
    }
    if (options.length >= 2) {
      const isPermissionShaped = /permission required|do you want to|do you trust|would you like to/i.test(joined)
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
const TOOL_ACTIVITY_LINE = /^\s*[●▸]/

/** Best-effort extraction of "what agy actually said back", for a screen
 *  that has just settled to the ready-for-input footer after a turn. agy's
 *  interactive TUI is a full-redraw display, not a text stream — there is
 *  no reliable per-token delta the way structured `--output-format
 *  stream-json` provides, so this reconstructs the reply from the visible
 *  screen: everything after the last echoed prompt line ("> ..."), minus
 *  UI chrome (borders, the empty compose box, the footer, tool-activity
 *  lines). Good enough for ordinary prose; not a pixel-perfect transcript
 *  of complex formatting — see docs/antigravity-transports.md. */
export function extractResponseText(lines: string[]): string {
  const echoIdx = findLastIndex(lines, (l) => PROMPT_ECHO_LINE.test(l))
  // A long prompt word-wraps across multiple physical rows with no blank
  // line between them (confirmed live) — the real response always starts
  // only after the next blank line, so skip every non-blank row right
  // after the echo rather than assuming the echo is exactly one row tall.
  let bodyStart = echoIdx + 1
  if (echoIdx !== -1) {
    while (bodyStart < lines.length && lines[bodyStart]!.trim() !== '') bodyStart++
  }
  const body = echoIdx === -1 ? lines : lines.slice(bodyStart)
  const kept = body.filter((line) => {
    const trimmed = line.trim()
    if (!trimmed) return true // preserve paragraph breaks
    if (BORDER_LINE.test(trimmed)) return false
    if (trimmed === '>') return false // empty compose box
    if (READY_FOOTER.test(trimmed) || BUSY_FOOTER.test(trimmed)) return false
    if (TOOL_ACTIVITY_LINE.test(line)) return false
    return true
  })
  return kept.join('\n').trim()
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
