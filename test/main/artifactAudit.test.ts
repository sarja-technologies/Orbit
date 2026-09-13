// An audit of the artifact system as it actually behaves, written as
// assertions so the answers stay true.
//
// The questions: what puts something into Artifacts, does it survive a
// reload, is the count right, does it open, and is it attributed to the
// right session and project. Ordinary project-file tracking must be
// unaffected by any of it.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrbitDatabase } from '../../src/main/persistence/database'
import { OrbitStore } from '../../src/main/persistence/store'
import { FileStorage } from '../../src/main/files/fileStorage'
import { ArtifactService } from '../../src/main/artifacts/artifactService'

let dir = ''
let source = ''
let db: OrbitDatabase
let store: OrbitStore
let artifacts: ArtifactService

async function openDatabase(): Promise<void> {
  db = new OrbitDatabase({ dataDir: dir })
  await db.init()
  store = new OrbitStore(db)
  artifacts = new ArtifactService(store, new FileStorage(dir))
}

function sourceFile(name: string, contents = 'bytes'): string {
  const full = path.join(source, name)
  fs.writeFileSync(full, contents)
  return full
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-audit-'))
  source = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-src-'))
  await openDatabase()
})

afterEach(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(source, { recursive: true, force: true })
})

describe('what puts something into Artifacts', () => {
  it('a user import does', () => {
    const project = store.createProject('Audit')
    artifacts.importUserArtifacts(project.id, [sourceFile('brief.md')])

    const listed = store.openProjectSnapshot(project.id).artifacts
    expect(listed).toHaveLength(1)
    expect(listed[0]!.source).toBe('user-import')
  })

  it('a provider registration does, attributed to its turn', () => {
    const project = store.createProject('Audit')
    const conversation = store.createConversation(project.id, 'S')
    const run = store.createRun({ projectId: project.id, conversationId: conversation.id })

    const artifact = artifacts.registerProviderArtifact({
      projectId: project.id,
      conversationId: conversation.id,
      runId: run.id,
      sourcePath: sourceFile('render.png')
    })

    expect(artifact.source).toBe('provider')
    expect(artifact.creatorConversationId).toBe(conversation.id)
    expect(artifact.creatorRunId).toBe(run.id)
    expect(artifact.projectId).toBe(project.id)
  })

  it('attaching a project file does NOT — it stays an ordinary file', () => {
    // Ordinary project-file tracking must be untouched by any of this.
    const project = store.createProject('Audit')
    artifacts.attachProjectFiles(project.id, [sourceFile('notes.txt')])

    const snapshot = store.openProjectSnapshot(project.id)
    expect(snapshot.projectFiles).toHaveLength(1)
    expect(snapshot.artifacts).toHaveLength(0)
  })
})

describe('artifacts survive a reload', () => {
  it('is still listed, and still on disk, after the database is reopened', async () => {
    const project = store.createProject('Audit')
    const artifact = artifacts.importUserArtifacts(project.id, [sourceFile('kept.png')])[0]!

    db.close()
    await openDatabase()

    const listed = store.openProjectSnapshot(project.id).artifacts
    expect(listed).toHaveLength(1)
    expect(listed[0]!.id).toBe(artifact.id)
    expect(fs.existsSync(listed[0]!.location)).toBe(true)
  })

  it('does not depend on the file it was made from still existing', () => {
    const project = store.createProject('Audit')
    const original = sourceFile('temporary.png')
    const artifact = artifacts.importUserArtifacts(project.id, [original])[0]!

    // Orbit copies the bytes into its own storage, so an agent's scratch
    // file being cleaned up does not empty Artifacts.
    fs.rmSync(original)
    expect(fs.existsSync(artifact.location)).toBe(true)
    expect(artifacts.getContent(artifact.id).name).toBe('temporary.png')
  })
})

describe('the count is right', () => {
  it('counts every artifact on the project, once each', () => {
    const project = store.createProject('Audit')
    artifacts.importUserArtifacts(project.id, [sourceFile('a.png'), sourceFile('b.png'), sourceFile('c.mp4')])

    expect(store.openProjectSnapshot(project.id).artifacts).toHaveLength(3)
  })

  it('keeps each project’s artifacts to itself', () => {
    const mine = store.createProject('Mine')
    const theirs = store.createProject('Theirs')
    artifacts.importUserArtifacts(mine.id, [sourceFile('mine.png')])
    artifacts.importUserArtifacts(theirs.id, [sourceFile('theirs.png')])

    expect(store.openProjectSnapshot(mine.id).artifacts.map((a) => a.name)).toEqual(['mine.png'])
    expect(store.openProjectSnapshot(theirs.id).artifacts.map((a) => a.name)).toEqual(['theirs.png'])
  })
})

