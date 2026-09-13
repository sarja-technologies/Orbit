import { memo, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Artifact, ID } from '@shared/domain'
import type { ArtifactActionResult, ArtifactContent, ArtifactSummary } from '@shared/contracts'
import { hasInlinePreview, outputKindFor, outputTypeLabel, type OutputKind } from '@shared/outputArtifacts'
import { getOrbitApi } from '../orbitApi'
import { formatBytes } from '../lib/attachments'
import { Modal, ModalHeader } from './Modal'

/** Card data is fetched once per artifact for the life of the window.
 *  Previews are bytes the main process already downscaled; refetching them
 *  on every transcript render would be pure waste. A failed action clears
 *  the entry, so a file deleted mid-session is re-described. */
const summaries = new Map<ID, Promise<ArtifactSummary>>()

function loadSummary(artifactId: ID): Promise<ArtifactSummary> | null {
  const orbit = getOrbitApi()
  if (!orbit?.artifacts.describe) return null
  let pending = summaries.get(artifactId)
  if (!pending) {
    pending = orbit.artifacts.describe(artifactId).catch(() => {
      summaries.delete(artifactId)
      return { artifactId, available: false, byteSize: null, previewDataUrl: null, canOpen: false, canReveal: false }
    })
    summaries.set(artifactId, pending)
  }
  return pending
}

/** Test seam: the cache is module state. */
export function clearArtifactSummaryCache(): void {
  summaries.clear()
}

const REVEAL_LABEL = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent) ? 'Show in Finder' : 'Show in folder'

/** What a turn handed to the user, drawn under the reply that produced it.
 *
 *  Images are previews you can click to see larger; everything else is a
 *  compact card. Neither shows where the file lives — the name is what the
 *  user recognises, and the OS actions go and find it for them. */
export const TurnArtifacts = memo(function TurnArtifacts({ artifacts }: { artifacts: Artifact[] }): JSX.Element | null {
  if (artifacts.length === 0) return null
  const images = artifacts.filter((artifact) => hasInlinePreview(artifact.name))
  const files = artifacts.filter((artifact) => !hasInlinePreview(artifact.name))
  return (
    <div className="turn-artifacts chat-rail" aria-label="Files from this response">
      {images.length > 0 ? (
        <div className="turn-artifact-images">
          {images.map((artifact) => (
            <ArtifactImage key={artifact.id} artifact={artifact} />
          ))}
        </div>
      ) : null}
      {files.length > 0 ? (
        <div className="turn-artifact-files">
          {files.map((artifact) => (
            <ArtifactFileCard key={artifact.id} artifact={artifact} />
          ))}
        </div>
      ) : null}
    </div>
  )
})

function useArtifactSummary(artifactId: ID): [ArtifactSummary | null, (next: ArtifactSummary) => void] {
  const [summary, setSummary] = useState<ArtifactSummary | null>(null)
  useEffect(() => {
    let live = true
    void loadSummary(artifactId)?.then((result) => {
      if (live) setSummary(result)
    })
    return () => {
      live = false
    }
  }, [artifactId])
  return [summary, setSummary]
}

/** Runs an OS action and turns its outcome into state the card can show.
 *  A file that turns out to be gone flips the card to unavailable. */
function useArtifactActions(
  artifactId: ID,
  summary: ArtifactSummary | null,
  setSummary: (next: ArtifactSummary) => void
): { problem: string | null; open: () => void; reveal: () => void } {
  const [problem, setProblem] = useState<string | null>(null)
  const run = (action: 'open' | 'reveal'): void => {
    const orbit = getOrbitApi()
    if (!orbit) return
    setProblem(null)
    const call: Promise<ArtifactActionResult> = action === 'open' ? orbit.artifacts.open(artifactId) : orbit.artifacts.reveal(artifactId)
    void call
      .then((result) => {
        if (result.ok) return
        if (result.reason === 'missing') {
          summaries.delete(artifactId)
          if (summary) setSummary({ ...summary, available: false, canOpen: false, canReveal: false })
          setProblem('This file is no longer available.')
        } else if (result.reason === 'not-openable') {
          setProblem('Orbit does not open this kind of file directly.')
        } else {
          setProblem('No app could open this file.')
        }
      })
      .catch(() => setProblem('That did not work.'))
  }
  return { problem, open: () => run('open'), reveal: () => run('reveal') }
}

function ArtifactImage({ artifact }: { artifact: Artifact }): JSX.Element {
  const [summary, setSummary] = useArtifactSummary(artifact.id)
  const [viewing, setViewing] = useState(false)
  const actions = useArtifactActions(artifact.id, summary, setSummary)

  if (summary && (!summary.available || !summary.previewDataUrl)) {
    // Gone from disk, or too large to preview: the file card still names it
    // and still offers whatever can genuinely be done.
    return <ArtifactFileCard artifact={artifact} />
  }

  return (
    <figure className="turn-artifact-image">
      <button
        type="button"
        className="turn-artifact-image-button"
        onClick={() => setViewing(true)}
        aria-label={`View ${artifact.name} larger`}
        disabled={!summary}
      >
        {summary?.previewDataUrl ? (
          <img src={summary.previewDataUrl} alt={artifact.name} draggable={false} />
        ) : (
          <span className="turn-artifact-image-placeholder" aria-hidden="true" />
        )}
      </button>
      <figcaption className="turn-artifact-caption">
        <span className="turn-artifact-name" title={artifact.name}>
          {artifact.name}
        </span>
        <ArtifactActions summary={summary} onOpen={actions.open} onReveal={actions.reveal} compact />
      </figcaption>
      {actions.problem ? <p className="turn-artifact-problem">{actions.problem}</p> : null}
      {viewing && summary ? (
        <ArtifactViewer artifact={artifact} summary={summary} onClose={() => setViewing(false)} onOpen={actions.open} onReveal={actions.reveal} />
      ) : null}
    </figure>
  )
}

