import { useRef } from 'react'
import type { ConversationTransport } from '@shared/domain'
import { APPROVAL_MODES, APPROVAL_MODE_ORDER, approvalModeFor, canSwitchTo, switchBlockedReason } from '../lib/approvalModes'
import { useDismiss } from '../lib/useDismiss'
import { ComposerControlButton, ComposerPopover, PopoverTitle, ShieldGlyph, useComposerControl } from './ComposerControl'
import { Tick } from './ModelBrowser'

interface ApprovalsControlProps {
  transport: ConversationTransport
  disabled: boolean
  onSelect: (transport: ConversationTransport) => void
}

const CONTROL_ID = 'approvals'

/** Whether Antigravity can stop and ask you, as a control beside Model.
 *
 *  States the session's real transport and nothing else — see
 *  lib/approvalModes.ts for why this is approvals rather than permissions,
 *  and why there is no third "approve everything" mode. */
export function ApprovalsControl({ transport, disabled, onSelect }: ApprovalsControlProps): JSX.Element {
  const { open, setOpen, toggle } = useComposerControl(CONTROL_ID)
  const wrapperRef = useRef<HTMLDivElement>(null)
  useDismiss(wrapperRef, open, () => setOpen(false))

  const current = approvalModeFor(transport)

  return (
    <div className="composer-control" ref={wrapperRef}>
      <ComposerControlButton
        name="Approvals"
        icon={<ShieldGlyph />}
        label={current.label}
        ariaLabel={`Approvals: ${current.label}`}
        title={current.description}
        tone={current.tone}
        open={open}
        disabled={disabled}
        onClick={toggle}
      />

      {open ? (
        <ComposerPopover label="Approvals" width={340}>
          <PopoverTitle>Approvals</PopoverTitle>
          <div className="approval-list">
            {APPROVAL_MODE_ORDER.map((id) => {
              const mode = APPROVAL_MODES[id]
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
                  className={selected ? 'approval-row selected' : 'approval-row'}
                  onClick={() => {
                    if (!canSwitchTo(transport, id)) return
                    setOpen(false)
                    onSelect(id)
                  }}
                >
                  <span className="approval-row-text">
                    <span className="approval-row-name">{mode.title}</span>
                    <span className="approval-row-body">{mode.description}</span>
                    {/* The real internal identifier, kept as secondary detail
                        rather than as the control's own name. */}
                    <span className="approval-row-technical">{mode.technical}</span>
                    {blocked ? <span className="approval-row-blocked">{blocked}</span> : null}
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
