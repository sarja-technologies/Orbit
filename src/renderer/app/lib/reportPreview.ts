// How much of a long reply the transcript shows before asking.
//
// A coding agent's final message for a real task is often a full report:
// what it changed, file by file, then the commands it ran, then a table of
// results. Dropped into the transcript whole, that is several screens of
// scrolling between the reader and the composer, and the one or two
// sentences that actually say what happened are buried in it.
//
// So a long reply opens on its own opening and offers the rest. Three
// rules keep that honest:
//
//  1. The preview is a real prefix of the real message — never a generated
//     or paraphrased summary. Every word shown was written by the model.
//  2. The cut lands on a block boundary, never inside a fence, a table or
//     a list, so what is shown renders as itself rather than as a fragment.
//  3. Anything that reads like a problem keeps the whole message open. A
//     turn can report a failure and still have *succeeded* as a run, and
//     that report is precisely what must not end up behind a button.
//
// Nothing here ever removes content: the full text is one click away in
// every case, and the button says how much is behind it.

/** Below this, a message is not long enough to be worth folding at all. */
const COLLAPSE_MIN_LINES = 26

/** Roughly how many lines of substance the preview aims for. The cut then
 *  moves to the next block boundary, so the real figure varies. */
const PREVIEW_CONTENT_LINES = 10

/** Folding is only worth the button if a real amount stays behind it. */
const MIN_HIDDEN_LINES = 6

/** Words that mean the reader needs the whole thing.
 *
 *  Deliberately broad and deliberately fail-open: matching keeps the
 *  message fully expanded, so a false positive costs some scrolling and a
 *  false negative would cost the reader a failure they never saw. */
const TROUBLE = /\b(error|errors|failed|failing|failure|failures|exception|traceback|panic|denied|unable|couldn'?t|cannot|can'?t|warning|warnings|broke|broken|crash|crashed|timed out|timeout)\b|[✗✘❌⚠]/i

const FENCE = /^\s*```/

export interface ReportPreview {
  /** Whether the transcript should fold this message at all. */
  collapsible: boolean
  /** The real opening of the message, cut at a block boundary. Equal to
   *  the whole source when `collapsible` is false. */
  preview: string
  /** How many lines the fold would hide — what the button reports. */
  hiddenLines: number
}

/** Decides how a settled assistant message is first shown.
 *
 *  `source` is the message's own text. The result is derived purely from
 *  it, so the same message always folds the same way and a re-render can
 *  never change what the reader is looking at. */
export function reportPreview(source: string): ReportPreview {
  const whole: ReportPreview = { collapsible: false, preview: source, hiddenLines: 0 }

  const lines = source.split('\n')
  if (lines.length < COLLAPSE_MIN_LINES) return whole

  const cut = cutIndex(lines)
  if (cut === null) return whole

  const hidden = lines.slice(cut)
  // Trailing blank lines are not content the reader is missing.
  const hiddenLines = hidden.filter((line) => line.trim().length > 0).length
  if (hiddenLines < MIN_HIDDEN_LINES) return whole

  // The whole point of the rule: a report that goes on to describe
  // something going wrong is never folded away from the reader.
  if (TROUBLE.test(hidden.join('\n'))) return whole

  return {
    collapsible: true,
    preview: lines.slice(0, cut).join('\n').trimEnd(),
    hiddenLines
  }
}

/** The first line index that may be hidden, or null when the message has
 *  no boundary to cut on (one enormous code block, say — folding that in
 *  the middle would show a fragment, so it is shown whole).
 *
 *  A boundary is a blank line outside a fence. Blank lines are what
 *  separate every block this Markdown dialect has, so cutting on one can
 *  never land inside a table, a list, a quote or a fence. */
function cutIndex(lines: string[]): number | null {
  let insideFence = false
  let content = 0

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (FENCE.test(line)) {
      insideFence = !insideFence
      content++
      continue
    }
    if (insideFence) {
      content++
      continue
    }
    if (line.trim().length === 0) {
      // A boundary, but only once enough has been shown for the preview to
      // stand on its own — an opening one-line heading is not a summary.
      if (content >= PREVIEW_CONTENT_LINES) return index
      continue
    }
    content++
  }

  return null
}
