import path from 'node:path'
import type { ArtifactType, Artifact } from '@shared/domain'

const mimeByExt: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.jsx': 'text/javascript',
  '.diff': 'text/x-diff',
  '.patch': 'text/x-diff',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
}

export function inferMimeType(filePath: string): string | null {
  return mimeByExt[path.extname(filePath).toLowerCase()] ?? null
}

export function inferArtifactType(filePath: string, mimeType: string | null): ArtifactType {
  const ext = path.extname(filePath).toLowerCase()
  if (mimeType?.startsWith('image/') && ext !== '.svg') return 'image'
  if (mimeType === 'image/svg+xml') return 'svg'
  if (mimeType === 'text/markdown') return 'markdown'
  if (mimeType === 'text/html') return 'html'
  if (mimeType?.startsWith('audio/')) return 'audio'
  if (mimeType?.startsWith('video/')) return 'video'
  if (ext === '.diff' || ext === '.patch') return 'diff'
  if (['.ts', '.tsx', '.js', '.jsx', '.css', '.json'].includes(ext)) return 'code'
  if (mimeType?.startsWith('text/')) return 'text'
  return 'other'
}

export function previewKindFor(type: ArtifactType): Artifact['previewKind'] {
  if (type === 'image') return 'image'
  if (type === 'markdown') return 'markdown'
  if (type === 'html') return 'html'
  if (type === 'svg') return 'svg'
  if (type === 'audio') return 'audio'
  if (type === 'video') return 'video'
  if (type === 'text' || type === 'code' || type === 'diff') return 'text'
  return 'metadata'
}
