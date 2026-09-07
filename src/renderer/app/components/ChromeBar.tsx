import { useEffect, useRef, useState } from 'react'
import type { ID, Project, ProviderStatus } from '@shared/domain'
import { describeProviderProblem } from '../lib/errorCopy'

interface ChromeBarProps {
  projects: Project[]
  activeProject: Project | null
  providerStatus: ProviderStatus | null
  onSelectProject: (projectId: ID) => void
  onCreateProject: (name: string) => void
}

/** One compact bar: identity, active project, provider health. A healthy
 *  provider is a dot and a word — never a permanent banner. */
export function ChromeBar({ projects, activeProject, providerStatus, onSelectProject, onCreateProject }: ChromeBarProps): JSX.Element {
  const problem = providerStatus ? describeProviderProblem(providerStatus.state, providerStatus.message) : null
  const state = providerStatus?.state ?? 'idle'

  return (
    <header className="chrome">
      <div className="chrome-brand">Orbit</div>

      {/* Project context reads as a path, so "where am I" is unambiguous.
          Creating a project lives inside the menu rather than advertising
          itself as permanent chrome. */}
      <div className="chrome-project">
        <span className="chrome-sep" aria-hidden="true">/</span>
        <ProjectMenu
          projects={projects}
          activeProject={activeProject}
          onSelectProject={onSelectProject}
          onCreateProject={onCreateProject}
        />
      </div>

      {/* Tertiary: a healthy provider is a dot, nothing more. */}
      <div className="chrome-status" title={providerStatus?.message ?? undefined}>
        <span className={`status-dot status-dot-${state}`} aria-hidden="true" />
        {problem ? <span className="status-label">Antigravity</span> : null}
        <span className="visually-hidden">{problem ? problem.title : 'Antigravity is ready'}</span>
      </div>
    </header>
  )
}

function ProjectMenu({
  projects,
  activeProject,
  onSelectProject,
  onCreateProject
}: {
  projects: Project[]
  activeProject: Project | null
  onSelectProject: (projectId: ID) => void
  onCreateProject: (name: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (creating) nameRef.current?.focus()
  }, [creating])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (!wrapperRef.current?.contains(event.target as Node)) {
        setOpen(false)
        setCreating(false)
      }
    }
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false)
        setCreating(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="project-menu" ref={wrapperRef}>
      <button
        type="button"
        className="project-trigger"
        aria-label="Project"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => {
          setOpen((value) => !value)
          setCreating(false)
        }}
      >
        <FolderGlyph />
        <span className="project-name">{activeProject?.name ?? 'No project'}</span>
        <ChevronGlyph />
      </button>
      {open ? (
        <div className="menu" role="menu">
          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              role="menuitemradio"
              aria-checked={project.id === activeProject?.id}
              className={project.id === activeProject?.id ? 'menu-item selected' : 'menu-item'}
              onClick={() => {
                setOpen(false)
                onSelectProject(project.id)
              }}
            >
              <span className="menu-item-label">{project.name}</span>
            </button>
          ))}
          {projects.length > 0 ? <div className="menu-divider" role="none" /> : null}
          {/* Named in place. Electron's renderer has no window.prompt — it
              throws — so a dialog-based flow would leave the user unable to
              create a project at all. */}
          {creating ? (
            <input
              ref={nameRef}
              className="project-name-input"
              placeholder="Project name"
              aria-label="New project name"
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  const name = event.currentTarget.value.trim()
                  if (!name) return
                  setCreating(false)
                  setOpen(false)
                  onCreateProject(name)
                }
              }}
            />
          ) : (
            <button type="button" role="menuitem" className="menu-item" onClick={() => setCreating(true)}>
              <span className="menu-item-label">New project…</span>
            </button>
          )}
        </div>
      ) : null}
    </div>
  )
}

function FolderGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.3l1.2 1.5h5.5A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
    </svg>
  )
}

function ChevronGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" focusable="false">
      <path d="M4 6.5l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

interface ProviderBannerProps {
  providerStatus: ProviderStatus | null
}

/** Only rendered for genuinely actionable problems — never for a healthy
 *  or still-starting provider. */
export function ProviderBanner({ providerStatus }: ProviderBannerProps): JSX.Element | null {
  const problem = providerStatus ? describeProviderProblem(providerStatus.state, providerStatus.message) : null
  if (!problem) return null
  return (
    <div className="provider-banner" role="status">
      <span>{problem.title}</span>
      {providerStatus?.message ? <span className="provider-banner-detail">{providerStatus.message}</span> : null}
    </div>
  )
}
