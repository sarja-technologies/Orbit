// What happens when the user clicks an artifact card: the renderer names an
// artifact by id, and the main process decides — at that moment — which
// file, if any, the OS is handed. These pin that the answer is always a
// real file inside an allowed folder, never something an agent could
// redirect afterwards.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrbitDatabase } from '../../src/main/persistence/database'
import { OrbitStore } from '../../src/main/persistence/store'
import { FileStorage } from '../../src/main/files/fileStorage'
import { ArtifactService, type DesktopShell } from '../../src/main/artifacts/artifactService'
import type { Artifact } from '../../src/shared/domain'
import { pdfBytes, pngBytes } from './fixtures/outputFiles'

let dir = ''
let workspace = ''
let db: OrbitDatabase
let store: OrbitStore
let desktop: { openPath: ReturnType<typeof vi.fn>; showItemInFolder: ReturnType<typeof vi.fn> }
let thumbnailer: ReturnType<typeof vi.fn>
let service: ArtifactService

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-actions-')))
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-actions-ws-')))
  db = new OrbitDatabase({ dataDir: dir })
  await db.init()
  store = new OrbitStore(db)
  desktop = { openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() }
  thumbnailer = vi.fn(() => 'data:image/png;base64,THUMB')
  service = new ArtifactService(store, new FileStorage(dir), desktop as unknown as DesktopShell, thumbnailer)
})

afterEach(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(workspace, { recursive: true, force: true })
})

function produce(relative: string, bytes: Buffer | string): { artifact: Artifact; original: string } {
  const original = path.join(workspace, relative)
  fs.mkdirSync(path.dirname(original), { recursive: true })
  fs.writeFileSync(original, bytes)
  const conversation = store.createConversation(null, 'S')
  const run = store.createRun({ projectId: null, conversationId: conversation.id })
  const artifact = service.registerOutput({ projectId: null, conversationId: conversation.id, runId: run.id, sourcePath: original, sourceRoot: workspace })
  return { artifact, original }
}

describe('registering', () => {
  it('refuses a path outside the root it was found in', () => {
    const outside = path.join(dir, 'elsewhere.png')
    fs.writeFileSync(outside, pngBytes())
    const conversation = store.createConversation(null, 'S')
    const run = store.createRun({ projectId: null, conversationId: conversation.id })
    expect(() => service.registerOutput({ projectId: null, conversationId: conversation.id, runId: run.id, sourcePath: outside, sourceRoot: workspace })).toThrow()
    expect(() =>
      service.registerOutput({ projectId: null, conversationId: conversation.id, runId: run.id, sourcePath: path.join(workspace, '..', path.basename(dir), 'elsewhere.png'), sourceRoot: workspace })
    ).toThrow()
    expect(store.openUnsortedSnapshot().artifacts).toEqual([])
  })

  it('records where it came from relative to its root, for display only', () => {
    const { artifact } = produce('renders/mountain.png', pngBytes())
    expect(artifact.metadata.relativePath).toBe(path.join('renders', 'mountain.png'))
    expect(artifact.metadata.sourceRoot).toBe(workspace)
  })
})

describe('describing a card', () => {
  it('gives a preview, a size and the actions that will work — and no path', () => {
    const bytes = pngBytes(10, 10)
    const { artifact } = produce('mountain.png', bytes)
    const summary = service.describe(artifact.id)
    expect(summary).toEqual({ artifactId: artifact.id, available: true, byteSize: bytes.length, previewDataUrl: 'data:image/png;base64,THUMB', canOpen: true, canReveal: true })
    expect(JSON.stringify(summary)).not.toContain(workspace)
  })

  it('falls back to the image’s own bytes when it cannot be thumbnailed', () => {
    thumbnailer.mockReturnValue(null)
    const { artifact } = produce('mountain.png', pngBytes())
    expect(service.describe(artifact.id).previewDataUrl).toMatch(/^data:image\/png;base64,/)
  })

  it('does not preview a document', () => {
    const { artifact } = produce('report.pdf', pdfBytes())
    expect(service.describe(artifact.id).previewDataUrl).toBeNull()
    expect(thumbnailer).not.toHaveBeenCalled()
  })

  it('handles a stored copy that has been deleted without throwing', () => {
    const { artifact, original } = produce('mountain.png', pngBytes())
    fs.rmSync(artifact.location)
    fs.rmSync(original)
    expect(service.describe(artifact.id)).toMatchObject({ available: false, previewDataUrl: null, canOpen: false, canReveal: false })
  })

  it('handles an id that does not exist', () => {
    expect(service.describe('artifact_missing')).toMatchObject({ available: false, canOpen: false, canReveal: false })
  })
})

