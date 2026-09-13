import fs from 'node:fs'
import path from 'node:path'
import { nativeImage, shell } from 'electron'
import type { Artifact, ArtifactType, ID, ProjectFile } from '@shared/domain'
import type { ArtifactActionResult, ArtifactContent, ArtifactSummary } from '@shared/contracts'
import { FileStorage, hashFile, type ArtifactOwner } from '@main/files/fileStorage'
import { inferArtifactType, inferMimeType, previewKindFor } from '@main/files/mime'
import type { OrbitStore } from '@main/persistence/store'
import { extensionOf, hasInlinePreview, isOpenableOutput, outputMimeTypeFor } from '@shared/outputArtifacts'
import { canonicalDirectory, resolveContainedFile } from './safePaths'

const TEXT_PREVIEW_LIMIT = 1024 * 1024
const BINARY_PREVIEW_LIMIT = 20 * 1024 * 1024
/** Longest edge of the inline preview drawn in the conversation. Twice the
 *  displayed size, so it stays sharp on a Retina screen. */
const INLINE_PREVIEW_EDGE = 720
/** Formats shown inline from their own bytes rather than a rendered
 *  thumbnail: an animated GIF would lose its animation, and an SVG cannot be
 *  rasterized by nativeImage. Capped so history never loads a huge file
 *  just to draw a card. */
const RAW_INLINE_PREVIEW_LIMIT = 4 * 1024 * 1024

/** The two OS actions Orbit performs on an artifact. Injected so tests can
 *  assert exactly which path would have been handed to the OS. */
export interface DesktopShell {
  openPath(filePath: string): Promise<string>
  showItemInFolder(filePath: string): void
}

/** A downscaled data URL for an image on disk, or null when it cannot be
 *  decoded. */
export type ImageThumbnailer = (filePath: string, maxEdge: number) => string | null

export interface RegisterOutputInput {
  projectId: ID | null
  conversationId: ID
  runId: ID
  /** Where the output was found. Untrusted: re-resolved here. */
  sourcePath: string
  /** The folder it must be inside — the workspace, or a provider's own
   *  output folder. Recorded, and enforced again every time it is opened. */
  sourceRoot: string
  displayName?: string
  metadata?: Record<string, unknown>
}

export class ArtifactService {
  constructor(
    private readonly store: OrbitStore,
    private readonly storage: FileStorage,
    private readonly desktop: DesktopShell = electronShell(),
    private readonly thumbnailer: ImageThumbnailer = nativeThumbnail
  ) {}

  attachProjectFiles(projectId: ID, paths: string[]): ProjectFile[] {
    return paths.map((sourcePath) => {
      const stored = this.storage.storeProjectFile(projectId, sourcePath)
      return this.store.createProjectFile({
        projectId,
        originalPath: stored.originalPath,
        storedPath: stored.storedPath,
        name: stored.name,
        mimeType: inferMimeType(stored.name),
        byteSize: stored.byteSize,
        contentHash: stored.contentHash
      })
    })
  }

  /** Companion to attachProjectFiles for content that has no source path
   *  (a pasted clipboard image). */
  attachProjectBytes(projectId: ID, name: string, bytes: Uint8Array): ProjectFile {
    const stored = this.storage.storeProjectBytes(projectId, name, bytes)
    return this.store.createProjectFile({
      projectId,
      originalPath: stored.originalPath,
      storedPath: stored.storedPath,
      name: stored.name,
      mimeType: inferMimeType(stored.name),
      byteSize: stored.byteSize,
      contentHash: stored.contentHash
    })
  }

  importUserArtifacts(projectId: ID, paths: string[], creatorConversationId: ID | null = null): Artifact[] {
    return paths.map((sourcePath) =>
      this.registerArtifactFromPath({
        owner: { projectId },
        projectId,
        sourcePath,
        source: 'user-import',
        creatorConversationId,
        creatorRunId: null,
        attributionCertain: true
      })
    )
  }

