import { useEffect, useRef, type ClipboardEvent, type KeyboardEvent } from 'react'
import type { Conversation, ConversationTransport, ID, ModelOption, Project, ReasoningEffort } from '@shared/domain'
import type { DraftAttachment } from '../lib/attachments'
import { imageItemsFromClipboard } from '../lib/attachments'
import { AttachmentChip } from './AttachmentChip'
import { ComposerControlProvider } from './ComposerControl'
import { ModelControls } from './ModelControls'
import { PermissionControl } from './PermissionControl'
import { ProjectControl } from './ProjectControl'

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
  /** The model the runtime reported for this session, if any. */
  resolvedModelId: string | null
  onSelectModel: (model: string | null) => void
  onSelectEffort: (effort: ReasoningEffort) => void
  /** The working context the next message will act in — the project, its
   *  folder, and whether Antigravity can stop and ask about what it does
   *  there. Passed in rather than read here: the composer renders the
   *  session's real state, it does not own it. */
  project: Project | null
  conversation: Conversation | null
  projects: readonly Project[]
  onSelectProject: (projectId: ID) => void
  onChangeProjectFolder: () => void
  onSelectTransport: (transport: ConversationTransport) => void
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

const MAX_HEIGHT = 320

/** The primary control surface: one elevated, generously rounded card that
 *  carries the prompt, its attachments, the real model state and the send
 *  action. Everything inside it stays quiet so the surface itself reads as
 *  the thing you act on. */
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
  resolvedModelId,
  onSelectModel,
  onSelectEffort,
  project,
  conversation,
  projects,
  onSelectProject,
  onChangeProjectFolder,
  onSelectTransport,
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
      {replying ? <div className="composer-hint">Replying to Antigravity</div> : null}

      <div className="composer-surface">
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
          <button type="button" className="composer-attach" onClick={onPickFiles} disabled={disabled} aria-label="Add files">
            <PlusGlyph />
          </button>

          {/* Project, Model, Permissions — the three things that decide what
              the next message will actually do, in one row, sharing one
              trigger shape and one open-at-a-time popover. */}
          <ComposerControlProvider>
            <div className="composer-context">
              <ProjectControl
                project={project}
                conversation={conversation}
                projects={projects}
                disabled={disabled}
                onSelectProject={onSelectProject}
                onChangeFolder={onChangeProjectFolder}
              />

              <ModelControls
                models={models}
                selectedModel={selectedModel}
                selectedEffort={selectedEffort}
                resolvedModelId={resolvedModelId}
                disabled={disabled}
                onSelectModel={onSelectModel}
                onSelectEffort={onSelectEffort}
              />

              <PermissionControl
                transport={conversation?.transport ?? 'structured'}
                disabled={disabled || !conversation}
                onSelect={onSelectTransport}
              />
            </div>
          </ComposerControlProvider>

          <div className="composer-spacer" />

          {running ? (
            <button type="button" className="composer-send is-stop" onClick={onCancel} aria-label="Stop generating">
              <StopGlyph />
            </button>
          ) : (
            <button type="button" className="composer-send" onClick={onSend} disabled={!canSend} aria-label="Send message">
              <SendGlyph />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function PlusGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
    </svg>
  )
}

function SendGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <path d="M8 13V3.8M4.2 7.4L8 3.5l3.8 3.9" stroke="currentColor" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function StopGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
      <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
    </svg>
  )
}
