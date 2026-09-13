// Foreign keys, as the schema declares them, actually hold.
//
// Real bug found while building artifact cleanup: `PRAGMA foreign_keys` is
// per connection, and sql.js's export() — called after every write to
// persist the database — reopens it, turning enforcement off. No
// ON DELETE CASCADE ever ran: a deleted session left its messages, runs,
// run events and artifact versions behind, and those version rows kept
// "referencing" copies that could then never be reclaimed.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrbitDatabase } from '../../src/main/persistence/database'
import { OrbitStore } from '../../src/main/persistence/store'
import { numberValue } from '../../src/main/persistence/database'

let dir = ''
let db: OrbitDatabase
let store: OrbitStore

const count = (sql: string): number => db.get(sql, [], (row) => numberValue(row, 'n')) ?? 0

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-integrity-'))
  db = new OrbitDatabase({ dataDir: dir })
  await db.init()
  store = new OrbitStore(db)
})

afterEach(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('foreign keys', () => {
  it('stay enforced after writes are persisted', () => {
    store.createConversation(null, 'A')
    store.createConversation(null, 'B')
    expect(db.get('PRAGMA foreign_keys', [], (row) => numberValue(row, 'foreign_keys'))).toBe(1)
  })

  it('cascade a deleted session to its messages, runs, run events and artifact versions', () => {
    const conversation = store.createConversation(null, 'Doomed')
    const run = store.createRun({ projectId: null, conversationId: conversation.id })
    store.createMessage({ projectId: null, conversationId: conversation.id, runId: run.id, role: 'assistant', content: 'hi', status: 'completed' })
    store.addRunEvent({ type: 'run.cancelled', projectId: null, conversationId: conversation.id, runId: run.id, providerId: 'antigravity', createdAt: 'now' })
    store.createArtifact({ projectId: null, creatorConversationId: conversation.id, creatorRunId: run.id, type: 'image', name: 'a.png', source: 'provider', location: '/nowhere/a.png', previewKind: 'image', mimeType: 'image/png', byteSize: 1, contentHash: 'h' })

    store.deleteConversation(conversation.id)

    expect(count('SELECT COUNT(*) AS n FROM messages')).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM runs')).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM run_events')).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM artifacts')).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM artifact_versions')).toBe(0)
  })

  it('keep a project’s imported artifact when its session goes, clearing only the link', () => {
    const project = store.createProject('P')
    const conversation = store.createConversation(project.id, 'S')
    const { artifact } = store.createArtifact({ projectId: project.id, creatorConversationId: conversation.id, creatorRunId: null, type: 'other', name: 'brief.pdf', source: 'user-import', location: '/nowhere/brief.pdf', previewKind: 'metadata', mimeType: null, byteSize: 1, contentHash: 'h' })

    store.deleteConversation(conversation.id)

    expect(store.getArtifact(artifact.id)?.creatorConversationId).toBeNull()
  })
})

describe('repairing what the bug left behind', () => {
  it('removes orphaned rows on open, exactly as the cascades would have, and is idempotent', async () => {
    const survivor = store.createConversation(null, 'Survivor')
    const kept = store.createMessage({ projectId: null, conversationId: survivor.id, runId: null, role: 'user', content: 'still here', status: 'completed' })
    // Recreate the damage: rows whose owners were deleted without cascading.
    db.exec('PRAGMA foreign_keys = OFF')
    db.exec("INSERT INTO messages (id, project_id, conversation_id, run_id, role, content, status, created_at, updated_at, sequence) VALUES ('m_orphan', NULL, 'conversation_gone', NULL, 'user', 'x', 'completed', 'now', 'now', 1)")
    db.exec("INSERT INTO runs (id, project_id, conversation_id, provider_id, state, started_at, metadata_json) VALUES ('r_orphan', NULL, 'conversation_gone', 'antigravity', 'completed', 'now', '{}')")
    db.exec("INSERT INTO run_events (id, run_id, event_type, payload_json, created_at, sequence) VALUES ('e_orphan', 'run_gone', 'x', '{}', 'now', 1)")
    db.exec("INSERT INTO artifacts (id, project_id, creator_conversation_id, creator_run_id, type, name, source, location, preview_kind, mime_type, metadata_json, created_at, updated_at) VALUES ('a_orphan', NULL, 'conversation_gone', NULL, 'image', 'x.png', 'provider', '/x', 'image', NULL, '{}', 'now', 'now')")
    db.exec("INSERT INTO artifact_versions (id, artifact_id, version_number, location, preview_location, mime_type, byte_size, content_hash, metadata_json, created_at) VALUES ('v_orphan', 'artifact_gone', 1, '/x', '/x', NULL, 1, 'h', '{}', 'now')")
    db.close()

    db = new OrbitDatabase({ dataDir: dir })
    await db.init()
    store = new OrbitStore(db)

    expect(count("SELECT COUNT(*) AS n FROM messages WHERE id = 'm_orphan'")).toBe(0)
    expect(count("SELECT COUNT(*) AS n FROM runs WHERE id = 'r_orphan'")).toBe(0)
    expect(count("SELECT COUNT(*) AS n FROM run_events WHERE id = 'e_orphan'")).toBe(0)
    expect(count("SELECT COUNT(*) AS n FROM artifacts WHERE id = 'a_orphan'")).toBe(0)
    expect(count("SELECT COUNT(*) AS n FROM artifact_versions WHERE id = 'v_orphan'")).toBe(0)
    expect(store.getConversation(survivor.id)).not.toBeNull()
    expect(count(`SELECT COUNT(*) AS n FROM messages WHERE id = '${kept.id}'`)).toBe(1)

    db.close()
    db = new OrbitDatabase({ dataDir: dir })
    await expect(db.init()).resolves.toBeUndefined()
    store = new OrbitStore(db)
    expect(store.getConversation(survivor.id)).not.toBeNull()
  })
})
