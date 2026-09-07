import { useEffect, useRef, type ClipboardEvent, type KeyboardEvent } from 'react'
import type { ModelOption, ReasoningEffort } from '@shared/domain'
import type { DraftAttachment } from '../lib/attachments'
import { imageItemsFromClipboard } from '../lib/attachments'
import { AttachmentChip } from './AttachmentChip'
import { ModelControls } from './ModelControls'

interface ComposerProps {
  value: string
  attachments: DraftAttachment[]
  disabled: boolean
  running: boolean
  /** Set when the next message answers a question Antigravity just asked. */
  replying: boolean
  models: ModelOption[]
  selectedModel: string | null
  selectedEffort: ReasoningEffort | null
  onModelChange: (model: string | null, effort: ReasoningEffort | null) => void
  /** Lets the empty-state starters hand focus back to the composer after
   *  they fill it, so the user can keep typing without reaching for it. */
  registerFocus?: (focus: () => void) => void
  onChange: (value: string) => void
  onSend: () => void
  onCancel: () => void
  onPickFiles: () => void
  onPasteImages: (files: File[]) => void
  onRemoveAttachment: (fileId: string) => void
  onRetryAttachment: (fileId: string) => void
}

const MAX_HEIGHT = 260

export function Composer({
  value,
  attachments,
  disabled,
  running,
  replying,
  onChange,
  onSend,
  onCancel,
  onPickFiles,
  onPasteImages,
  onRemoveAttachment,
  onRetryAttachment,
  models,
  selectedModel,
  selectedEffort,
  onModelChange,
  registerFocus
}: ComposerProps): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    registerFocus?.(() => textareaRef.current?.focus())
  }, [registerFocus])

  // Grow upward with content, then scroll internally.
  useEffect(() => {
    const node = textareaRef.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(node.scrollHeight, MAX_HEIGHT)}px`
  }, [value])

  const canSend = !disabled && !running && (value.trim().length > 0 || attachments.length > 0)

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      if (canSend) onSend()
      return
    }
    if (event.key === 'Escape' && running) {
      event.preventDefault()
      onCancel()
    }
  }

  // Only real image payloads become attachments — ordinary copied text
  // must fall through to the textarea untouched.
  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const imageItems = imageItemsFromClipboard(event.clipboardData?.items)
    if (imageItems.length === 0) return
    const files = imageItems.map((item) => item.getAsFile()).filter((file): file is File => file !== null)
    if (files.length === 0) return
    event.preventDefault()
    onPasteImages(files)
  }

  return (
    <div className="composer">
      {attachments.length > 0 ? (
        <div className="composer-attachments">
          {attachments.map((attachment) => (
            <AttachmentChip
              key={attachment.fileId}
              attachment={attachment}
              onRemove={() => onRemoveAttachment(attachment.fileId)}
              onRetry={() => onRetryAttachment(attachment.fileId)}
            />
          ))}
        </div>
      ) : null}

      {replying ? <div className="composer-hint">Replying to Antigravity</div> : null}

      <div className="composer-surface">
        <textarea
          ref={textareaRef}
          className="composer-input"
          rows={1}
          value={value}
          disabled={disabled}
          placeholder={replying ? 'Reply to Antigravity…' : 'Ask Antigravity or describe a task…'}
          aria-label={replying ? 'Reply to Antigravity' : 'Message Antigravity'}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
        />

        <div className="composer-controls">
          <button type="button" className="icon-button composer-attach" onClick={onPickFiles} disabled={disabled} aria-label="Add files">
            <PlusGlyph />
          </button>

          <ModelControls
            models={models}
            selectedModel={selectedModel}
            selectedEffort={selectedEffort}
            disabled={disabled}
            onChange={onModelChange}
          />

          <div className="composer-spacer" />

          {running ? (
            <button type="button" className="composer-send composer-stop" onClick={onCancel} aria-label="Stop generating">
              <StopGlyph />
              <span>Stop</span>
            </button>
          ) : (
            <button type="button" className="composer-send" onClick={onSend} disabled={!canSend} aria-label="Send message">
              <SendGlyph />
              <span>Send</span>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function PlusGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
    </svg>
  )
}

function SendGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
      <path d="M8 13V3.5M4 7l4-3.5L12 7" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function StopGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" focusable="false">
      <rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" />
    </svg>
  )
}
