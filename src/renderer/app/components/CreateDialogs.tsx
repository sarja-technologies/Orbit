import { useId, useState } from 'react'
import { Modal, ModalHeader } from './Modal'

/** A project is the one thing in Orbit that has to be configured before it
 *  exists: it owns the real folder on disk that Antigravity runs in, and
 *  every session inside it inherits that. Sessions themselves are created
 *  instantly with no dialog at all — see App.createSession.
 *
 *  An empty folder field means "no folder of its own": Orbit's managed
 *  workspace. That is never guessed or silently invented.
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

/** Last path segment, for suggesting a project name from a chosen folder.
 *  Handles both separators and a trailing slash. */
function basename(candidate: string): string {
  const parts = candidate.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? candidate
}