  /** Registers a file the provider explicitly named. Kept for providers
   *  that report exact paths; the path is still required to be inside
   *  `sourceRoot` when one is given. */
  registerProviderArtifact(input: {
    projectId: ID | null
    conversationId: ID
    runId: ID
    sourcePath: string
    sourceRoot?: string
    metadata?: Record<string, unknown>
  }): Artifact {
    if (input.sourceRoot) {
      return this.registerOutput({ ...input, sourceRoot: input.sourceRoot })
    }
    const payload: Parameters<ArtifactService['registerArtifactFromPath']>[0] = {
      owner: ownerFor(input.projectId, input.conversationId),
      projectId: input.projectId,
      sourcePath: input.sourcePath,
      source: 'provider',
      creatorConversationId: input.conversationId,
      creatorRunId: input.runId,
      attributionCertain: true
    }
    if (input.metadata) payload.metadata = input.metadata
    return this.registerArtifactFromPath(payload)
  }

  /** Registers an output a turn produced, attributed to that turn.
   *
   *  The path is untrusted: it is canonicalized and must be an existing
   *  regular file physically inside `sourceRoot`, or nothing is registered.
   *  The bytes are then copied into Orbit's own storage, so the turn keeps
   *  exactly what it produced even if the agent later overwrites or deletes
   *  the file — a second "mountain.png" in a later turn is that turn's, and
   *  never rewrites the first. */
  registerOutput(input: RegisterOutputInput): Artifact {
    const root = canonicalDirectory(input.sourceRoot)
    const real = root ? resolveContainedFile(input.sourcePath, [root]) : null
    if (!root || !real) throw new Error('Output is not a regular file inside its workspace.')
    const relativePath = path.relative(root, real)
    return this.registerArtifactFromPath({
      owner: ownerFor(input.projectId, input.conversationId),
      projectId: input.projectId,
      sourcePath: real,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      source: 'provider',
      creatorConversationId: input.conversationId,
      creatorRunId: input.runId,
      attributionCertain: true,
      metadata: { sourceRoot: root, relativePath, ...(input.metadata ?? {}) }
    })
  }

  /** What a conversation card needs to draw an artifact: whether its stored
   *  copy still exists, its size, and — for an image — a preview.
   *
   *  Never throws for a file that has gone missing. A history that contains
   *  an output whose bytes were deleted must still open; the card says the
   *  file is no longer available instead. */
  describe(artifactId: ID): ArtifactSummary {
    const artifact = this.store.getArtifact(artifactId)
    if (!artifact) return { artifactId, available: false, byteSize: null, previewDataUrl: null, canOpen: false, canReveal: false }
    const stored = this.storedCopy(artifact)
    const version = artifact.currentVersionId ? this.store.getArtifactVersion(artifact.currentVersionId) : null
    let byteSize = version?.byteSize ?? null
    let previewDataUrl: string | null = null
    if (stored) {
      try {
        byteSize = fs.statSync(stored).size
        if (hasInlinePreview(artifact.name)) previewDataUrl = this.inlinePreview(stored, artifact)
      } catch {
        previewDataUrl = null
      }
    }
    // Exactly what open() and reveal() would find, so a card never offers
    // an action that is bound to fail. The hash is only needed when Orbit's
    // own copy is gone, which is rare.
    const openable = isOpenableOutput(artifact.name) && Boolean(stored ?? this.unchangedOriginal(artifact))
    return {
      artifactId,
      available: Boolean(stored),
      byteSize,
      previewDataUrl,
      canOpen: openable,
      canReveal: Boolean(stored ?? this.containedOriginal(artifact))
    }
  }