describe('an artifact opens correctly', () => {
  it('returns image bytes as a data URL the renderer can show', () => {
    const project = store.createProject('Audit')
    const artifact = artifacts.importUserArtifacts(project.id, [sourceFile('shot.png', 'PNGDATA')])[0]!

    const content = artifacts.getContent(artifact.id)
    expect(content.previewKind).toBe('image')
    expect(content.dataUrl).toMatch(/^data:image\/png;base64,/)
  })

  it('returns text content for a text artifact', () => {
    const project = store.createProject('Audit')
    const artifact = artifacts.importUserArtifacts(project.id, [sourceFile('plan.md', '# Plan')])[0]!

    const content = artifacts.getContent(artifact.id)
    expect(content.previewKind).toBe('markdown')
    expect(content.text).toBe('# Plan')
  })

  it('reports a missing artifact rather than returning something wrong', () => {
    expect(() => artifacts.getContent('artifact_nope')).toThrow(/not found/i)
  })

  it('reports a deleted stored copy as unavailable instead of throwing', () => {
    const project = store.createProject('Audit')
    const artifact = artifacts.importUserArtifacts(project.id, [sourceFile('gone.png', 'PNGDATA')])[0]!
    fs.rmSync(artifact.location)

    const content = artifacts.getContent(artifact.id)
    expect(content.available).toBe(false)
    expect(content.dataUrl).toBeUndefined()
    // No filesystem path ever reaches the renderer through content.
    expect(JSON.stringify(content)).not.toContain(dir)
  })
})

describe('an Unsorted session can own artifacts', () => {
  it('lists an Unsorted session’s outputs in its snapshot', () => {
    // artifacts.project_id used to be NOT NULL, which made this impossible.
    const conversation = store.createConversation(null, 'Unsorted')
    const run = store.createRun({ projectId: null, conversationId: conversation.id })
    artifacts.registerOutput({ projectId: null, conversationId: conversation.id, runId: run.id, sourcePath: sourceFile('draft.png'), sourceRoot: source })

    const listed = store.openUnsortedSnapshot().artifacts
    expect(listed.map((artifact) => [artifact.name, artifact.projectId, artifact.creatorRunId])).toEqual([['draft.png', null, run.id]])
    expect(store.openUnsortedSnapshot().artifactVersions).toHaveLength(1)
  })

  it('migrates a database whose artifacts table still requires a project', async () => {
    const project = store.createProject('Legacy')
    const kept = artifacts.importUserArtifacts(project.id, [sourceFile('legacy.png')])[0]!
    // Rebuild the table the way every database before this change had it.
    // Without a rename, which would rewrite artifact_versions' reference.
    db.exec('PRAGMA foreign_keys = OFF')
    db.exec('CREATE TEMP TABLE artifacts_old AS SELECT * FROM artifacts')
    db.exec('DROP TABLE artifacts')
    db.exec(`CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      creator_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      creator_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
      type TEXT NOT NULL, name TEXT NOT NULL, source TEXT NOT NULL, location TEXT NOT NULL,
      preview_kind TEXT NOT NULL, mime_type TEXT, metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, current_version_id TEXT)`)
    db.exec('INSERT INTO artifacts SELECT * FROM artifacts_old')
    db.exec('DROP TABLE artifacts_old')
    db.exec('PRAGMA foreign_keys = ON')
    db.close()

    await openDatabase()
    expect(store.openProjectSnapshot(project.id).artifacts.map((artifact) => artifact.id)).toEqual([kept.id])
    const conversation = store.createConversation(null, 'Unsorted')
    const run = store.createRun({ projectId: null, conversationId: conversation.id })
    expect(() =>
      artifacts.registerOutput({ projectId: null, conversationId: conversation.id, runId: run.id, sourcePath: sourceFile('after.png'), sourceRoot: source })
    ).not.toThrow()
  })
})
