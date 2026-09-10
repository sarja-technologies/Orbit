// Reads "what is agy doing right now" off the live PTY screen.
//
// The interactive transport has no structured tool stream the way
// `stream-json` does — the screen is the only source (see
// docs/antigravity-transports.md). What is on it, and captured live against
// agy 1.1.27, is exactly two kinds of row:
//
//   ▸ Thought for 11s                       a settled marker, not live work
//   ⣽  Verifying Requirements Thoroughly…   agy's own live status line
//   ● <tool activity>                       agy's tool-activity rows
//
// Only the last two are live activity. Both are text agy itself renders,
// visibly, to its own users; neither is a reconstruction of anything hidden.
// Orbit never infers a status from the answer text, never guesses what the
// model is thinking, and reports nothing at all when the screen says
// nothing — a turn with no status row on screen produces no activity rather
// than a manufactured one.
import type { ToolActivityKind } from '@shared/runtime-events'

export interface ScreenActivity {
  label: string
  kind: ToolActivityKind
}

/** Real captured progress row: a Braille spinner frame, whitespace, then
 *  agy's own current status ("⣽  Working...", "⢿  Verifying Requirements
 *  Thoroughly..."). The frame character rotates every redraw, which is why
 *  the status text — not the row — is what identifies the activity. */
const SPINNER_STATUS = /^\s*[⠀-⣿]\s+(\S.*?)\s*$/
/** Real captured tool-activity marker (the same rows `extractResponseText`
 *  strips out of the response body). */
const TOOL_ROW = /^\s*[●▸]\s+(\S.*?)\s*$/
/** agy's settled "how long the model thought" marker. Observable, but not
 *  live activity — it describes a phase that is already over, and showing
 *  it as the current step would freeze the activity line on it. */
const THOUGHT_MARKER = /^Thought for\b/i
/** The rotating hint agy hangs off its working indicator ("└ Tip: …").
 *  Churn, not activity. */
const TIP_ROW = /^\s*└/

/** How far back from the bottom of the screen a live status row can be. agy
 *  draws it directly above the compose box, and the compose box is at most a
 *  handful of rows. */
const TAIL_ROWS = 14

/** The single live activity the screen is currently showing, or null.
 *
 *  The LOWEST matching row wins, whichever kind it is. agy's display only
 *  grows downward, so the bottom-most row is the most recent thing it drew
 *  — which makes it the only one that can be claimed to be current.
 *  Preferring a tool row over the spinner beneath it was tempting (a
 *  command is more specific than a phase) but would be a guess: Orbit has
 *  no captured evidence about how long a tool row stays on screen after
 *  its tool finishes, and reporting a finished command as still running is
 *  precisely the lie the activity feed exists to stop telling. */
export function readScreenActivity(lines: readonly string[]): ScreenActivity | null {
  const tail = lines.slice(-TAIL_ROWS)

  let status: ScreenActivity | null = null
  for (const line of tail) {
    if (TIP_ROW.test(line)) continue

    const tool = TOOL_ROW.exec(line)
    if (tool) {
      const label = trimEllipsis(tool[1]!)
      // The thought marker uses the same row shape as a real tool row, so
      // it is excluded by content rather than by position.
      if (label && !THOUGHT_MARKER.test(label)) status = { label, kind: 'tool' }
      continue
    }

    const spinner = SPINNER_STATUS.exec(line)
    if (spinner) {
      const label = trimEllipsis(spinner[1]!)
      // A bare spinner frame with no words after it says nothing.
      if (label) status = { label, kind: 'status' }
    }
  }

  return status
}

/** agy animates a status by appending dots to it, so "Working", "Working."
 *  and "Working..." are the same activity and must not read as three. */
function trimEllipsis(value: string): string {
  return value.replace(/[.…]+$/, '').trim()
}