  getContent(artifactId: ID): ArtifactContent {
    const artifact = this.store.getArtifact(artifactId)
    if (!artifact) throw new Error('Artifact not found.')
    const base = {
      artifactId: artifact.id,
      previewKind: artifact.previewKind,
      name: artifact.name,
      mimeType: artifact.mimeType
    }
    const stored = this.storedCopy(artifact)
    if (!stored) return { ...base, available: false, byteSize: 0 }
    const size = fs.statSync(stored).size
    const present = { ...base, available: true, byteSize: size }
    if (artifact.previewKind === 'image' || artifact.previewKind === 'audio' || artifact.previewKind === 'video') {
      if (size > BINARY_PREVIEW_LIMIT) return present
      return { ...present, dataUrl: fileToDataUrl(stored, artifact.mimeType ?? 'application/octet-stream') }
    }
    if (artifact.previewKind === 'svg' && size <= TEXT_PREVIEW_LIMIT) {
      // Both: the side panel renders the markup in a sandboxed frame, the
      // conversation's larger view draws it as an image.
      return { ...present, text: fs.readFileSync(stored, 'utf8'), dataUrl: fileToDataUrl(stored, 'image/svg+xml') }
    }
    if (artifact.previewKind === 'text' || artifact.previewKind === 'markdown' || artifact.previewKind === 'html' || artifact.previewKind === 'svg') {
      if (size > TEXT_PREVIEW_LIMIT) return present
      return { ...present, text: fs.readFileSync(stored, 'utf8') }
    }
    return present
  }

  /** Data-URL preview for a managed project file. Returns null for
   *  anything that is not a real, still-present, reasonably sized image —
   *  the renderer never receives a path, only bytes it is allowed to show. */
  getProjectFileThumbnail(fileId: ID): string | null {
    const file = this.store.getProjectFile(fileId)
    if (!file) return null
    const mimeType = file.mimeType ?? inferMimeType(file.name)
    if (!mimeType?.startsWith('image/')) return null
    try {
      const stat = fs.statSync(file.storedPath)
      if (!stat.isFile() || stat.size > BINARY_PREVIEW_LIMIT) return null
      return fileToDataUrl(file.storedPath, mimeType)
    } catch {
      return null
    }
  }

  /** Opens the artifact with the OS's default application.
   *
   *  The renderer supplies only an id. The file handed to the OS is chosen
   *  here, re-validated at this moment, and only ever one of two things: the
   *  original the turn produced, if it is still inside the folder it was
   *  found in AND still byte-identical to what the turn produced; otherwise
   *  Orbit's own stored copy. The format must be on the closed list of
   *  deliverables, so an artifact can never be a way to launch a script,
   *  an app bundle or an HTML page. */
  async open(artifactId: ID): Promise<ArtifactActionResult> {
    const artifact = this.store.getArtifact(artifactId)
    if (!artifact) return { ok: false, reason: 'missing' }
    if (!isOpenableOutput(artifact.name)) return { ok: false, reason: 'not-openable' }
    const target = this.unchangedOriginal(artifact) ?? this.storedCopy(artifact)
    if (!target) return { ok: false, reason: 'missing' }
    // The file actually handed over must be the same kind of file.
    if (extensionOf(target) !== extensionOf(artifact.name)) return { ok: false, reason: 'not-openable' }
    const error = await this.desktop.openPath(target)
    return error ? { ok: false, reason: 'failed' } : { ok: true }
  }

  /** Shows the artifact in Finder / Explorer: where the agent put it when it
   *  is still there, otherwise Orbit's stored copy. Revealing selects a file
   *  in a folder window and runs nothing, so a changed original is still the
   *  right place to point at. */
  async reveal(artifactId: ID): Promise<ArtifactActionResult> {
    const artifact = this.store.getArtifact(artifactId)
    if (!artifact) return { ok: false, reason: 'missing' }
    const target = this.containedOriginal(artifact) ?? this.storedCopy(artifact)
    if (!target) return { ok: false, reason: 'missing' }
    this.desktop.showItemInFolder(target)
    return { ok: true }
  }

  /** Orbit's stored copy, if it still exists as a regular file inside
   *  Orbit's data folder. Null when it has been deleted from disk. */
  private storedCopy(artifact: Artifact): string | null {
    return resolveContainedFile(artifact.location, [this.storage.root])
  }

  /** The file where the turn produced it — only for outputs registered with
   *  a root, and only while it is still inside that root. */
  private containedOriginal(artifact: Artifact): string | null {
    const originalPath = stringField(artifact.metadata, 'originalPath')
    const sourceRoot = stringField(artifact.metadata, 'sourceRoot')
    if (!originalPath || !sourceRoot) return null
    return resolveContainedFile(originalPath, [sourceRoot])
  }

