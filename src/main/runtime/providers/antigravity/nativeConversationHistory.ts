// Recovers a PTY session's native Antigravity conversation id from agy's
// own local history file, instead of any live terminal interaction.
//
// Investigated live (agy 1.1.27, this machine) as the safer alternative to
// the removed `/help`-scrape approach (see AntigravityPtySession's
// nativeConversationId doc comment and docs/antigravity-transports.md for
// why that hung the whole session):
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
// This is a plain, bounded file read — it cannot hang or otherwise affect
// the live PTY session the way writing into its terminal can.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Computed per call (not cached) so it reflects the real home directory
 *  at call time — this also makes the function trivially testable by
 *  overriding `process.env.HOME`, without needing a fresh module import. */
function historyPath(): string {
  return path.join(os.homedir(), '.gemini', 'antigravity-cli', 'history.jsonl')
}

/** Bounds how much of a long-lived, ever-growing history file gets read —
 *  we only ever care about the most recent entries for the current
 *  process's own workspace. */
const MAX_TAIL_BYTES = 512 * 1024

interface HistoryEntry {
  display?: unknown
  workspace?: unknown
  conversationId?: unknown
}

/** Best-effort, synchronous: returns the most recently recorded native
 *  conversation id for prompts sent against `workspacePath`, or null if
 *  none is found (never throws — a missing/unreadable/unparseable history
 *  file just means this optional capture doesn't happen, matching every
 *  other best-effort fallback in this transport). Not verified outside
 *  Linux — `~/.gemini` is assumed to hold the same meaning via
 *  `os.homedir()` on macOS/Windows, but that assumption itself is
 *  untested there.
 *
 *  `historyFilePath` is test-only: overriding `process.env.HOME` does not
 *  reliably reach `os.homedir()`'s native binding under vitest's threaded
 *  worker pool (confirmed — it works in a plain Node process, but not
 *  there), so tests inject a real temp-file path directly instead. */
export function findRecentConversationId(workspacePath: string, historyFilePath?: string): string | null {
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
      if (typeof entry.conversationId === 'string' && entry.conversationId.length > 0) return entry.conversationId
    }
    return null
  } catch {
    return null
  }
}
