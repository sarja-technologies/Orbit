// Recovers a PTY session's native Antigravity conversation id from agy's
// own local history file, instead of any live terminal interaction.
//
// Investigated live (agy 1.1.27, re-confirmed on 1.2.8) as the safer
// alternative to the removed `/help`-scrape approach (see
// AntigravityPtySession's nativeConversationId doc comment and
// docs/antigravity-transports.md for why that hung the whole session):
//
//   ~/.gemini/antigravity-cli/history.jsonl — one JSON object per prompt
//   ever sent to agy (across every tool on the machine, not just Orbit):
//   `{"display": "<prompt text>", "timestamp": <ms>, "workspace": "<cwd>"}`,
//   gaining a `"conversationId"` field once agy has assigned one to that
//   conversation. Confirmed live: the FIRST prompt of a brand-new
//   conversation is logged without a conversationId (agy hasn't minted one
//   yet at prompt-send time); the SECOND and later prompts in the same
//   conversation carry it. Written as each prompt is sent, not on process
//   exit — unlike `conversation_summaries.db` (also investigated: only
//   populated for gracefully-exited sessions, confirmed empty for every
//   session this task killed abruptly, which is exactly how Orbit's own
//   shutdown/crash paths behave — not a usable signal here).
//
//   `display` holds the prompt VERBATIM, not a truncation: the longest
//   entry in a real 200KB history on this machine is 8189 characters and
//   retains its newlines. That is what makes matching on it sound.
//
// ## Why the workspace is not enough to identify a conversation
//
// This used to answer "the most recent conversation id recorded for this
// workspace", which is a different question from "this session's
// conversation id" — and the difference is a real cross-wiring bug, not a
// theoretical one. Every session in an Orbit project shares that project's
// folder, so two sessions in one project share a workspace. Session B's
// first turn is logged without an id, so a backward scan would walk
// straight past it and return session A's id; B would then persist A's id
// and resume into A's conversation on its next turn, inheriting a history
// the user never put there.
//
// Measured, not assumed: in the real history file on this machine, 2 of
// 361 workspaces already carry more than one distinct conversation id, one
// of them six.
//
// So a candidate entry must now prove it belongs to the calling session:
// same workspace, logged no earlier than the session began, AND carrying a
// prompt that session actually delivered. If two different conversation
// ids both satisfy that (the one genuinely ambiguous case: two concurrent
// sessions in one folder sending byte-identical prompts), nothing is
// returned at all. Declining to capture costs a resume; guessing wrong
// would hand the user someone else's conversation.
//
// This is a plain, bounded file read — it cannot hang or otherwise affect
// the live PTY session the way writing into its terminal can.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Computed per call (not cached) so it reflects the real home directory
 *  at call time. */
function historyPath(): string {
  return path.join(os.homedir(), '.gemini', 'antigravity-cli', 'history.jsonl')
}

/** Bounds how much of a long-lived, ever-growing history file gets read —
 *  we only ever care about the most recent entries for the current
 *  process's own workspace. */
const MAX_TAIL_BYTES = 512 * 1024

/** Absorbs clock skew between agy writing its timestamp and Orbit reading
 *  its own `Date.now()`, so a prompt logged a moment "before" the session
 *  started is still eligible. Small enough that it cannot reach back into
 *  a previous session's turns. */
const TIMESTAMP_SKEW_MS = 5_000

interface HistoryEntry {
  display?: unknown
  workspace?: unknown
  timestamp?: unknown
  conversationId?: unknown
}

export interface ConversationIdLookup {
  /** The real folder this session's agy process is running in. */
  workspacePath: string
  /** When this session began, in epoch ms. Entries older than this cannot
   *  belong to it. */
  notBeforeMs: number
  /** The prompt texts this session actually delivered, exactly as they
   *  were written to the terminal. An entry whose `display` is not one of
   *  these was logged by some other session. */
  prompts: readonly string[]
  /** Test-only: overriding `process.env.HOME` does not reliably reach
   *  `os.homedir()`'s native binding under vitest's threaded worker pool
   *  (confirmed — it works in a plain Node process, but not there), so
   *  tests inject a real temp-file path directly instead. */
  historyFilePath?: string
}

/** Best-effort and synchronous: the native conversation id agy recorded
 *  for THIS session, or null when there is no unambiguous answer (never
 *  throws — a missing/unreadable/unparseable history file just means this
 *  optional capture doesn't happen, matching every other best-effort
 *  fallback in this transport). */
export function findRecentConversationId(lookup: ConversationIdLookup): string | null {
  const { workspacePath, notBeforeMs, prompts, historyFilePath } = lookup
  // Nothing was delivered, so nothing in the file can be ours.
  if (prompts.length === 0) return null
  const delivered = new Set(prompts)
  const earliest = notBeforeMs - TIMESTAMP_SKEW_MS

  try {
    const target = historyFilePath ?? historyPath()
    const stat = fs.statSync(target)
    const start = Math.max(0, stat.size - MAX_TAIL_BYTES)
    const fd = fs.openSync(target, 'r')
    let text: string
    try {
      const buffer = Buffer.alloc(stat.size - start)
      fs.readSync(fd, buffer, 0, buffer.length, start)
      text = buffer.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }

    // Every id this session can prove is its own. Collected rather than
    // returned on first hit so an ambiguous result can be recognized as
    // ambiguous instead of silently resolved by scan order.
    const mine = new Set<string>()
    let newest: string | null = null

    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim()
      if (!line) continue
      let entry: HistoryEntry
      try {
        entry = JSON.parse(line) as HistoryEntry
      } catch {
        continue // a truncated first/last line from the byte-offset read
      }
      if (entry.workspace !== workspacePath) continue
      if (typeof entry.timestamp !== 'number' || entry.timestamp < earliest) continue
      if (typeof entry.display !== 'string' || !delivered.has(entry.display)) continue
      if (typeof entry.conversationId !== 'string' || entry.conversationId.length === 0) continue
      if (newest === null) newest = entry.conversationId
      mine.add(entry.conversationId)
    }

    // One session means one native conversation. Two distinct ids carrying
    // this session's own prompts means the evidence cannot tell them
    // apart, and a wrong answer is worse than none.
    if (mine.size !== 1) return null
    return newest
  } catch {
    return null
  }
}
