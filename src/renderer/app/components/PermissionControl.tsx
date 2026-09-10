import { useEffect, useRef, useState } from 'react'
import { PERMISSION_MODES, permissionModeInfo, type PermissionMode } from '@shared/permissionMode'

interface PermissionControlProps {
  mode: PermissionMode
  disabled: boolean
  onSelect: (mode: PermissionMode) => void
}

/** How this session answers Antigravity's permission requests.
 *
 *  Every mode offered here is one agy genuinely has — see permissionMode.ts,
 *  which documents the `permission_mode` each one produces in agy's own
 *  `init` event. There are two, not three: agy's `--mode accept-edits`
 *  looks like a middle ground but leaves permissions at "request-review",
 *  so offering it as one would be a control that changes nothing.
 *
 *  Changing the mode takes effect on the session's next turn, because it is
 *  a launch flag — the same way a model change is. The popover says so
 *  rather than letting a user assume it retroactively applies to a turn
 *  already running. */
export function PermissionControl({ mode, disabled, onSelect }: PermissionControlProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const active = permissionModeInfo(mode)

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
    <div className="permission-control" ref={wrapperRef}>
      <button
        type="button"
        className={`permission-trigger${mode === 'skip' ? ' is-permissive' : ''}`}
        disabled={disabled}
        aria-label="Permissions"
        aria-expanded={open}
        aria-haspopup="dialog"
        title={active.description}
        onClick={() => setOpen((value) => !value)}
      >
        {mode === 'skip' ? <UnlockedGlyph /> : <ShieldGlyph />}
        <span className="permission-trigger-name">{active.label}</span>
      </button>

      {open ? (
        <div className="permission-popover" role="dialog" aria-label="Permissions">
          <h3 className="pane-title">Permissions</h3>
          <div className="permission-list">
            {PERMISSION_MODES.map((option) => (
              <button
                key={option.id}
                type="button"
                role="menuitemradio"
                aria-checked={option.id === mode}
                className={option.id === mode ? 'permission-row selected' : 'permission-row'}
                onClick={() => {
                  onSelect(option.id)
                  setOpen(false)
                }}
              >
                <span className="permission-row-mark" aria-hidden="true">
                  {option.id === 'skip' ? <UnlockedGlyph /> : <ShieldGlyph />}
                </span>
                <span className="permission-row-text">
                  <span className="permission-row-name">{option.label}</span>
                  <span className="permission-row-hint">{option.description}</span>
                </span>
              </button>
            ))}
          </div>
          <p className="permission-note">Applies from this session’s next message.</p>
        </div>
      ) : null}
    </div>
  )
}

function ShieldGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <path d="M8 2.2l4.4 1.7v4c0 2.6-1.8 4.6-4.4 5.6-2.6-1-4.4-3-4.4-5.6v-4L8 2.2Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  )
}

function UnlockedGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <rect x="3.4" y="7.2" width="9.2" height="6.2" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.6 7.2V5.4a2.4 2.4 0 0 1 4.7-.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}
