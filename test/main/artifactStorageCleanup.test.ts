// Artifact storage garbage collection. Orbit keeps its own copy of every
// output a turn produced; these pin that a copy is reclaimed exactly when
// nothing refers to it any more — and that nothing else, above all the
// user's original file, is ever deleted.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrbitDatabase } from '../../src/main/persistence/database'
import { OrbitStore } from '../../src/main/persistence/store'
import { FileStorage, TEMPORARY_PREFIX } from '../../src/main/files/fileStorage'
import { ArtifactService } from '../../src/main/artifacts/artifactService'
import { artifactStorageRoots, removeUnreferencedCopies, sweepArtifactStorage } from '../../src/main/artifacts/artifactStorageGc'
import { OrbitRuntime } from '../../src/main/runtime/orbitRuntime'
import type { AgentProvider } from '../../src/main/runtime/provider'
import type { Artifact } from '../../src/shared/domain'
import { pdfBytes, pngBytes } from './fixtures/outputFiles'

let dir = ''
let workspace = ''
let db: OrbitDatabase
let store: OrbitStore
let artifacts: ArtifactService
let runtime: OrbitRuntime

const quietProvider: AgentProvider = {
  getStatus: async () => ({ id: 'antigravity', state: 'ready', sdkAvailable: true, authConfigured: true, message: null, details: {} }),
  listModels: async () => [],
  sendMessage: async () => undefined,
  cancelRun: async () => undefined,
  respondToInteraction: async () => undefined,
  releaseConversation: async () => undefined,
  shutdown: async () => undefined
}

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-gc-')))
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-gc-ws-')))
  db = new OrbitDatabase({ dataDir: dir })
  await db.init()
  store = new OrbitStore(db)
  artifacts = new ArtifactService(store, new FileStorage(dir))
  runtime = new OrbitRuntime(store, artifacts, quietProvider, dir, '0.1.0')
})

afterEach(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(workspace, { recursive: true, force: true })
})

/** A turn's output, registered the way the runtime registers one. */
function produce(conversationId: string, projectId: string | null, name: string, bytes: Buffer = pngBytes()): { artifact: Artifact; original: string } {
  const original = path.join(workspace, `${conversationId}-${name}`)
  fs.writeFileSync(original, bytes)
  const run = store.createRun({ projectId, conversationId })
  const artifact = artifacts.registerOutput({ projectId, conversationId, runId: run.id, sourcePath: original, sourceRoot: workspace, displayName: name })
  return { artifact, original }
}

