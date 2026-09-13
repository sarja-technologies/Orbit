import type { Artifact } from '@shared/domain'
import type { ArtifactContent } from '@shared/contracts'
import { formatBytes } from '../lib/attachments'

export function ArtifactPreview({ artifact, content }: { artifact: Artifact | null; content: ArtifactContent | null }): JSX.Element {
  if (!artifact) return <p className="context-empty">Select something to preview it.</p>
  if (!content) return <p className="context-empty">Loading…</p>
  if (!content.available) return <p className="context-empty">This file is no longer available.</p>
  if (content.dataUrl && content.previewKind === 'image') return <img className="artifact-image" src={content.dataUrl} alt={artifact.name} />
  if (content.dataUrl && content.previewKind === 'audio') return <audio controls src={content.dataUrl} />
  if (content.dataUrl && content.previewKind === 'video') return <video controls src={content.dataUrl} />
  if (content.text && (content.previewKind === 'html' || content.previewKind === 'svg')) {
    return <iframe className="artifact-frame" title={artifact.name} sandbox="" srcDoc={content.text} />
  }
  if (content.text) return <pre className="artifact-text">{content.text}</pre>
  return (
    <div className="artifact-meta">
      <strong>{artifact.name}</strong>
      <span>{artifact.mimeType ?? 'Unknown type'}</span>
      <span>{formatBytes(content.byteSize)}</span>
    </div>
  )
}
