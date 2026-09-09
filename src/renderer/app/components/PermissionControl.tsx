import { useRef } from 'react'
import type { ConversationTransport } from '@shared/domain'
import { PERMISSION_MODES, PERMISSION_MODE_ORDER, canSwitchTo, permissionModeFor, switchBlockedReason } from '../lib/permissionModes'
import { useDismiss } from '../lib/useDismiss'
import { ComposerControlButton, ComposerPopover, PopoverTitle, ShieldGlyph, useComposerControl } from './ComposerControl'
import { Tick } from './ModelBrowser'

interface PermissionControlProps {
  transport: ConversationTransport
  disabled: boolean
  onSelect: (transport: ConversationTransport) => void
}

const CONTROL_ID = 'permissions'

/** Whether Antigravity can stop and ask you, as a control beside Model.
 *
 *  This states the session's real transport and nothing else. agy 1.1.27 has
 *  no auto-approve or skip-permissions setting, so Orbit offers neither —
 *  see lib/permissionModes.ts for why an invented third mode would be worse
 *  than no third mode. */
export function PermissionControl({ transport, disabled, onSelect }: PermissionControlProps): JSX.Element {
  const { open, setOpen, toggle } = useComposerControl(CONTROL_ID)
  const wrapperRef = useRef<HTMLDivElement>(null)
  useDismiss(wrapperRef, open, () => setOpen(false))

  const current = permissionModeFor(transport)

  return (
    <div className="composer-control" ref={wrapperRef}>
      <ComposerControlButton
        name="Permissions"
        icon={<ShieldGlyph />}
        label={current.label}
        ariaLabel={`Permissions: ${current.label}`}
        title={current.description}
        tone={current.tone}
        open={open}
        disabled={disabled}
        onClick={toggle}
      />

      {open ? (
        <ComposerPopover label="Permissions" width={340}>
          <PopoverTitle>Permissions</PopoverTitle>
          <div className="permission-list">
            {PERMISSION_MODE_ORDER.map((id) => {
              const mode = PERMISSION_MODES[id]
              const selected = id === transport
              const blocked = switchBlockedReason(transport, id)
              return (
                <button
                  key={id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  disabled={!selected && !canSwitchTo(transport, id)}
                  data-tone={mode.tone}
                  className={selected ? 'permission-row selected' : 'permission-row'}
                  onClick={() => {
                    if (!canSwitchTo(transport, id)) return
                    setOpen(false)
                    onSelect(id)
                  }}
                >
                  <span className="permission-row-text">
                    <span className="permission-row-name">{mode.title}</span>
                    <span className="permission-row-body">{mode.description}</span>
                    {/* The real internal identifier, kept as a detail line
                        rather than as the control's own name. */}
                    <span className="permission-row-technical">{mode.technical}</span>
                    {blocked ? <span className="permission-row-blocked">{blocked}</span> : null}
                  </span>
                  <Tick checked={selected} />
                </button>
              )
            })}
          </div>
        </ComposerPopover>
      ) : null}
    </div>
  )
}