  private unchangedOriginal(artifact: Artifact): string | null {
    const original = this.containedOriginal(artifact)
    if (!original) return null
    const version = artifact.currentVersionId ? this.store.getArtifactVersion(artifact.currentVersionId) : null
    if (!version) return null
    try {
      if (fs.statSync(original).size !== version.byteSize) return null
      return hashFile(original) === version.contentHash ? original : null
    } catch {
      return null
    }
  }

  private inlinePreview(stored: string, artifact: Artifact): string | null {
    const mimeType = outputMimeTypeFor(artifact.name) ?? artifact.mimeType ?? 'application/octet-stream'
    const size = fs.statSync(stored).size
    const raw = (): string | null => (size <= RAW_INLINE_PREVIEW_LIMIT ? fileToDataUrl(stored, mimeType) : null)
    if (mimeType === 'image/gif' || mimeType === 'image/svg+xml') return raw()
    try {
      return this.thumbnailer(stored, INLINE_PREVIEW_EDGE) ?? raw()
    } catch {
      return raw()
    }
  }

  private registerArtifactFromPath(input: {
    owner: ArtifactOwner
    projectId: ID | null
    sourcePath: string
    displayName?: string
    source: Artifact['source']
    creatorConversationId: ID | null
    creatorRunId: ID | null
    attributionCertain: boolean
    metadata?: Record<string, unknown>
  }): Artifact {
    const stored = this.storage.storeArtifact(input.owner, input.sourcePath, input.displayName)
    const mimeType = inferMimeType(stored.name) ?? outputMimeTypeFor(stored.name)
    const type: ArtifactType = inferArtifactType(stored.name, mimeType)
    try {
      return this.createArtifactRow(input, stored, mimeType, type)
    } catch (error) {
      // No row, no copy: a copy nothing references would otherwise sit in
      // storage until the next sweep.
      fs.rmSync(stored.storedPath, { force: true })
      throw error
    }
  }

  private createArtifactRow(
    input: Parameters<ArtifactService['registerArtifactFromPath']>[0],
    stored: ReturnType<FileStorage['storeArtifact']>,
    mimeType: string | null,
    type: ArtifactType
  ): Artifact {
    const { artifact } = this.store.createArtifact({
      projectId: input.projectId,
      creatorConversationId: input.creatorConversationId,
      creatorRunId: input.creatorRunId,
      type,
      name: stored.name,
      source: input.source,
      location: stored.storedPath,
      previewKind: previewKindFor(type),
      mimeType,
      byteSize: stored.byteSize,
      contentHash: stored.contentHash,
      metadata: {
        originalPath: stored.originalPath,
        attributionCertain: input.attributionCertain,
        ...(input.metadata ?? {})
      }
    })
    return artifact
  }
}

function ownerFor(projectId: ID | null, conversationId: ID): ArtifactOwner {
  return projectId ? { projectId } : { conversationId }
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function fileToDataUrl(filePath: string, mimeType: string): string {
  return `data:${mimeType};base64,${fs.readFileSync(filePath).toString('base64')}`
}

function electronShell(): DesktopShell {
  return {
    openPath: (filePath) => shell.openPath(filePath),
    showItemInFolder: (filePath) => shell.showItemInFolder(filePath)
  }
}

/** Rendered through Electron's own image decoder, so a 4 MB generated JPEG
 *  becomes a few hundred KB in the conversation. PNG output keeps
 *  transparency; JPEG sources stay JPEG. */
function nativeThumbnail(filePath: string, maxEdge: number): string | null {
  if (!nativeImage?.createFromPath) return null
  const image = nativeImage.createFromPath(filePath)
  if (image.isEmpty()) return null
  const { width, height } = image.getSize()
  const scaled = width > maxEdge || height > maxEdge ? image.resize(width >= height ? { width: maxEdge, quality: 'good' } : { height: maxEdge, quality: 'good' }) : image
  const isJpeg = ['.jpg', '.jpeg'].includes(extensionOf(filePath))
  return isJpeg ? `data:image/jpeg;base64,${scaled.toJPEG(86).toString('base64')}` : `data:image/png;base64,${scaled.toPNG().toString('base64')}`
}
