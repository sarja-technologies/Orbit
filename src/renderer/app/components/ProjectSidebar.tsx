import { useEffect, useRef, useState } from 'react'
import type { Conversation, ID, ProjectGroup } from '@shared/domain'
import { relativeTime } from '../lib/relativeTime'

export type SessionIndicator = 'running' | 'attention' | null

interface ProjectSidebarProps {
  groups: ProjectGroup[]
  /** Sessions that belong to no project, shown in their own group above
   *  the projects. A grouping, not a project — there is no folder, no
   *  settings and nothing to open behind it. */
  unsorted: Conversation[]
  /** Opens Orbit's settings. Lives in the sidebar's own footer, not beside
   *  any project. */
  onOpenSettings: () => void
  activeProjectId: ID | null
  activeConversationId: ID | null
  expandedProjectIds: readonly ID[]
  indicatorFor: (conversationId: ID) => SessionIndicator
  collapsed: boolean
  /** The user's dragged width, applied inline because it is live state, not
   *  a stylesheet constant. Ignored while collapsed, which has its own
   *  fixed rail width. */
  width: number
  onToggleProject: (projectId: ID) => void
  /** Null names the Unsorted workspace rather than a project. */
  onSelectSession: (projectId: ID | null, conversationId: ID) => void
  /** Opens the project-creation dialog: a project genuinely needs a name
   *  and a folder before it can exist. */
  onNewProject: () => void
  /** Creates a session in this project there and then — no dialog. A
   *  session needs nothing configured: it is named from its first prompt
   *  and runs in its project's folder. */
  /** Null creates an Unsorted session, which is what the global control
   *  does; a project's own + passes that project's id. */
  onNewSession: (projectId: ID | null) => void
  onRename: (conversationId: ID, title: string) => void
  onDelete: (conversationId: ID) => void
  onToggleCollapsed: () => void
}

/** Navigation, project-first: every session belongs to a project and is
 *  shown underneath it. The flat list this replaces could not answer "which
 *  project am I in?" — the thing that matters most once there is more than
 *  one. Rows are separated by rhythm and a soft selected fill, never boxes. */
