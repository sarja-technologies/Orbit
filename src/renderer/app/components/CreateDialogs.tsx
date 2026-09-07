import { useEffect, useId, useState } from 'react'
import type { ID, Project } from '@shared/domain'
import { Modal, ModalHeader } from './Modal'

/** Both dialogs speak in terms of a real folder on disk, because that is
 *  what Antigravity actually runs in. An empty field means "no folder of its
 *  own": Orbit's managed workspace for a project, or the project's folder for
 *  a session. Neither is ever guessed or silently invented.
 *
 *  The native picker is the primary way in, and the field stays editable
 *  beside it because pasting a path you already have is faster than
 *  navigating to it. */
interface FolderFieldProps {
  label: string
  path: string | null
  /** What happens with no folder chosen — the honest description of the
   *  outcome, not decorative placeholder text. */
  fallback: string
  busy: boolean
  onChange: (path: string | null) => void
  onChoose: () => void
}

/** Antigravity is launched with this as its working directory, so a relative
 *  path has no meaning by the time it gets there. Caught here rather than as
 *  a failed create. */
export function isAbsolutePath(candidate: string): boolean {
  return candidate.startsWith('/') || /^[A-Za-z]:[\\/]/.test(candidate)
}

function FolderField({ label, path, fallback, busy, onChange, onChoose }: FolderFieldProps): JSX.Element {
  const inputId = useId()
  const invalid = path !== null && path.trim().length > 0 && !isAbsolutePath(path.trim())
  return (
    <div className="field">
      <label className="field-label" htmlFor={inputId}>
        {label}
      </label>
      <div className="folder-field">
        <input
          id={inputId}
          className="folder-input"
          value={path ?? ''}
          spellCheck={false}
          placeholder={fallback}
          onChange={(event) => onChange(event.target.value.trim() ? event.target.value : null)}
        />
        <button type="button" className="ghost" onClick={onChoose} disabled={busy}>
          {busy ? 'Choosing…' : 'Choose…'}
        </button>
      </div>
      {invalid ? <span className="field-error">Use a full path, starting from the root of the disk.</span> : null}
    </div>
  )
}

interface CreateProjectDialogProps {
  onCancel: () => void
  onCreate: (input: { name: string; rootPath: string | null }) => void
  pickFolder: () => Promise<string | null>
}

export function CreateProjectDialog({ onCancel, onCreate, pickFolder }: CreateProjectDialogProps): JSX.Element {
  const [name, setName] = useState('')
  const [rootPath, setRootPath] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)

  const choose = async (): Promise<void> => {
    setPicking(true)
    try {
      const chosen = await pickFolder()
      if (chosen) {
        setRootPath(chosen)
        // A freshly picked folder is almost always what the project should
        // be called, and it is still fully editable.
        if (!name.trim()) setName(basename(chosen))
      }
    } finally {
      setPicking(false)
    }
  }

  const valid = name.trim().length > 0 && (rootPath === null || isAbsolutePath(rootPath.trim()))

  const submit = (): void => {
    if (!valid) return
    onCreate({ name: name.trim(), rootPath: rootPath?.trim() || null })
  }

  return (
    <Modal label="New project" onClose={onCancel}>
      <ModalHeader title="New project" onClose={onCancel} />
      <form
        className="modal-body modal-form"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <label className="field">
          <span className="field-label">Project name</span>
          <input
            className="field-input"
            value={name}
            autoFocus
            placeholder="e.g. AgentDock Website"
            aria-label="Project name"
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        <FolderField
          label="Working folder"
          path={rootPath}
          fallback="Orbit-managed workspace"
          busy={picking}
          onChange={setRootPath}
          onChoose={() => void choose()}
        />

        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!valid}>
            Create project
          </button>
        </div>
      </form>
    </Modal>
  )
}

interface CreateSessionDialogProps {
  projects: Project[]
  /** The project the user launched this from — a project row's own + button
   *  preselects itself so the common case takes no extra decision. */
  initialProjectId: ID | null
  onCancel: () => void
  onCreate: (input: { projectId: ID; title: string | null; workingDirectory: string | null }) => void
  pickFolder: (defaultPath: string | null) => Promise<string | null>
}

export function CreateSessionDialog({
  projects,
  initialProjectId,
  onCancel,
  onCreate,
  pickFolder
}: CreateSessionDialogProps): JSX.Element {
  const [projectId, setProjectId] = useState<ID | null>(initialProjectId ?? projects[0]?.id ?? null)
  const [title, setTitle] = useState('')
  const [workingDirectory, setWorkingDirectory] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const project = projects.find((candidate) => candidate.id === projectId) ?? null

  // Switching project changes what "inherit" means, so an override chosen
  // for the previous project must not silently carry over to this one.
  useEffect(() => {
    setWorkingDirectory(null)
  }, [projectId])

  const choose = async (): Promise<void> => {
    setPicking(true)
    try {
      const chosen = await pickFolder(project?.rootPath ?? null)
      if (chosen) setWorkingDirectory(chosen)
    } finally {
      setPicking(false)
    }
  }

  const valid = Boolean(projectId) && (workingDirectory === null || isAbsolutePath(workingDirectory.trim()))

  const submit = (): void => {
    if (!projectId || !valid) return
    onCreate({ projectId, title: title.trim() || null, workingDirectory: workingDirectory?.trim() || null })
  }

  return (
    <Modal label="New session" onClose={onCancel}>
      <ModalHeader title="New session" onClose={onCancel} />
      <form
        className="modal-body modal-form"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <label className="field">
          <span className="field-label">Project</span>
          <select
            className="field-input"
            value={projectId ?? ''}
            aria-label="Project"
            onChange={(event) => setProjectId(event.target.value || null)}
          >
            {projects.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="field-label">Session name</span>
          <input
            className="field-input"
            value={title}
            autoFocus
            placeholder="New session"
            aria-label="Session name"
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>

        <FolderField
          label="Working folder"
          path={workingDirectory}
          fallback={project?.rootPath ?? `${project?.name ?? 'Project'} · Orbit-managed workspace`}
          busy={picking}
          onChange={setWorkingDirectory}
          onChoose={() => void choose()}
        />

        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!valid}>
            Create session
          </button>
        </div>
      </form>
    </Modal>
  )
}

/** Last path segment, for suggesting a project name from a chosen folder.
 *  Handles both separators and a trailing slash. */
function basename(candidate: string): string {
  const parts = candidate.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? candidate
}
