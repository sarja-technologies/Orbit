import { useEffect, useRef, useState } from 'react'
import type { Conversation, ID, Project } from '@shared/domain'

interface ProjectControlProps {
  project: Project | null
  conversation: Conversation | null
  disabled: boolean
  /** Opens the OS folder picker and sets the PROJECT's root. Folder access
   *  is never performed in the renderer — this hands off to the existing
   *  main-process dialog and project APIs. */
  onChooseProjectFolder: () => void
  /** Clears a session's own folder override, returning it to the project's.
   *  Absent behaviour, not a delete: the project keeps its folder. */
  onUseProjectFolder: () => void
  /** The projects an Unsorted session can be filed into. */
  projects: Project[]
  /** Files this session into a project, in place. */
  onAssignProject: (projectId: ID) => void
}

/** Where this session's work actually happens, stated next to the model.
 *
 *  Two different facts share this control and are deliberately not blurred
 *  together: the Orbit *project* a session belongs to, and the real
 *  filesystem *folder* agy is launched in. The trigger shows the project
 *  name, because that is the thing a person navigates by; the folder rides
 *  underneath it and in the popover, because that is the thing that decides
 *  what the model can actually see.
 *
 *  A session inherits its project's folder unless it has its own override —
 *  the architecture Orbit already has — so the popover says which of those
 *  two is in force rather than showing one path with no explanation. When
 *  no folder has ever been chosen, it claims nothing: Orbit's managed
 *  workspace is an internal location, not somewhere the user picked. */
export function ProjectControl({
  project,
  conversation,
  disabled,
  onChooseProjectFolder,
  onUseProjectFolder,
  projects,
  onAssignProject
}: ProjectControlProps): JSX.Element {
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

  const override = conversation?.workingDirectory ?? null
  const projectRoot = project?.rootPath ?? null
  const effective = override ?? projectRoot
  // An Unsorted session is a normal state, not a missing one: it runs in a
  // workspace Orbit keeps for it, and can be filed into a project later.
  const unsorted = conversation !== null && conversation.projectId === null
  const projectName = project?.name ?? (unsorted ? 'No project' : 'No project')

  return (
    <div className="project-control" ref={wrapperRef}>
      <button
        type="button"
        className="project-trigger"
        disabled={disabled || (!project && !unsorted)}
        aria-label="Project and working folder"
        aria-expanded={open}
        aria-haspopup="dialog"
        // The full path is a tooltip as well as popover content: the common
        // case is wanting to check it, not wanting to change it.
        title={effective ?? (unsorted ? 'Orbit workspace' : 'No folder chosen')}
        onClick={() => setOpen((value) => !value)}
      >
        <FolderGlyph />
        <span className="project-trigger-text">
          <span className="project-trigger-name">{projectName}</span>
          {effective ? (
            <span className="project-trigger-path">{shortenPath(effective)}</span>
          ) : unsorted ? (
            <span className="project-trigger-path">Orbit workspace</span>
          ) : null}
        </span>
      </button>

      {open ? (
        <div className="project-popover" role="dialog" aria-label="Project and working folder">
          <div className="project-popover-head">
            <span className="project-popover-name">{projectName}</span>
            <span className="project-popover-role">{unsorted ? 'Unsorted' : override ? 'Session folder' : 'Project folder'}</span>
          </div>

          {effective ? (
            <p className="project-popover-path" title={effective}>
              {effective}
            </p>
          ) : (
            <p className="project-popover-empty">
              No folder chosen. Antigravity runs in Orbit’s own managed workspace for this session.
            </p>
          )}

          <p className="project-popover-note">
            {unsorted
              ? 'This session belongs to no project. It is ready to use as it is — add it to one whenever you want to.'
              : override
                ? 'This session overrides its project’s folder.'
                : 'This session uses its project’s folder.'}
          </p>

          {unsorted && projects.length > 0 ? (
            <div className="project-assign">
              <label className="project-assign-label" htmlFor="project-assign">
                Add to a project
              </label>
              <select
                id="project-assign"
                className="project-assign-select"
                value=""
                onChange={(event) => {
                  if (!event.target.value) return
                  setOpen(false)
                  onAssignProject(event.target.value)
                }}
              >
                <option value="">Choose a project…</option>
                {projects.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
              {/* Said plainly, because the alternative would be Orbit
                  quietly pointing the next turn at the user's real files
                  with this session's scratch history behind it. */}
              <p className="project-assign-note">
                The session keeps its own folder. Choose the project’s folder separately if you want it to work there.
              </p>
            </div>
          ) : null}

          <div className="project-popover-actions">
            {!unsorted ? (
              <button
                type="button"
                className="project-popover-action"
                onClick={() => {
                  setOpen(false)
                  onChooseProjectFolder()
                }}
              >
                {projectRoot ? 'Change project folder…' : 'Choose project folder…'}
              </button>
            ) : null}
            {override ? (
              <button
                type="button"
                className="project-popover-action"
                onClick={() => {
                  setOpen(false)
                  onUseProjectFolder()
                }}
              >
                Use the project’s folder
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** The tail of a path, with the home directory as `~`. The control has room
 *  for roughly a folder and its parent; the whole path stays available in
 *  the tooltip and the popover, so nothing is hidden — only abbreviated. */
export function shortenPath(path: string): string {
  const withHome = path.replace(/^\/(?:Users|home)\/[^/]+/, '~')
  const parts = withHome.split('/').filter(Boolean)
  if (parts.length <= 2) return withHome
  return `${withHome.startsWith('~') ? '~/…/' : '…/'}${parts.slice(-2).join('/')}`
}

function FolderGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="M2.2 4.4c0-.7.6-1.3 1.3-1.3h2.4c.4 0 .8.2 1 .5l.7.9h4.9c.7 0 1.3.6 1.3 1.3v5.4c0 .7-.6 1.3-1.3 1.3H3.5c-.7 0-1.3-.6-1.3-1.3V4.4Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}