export function ProjectSidebar({
  groups,
  unsorted,
  onOpenSettings,
  activeProjectId,
  activeConversationId,
  expandedProjectIds,
  indicatorFor,
  collapsed,
  width,
  onToggleProject,
  onSelectSession,
  onNewProject,
  onNewSession,
  onRename,
  onDelete,
  onToggleCollapsed
}: ProjectSidebarProps): JSX.Element {
  const [renamingId, setRenamingId] = useState<ID | null>(null)
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<ID | null>(null)

  if (collapsed) {
    return (
      <nav className="sidebar sidebar-collapsed" aria-label="Projects and sessions">
        <button type="button" className="icon-button" onClick={onToggleCollapsed} aria-label="Show projects" title="Show projects">
          <PanelGlyph />
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={() => onNewSession(null)}
          aria-label="New session"
          title="New session"
        >
          <PlusGlyph />
        </button>
      </nav>
    )
  }

  return (
    <nav className="sidebar" aria-label="Projects and sessions" style={{ width }}>
      <div className="sidebar-brand">
        <OrbitLogo />
        <span className="brand-text">
          <span className="brand-name">Orbit</span>
          <span className="brand-by">by AgentDock</span>
        </span>
        <button type="button" className="icon-button" onClick={onToggleCollapsed} aria-label="Hide projects" title="Hide projects">
          <PanelGlyph />
        </button>
      </div>

      <div className="sidebar-section">
        <span className="sidebar-section-label">Projects</span>
        <CreateMenu activeProjectId={activeProjectId} onNewProject={onNewProject} onNewSession={onNewSession} />
      </div>

      <div className="project-tree">
        {unsorted.length > 0 ? (
          <div className={activeProjectId === null ? 'project-group current' : 'project-group'}>
            <div className="project-row">
              <span className="project-open project-open-static">
                <span className="project-name">Unsorted</span>
              </span>
            </div>
            <div className="session-list">
              {unsorted.map((conversation) => (
                <SessionRow
                  key={conversation.id}
                  conversation={conversation}
                  active={conversation.id === activeConversationId}
                  indicator={indicatorFor(conversation.id)}
                  renaming={renamingId === conversation.id}
                  confirmingDelete={confirmingDeleteId === conversation.id}
                  onSelect={() => onSelectSession(null, conversation.id)}
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
            </div>
          </div>
        ) : null}

        {groups.map((group) => {
          const expanded = expandedProjectIds.includes(group.project.id)
          return (
            <div
              key={group.project.id}
              className={group.project.id === activeProjectId ? 'project-group current' : 'project-group'}
            >
              <div className="project-row">
                <button
                  type="button"
                  className="project-open"
                  aria-expanded={expanded}
                  onClick={() => onToggleProject(group.project.id)}
                  title={group.project.rootPath ?? 'Orbit-managed workspace'}
                >
                  <DisclosureGlyph open={expanded} />
                  <span className="project-name">{group.project.name}</span>
                  {/* Aria-hidden on purpose: expanding the group announces
                      the sessions themselves, so the count would only make
                      the row's name longer without adding anything. */}
                  {!expanded && group.conversations.length > 0 ? (
                    <span className="project-count" aria-hidden="true">
                      {group.conversations.length}
                    </span>
                  ) : null}
                </button>
                {/* One click is the whole flow: the session exists in this
                    project immediately, with nothing to fill in. */}
                <button
                  type="button"
                  className="icon-button project-add"
                  aria-label={`New session in ${group.project.name}`}
                  title={`New session in ${group.project.name}`}
                  onClick={() => onNewSession(group.project.id)}
                >
                  <PlusGlyph />
                </button>
              </div>

              {expanded ? (
                <div className="session-list">
                  {group.conversations.map((conversation) => (
                    <SessionRow
                      key={conversation.id}
                      conversation={conversation}
                      active={conversation.id === activeConversationId}
                      indicator={indicatorFor(conversation.id)}
                      renaming={renamingId === conversation.id}
                      confirmingDelete={confirmingDeleteId === conversation.id}
                      onSelect={() => onSelectSession(group.project.id, conversation.id)}
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
                  {group.conversations.length === 0 ? <p className="sidebar-empty">No sessions yet.</p> : null}
                </div>
              ) : null}
            </div>
          )
        })}
        {groups.length === 0 ? <p className="sidebar-empty">No projects yet.</p> : null}
      </div>

      {/* Orbit's own settings, kept away from the projects above it: these
          belong to the app, not to any one project or session. */}
      <div className="sidebar-footer">
        <button type="button" className="sidebar-settings" onClick={onOpenSettings} aria-label="Settings">
          <GearGlyph />
          <span className="sidebar-settings-label">Settings</span>
        </button>
      </div>
    </nav>
  )
}

function GearGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M8 1.6v1.5M8 12.9v1.5M14.4 8h-1.5M3.1 8H1.6M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1M12.5 12.5l-1.1-1.1M4.6 4.6L3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  )
}

interface CreateMenuProps {
  activeProjectId: ID | null
  onNewProject: () => void
  /** Null creates an Unsorted session, which is what the global control
   *  does; a project's own + passes that project's id. */
  onNewSession: (projectId: ID | null) => void
}

/** The one creation affordance, compact enough to sit on the section header
 *  rather than taking a full-width button's worth of the sidebar. The two
 *  items are deliberately asymmetric: a project opens its dialog, a session
 *  just appears — Unsorted, so it needs nothing chosen first. */
function CreateMenu({ activeProjectId, onNewProject, onNewSession }: CreateMenuProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="create-menu" ref={wrapperRef}>
      <button
        type="button"
        className="icon-button create-trigger"
        aria-label="New project or session"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <PlusGlyph />
      </button>
      {open ? (
        <div className="menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setOpen(false)
              onNewProject()
            }}
          >
            <FolderGlyph />
            <span className="menu-item-label">New project</span>
          </button>
          {/* Always available: a new session needs no project, and starts
              Unsorted. A project's own + is how one is made inside it. */}
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setOpen(false)
              onNewSession(null)
            }}
          >
            <ChatGlyph />
            <span className="menu-item-label">New session</span>
          </button>
        </div>
      ) : null}
    </div>
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
      <button
        type="button"
        className="session-open"
        onClick={onSelect}
        onDoubleClick={onStartRename}
        aria-current={active ? 'true' : undefined}
        title={conversation.workingDirectory ?? undefined}
      >
        {indicator ? <span className={`session-indicator session-indicator-${indicator}`} aria-hidden="true" /> : null}
        <span className="session-name">{conversation.title}</span>
        <span className="session-time">{relativeTime(conversation.updatedAt)}</span>
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

function OrbitLogo(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="21" height="21" aria-hidden="true" focusable="false" className="orbit-logo">
      <circle cx="12" cy="12" r="4.6" stroke="currentColor" strokeWidth="2.2" fill="none" />
      <ellipse cx="12" cy="12" rx="10.2" ry="4.4" stroke="currentColor" strokeWidth="1.4" fill="none" opacity="0.55" transform="rotate(-30 12 12)" />
    </svg>
  )
}

function PlusGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
    </svg>
  )
}

function DisclosureGlyph({ open }: { open: boolean }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden="true"
      focusable="false"
      className={open ? 'disclosure-glyph open' : 'disclosure-glyph'}
    >
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
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

function PanelGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor" strokeWidth="1.3" fill="none" />
      <path d="M6.5 3v10" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

function FolderGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.3l1.2 1.5h5.5A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ChatGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="M2.5 4.2A1.7 1.7 0 0 1 4.2 2.5h7.6A1.7 1.7 0 0 1 13.5 4.2v5A1.7 1.7 0 0 1 11.8 11H6.4L3.4 13.3V11h-.9z"
        stroke="currentColor"
        strokeWidth="1.2"
        fill="none"
        strokeLinejoin="round"
      />
    </svg>
  )
}
