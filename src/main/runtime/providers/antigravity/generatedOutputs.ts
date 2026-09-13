// Finds media Antigravity generated OUTSIDE the workspace during a turn.
//
// Captured live against agy 1.2.2 (see docs/antigravity-transports.md,
// "Generated files"): the `generate_image` tool never writes into the
// project. It saves to agy's own per-conversation folder,
//
//   ~/.gemini/antigravity-cli/brain/<conversation-id>/<ImageName>_<ms>.jpg
//
// and `stream-json` reports only `{tool_name: "generate_image",
// parameters: {ImageName, Prompt}}` — never the path. So a workspace scan
// alone can never see the one thing a user most obviously asked for.
//
// The folder's layout is agy's own and is what makes this precise:
//
//   <id>/<name>_<ms>.jpg          generated images      ← what we want
//   <id>/*.md (+ .metadata.json)  agy's planning docs   ← not media, ignored
//   <id>/.user_uploaded/…         images the USER sent  ← hidden, ignored
//   <id>/.tempmediaStorage/…      agy's scratch media   ← hidden, ignored
//   <id>/.system_generated/…      logs and step output  ← hidden, ignored
//
// Only top-level, non-hidden media files written during the turn count.
//
// The conversation id is known on the structured transport from `init`, and
// on the PTY from the second turn onward. A PTY session's FIRST turn has no
// id anywhere Orbit can read (history.jsonl only records one from the second
// prompt), so that case is resolved from agy's own transcript: the brain
// folder, modified during this turn, whose recorded user input is this
// turn's prompt.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { outputKindFor } from '@shared/outputArtifacts'
import { canonicalDirectory, isWithin } from '@main/artifacts/safePaths'
import { MAX_OUTPUT_BYTES } from '@main/artifacts/outputScan'
import type { GeneratedOutput, GeneratedOutputQuery } from '@main/runtime/provider'

/** agy mints UUIDs; anything else — and in particular anything containing a
 *  path separator or `..` — is refused before it is ever joined to a path. */
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Clock slack between Orbit's turn start and agy's own writes. */
const SKEW_MS = 2000
/** How much of a transcript is read to find the prompt. The user input of
 *  the current turn is near the end; a long conversation's early history is
 *  irrelevant. */
const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024
/** Prompt characters compared. Enough to be unambiguous, few enough that a
 *  hint agy or Orbit appends later in the prompt cannot break the match. */
const PROMPT_EXCERPT_CHARS = 160

export function defaultBrainRoot(): string {
  return process.env.ORBIT_AGY_BRAIN_DIR || path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain')
}

/** agy appends `_<epoch ms>` to the name the model chose. The name without
 *  it is what the model — and so the user — called the image. */
export function displayNameForGenerated(fileName: string): string {
  return fileName.replace(/_\d{13}(\.[^.]+)$/, '$1')
}

export function findGeneratedOutputs(query: GeneratedOutputQuery, brainRoot: string = defaultBrainRoot()): GeneratedOutput[] {
  const root = canonicalDirectory(brainRoot)
  if (!root) return []

  const ids = new Set<string>()
  if (query.nativeConversationId && CONVERSATION_ID.test(query.nativeConversationId)) ids.add(query.nativeConversationId)
  // Also resolved from the transcript when an id is already known: the PTY's
  // history-file lookup is keyed by workspace, so it can name a different
  // conversation that ran in the same folder. The prompt match is the
  // stronger identity; the two are unioned and deduplicated by path.
  const matched = findConversationByPrompt(root, query.prompt, query.startedAtMs)
  if (matched) ids.add(matched)

  const outputs = new Map<string, GeneratedOutput>()
  for (const id of ids) {
    for (const output of listGeneratedMedia(root, id, query.startedAtMs)) outputs.set(output.filePath, output)
  }
  return [...outputs.values()].sort((a, b) => a.modifiedMs - b.modifiedMs)
}

function listGeneratedMedia(root: string, conversationId: string, startedAtMs: number): GeneratedOutput[] {
  const dir = canonicalDirectory(path.join(root, conversationId))
  // The folder must really be inside the brain root — a symlinked
  // conversation folder pointing elsewhere is not agy's output.
  if (!dir || !isWithin(root, dir)) return []

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const found: GeneratedOutput[] = []
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue
    const kind = outputKindFor(entry.name)
    if (kind !== 'image' && kind !== 'video') continue
    const filePath = path.join(dir, entry.name)
    try {
      const stat = fs.lstatSync(filePath)
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_OUTPUT_BYTES) continue
      if (stat.mtimeMs < startedAtMs - SKEW_MS) continue
      found.push({
        filePath,
        root: dir,
        displayName: displayNameForGenerated(entry.name),
        modifiedMs: stat.mtimeMs,
        byteSize: stat.size,
        origin: 'provider-generated'
      })
    } catch {
      // Removed while listing.
    }
  }
  return found
}

/** The brain folder whose transcript records this turn's prompt as user
 *  input, among folders touched since the turn started. Null when there is
 *  no such folder, or no usable prompt to match on. */
export function findConversationByPrompt(root: string, prompt: string, startedAtMs: number): string | null {
  const excerpt = normalize(prompt).slice(0, PROMPT_EXCERPT_CHARS)
  if (excerpt.length < 4) return null

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }

  const candidates: Array<{ id: string; modifiedMs: number }> = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !CONVERSATION_ID.test(entry.name)) continue
    try {
      const modifiedMs = fs.statSync(path.join(root, entry.name)).mtimeMs
      if (modifiedMs >= startedAtMs - SKEW_MS) candidates.push({ id: entry.name, modifiedMs })
    } catch {
      // Vanished.
    }
  }
  // Most recently touched first: the conversation that just ran.
  candidates.sort((a, b) => b.modifiedMs - a.modifiedMs)

  for (const candidate of candidates) {
    const transcript = path.join(root, candidate.id, '.system_generated', 'logs', 'transcript.jsonl')
    if (transcriptHasPrompt(transcript, excerpt, startedAtMs)) return candidate.id
  }
  return null
}

function transcriptHasPrompt(transcriptPath: string, excerpt: string, startedAtMs: number): boolean {
  let text: string
  try {
    const stat = fs.statSync(transcriptPath)
    const start = Math.max(0, stat.size - TRANSCRIPT_TAIL_BYTES)
    const fd = fs.openSync(transcriptPath, 'r')
    try {
      const buffer = Buffer.alloc(stat.size - start)
      fs.readSync(fd, buffer, 0, buffer.length, start)
      text = buffer.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return false
  }

  for (const line of text.split('\n')) {
    if (!line.includes('USER_INPUT')) continue
    let step: { type?: unknown; content?: unknown; created_at?: unknown }
    try {
      step = JSON.parse(line) as typeof step
    } catch {
      continue // The first line of a tail read is usually cut.
    }
    if (step.type !== 'USER_INPUT' || typeof step.content !== 'string') continue
    // An earlier turn that happened to send the same words is not this one.
    const created = typeof step.created_at === 'string' ? Date.parse(step.created_at) : Number.NaN
    if (!Number.isNaN(created) && created < startedAtMs - SKEW_MS) continue
    if (normalize(userRequestOf(step.content)).includes(excerpt)) return true
  }
  return false
}

/** agy wraps what the user sent as `<USER_REQUEST>…</USER_REQUEST>`
 *  followed by its own metadata; only the request is compared. */
function userRequestOf(content: string): string {
  const match = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(content)
  return match ? match[1]! : content
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}
