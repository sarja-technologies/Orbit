import { useEffect } from 'react'
import type { MediaKind } from '@shared/outputArtifacts'
import { mediaAddedMessage } from '@shared/outputArtifacts'

export interface ArtifactNotice {
  /** The artifact's own id — also the dedupe key, so one registration
   *  produces exactly one toast however many times the event is seen. */
  artifactId: string
  name: string
  kind: MediaKind
}

/** How long a toast stays up. Long enough to read and click, short enough
 *  that it is gone before it becomes something to dismiss. */
const DISMISS_AFTER_MS = 5200

interface ArtifactToastsProps {
  notices: ArtifactNotice[]
  onOpen: (artifactId: string) => void
  onDismiss: (artifactId: string) => void
}

/** Tells the user that something they can look at has appeared, without
 *  taking them there.
 *
 *  Deliberately not the `notice` banner: that is for things that went
 *  wrong and stays until dismissed. A generated image is good news and
 *  should cost nothing — so these sit out of the way, disappear on their
 *  own, and never steal focus. Clicking one opens the artifact. */
export function ArtifactToasts({ notices, onOpen, onDismiss }: ArtifactToastsProps): JSX.Element | null {
  if (notices.length === 0) return null

  return (
    <div className="artifact-toasts" aria-live="polite">
      {notices.map((notice) => (
        <ArtifactToast key={notice.artifactId} notice={notice} onOpen={onOpen} onDismiss={onDismiss} />
      ))}
    </div>
  )
}

function ArtifactToast({
  notice,
  onOpen,
  onDismiss
}: {
  notice: ArtifactNotice
  onOpen: (artifactId: string) => void
  onDismiss: (artifactId: string) => void
}): JSX.Element {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(notice.artifactId), DISMISS_AFTER_MS)
    return () => clearTimeout(timer)
  }, [notice.artifactId, onDismiss])

  return (
    <button type="button" className="artifact-toast" onClick={() => onOpen(notice.artifactId)}>
      <span className="artifact-toast-mark" aria-hidden="true">
        {notice.kind === 'video' ? <VideoGlyph /> : <ImageGlyph />}
      </span>
      <span className="artifact-toast-text">
        <span className="artifact-toast-title">{mediaAddedMessage(notice.kind)}</span>
        {/* The file's own name, so several in a row are distinguishable. */}
        <span className="artifact-toast-name">{notice.name}</span>
      </span>
    </button>
  )
}

function ImageGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <rect x="2.2" y="3.2" width="11.6" height="9.6" rx="1.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="6" cy="6.6" r="1.1" fill="currentColor" />
      <path d="M3.2 11.2l3-2.8 2.4 2.2 2-1.6 2.2 2.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function VideoGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <rect x="2.2" y="3.6" width="8.4" height="8.8" rx="1.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.8 8l3-2.2v4.4L10.8 8z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  )
}
