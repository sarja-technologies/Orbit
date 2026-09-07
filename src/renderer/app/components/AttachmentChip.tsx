import { formatBytes, stateHint, stateLabel, type DraftAttachment } from '../lib/attachments'

interface AttachmentChipProps {
  attachment: DraftAttachment
  onRemove: () => void
  onRetry: () => void
}

export function AttachmentChip({ attachment, onRemove, onRetry }: AttachmentChipProps): JSX.Element {
  const hint = stateHint(attachment.state)
  const busy = attachment.state === 'attaching'

  return (
    <div className={`chip chip-${attachment.state}`} title={hint ?? attachment.name}>
      <span className="chip-visual" aria-hidden="true">
        {attachment.thumbnail ? <img src={attachment.thumbnail} alt="" /> : <FileGlyph />}
        {busy ? <span className="chip-busy" /> : null}
      </span>

      <span className="chip-text">
        <span className="chip-name">{attachment.name}</span>
        <span className="chip-meta">
          {attachment.state === 'ready' ? formatBytes(attachment.byteSize) : stateLabel(attachment.state)}
        </span>
      </span>

      {attachment.state === 'failed' ? (
        <button type="button" className="chip-action" onClick={onRetry} aria-label={`Retry attaching ${attachment.name}`}>
          Retry
        </button>
      ) : null}

      <button type="button" className="chip-remove" onClick={onRemove} aria-label={`Remove ${attachment.name}`}>
        <CloseGlyph />
      </button>
    </div>
  )
}

function FileGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" focusable="false">
      <path d="M4 2h5l3 3v9H4z" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
      <path d="M9 2v3h3" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
    </svg>
  )
}

function CloseGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" focusable="false">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}
