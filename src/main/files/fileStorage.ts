import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createId } from '@main/util/ids'

/** Name prefix of a copy that has not been finalised yet. */
export const TEMPORARY_PREFIX = '.orbit-incomplete-'

export interface StoredFile {
  originalPath: string
  storedPath: string
  name: string
  byteSize: number
  contentHash: string
}

/** Who an artifact's stored copy belongs to. A session with no project
 *  keeps its outputs beside its own id, so nothing it produced lands inside
 *  a project it does not belong to. */
export type ArtifactOwner = { projectId: string } | { conversationId: string }

export class FileStorage {
  constructor(private readonly dataDir: string) {}

  /** Orbit's own data folder — the one place every stored copy lives. */
  get root(): string {
    return this.dataDir
  }

  storeProjectFile(projectId: string, sourcePath: string): StoredFile {
    return this.copyInto(path.join('projects', projectId), 'files', sourcePath)
  }

  /** `name` overrides the stored display name — the provider sometimes knows
   *  a better one than the file on disk (see generatedOutputs.ts). */
  storeArtifact(owner: ArtifactOwner | string, sourcePath: string, name?: string): StoredFile {
    const scope = typeof owner === 'string' ? path.join('projects', owner) : 'projectId' in owner ? path.join('projects', owner.projectId) : path.join('conversations', owner.conversationId)
    return this.copyInto(scope, 'artifacts', sourcePath, name)
  }

  /** Stores bytes that never existed as a file on disk — specifically a
   *  pasted clipboard image, which has no source path to copy from. */
  storeProjectBytes(projectId: string, name: string, bytes: Uint8Array): StoredFile {
    if (bytes.byteLength > 100 * 1024 * 1024) throw new Error('Orbit imports are capped at 100 MB per file.')
    const destDir = path.join(this.dataDir, 'projects', projectId, 'files')
    fs.mkdirSync(destDir, { recursive: true })
    const storedPath = path.join(destDir, `${createId('file')}-${sanitizeName(name)}`)
    fs.writeFileSync(storedPath, bytes)
    return {
      originalPath: storedPath,
      storedPath,
      name,
      byteSize: bytes.byteLength,
      contentHash: hashFile(storedPath)
    }
  }

  private copyInto(scope: string, kind: 'files' | 'artifacts', sourcePath: string, displayName?: string): StoredFile {
    const stat = fs.statSync(sourcePath)
    if (!stat.isFile()) throw new Error('Only regular files can be imported into Orbit.')
    if (stat.size > 100 * 1024 * 1024) throw new Error('Orbit MVP imports are capped at 100 MB per file.')
    const name = displayName || path.basename(sourcePath)
    const destDir = path.join(this.dataDir, scope, kind)
    fs.mkdirSync(destDir, { recursive: true })
    const storedPath = path.join(destDir, `${createId(kind.slice(0, -1))}-${sanitizeName(name)}`)
    // Copied under a temporary name and renamed into place, so a copy that
    // fails or is interrupted never leaves a half-written file under a name
    // that looks finished. A leftover temporary file is reclaimed by the
    // storage sweep (artifactStorageGc.ts).
    const temporaryPath = path.join(destDir, `${TEMPORARY_PREFIX}${createId('copy')}`)
    try {
      fs.copyFileSync(sourcePath, temporaryPath)
      fs.renameSync(temporaryPath, storedPath)
    } catch (error) {
      fs.rmSync(temporaryPath, { force: true })
      throw error
    }
    return {
      originalPath: sourcePath,
      storedPath,
      name,
      byteSize: stat.size,
      contentHash: hashFile(storedPath)
    }
  }
}

export function hashFile(filePath: string): string {
  const hash = createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex')
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_')
}
