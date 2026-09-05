import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createId } from '@main/util/ids'

export interface StoredFile {
  originalPath: string
  storedPath: string
  name: string
  byteSize: number
  contentHash: string
}

export class FileStorage {
  constructor(private readonly dataDir: string) {}

  storeProjectFile(projectId: string, sourcePath: string): StoredFile {
    return this.copyInto(projectId, 'files', sourcePath)
  }

  storeArtifact(projectId: string, sourcePath: string): StoredFile {
    return this.copyInto(projectId, 'artifacts', sourcePath)
  }

  private copyInto(projectId: string, kind: 'files' | 'artifacts', sourcePath: string): StoredFile {
    const stat = fs.statSync(sourcePath)
    if (!stat.isFile()) throw new Error('Only regular files can be imported into Orbit.')
    if (stat.size > 100 * 1024 * 1024) throw new Error('Orbit MVP imports are capped at 100 MB per file.')
    const name = path.basename(sourcePath)
    const destDir = path.join(this.dataDir, 'projects', projectId, kind)
    fs.mkdirSync(destDir, { recursive: true })
    const storedPath = path.join(destDir, `${createId(kind.slice(0, -1))}-${sanitizeName(name)}`)
    fs.copyFileSync(sourcePath, storedPath)
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
