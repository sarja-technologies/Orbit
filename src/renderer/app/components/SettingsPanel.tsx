import { useEffect, useRef, useState } from 'react'
import type { ModelOption, OrbitPreferences } from '@shared/domain'
import type { ResolvedDefaultModel } from '@shared/newSessionDefaults'
import { PERMISSION_MODES, type PermissionMode } from '@shared/permissionMode'
import { resolveDefaultPermissionMode } from '@shared/newSessionDefaults'
import { CLEAR_DATA_CONFIRMATION } from '@shared/clearData'
import { AgentMark } from './ProviderLogo'
import { agentIdentity } from '../lib/agentIdentity'

interface SettingsPanelProps {
  preferences: OrbitPreferences
  models: ModelOption[]
  /** How a new session's model resolves right now — including a saved
   *  default the catalogue no longer lists, which this panel says out loud
   *  rather than quietly substituting. */
  modelStatus: ResolvedDefaultModel | null
  busy: boolean
  onClose: () => void
  onSelectDefaultModel: (modelId: string) => void
  onSelectDefaultPermissionMode: (mode: PermissionMode) => void
  onClearAllData: (confirmation: string) => void
}

/** Orbit's settings: the small number of things that are genuinely Orbit's
 *  to remember, not a preferences department.
 *
 *  Both General settings describe what the NEXT session starts with. A
 *  session owns its own model and permissions once it exists, and changing
 *  a default here deliberately leaves every existing conversation alone —
 *  the session-level controls in the composer are how an open session is
 *  changed. */
export function SettingsPanel({
  preferences,
  models,
  modelStatus,
  busy,
  onClose,
  onSelectDefaultModel,
  onSelectDefaultPermissionMode,
  onClearAllData
}: SettingsPanelProps): JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const [confirming, setConfirming] = useState(false)
  const [typed, setTyped] = useState('')

  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const selectedModel = modelStatus?.modelId ?? ''
  const permission = resolveDefaultPermissionMode(preferences)
  const identity = agentIdentity(models, selectedModel)

  return (
    <div className="settings-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="settings" role="dialog" aria-modal="true" aria-label="Settings" ref={dialogRef}>
        <header className="settings-head">
          <h2 className="settings-title">Settings</h2>
          <button type="button" className="icon-button" aria-label="Close settings" ref={closeRef} onClick={onClose}>
            <CloseGlyph />
          </button>
        </header>

        <section className="settings-section">
          <h3 className="settings-section-title">General</h3>

          <div className="settings-row">
            <label className="settings-label" htmlFor="settings-default-model">
              Default model
              <span className="settings-hint">Used by new sessions. Open conversations keep the model they have.</span>
            </label>
            <div className="settings-field">
              <span className="settings-model-mark">
                <AgentMark identity={identity} size={14} />
              </span>
              <select
                id="settings-default-model"
                className="settings-select"
                value={selectedModel}
                disabled={models.length === 0}
                onChange={(event) => onSelectDefaultModel(event.target.value)}
              >
                {/* Only models the live catalogue really lists. A saved id
                    that is gone is reported below rather than offered. */}
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {models.length === 0 ? (
            <p className="settings-note">
              Orbit could not read Antigravity’s model catalogue, so there is nothing to choose from yet.
            </p>
          ) : null}

          {modelStatus?.missingModelId ? (
            <p className="settings-note is-warning" role="status">
              {modelStatus.source === 'unavailable'
                ? `The model you chose (${modelStatus.missingModelId}) is no longer available, and neither is Orbit’s own default. Choose one from the list.`
                : `The model you chose (${modelStatus.missingModelId}) is no longer available. New sessions are using Orbit’s default until you pick another.`}
            </p>
          ) : null}

          <div className="settings-row">
            <label className="settings-label" htmlFor="settings-default-permissions">
              Default permissions
              <span className="settings-hint">Used by new sessions. Open conversations keep their own setting.</span>
            </label>
            <div className="settings-field">
              <select
                id="settings-default-permissions"
                className="settings-select"
                value={permission}
                onChange={(event) => onSelectDefaultPermissionMode(event.target.value as PermissionMode)}
              >
                {PERMISSION_MODES.map((mode) => (
                  <option key={mode.id} value={mode.id}>
                    {mode.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>

        <section className="settings-section">
          <h3 className="settings-section-title">Data</h3>

          {!confirming ? (
            <div className="settings-row">
              <span className="settings-label">
                Clear all Orbit data
                <span className="settings-hint">Everything Orbit stores. Your own project folders are not touched.</span>
              </span>
              <div className="settings-field">
                <button type="button" className="danger" onClick={() => setConfirming(true)}>
                  Clear data
                </button>
              </div>
            </div>
          ) : (
            <div className="settings-danger" role="group" aria-label="Confirm clearing all Orbit data">
              <p className="settings-danger-title">This deletes everything Orbit stores.</p>
              <ul className="settings-danger-list">
                <li>Projects and their settings</li>
                <li>Sessions and conversations</li>
                <li>Messages and run history</li>
                <li>Orbit preferences, including these settings</li>
                <li>Files you attached, which Orbit copied in</li>
                <li>Artifacts Orbit created</li>
                <li>Workspaces Orbit manages for projects with no folder of their own</li>
              </ul>
              <p className="settings-danger-safe">
                Your own project folders are <strong>not</strong> deleted. A project that points at a folder on your computer
                loses only Orbit’s reference to it — the folder and its files stay exactly where they are.
              </p>
              <p className="settings-danger-final">This cannot be undone. Orbit will restart empty.</p>

              <label className="settings-label" htmlFor="settings-clear-confirm">
                Type {CLEAR_DATA_CONFIRMATION} to confirm
              </label>
              <input
                id="settings-clear-confirm"
                className="settings-input"
                value={typed}
                autoComplete="off"
                spellCheck={false}
                aria-label={`Type ${CLEAR_DATA_CONFIRMATION} to confirm`}
                onChange={(event) => setTyped(event.target.value)}
              />

              <div className="settings-danger-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setConfirming(false)
                    setTyped('')
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={typed.trim() !== CLEAR_DATA_CONFIRMATION || busy}
                  onClick={() => onClearAllData(typed.trim())}
                >
                  {busy ? 'Clearing…' : 'Clear all data'}
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function CloseGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
    </svg>
  )
}
