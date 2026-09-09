/** Session naming is Orbit's concern, not Antigravity's.
 *
 *  Verified against the installed CLI (agy 1.1.28, this machine) before
 *  choosing this: agy exposes no live conversation title anywhere Orbit can
 *  read one.
 *    - `~/.gemini/antigravity-cli/history.jsonl` records only
 *      `{display, timestamp, workspace, conversationId}` — no title (see
 *      nativeConversationHistory.ts, which reads that file for the id).
 *    - `~/.gemini/antigravity-cli/conversation_summaries.db` does have a
 *      `title` column, but it is only written for gracefully-exited
 *      sessions: on this machine it held a single row, with an empty title,
 *      across dozens of real conversations. Orbit's own cancel/shutdown
 *      paths kill agy abruptly, so it would be empty for Orbit sessions in
 *      particular.
 *    - The per-conversation `conversations/<id>.db` files carry no title
 *      table at all.
 *
 *  So the title comes from the user's own first prompt, derived locally.
 *  Deterministic and synchronous on purpose: it costs no second `agy`
 *  process (which the one-owner-per-conversation lifecycle would have to
 *  arbitrate), cannot fail slowly, cannot stall the send, and is directly
 *  testable. */

/** What every session is called until its first substantive prompt names
 *  it. Shared so the runtime that assigns it and the auto-title rule that
 *  looks for it can never drift apart. */
export const DEFAULT_SESSION_TITLE = 'New Session'

/** Kept short enough to read at a glance in the sidebar without truncating,
 *  which is the whole point of titling these at all. */
const MAX_WORDS = 6
const MAX_CHARS = 38
/** Below this the "title" tells the user nothing they cannot see anyway. */
const MIN_CHARS = 3

/** Openers that carry no subject: the ask, not the thing asked about. Only
 *  ever consumed from the front, and only while something is still left
 *  behind them — "help me" therefore derives nothing rather than an empty
 *  title, and the session keeps its default name until a prompt with real
 *  content arrives.
 *
 *  Generic construction verbs ("build me a…", "write a…") belong here
 *  because the object is the subject. Verbs that name a *kind* of work —
 *  fix, debug, refactor, review, explain, deploy — deliberately do not:
 *  "Fix the Login Bug" says more in the sidebar than "Login Bug". */
const LEADING_FILLER = new Set([
  'a',
  'add',
  'an',
  'and',
  'build',
  'can',
  'could',
  'create',
  'design',
  'for',
  'generate',
  'give',
  'have',
  'hey',
  'hi',
  'hello',
  'help',
  'i',
  'implement',
  'just',
  'let',
  'lets',
  "let's",
  'like',
  'make',
  'me',
  'my',
  'need',
  'now',
  'ok',
  'okay',
  'our',
  'please',
  'produce',
  'set',
  'show',
  'so',
  'some',
  'that',
  'the',
  'then',
  'this',
  'to',
  'up',
  'us',
  'want',
  'we',
  'with',
  'would',
  'write',
  'you',
  'your'
])

/** Left lowercase inside a title, the way titles are actually written.
 *  Never applied to the first word. */
const MINOR_WORDS = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'with'])

/** True when a session still carries the name Orbit gave it, and so is
 *  still Orbit's to name. */
export function hasDefaultSessionTitle(title: string): boolean {
  return title.trim() === DEFAULT_SESSION_TITLE
}

/** A concise sidebar title for a session, from the prompt that started it —
 *  or null when the prompt says nothing worth naming ("hi", "help me", an
 *  empty message), in which case the session keeps `New Session` and the
 *  next prompt gets the chance instead.
 *
 *  Never throws: every caller sends the real prompt regardless of what this
 *  returns. */
export function deriveSessionTitle(prompt: string): string | null {
  const source = firstMeaningfulLine(prompt)
  if (!source) return null

  const words = source
    // Sentence-ending punctuation bounds the title; a question mark or full
    // stop is where the useful part stops.
    .split(/(?<=[.!?])\s/)[0]!
    .split(/\s+/)
    .map(cleanWord)
    .filter((word) => word.length > 0)

  let start = 0
  while (start < words.length && LEADING_FILLER.has(words[start]!.toLowerCase())) start += 1
  // Everything was filler: an ask with no subject. Nothing to name.
  if (start >= words.length) return null

  const kept: string[] = []
  let length = 0
  for (const word of words.slice(start, start + MAX_WORDS)) {
    const next = length === 0 ? word.length : length + 1 + word.length
    if (kept.length > 0 && next > MAX_CHARS) break
    kept.push(word)
    length = next
  }
  // Cutting at a word cap can leave a dangling "for"/"on"/"the". Dropping
  // it costs no meaning and stops the title reading as if it were cut off.
  while (kept.length > 1 && MINOR_WORDS.has(kept[kept.length - 1]!.toLowerCase())) kept.pop()
  if (kept.length === 0) return null

  const title = kept.map((word, index) => titleCase(word, index === 0)).join(' ')
  const trimmed = title.length > MAX_CHARS ? title.slice(0, MAX_CHARS).trimEnd() : title
  if (trimmed.length < MIN_CHARS) return null
  // A derived title that lands back on the default is not a rename.
  return hasDefaultSessionTitle(trimmed) ? null : trimmed
}

/** The first line with prose on it, skipping fenced code and quote markers
 *  so a prompt that opens with a pasted snippet still gets named after what
 *  the user actually asked. */
function firstMeaningfulLine(prompt: string): string | null {
  const lines = prompt.split(/\r?\n/)
  let inFence = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    // Markdown heading and quote markers are decoration, not content.
    const stripped = trimmed.replace(/^[#>\-*\s]+/, '').trim()
    if (stripped.length > 0) return stripped
  }
  return null
}

/** Strips the punctuation a word is wrapped in without touching what is
 *  inside it, so `user_id`, `v2.1` and `C++` survive intact. */
function cleanWord(word: string): string {
  return word.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}+#]+$/u, '')
}

/** Sentence-style title casing that leaves a word alone when it already
 *  carries capitals of its own — `API`, `TypeScript` and `iOS` are how the
 *  user wrote them and how they should read back. */
function titleCase(word: string, first: boolean): string {
  if (/[A-Z]/.test(word.slice(1))) return word
  const lower = word.toLowerCase()
  if (!first && MINOR_WORDS.has(lower)) return lower
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}
