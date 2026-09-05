import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { shell } from 'electron'
import type { Artifact, ArtifactType, ID, ProjectFile } from '@shared/domain'
import type { ArtifactContent } from '@shared/contracts'
import { FileStorage, hashFile } from '@main/files/fileStorage'
import { inferArtifactType, inferMimeType, previewKindFor } from '@main/files/mime'
import type { OrbitStore } from '@main/persistence/store'

const TEXT_PREVIEW_LIMIT = 1024 * 1024
const BINARY_PREVIEW_LIMIT = 20 * 1024 * 1024

export class ArtifactService {
  constructor(
    private readonly store: OrbitStore,
    private readonly storage: FileStorage
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

  importUserArtifacts(projectId: ID, paths: string[], creatorConversationId: ID | null = null): Artifact[] {
    return paths.map((sourcePath) =>
      this.registerArtifactFromPath({
        projectId,
        sourcePath,
        source: 'user-import',
        creatorConversationId,
        creatorRunId: null,
        attributionCertain: true
      })
    )
  }

  registerProviderArtifact(input: { projectId: ID; conversationId: ID; runId: ID; sourcePath: string; metadata?: Record<string, unknown> }): Artifact {
    const payload: Parameters<ArtifactService['registerArtifactFromPath']>[0] = {
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

  getContent(artifactId: ID): ArtifactContent {
    const artifact = this.store.getArtifact(artifactId)
    if (!artifact) throw new Error('Artifact not found.')
    const stat = fs.statSync(artifact.location)
    const base = {
      artifactId: artifact.id,
      previewKind: artifact.previewKind,
      name: artifact.name,
      mimeType: artifact.mimeType,
      location: artifact.location,
      byteSize: stat.size
    }
    if (artifact.previewKind === 'image' || artifact.previewKind === 'audio' || artifact.previewKind === 'video') {
      if (stat.size > BINARY_PREVIEW_LIMIT) return base
      return { ...base, dataUrl: fileToDataUrl(artifact.location, artifact.mimeType ?? 'application/octet-stream') }
    }
    if (artifact.previewKind === 'text' || artifact.previewKind === 'markdown' || artifact.previewKind === 'html' || artifact.previewKind === 'svg') {
      if (stat.size > TEXT_PREVIEW_LIMIT) return base
      return { ...base, text: fs.readFileSync(artifact.location, 'utf8') }
    }
    return base
  }

  async reveal(artifactId: ID): Promise<void> {
    const artifact = this.store.getArtifact(artifactId)
    if (!artifact) throw new Error('Artifact not found.')
    shell.showItemInFolder(artifact.location)
  }

  private registerArtifactFromPath(input: {
    projectId: ID
    sourcePath: string
    source: Artifact['source']
    creatorConversationId: ID | null
    creatorRunId: ID | null
    attributionCertain: boolean
    metadata?: Record<string, unknown>
  }): Artifact {
    const stored = this.storage.storeArtifact(input.projectId, input.sourcePath)
    const mimeType = inferMimeType(stored.name)
    const type: ArtifactType = inferArtifactType(stored.name, mimeType)
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
      contentHash: hashFile(stored.storedPath),
      metadata: {
        originalPath: stored.originalPath,
        attributionCertain: input.attributionCertain,
        ...(input.metadata ?? {})
      }
    })
    return artifact
  }
}

function fileToDataUrl(filePath: string, mimeType: string): string {
  return `data:${mimeType};base64,${fs.readFileSync(filePath).toString('base64')}`
}

export function artifactExternalUrl(artifact: Artifact): string {
  return pathToFileURL(path.dirname(artifact.location)).toString()
}