describe('reclaiming copies when their owner is deleted', () => {
  it('deleting an artifact removes its copy, and never its original', () => {
    const conversation = store.createConversation(null, 'S')
    const { artifact, original } = produce(conversation.id, null, 'chart.png')

    runtime.deleteArtifact(artifact.id)

    expect(store.getArtifact(artifact.id)).toBeNull()
    expect(fs.existsSync(artifact.location)).toBe(false)
    expect(fs.existsSync(original)).toBe(true)
  })

  it('deleting an Unsorted session removes its artifacts’ rows and copies', async () => {
    const conversation = runtime.createConversation(null)
    const one = produce(conversation.id, null, 'a.png')
    const two = produce(conversation.id, null, 'b.pdf', pdfBytes())

    await runtime.deleteConversation(conversation.id)

    expect(store.getArtifact(one.artifact.id)).toBeNull()
    expect(store.getArtifact(two.artifact.id)).toBeNull()
    expect(fs.existsSync(one.artifact.location)).toBe(false)
    expect(fs.existsSync(two.artifact.location)).toBe(false)
    expect(fs.existsSync(one.original) && fs.existsSync(two.original)).toBe(true)
  })

  it('deleting a project session removes what its turns produced, keeps user imports, and leaves other sessions alone', async () => {
    const project = runtime.createProject('P', workspace)
    const doomed = runtime.openProject(project.id).conversations[0]!
    const other = runtime.createConversation(project.id, 'Other')
    const produced = produce(doomed.id, project.id, 'render.png')
    const kept = produce(other.id, project.id, 'keep.png')
    const importedSource = path.join(workspace, 'brief.pdf')
    fs.writeFileSync(importedSource, pdfBytes())
    const imported = artifacts.importUserArtifacts(project.id, [importedSource], doomed.id)[0]!

    await runtime.deleteConversation(doomed.id)

    expect(store.getArtifact(produced.artifact.id)).toBeNull()
    expect(fs.existsSync(produced.artifact.location)).toBe(false)
    expect(store.getArtifact(kept.artifact.id)).not.toBeNull()
    expect(fs.existsSync(kept.artifact.location)).toBe(true)
    expect(store.getArtifact(imported.id)).not.toBeNull()
    expect(fs.existsSync(imported.location)).toBe(true)
  })

  it('moving a session into a project removes nothing', () => {
    const conversation = runtime.createConversation(null)
    const { artifact } = produce(conversation.id, null, 'moved.png')
    const project = runtime.createProject('Filed')

    runtime.assignConversationToProject(conversation.id, project.id)
    sweepArtifactStorage(dir, store, { minAgeMs: 0 })

    expect(store.getArtifact(artifact.id)?.projectId).toBe(project.id)
    expect(fs.existsSync(artifact.location)).toBe(true)
  })

  it('never deletes a copy another row still refers to', () => {
    const conversation = store.createConversation(null, 'S')
    const { artifact } = produce(conversation.id, null, 'shared.png')
    // A second row naming the same file — a migration or a future dedupe.
    const twin = store.createArtifact({
      projectId: null,
      creatorConversationId: conversation.id,
      creatorRunId: null,
      type: 'image',
      name: 'shared.png',
      source: 'provider',
      location: artifact.location,
      previewKind: 'image',
      mimeType: 'image/png',
      byteSize: 1,
      contentHash: 'x'
    }).artifact

    runtime.deleteArtifact(artifact.id)
    expect(fs.existsSync(artifact.location)).toBe(true)

    runtime.deleteArtifact(twin.id)
    expect(fs.existsSync(artifact.location)).toBe(false)
  })

  it('tolerates a copy that is already missing, and deletes the row regardless', () => {
    const conversation = store.createConversation(null, 'S')
    const { artifact } = produce(conversation.id, null, 'gone.png')
    fs.rmSync(artifact.location)

    expect(() => runtime.deleteArtifact(artifact.id)).not.toThrow()
    expect(store.getArtifact(artifact.id)).toBeNull()
  })

  it('a copy that cannot be removed leaves the database consistent, and a later sweep reclaims it', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return
    const conversation = runtime.createConversation(null)
    const { artifact } = produce(conversation.id, null, 'locked.png')
    const folder = path.dirname(artifact.location)
    fs.chmodSync(folder, 0o500) // unlink refused
    try {
      await expect(runtime.deleteConversation(conversation.id)).resolves.toBeUndefined()
      expect(store.getArtifact(artifact.id)).toBeNull()
      expect(store.getConversation(conversation.id)).toBeNull()
      expect(fs.existsSync(artifact.location)).toBe(true)
    } finally {
      fs.chmodSync(folder, 0o700)
    }
    expect(runtime.sweepArtifactStorage().removed).toContain(artifact.location)
    expect(fs.existsSync(artifact.location)).toBe(false)
  })
})

