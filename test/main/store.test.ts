import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrbitDatabase } from '../../src/main/persistence/database'
import { OrbitStore } from '../../src/main/persistence/store'
import { DEFAULT_SESSION_TITLE } from '../../src/shared/sessionTitle'
import type { RuntimeEvent } from '../../src/shared/runtime-events'

let dir = ''
let db: OrbitDatabase
let store: OrbitStore

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-store-'))
  db = new OrbitDatabase({ dataDir: dir })
  await db.init()
  store = new OrbitStore(db)
})

afterEach(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('OrbitStore', () => {
  it('persists a model and reasoning effort per conversation', () => {
    const project = store.createProject('Launch')
    const conversation = store.createConversation(project.id, 'Website')

    // A brand-new conversation carries no selection at all — Orbit must not
    // start one on a model the user never picked.
    expect(conversation.model).toBeNull()
    expect(conversation.reasoningEffort).toBeNull()

    store.setConversationModel(conversation.id, 'gemini-3.8-flash', 'medium')
    const saved = store.getConversation(conversation.id)
    expect(saved?.model).toBe('gemini-3.8-flash')
    expect(saved?.reasoningEffort).toBe('medium')

    // Selecting a model with no reasoning tiers must clear a stale effort
    // rather than leaving one behind that the model cannot honour.
    store.setConversationModel(conversation.id, 'claude-sonnet-4-6', null)
    const cleared = store.getConversation(conversation.id)
    expect(cleared?.model).toBe('claude-sonnet-4-6')
    expect(cleared?.reasoningEffort).toBeNull()

    // And returning to the default is a real, persisted state.
    store.setConversationModel(conversation.id, null, null)
    const reset = store.getConversation(conversation.id)
    expect(reset?.model).toBeNull()
  })

  it('round trips projects, conversations, messages, runs, and artifacts', () => {
    const project = store.createProject('Launch')
    const conversation = store.createConversation(project.id, 'Website')
    const run = store.createRun({ projectId: project.id, conversationId: conversation.id })
    store.createMessage({
      projectId: project.id,
      conversationId: conversation.id,
      runId: run.id,
      role: 'user',
      content: 'Build a page',
      status: 'completed'
    })
    const artifact = store.createArtifact({
      projectId: project.id,
      creatorConversationId: conversation.id,
      creatorRunId: run.id,
      type: 'html',
      name: 'index.html',
      source: 'provider',
      location: '/tmp/index.html',
      previewKind: 'html',
      mimeType: 'text/html',
      byteSize: 12,
      contentHash: 'hash'
    })
    const snapshot = store.openProjectSnapshot(project.id)
    expect(snapshot.project.name).toBe('Launch')
    expect(snapshot.conversations).toHaveLength(1)
    expect(snapshot.messages[0]?.content).toBe('Build a page')
    expect(snapshot.runs[0]?.id).toBe(run.id)
    expect(snapshot.artifacts[0]?.id).toBe(artifact.artifact.id)
    expect(snapshot.artifactVersions[0]?.artifactId).toBe(artifact.artifact.id)
  })

  it('persists to disk across database instances', async () => {
    const project = store.createProject('Persistent')
    db.close()
    db = new OrbitDatabase({ dataDir: dir })
    await db.init()
    store = new OrbitStore(db)
    expect(store.getProject(project.id)?.name).toBe('Persistent')
  })

  it('persists a project folder and a per-session override', () => {
    const project = store.createProject('Website', '/home/dev/agentdock')
    const inherits = store.createConversation(project.id, 'Copy')
    const overrides = store.createConversation(project.id, 'Docs', { workingDirectory: '/home/dev/docs' })

    expect(store.getProject(project.id)?.rootPath).toBe('/home/dev/agentdock')
    // null is a real value: "this session uses the project's folder".
    expect(inherits.workingDirectory).toBeNull()
    expect(store.getConversation(overrides.id)?.workingDirectory).toBe('/home/dev/docs')
  })

  it('treats a blank folder as no folder rather than an empty path', () => {
    const project = store.createProject('Blank', '   ')
    expect(project.rootPath).toBeNull()
    expect(store.createConversation(project.id, 'Main', { workingDirectory: '' }).workingDirectory).toBeNull()
  })

  it('changes a project folder and clears a session override', () => {
    const project = store.createProject('Movable', '/home/dev/one')
    const conversation = store.createConversation(project.id, 'Main', { workingDirectory: '/home/dev/two' })

    expect(store.setProjectRoot(project.id, '/home/dev/three').rootPath).toBe('/home/dev/three')
    expect(store.setConversationWorkingDirectory(conversation.id, null).workingDirectory).toBeNull()
  })

  it('groups every project with its own sessions, newest project first', () => {
    const first = store.createProject('First')
    const second = store.createProject('Second')
    store.createConversation(first.id, 'A')
    store.createConversation(first.id, 'B')
    store.createConversation(second.id, 'C')

    const tree = store.listProjectTree()
    expect(tree.map((group) => group.project.name)).toEqual(['Second', 'First'])
    expect(tree[0]?.conversations.map((item) => item.title)).toEqual(['C'])
    expect(tree[1]?.conversations.map((item) => item.title).sort()).toEqual(['A', 'B'])
  })

  it('seeds a session with the reasoning tier it was created with', () => {
    const project = store.createProject('Seeded')
    expect(store.createConversation(project.id, 'Default').reasoningEffort).toBeNull()
    expect(store.createConversation(project.id, 'Seeded', { reasoningEffort: 'high' }).reasoningEffort).toBe('high')
  })

  it('round trips reasoning preferences across database instances', async () => {
    expect(store.readPreferences()).toEqual({ defaultModel: null, lastReasoningEffort: null, modelReasoningEfforts: {} })
    store.writePreferences({ defaultModel: null, lastReasoningEffort: 'high', modelReasoningEfforts: { 'gemini-3.1-pro': 'low' } })

    db.close()
    db = new OrbitDatabase({ dataDir: dir })
    await db.init()
    store = new OrbitStore(db)

    expect(store.readPreferences()).toEqual({ defaultModel: null, lastReasoningEffort: 'high', modelReasoningEfforts: { 'gemini-3.1-pro': 'low' } })
  })

  it('overwrites preferences in place rather than accumulating rows', () => {
    store.writePreferences({ defaultModel: null, lastReasoningEffort: 'low', modelReasoningEfforts: {} })
    store.writePreferences({ defaultModel: null, lastReasoningEffort: 'medium', modelReasoningEfforts: {} })
    expect(store.readPreferences().lastReasoningEffort).toBe('medium')
  })

  it('names an unnamed session New Session, so first-prompt titling can claim it', () => {
    const project = store.createProject('Naming')
    expect(store.createConversation(project.id, '').title).toBe(DEFAULT_SESSION_TITLE)
    expect(store.createConversation(project.id, '   ').title).toBe(DEFAULT_SESSION_TITLE)
  })

  it('auto-titles a session that still carries the default name', () => {
    const project = store.createProject('Naming')
    const session = store.createConversation(project.id, DEFAULT_SESSION_TITLE)

    expect(store.autoTitleConversation(session.id, 'Robotics Landing Page')?.title).toBe('Robotics Landing Page')
    expect(store.getConversation(session.id)?.title).toBe('Robotics Landing Page')
  })

  it('auto-titles at most once, because the default name is gone afterwards', () => {
    const project = store.createProject('Naming')
    const session = store.createConversation(project.id, DEFAULT_SESSION_TITLE)
    store.autoTitleConversation(session.id, 'Robotics Landing Page')

    // Whatever a later message would have derived, the session is named.
    expect(store.autoTitleConversation(session.id, 'Something Else')).toBeNull()
    expect(store.getConversation(session.id)?.title).toBe('Robotics Landing Page')
  })

  it('never auto-titles over a name the user chose', () => {
    const project = store.createProject('Naming')
    const session = store.createConversation(project.id, DEFAULT_SESSION_TITLE)
    store.renameConversation(session.id, 'Ship checklist')

    expect(store.autoTitleConversation(session.id, 'Robotics Landing Page')).toBeNull()
    expect(store.getConversation(session.id)?.title).toBe('Ship checklist')
  })

  it('never auto-titles over a user who renamed a session back to the default', () => {
    // The title alone cannot tell these apart, which is exactly why the
    // store records that the user chose it.
    const project = store.createProject('Naming')
    const session = store.createConversation(project.id, DEFAULT_SESSION_TITLE)
    store.renameConversation(session.id, 'Draft')
    store.renameConversation(session.id, DEFAULT_SESSION_TITLE)

    expect(store.autoTitleConversation(session.id, 'Robotics Landing Page')).toBeNull()
    expect(store.getConversation(session.id)?.title).toBe(DEFAULT_SESSION_TITLE)
  })

  it('declines an empty auto-title rather than blanking the session name', () => {
    const project = store.createProject('Naming')
    const session = store.createConversation(project.id, DEFAULT_SESSION_TITLE)

    expect(store.autoTitleConversation(session.id, '   ')).toBeNull()
    expect(store.getConversation(session.id)?.title).toBe(DEFAULT_SESSION_TITLE)
  })

  it('remembers a user-chosen name across database instances', async () => {
    const project = store.createProject('Naming')
    const session = store.createConversation(project.id, DEFAULT_SESSION_TITLE)
    store.renameConversation(session.id, 'Ship checklist')
    db.close()

    db = new OrbitDatabase({ dataDir: dir })
    await db.init()
    store = new OrbitStore(db)

    // The flag is persisted, not merely in-memory for this launch.
    expect(store.autoTitleConversation(session.id, 'Robotics Landing Page')).toBeNull()
    expect(store.getConversation(session.id)?.title).toBe('Ship checklist')
  })

  it('opens a database written before projects and sessions had folders', async () => {
    // Exactly the pre-migration shape: no root_path, no working_directory.
    db.close()
    fs.rmSync(path.join(dir, 'orbit.sqlite'), { force: true })
    const legacy = new OrbitDatabase({ dataDir: dir })
    await legacy.init()
    legacy.exec('DROP TABLE conversations; DROP TABLE projects;')
    legacy.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`)
    legacy.exec(
      `CREATE TABLE conversations (
         id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, provider_id TEXT NOT NULL,
         native_conversation_id TEXT, status TEXT NOT NULL, transport TEXT NOT NULL DEFAULT 'structured',
         model TEXT, reasoning_effort TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`
    )
    legacy.run('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', ['p1', 'Legacy', 'now', 'now'])
    legacy.run(
      `INSERT INTO conversations (id, project_id, title, provider_id, native_conversation_id, status, transport, model, reasoning_effort, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['c1', 'p1', 'Old session', 'antigravity', null, 'idle', 'structured', null, null, 'now', 'now']
    )
    legacy.close()

    db = new OrbitDatabase({ dataDir: dir })
    await db.init()
    store = new OrbitStore(db)

    // The session is grouped under its existing project and keeps its title;
    // the new folder columns simply read as "no folder chosen".
    const tree = store.listProjectTree()
    expect(tree).toHaveLength(1)
    expect(tree[0]?.project.name).toBe('Legacy')
    expect(tree[0]?.project.rootPath).toBeNull()
    expect(tree[0]?.conversations.map((item) => item.title)).toEqual(['Old session'])
    expect(tree[0]?.conversations[0]?.workingDirectory).toBeNull()

    // The title column added for auto-titling migrated in too, and a stored
    // session keeps working: it is named, so it is never a titling
    // candidate, and it can still be renamed and sent to.
    expect(store.autoTitleConversation('c1', 'Something Derived')).toBeNull()
    expect(store.renameConversation('c1', 'Renamed session').title).toBe('Renamed session')
    expect(store.getConversation('c1')?.title).toBe('Renamed session')
  })

  it('auto-titles a stored session that predates the title_is_custom column', async () => {
    // The case above never reads title_is_custom: its session is named, so
    // the title check declines first. A stored session actually *called*
    // `New Session` is the one that reaches the migrated column — and if
    // reading it ever threw, the runtime's catch would swallow it and the
    // session would silently never be titled again.
    db.close()
    fs.rmSync(path.join(dir, 'orbit.sqlite'), { force: true })
    const legacy = new OrbitDatabase({ dataDir: dir })
    await legacy.init()
    legacy.exec('DROP TABLE conversations; DROP TABLE projects;')
    legacy.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`)
    legacy.exec(
      `CREATE TABLE conversations (
         id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, provider_id TEXT NOT NULL,
         native_conversation_id TEXT, status TEXT NOT NULL, transport TEXT NOT NULL DEFAULT 'structured',
         model TEXT, reasoning_effort TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`
    )
    legacy.run('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', ['p1', 'Legacy', 'now', 'now'])
    legacy.run(
      `INSERT INTO conversations (id, project_id, title, provider_id, native_conversation_id, status, transport, model, reasoning_effort, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['c1', 'p1', DEFAULT_SESSION_TITLE, 'antigravity', null, 'idle', 'structured', null, null, 'now', 'now']
    )
    legacy.close()

    db = new OrbitDatabase({ dataDir: dir })
    await db.init()
    store = new OrbitStore(db)

    // The migration backfills 0, so the session is still Orbit's to name.
    expect(store.autoTitleConversation('c1', 'Robotics Landing Page')?.title).toBe('Robotics Landing Page')
    expect(store.getConversation('c1')?.title).toBe('Robotics Landing Page')
    // ...and having been named, it is done: no second rename.
    expect(store.autoTitleConversation('c1', 'Something Else')).toBeNull()
  })
})

// The streaming fix, at the layer it was actually broken in. Every write
// through sql.js serializes and rewrites the WHOLE database file,
// synchronously, on Electron's main thread — the thread that also has to
// read agy's output and forward it to the renderer. Storing a row per
// `text.delta` therefore charged O(database size) to every few words of a
// reply, which is what turned incremental output into one late lump.
describe('run event history', () => {
  const runtimeEvent = (runId: string, event: Partial<RuntimeEvent> & { type: RuntimeEvent['type'] }): RuntimeEvent =>
    ({ projectId: 'p1', conversationId: 'c1', runId, providerId: 'antigravity', createdAt: 'now', ...event }) as RuntimeEvent

  const setup = () => {
    const project = store.createProject('Events', null)
    const conversation = store.createConversation(project.id, 'Session', {})
    const run = store.createRun({ projectId: project.id, conversationId: conversation.id })
    return { project, conversation, run }
  }

  const storedTypes = (runId: string): string[] =>
    db.query('SELECT event_type FROM run_events WHERE run_id = ? ORDER BY sequence', [runId], (row) => String(row.event_type))

  it('does not store a row per streamed text delta', () => {
    const { project, conversation, run } = setup()
    for (let i = 0; i < 50; i++) {
      store.addRunEvent(runtimeEvent(run.id, { type: 'text.delta', projectId: project.id, conversationId: conversation.id, delta: 'more words ' }))
    }
    expect(storedTypes(run.id)).toEqual([])
  })

  it('still stores every event that is not a text delta', () => {
    const { project, conversation, run } = setup()
    const base = { projectId: project.id, conversationId: conversation.id }
    store.addRunEvent(runtimeEvent(run.id, { type: 'run.started', nativeConversationId: 'native-1', ...base }))
    store.addRunEvent(runtimeEvent(run.id, { type: 'text.delta', delta: 'ignored', ...base }))
    store.addRunEvent(runtimeEvent(run.id, { type: 'tool.activity', label: 'run_command', status: 'running', kind: 'running', command: 'npm test', ...base }))
    store.addRunEvent(runtimeEvent(run.id, { type: 'run.completed', finalText: 'Done.', ...base }))

    expect(storedTypes(run.id)).toEqual(['run.started', 'tool.activity', 'run.completed'])
    // Sequencing is unbroken by the skipped deltas.
    const sequences = db.query('SELECT sequence FROM run_events WHERE run_id = ? ORDER BY sequence', [run.id], (row) => Number(row.sequence))
    expect(sequences).toEqual([1, 2, 3])
  })

  it('keeps the structured activity facts it stores', () => {
    const { project, conversation, run } = setup()
    store.addRunEvent(
      runtimeEvent(run.id, {
        type: 'tool.activity',
        label: 'run_command',
        status: 'running',
        kind: 'running',
        command: 'npm run build -- --watch',
        projectId: project.id,
        conversationId: conversation.id
      })
    )
    const [payload] = db.query('SELECT payload_json FROM run_events WHERE run_id = ?', [run.id], (row) => String(row.payload_json))
    expect(JSON.parse(payload!)).toMatchObject({ kind: 'running', command: 'npm run build -- --watch' })
  })
})

describe('database durability', () => {
  it('writes coalesced changes to disk, so a reopened database sees them all', async () => {
    const project = store.createProject('Durable', null)
    for (let i = 0; i < 20; i++) store.createConversation(project.id, `Session ${i}`, {})
    // close() flushes synchronously; nothing may be lost to the coalescing.
    db.close()

    db = new OrbitDatabase({ dataDir: dir })
    await db.init()
    store = new OrbitStore(db)
    expect(store.listProjectTree()[0]?.conversations).toHaveLength(20)
  })

  it('flushes on demand without waiting for the coalescing window', async () => {
    const project = store.createProject('Flush', null)
    db.flush()

    const reader = new OrbitDatabase({ dataDir: dir })
    await reader.init()
    expect(new OrbitStore(reader).getProject(project.id)?.name).toBe('Flush')
    reader.close()
  })
})