describe('opening', () => {
  it('opens the original in the project while it still matches what the turn produced', async () => {
    const { artifact, original } = produce('report.pdf', pdfBytes())
    expect(await service.open(artifact.id)).toEqual({ ok: true })
    expect(desktop.openPath).toHaveBeenCalledWith(original)
  })

  it('opens Orbit’s own copy once the original has been changed', async () => {
    const { artifact, original } = produce('report.pdf', pdfBytes('first'))
    fs.writeFileSync(original, pdfBytes('rewritten by a later turn'))
    await service.open(artifact.id)
    expect(desktop.openPath).toHaveBeenCalledWith(artifact.location)
  })

  it('never follows an original that was swapped for a symlink to somewhere else', async () => {
    const secretDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-secret-')))
    try {
      const { artifact, original } = produce('report.pdf', pdfBytes())
      const secret = path.join(secretDir, 'report.pdf')
      fs.copyFileSync(original, secret) // identical bytes, so only containment can refuse it
      fs.rmSync(original)
      fs.symlinkSync(secret, original)

      await service.open(artifact.id)
      await service.reveal(artifact.id)
      expect(desktop.openPath).toHaveBeenCalledWith(artifact.location)
      expect(desktop.showItemInFolder).toHaveBeenCalledWith(artifact.location)
      for (const call of [...desktop.openPath.mock.calls, ...desktop.showItemInFolder.mock.calls]) expect(String(call[0])).not.toContain(secretDir)
    } finally {
      fs.rmSync(secretDir, { recursive: true, force: true })
    }
  })

  it('refuses to open a stored location that was tampered to point outside Orbit', async () => {
    const { artifact, original } = produce('report.pdf', pdfBytes())
    fs.rmSync(original)
    db.run('UPDATE artifacts SET location = ? WHERE id = ?', ['/etc/hosts', artifact.id])
    expect(await service.open(artifact.id)).toEqual({ ok: false, reason: 'missing' })
    expect(desktop.openPath).not.toHaveBeenCalled()
  })

  it('refuses a format that is not a deliverable, even if it was registered', async () => {
    const script = path.join(workspace, 'run.command')
    fs.writeFileSync(script, '#!/bin/sh\necho hi\n')
    const artifact = service.importUserArtifacts(store.createProject('P').id, [script])[0]!
    expect(await service.open(artifact.id)).toEqual({ ok: false, reason: 'not-openable' })
    expect(desktop.openPath).not.toHaveBeenCalled()
    expect(service.describe(artifact.id).canOpen).toBe(false)
  })

  it('says the file is missing when nothing is left to open', async () => {
    const { artifact, original } = produce('report.pdf', pdfBytes())
    fs.rmSync(artifact.location)
    fs.rmSync(original)
    expect(await service.open(artifact.id)).toEqual({ ok: false, reason: 'missing' })
    expect(await service.reveal(artifact.id)).toEqual({ ok: false, reason: 'missing' })
  })

  it('reports an OS failure honestly', async () => {
    desktop.openPath.mockResolvedValue('No application knows how to open this')
    const { artifact } = produce('report.pdf', pdfBytes())
    expect(await service.open(artifact.id)).toEqual({ ok: false, reason: 'failed' })
  })
})

describe('revealing', () => {
  it('shows the file where the agent put it', async () => {
    const { artifact, original } = produce('out/report.pdf', pdfBytes())
    expect(await service.reveal(artifact.id)).toEqual({ ok: true })
    expect(desktop.showItemInFolder).toHaveBeenCalledWith(original)
  })

  it('falls back to Orbit’s copy once the original is gone', async () => {
    const { artifact, original } = produce('out/report.pdf', pdfBytes())
    fs.rmSync(original)
    await service.reveal(artifact.id)
    expect(desktop.showItemInFolder).toHaveBeenCalledWith(artifact.location)
  })
})
