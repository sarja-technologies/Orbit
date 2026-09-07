import { useEffect, useRef, useState } from 'react'
import type { Conversation, ID } from '@shared/domain'

export type SessionIndicator = 'running' | 'attention' | null

interface SessionSidebarProps {
  conversations: Conversation[]
  activeConversationId: ID | null
  indicatorFor: (conversationId: ID) => SessionIndicator
  collapsed: boolean
  disabled: boolean
  onSelect: (conversationId: ID) => void
  onCreate: () => void
  onRename: (conversationId: ID, title: string) => void
  onDelete: (conversationId: ID) => void
  onToggleCollapsed: () => void
}

export function SessionSidebar({
  conversations,
  activeConversationId,
  indicatorFor,
  collapsed,
  disabled,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onToggleCollapsed
}: SessionSidebarProps): JSX.Element {
  const [renamingId, setRenamingId] = useState<ID | null>(null)
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<ID | null>(null)

  if (collapsed) {
    return (
      <nav className="sidebar sidebar-collapsed" aria-label="Sessions">
        <button type="button" className="icon-button" onClick={onToggleCollapsed} aria-label="Show sessions" title="Show sessions">
          <SidebarGlyph />
        </button>
        <button type="button" className="icon-button" onClick={onCreate} disabled={disabled} aria-label="New session" title="New session">
          <PlusGlyph />
        </button>
      </nav>
    )
  }

  return (
    <nav className="sidebar" aria-label="Sessions">
      <div className="sidebar-head">
        <span className="sidebar-title">Sessions</span>
        <button type="button" className="icon-button" onClick={onToggleCollapsed} aria-label="Hide sessions" title="Hide sessions">
          <SidebarGlyph />
        </button>
      </div>

      <button type="button" className="new-session" onClick={onCreate} disabled={disabled}>
        <PlusGlyph />
        <span>New</span>
      </button>

      <div className="session-list">
        {conversations.map((conversation) => (
          <SessionRow
            key={conversation.id}
            conversation={conversation}
            active={conversation.id === activeConversationId}
            indicator={indicatorFor(conversation.id)}
            renaming={renamingId === conversation.id}
            confirmingDelete={confirmingDeleteId === conversation.id}
            onSelect={() => onSelect(conversation.id)}
            onStartRename={() => setRenamingId(conversation.id)}
            onCommitRename={(title) => {
              setRenamingId(null)
              if (title.trim() && title.trim() !== conversation.title) onRename(conversation.id, title.trim())
            }}
            onRequestDelete={() => setConfirmingDeleteId(conversation.id)}
            onCancelDelete={() => setConfirmingDeleteId(null)}
            onConfirmDelete={() => {
              setConfirmingDeleteId(null)
              onDelete(conversation.id)
            }}
          />
        ))}
        {conversations.length === 0 ? <p className="sidebar-empty">No sessions yet.</p> : null}
      </div>
    </nav>
  )
}

interface SessionRowProps {
  conversation: Conversation
  active: boolean
  indicator: SessionIndicator
  renaming: boolean
  confirmingDelete: boolean
  onSelect: () => void
  onStartRename: () => void
  onCommitRename: (title: string) => void
  onRequestDelete: () => void
  onCancelDelete: () => void
  onConfirmDelete: () => void
}

function SessionRow({
  conversation,
  active,
  indicator,
  renaming,
  confirmingDelete,
  onSelect,
  onStartRename,
  onCommitRename,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete
}: SessionRowProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renaming) inputRef.current?.select()
  }, [renaming])

  if (confirmingDelete) {
    return (
      <div className="session-row session-row-confirm">
        <span className="session-confirm-text">Delete this session?</span>
        <div className="session-confirm-actions">
          <button type="button" className="danger-quiet" onClick={onConfirmDelete}>
            Delete
          </button>
          <button type="button" className="ghost" onClick={onCancelDelete}>
            Cancel
          </button>
        </div>
      </div>
    )
  }

  if (renaming) {
    return (
      <div className="session-row session-row-renaming">
        <input
          ref={inputRef}
          className="session-rename-input"
          defaultValue={conversation.title}
          aria-label="Session name"
          onBlur={(event) => onCommitRename(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              onCommitRename(event.currentTarget.value)
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              onCommitRename(conversation.title)
            }
          }}
        />
      </div>
    )
  }

  return (
    <div className={`session-row${active ? ' active' : ''}`}>
      <button type="button" className="session-open" onClick={onSelect} onDoubleClick={onStartRename} aria-current={active ? 'true' : undefined}>
        {indicator ? <span className={`session-indicator session-indicator-${indicator}`} aria-hidden="true" /> : null}
        <span className="session-name">{conversation.title}</span>
        {indicator === 'attention' ? <span className="visually-hidden">Needs your response</span> : null}
        {indicator === 'running' ? <span className="visually-hidden">Working</span> : null}
      </button>
      <SessionMenu onRename={onStartRename} onDelete={onRequestDelete} title={conversation.title} />
    </div>
  )
}

function SessionMenu({ onRename, onDelete, title }: { onRename: () => void; onDelete: () => void; title: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent): void => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  return (
    <div className="session-menu" ref={wrapperRef}>
      <button
        type="button"
        className="icon-button session-menu-trigger"
        aria-label={`Options for ${title}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreGlyph />
      </button>
      {open ? (
        <div className="menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onRename()
            }}
          >
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-danger"
            onClick={() => {
              setOpen(false)
              onDelete()
            }}
          >
            Delete
          </button>
        </div>
      ) : null}
    </div>
  )
}

function PlusGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
    </svg>
  )
}

function MoreGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <circle cx="8" cy="3.5" r="1.15" fill="currentColor" />
      <circle cx="8" cy="8" r="1.15" fill="currentColor" />
      <circle cx="8" cy="12.5" r="1.15" fill="currentColor" />
    </svg>
  )
}

function SidebarGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3" fill="none" />
      <path d="M6.5 3v10" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}
