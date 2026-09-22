// Writes fixture rows straight into Orbit's real database file, before the
// app is launched against it.
//
// Deliberately NOT a test hook inside the app. Orbit's production code has
// no `__e2e` surface and gains none for this: a transcript is just rows,
// so the fixture is rows, written with the same sql.js the app itself
// uses and read back by the app through its ordinary startup path. Nothing
// in `src/` knows this file exists.
//
// This is what lets the UI scenarios assert on exact prose — a specific
// wide table, a report that mentions a failure in its last line — which a
// real model turn cannot be relied upon to produce verbatim. Scenarios
// that need a real turn live in the live agy suite instead.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const initSqlJs = require('sql.js')

let counter = 0
const id = (prefix) => `${prefix}_e2e_${Date.now().toString(36)}_${counter++}`
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString()

/** Opens the app's database, applies `mutate`, and writes it back in the
 *  exact format `OrbitDatabase.persist()` uses. */
async function withDatabase(orbitDataDir, mutate) {
  const SQL = await initSqlJs()
  const dbPath = path.join(orbitDataDir, 'orbit.sqlite')
  fs.mkdirSync(orbitDataDir, { recursive: true })
  const db = fs.existsSync(dbPath) ? new SQL.Database(fs.readFileSync(dbPath)) : new SQL.Database()
  try {
    const result = mutate(db)
    fs.writeFileSync(dbPath, Buffer.from(db.export()))
    return result
  } finally {
    db.close()
  }
}

/** Reads a single column out of the app's database. Used to assert on
 *  persisted state the UI does not surface directly. */
export async function queryDatabase(orbitDataDir, sql) {
  const SQL = await initSqlJs()
  const dbPath = path.join(orbitDataDir, 'orbit.sqlite')
  if (!fs.existsSync(dbPath)) return []
  const db = new SQL.Database(fs.readFileSync(dbPath))
  try {
    const statement = db.prepare(sql)
    const rows = []
    while (statement.step()) rows.push(statement.getAsObject())
    statement.free()
    return rows
  } finally {
    db.close()
  }
}

/** One Unsorted session, ready for turns. */
export async function seedSession(orbitDataDir, { title = 'E2E Session', model = 'gemini-3.8-flash' } = {}) {
  const conversationId = id('conversation')
  await withDatabase(orbitDataDir, (db) => {
    db.run(
      `INSERT INTO conversations
       (id, project_id, title, provider_id, native_conversation_id, status, transport, model, reasoning_effort, working_directory, title_is_custom, title_state, created_at, updated_at)
       VALUES (?, NULL, ?, 'antigravity', NULL, 'idle', 'structured', ?, NULL, NULL, 1, 'custom', ?, ?)`,
      [conversationId, title, model, iso(), iso()]
    )
  })
  return conversationId
}

/** One completed exchange: the reader's prompt, then the reply, joined by
 *  a run that records which model answered — exactly the shape a real turn
 *  leaves behind. */
export async function seedTurn(
  orbitDataDir,
  conversationId,
  { prompt = 'Do the thing', content, model = 'gemini-3.8-flash', state = 'completed', error = null, sequence }
) {
  const runId = id('run')
  await withDatabase(orbitDataDir, (db) => {
    const next =
      sequence ??
      (() => {
        const statement = db.prepare('SELECT COALESCE(MAX(sequence), 0) AS max FROM messages WHERE conversation_id = ?')
        statement.bind([conversationId])
        statement.step()
        const { max } = statement.getAsObject()
        statement.free()
        return Number(max) + 1
      })()

    const messageStatus = state === 'cancelled' ? 'cancelled' : state === 'failed' ? 'failed' : 'completed'
    db.run(
      `INSERT INTO runs (id, project_id, conversation_id, provider_id, state, started_at, ended_at, cancellation_requested_at, native_run_id, error_json, metadata_json)
       VALUES (?, NULL, ?, 'antigravity', ?, ?, ?, NULL, NULL, ?, ?)`,
      [
        runId,
        conversationId,
        state,
        iso(-5000),
        iso(),
        error ? JSON.stringify(error) : null,
        JSON.stringify({ attachmentFileIds: [], referencedArtifactIds: [], model, reasoningEffort: null })
      ]
    )
    db.run(
      `INSERT INTO messages (id, project_id, conversation_id, run_id, role, content, status, created_at, updated_at, sequence)
       VALUES (?, NULL, ?, ?, 'user', ?, 'completed', ?, ?, ?)`,
      [id('message'), conversationId, runId, prompt, iso(-5000), iso(-5000), next]
    )
    db.run(
      `INSERT INTO messages (id, project_id, conversation_id, run_id, role, content, status, created_at, updated_at, sequence)
       VALUES (?, NULL, ?, ?, 'assistant', ?, ?, ?, ?, ?)`,
      [id('message'), conversationId, runId, content, messageStatus, iso(), iso(), next + 1]
    )
  })
  return runId
}

/** A run left in a non-terminal state, as an Orbit that was killed
 *  mid-turn leaves behind. Startup must settle it rather than showing a
 *  turn that is in flight forever. */
export async function seedInterruptedRun(orbitDataDir, conversationId) {
  const runId = id('run')
  await withDatabase(orbitDataDir, (db) => {
    const statement = db.prepare('SELECT COALESCE(MAX(sequence), 0) AS max FROM messages WHERE conversation_id = ?')
    statement.bind([conversationId])
    statement.step()
    const { max } = statement.getAsObject()
    statement.free()
    db.run(
      `INSERT INTO runs (id, project_id, conversation_id, provider_id, state, started_at, ended_at, cancellation_requested_at, native_run_id, error_json, metadata_json)
       VALUES (?, NULL, ?, 'antigravity', 'running', ?, NULL, NULL, NULL, NULL, ?)`,
      [runId, conversationId, iso(-60_000), JSON.stringify({ attachmentFileIds: [], referencedArtifactIds: [] })]
    )
    db.run(
      `INSERT INTO messages (id, project_id, conversation_id, run_id, role, content, status, created_at, updated_at, sequence)
       VALUES (?, NULL, ?, ?, 'user', 'A turn that never finished', 'completed', ?, ?, ?)`,
      [id('message'), conversationId, runId, iso(-60_000), iso(-60_000), Number(max) + 1]
    )
    db.run('UPDATE conversations SET status = ? WHERE id = ?', ['running', conversationId])
  })
  return runId
}

/** Points the next launch at a specific session, the way quitting from it
 *  would have. */
export async function rememberActiveSession(orbitDataDir, conversationId) {
  await withDatabase(orbitDataDir, (db) => {
    db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('preferences', ?)", [
      JSON.stringify({ lastActiveProjectId: null, lastActiveConversationId: conversationId })
    ])
  })
}