function ArtifactFileCard({ artifact }: { artifact: Artifact }): JSX.Element {
  const [summary, setSummary] = useArtifactSummary(artifact.id)
  const actions = useArtifactActions(artifact.id, summary, setSummary)
  const unavailable = summary !== null && !summary.available && !summary.canReveal
  const kind = outputKindFor(artifact.name)
  const meta = unavailable
    ? 'No longer available'
    : [outputTypeLabel(artifact.name), summary?.byteSize != null ? formatBytes(summary.byteSize) : null].filter(Boolean).join(' · ')

  return (
    <div className={`turn-artifact-file${unavailable ? ' is-unavailable' : ''}`}>
      <span className="turn-artifact-icon" data-kind={kind ?? 'file'} aria-hidden="true">
        <KindGlyph kind={kind} />
      </span>
      <span className="turn-artifact-text">
        <span className="turn-artifact-name" title={artifact.name}>
          {artifact.name}
        </span>
        <span className="turn-artifact-meta">{actions.problem ?? meta}</span>
      </span>
      <ArtifactActions summary={summary} onOpen={actions.open} onReveal={actions.reveal} />
    </div>
  )
}

function ArtifactActions({
  summary,
  onOpen,
  onReveal,
  compact = false
}: {
  summary: ArtifactSummary | null
  onOpen: () => void
  onReveal: () => void
  compact?: boolean
}): JSX.Element | null {
  if (!summary || (!summary.canOpen && !summary.canReveal)) return null
  return (
    <span className={`turn-artifact-actions${compact ? ' is-compact' : ''}`}>
      {summary.canOpen ? (
        <button type="button" className="ghost" onClick={onOpen}>
          Open
        </button>
      ) : null}
      {summary.canReveal ? (
        <button type="button" className="ghost" onClick={onReveal}>
          {REVEAL_LABEL}
        </button>
      ) : null}
    </span>
  )
}

/** The larger view. The full image is loaded only here, on request — the
 *  transcript itself only ever holds downscaled previews. */
function ArtifactViewer({
  artifact,
  summary,
  onClose,
  onOpen,
  onReveal
}: {
  artifact: Artifact
  summary: ArtifactSummary
  onClose: () => void
  onOpen: () => void
  onReveal: () => void
}): JSX.Element {
  const [content, setContent] = useState<ArtifactContent | null>(null)
  useEffect(() => {
    let live = true
    void getOrbitApi()
      ?.artifacts.getContent(artifact.id)
      .then((result) => {
        if (live) setContent(result)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [artifact.id])

  const source = content?.dataUrl ?? summary.previewDataUrl
  // Portalled to the document: the transcript establishes its own layout
  // containment, which would otherwise trap a fixed backdrop inside it.
  return createPortal(
    <Modal label={artifact.name} wide onClose={onClose}>
      <div className="artifact-viewer">
        <ModalHeader title={artifact.name} onClose={onClose} />
        <div className="artifact-viewer-stage">{source ? <img src={source} alt={artifact.name} /> : null}</div>
        <div className="artifact-viewer-foot">
          <span className="turn-artifact-meta">
            {[outputTypeLabel(artifact.name), summary.byteSize != null ? formatBytes(summary.byteSize) : null].filter(Boolean).join(' · ')}
          </span>
          <ArtifactActions summary={summary} onOpen={onOpen} onReveal={onReveal} />
        </div>
      </div>
    </Modal>,
    document.body
  )
}

function KindGlyph({ kind }: { kind: OutputKind | null }): JSX.Element {
  const common = { viewBox: '0 0 16 16', width: 16, height: 16, focusable: false as const, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const }
  switch (kind) {
    case 'image':
      return (
        <svg {...common}>
          <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
          <path d="m3 11.5 3.2-3.2 2.3 2.3 1.6-1.6 2.9 2.9" />
          <circle cx="10.6" cy="6" r="1" />
        </svg>
      )
    case 'video':
    case 'audio':
      return (
        <svg {...common}>
          <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
          <path d="M6.8 6v4l3.4-2z" fill="currentColor" />
        </svg>
      )
    case 'archive':
      return (
        <svg {...common}>
          <path d="M4 2h5l3 3v9H4z" />
          <path d="M7 3v1.2M7 5.6v1.2M7 8.2v1.2" />
          <rect x="6.2" y="10.2" width="1.6" height="1.8" rx="0.4" />
        </svg>
      )
    case 'data':
      return (
        <svg {...common}>
          <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
          <path d="M2.5 6.4h11M2.5 9.7h11M6.2 3v10" />
        </svg>
      )
    default:
      return (
        <svg {...common}>
          <path d="M4 2h5l3 3v9H4z" />
          <path d="M9 2v3h3M6 8.5h4M6 11h3" />
        </svg>
      )
  }
}