describe('the storage sweep', () => {
  it('reclaims an orphaned copy and keeps every referenced one', () => {
    const conversation = store.createConversation(null, 'S')
    const live = produce(conversation.id, null, 'live.png')
    const orphan = path.join(path.dirname(live.artifact.location), 'artifact_0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9-orphan.png')
    fs.writeFileSync(orphan, pngBytes())

    const report = sweepArtifactStorage(dir, store, { minAgeMs: 0 })

    expect(report.removed).toEqual([orphan])
    expect(fs.existsSync(live.artifact.location)).toBe(true)
  })

  it('reclaims an incomplete copy left by an interrupted write', () => {
    const conversation = store.createConversation(null, 'S')
    const live = produce(conversation.id, null, 'live.png')
    const partial = path.join(path.dirname(live.artifact.location), `${TEMPORARY_PREFIX}copy_123`)
    fs.writeFileSync(partial, 'half')

    expect(sweepArtifactStorage(dir, store, { minAgeMs: 0 }).removed).toEqual([partial])
  })

  it('leaves a very new unreferenced copy alone, since its row may be about to be written', () => {
    const conversation = store.createConversation(null, 'S')
    const live = produce(conversation.id, null, 'live.png')
    const fresh = path.join(path.dirname(live.artifact.location), 'artifact_0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9-fresh.png')
    fs.writeFileSync(fresh, pngBytes())

    expect(sweepArtifactStorage(dir, store).removed).toEqual([])
    expect(fs.existsSync(fresh)).toBe(true)
  })

  it('never removes a file Orbit did not name, even in its own storage', () => {
    const conversation = store.createConversation(null, 'S')
    const live = produce(conversation.id, null, 'live.png')
    const foreign = path.join(path.dirname(live.artifact.location), 'notes-the-user-dropped-here.txt')
    fs.writeFileSync(foreign, 'mine')

    sweepArtifactStorage(dir, store, { minAgeMs: 0 })
    expect(fs.existsSync(foreign)).toBe(true)
  })

  it('never deletes outside artifact storage: the data folder’s other files, a workspace, or a user file', () => {
    const project = store.createProject('P', workspace)
    const attachment = path.join(workspace, 'attach.png')
    fs.writeFileSync(attachment, pngBytes())
    const file = artifacts.attachProjectFiles(project.id, [attachment])[0]!
    const lookalikeInWorkspace = path.join(workspace, 'artifact_0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9-user.png')
    fs.writeFileSync(lookalikeInWorkspace, pngBytes())
    const managedWorkspace = path.join(dir, 'projects', project.id, 'workspace')
    fs.mkdirSync(managedWorkspace, { recursive: true })
    const lookalikeInData = path.join(managedWorkspace, 'artifact_0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9-agent.png')
    fs.writeFileSync(lookalikeInData, pngBytes())

    sweepArtifactStorage(dir, store, { minAgeMs: 0 })
    removeUnreferencedCopies([lookalikeInWorkspace, lookalikeInData, file.storedPath, attachment, '/etc/hosts', '../../etc/passwd', ''], dir, store)

    for (const kept of [attachment, file.storedPath, lookalikeInWorkspace, lookalikeInData, path.join(dir, 'orbit.sqlite')]) {
      expect(fs.existsSync(kept), kept).toBe(true)
    }
  })

  it('never follows a symlink out of storage, and never removes the link either', () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-gc-outside-')))
    try {
      const target = path.join(outside, 'artifact_0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9-secret.png')
      fs.writeFileSync(target, pngBytes())
      const conversation = store.createConversation(null, 'S')
      const live = produce(conversation.id, null, 'live.png')
      const storage = path.dirname(live.artifact.location)
      // A symlinked file with an Orbit-looking name…
      const link = path.join(storage, 'artifact_11111111-2222-4333-8444-555555555555-link.png')
      fs.symlinkSync(target, link)
      // …and a whole owner directory that is a symlink to elsewhere.
      fs.mkdirSync(path.join(outside, 'artifacts'))
      const deepTarget = path.join(outside, 'artifacts', 'artifact_0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9-deep.png')
      fs.writeFileSync(deepTarget, pngBytes())
      fs.symlinkSync(outside, path.join(dir, 'conversations', 'conversation_symlinked'))

      expect(artifactStorageRoots(dir).some((root) => root.startsWith(outside))).toBe(false)
      sweepArtifactStorage(dir, store, { minAgeMs: 0 })
      removeUnreferencedCopies([link, deepTarget, path.join(dir, 'conversations', 'conversation_symlinked', 'artifacts', path.basename(deepTarget))], dir, store)

      expect(fs.existsSync(target)).toBe(true)
      expect(fs.existsSync(deepTarget)).toBe(true)
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('is idempotent, and tidies away storage folders it emptied', () => {
    const conversation = runtime.createConversation(null)
    const { artifact } = produce(conversation.id, null, 'x.png')
    const owner = path.dirname(path.dirname(artifact.location))
    store.deleteArtifact(artifact.id) // row gone, file left, as after a crash

    expect(sweepArtifactStorage(dir, store, { minAgeMs: 0 }).removed).toEqual([artifact.location])
    expect(sweepArtifactStorage(dir, store, { minAgeMs: 0 })).toEqual({ removed: [], failed: [] })
    expect(fs.existsSync(owner)).toBe(false)
  })

  it('keeps a historical artifact whose copy is missing: its row stays, and the card still has something to say', () => {
    const conversation = store.createConversation(null, 'S')
    const { artifact } = produce(conversation.id, null, 'history.png')
    fs.rmSync(artifact.location)

    sweepArtifactStorage(dir, store, { minAgeMs: 0 })

    expect(store.getArtifact(artifact.id)).not.toBeNull()
    expect(artifacts.describe(artifact.id)).toMatchObject({ available: false })
  })
})

describe('writing a copy', () => {
  it('leaves no copy behind when its row cannot be written', () => {
    const conversation = store.createConversation(null, 'S')
    const original = path.join(workspace, 'doomed.png')
    fs.writeFileSync(original, pngBytes())
    const run = store.createRun({ projectId: null, conversationId: conversation.id })
    vi.spyOn(store, 'createArtifact').mockImplementation(() => {
      throw new Error('disk full')
    })

    expect(() => artifacts.registerOutput({ projectId: null, conversationId: conversation.id, runId: run.id, sourcePath: original, sourceRoot: workspace })).toThrow('disk full')
    const storage = path.join(dir, 'conversations', conversation.id, 'artifacts')
    expect(fs.existsSync(storage) ? fs.readdirSync(storage) : []).toEqual([])
    expect(fs.existsSync(original)).toBe(true)
  })

  it('never leaves a temporary file after a successful copy', () => {
    const conversation = store.createConversation(null, 'S')
    const { artifact } = produce(conversation.id, null, 'clean.png')
    expect(fs.readdirSync(path.dirname(artifact.location)).filter((name) => name.startsWith(TEMPORARY_PREFIX))).toEqual([])
  })
})
