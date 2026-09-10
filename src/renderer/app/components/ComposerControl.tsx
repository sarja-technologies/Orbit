import { createContext, forwardRef, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'

/** Which composer control currently owns a popover. Exactly one can, so
 *  opening the project picker closes the model picker rather than stacking
 *  two panels over each other at the bottom of the window. */
interface ComposerControlState {
  openId: string | null
  setOpenId: (id: string | null) => void
}

const ComposerControlContext = createContext<ComposerControlState | null>(null)

export function ComposerControlProvider({ children }: { children: ReactNode }): JSX.Element {
  const [openId, setOpenId] = useState<string | null>(null)
  const value = useMemo(() => ({ openId, setOpenId }), [openId])
  return <ComposerControlContext.Provider value={value}>{children}</ComposerControlContext.Provider>
}

/** Open state for one control.
 *
 *  Falls back to its own local state when there is no provider, so a control
 *  stays usable rendered on its own — which is how the model control is
 *  exercised in tests and how any of these could be reused outside the
 *  composer. The exclusivity is a composer property, not a control one. */
export function useComposerControl(id: string): { open: boolean; setOpen: (open: boolean) => void; toggle: () => void } {
  const shared = useContext(ComposerControlContext)
  const [localOpen, setLocalOpen] = useState(false)

  const open = shared ? shared.openId === id : localOpen
  const setOpen = useCallback(
    (next: boolean) => {
      if (shared) shared.setOpenId(next ? id : null)
      else setLocalOpen(next)
    },
    [shared, id]
  )
  const toggle = useCallback(() => setOpen(!open), [setOpen, open])

  return { open, setOpen, toggle }
}

interface ComposerControlButtonProps {
  /** The control's own name, e.g. "Project". Read to assistive tech as part
   *  of `aria-label`; never drawn, because the icon and the value say it. */
  name: string
  icon: ReactNode
  label: string
  /** The quieter second value on the same line — a resolved model, a path
   *  leaf. Optional because most controls have one thing to say. */
  detail?: string | null
  /** Shown in place of `detail` in the muted "we don't know yet" treatment. */
  unresolved?: string | null
  ariaLabel: string
  title?: string | undefined
  /** A control-specific badge riding at the end of the trigger, before the
   *  chevron — the model control's live reasoning tier is the only one. */
  trailing?: ReactNode
  open: boolean
  disabled?: boolean
  tone?: 'neutral' | 'caution'
  onClick: () => void
}

/** The one trigger shape the three composer context controls share, so
 *  Project, Model and Approvals read as one row of the same kind of thing
 *  rather than three separately-invented pills. */
export const ComposerControlButton = forwardRef<HTMLButtonElement, ComposerControlButtonProps>(function ComposerControlButton(
  { name, icon, label, detail, unresolved, ariaLabel, title, trailing, open, disabled, tone = 'neutral', onClick },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      className="composer-control-trigger"
      data-control={name.toLowerCase()}
      data-tone={tone}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-expanded={open}
      aria-haspopup="dialog"
      {...(title ? { title } : {})}
      onClick={onClick}
    >
      <span className="composer-control-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="composer-control-label">{label}</span>
      {detail ? <span className="composer-control-detail">{detail}</span> : null}
      {!detail && unresolved ? <span className="composer-control-unresolved">{unresolved}</span> : null}
      {trailing}
      <ChevronGlyph />
    </button>
  )
})

/** The panel a composer control opens. Anchored to the control's left edge
 *  and grown upward, because the composer sits at the bottom of the window
 *  and a downward panel would open off screen. */
export function ComposerPopover({
  label,
  align = 'left',
  width,
  children
}: {
  label: string
  align?: 'left' | 'right'
  width?: number
  children: ReactNode
}): JSX.Element {
  return (
    <div
      className="composer-popover"
      data-align={align}
      role="dialog"
      aria-label={label}
      {...(width ? { style: { ['--popover-width' as string]: `${width}px` } } : {})}
    >
      {children}
    </div>
  )
}

export function PopoverTitle({ children }: { children: ReactNode }): JSX.Element {
  return <h3 className="pane-title">{children}</h3>
}

export function ChevronGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" focusable="false" className="chevron-glyph">
      <path d="M4 6.5l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function FolderGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.3l1.2 1.5h5.5A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z"
        stroke="currentColor"
        strokeWidth="1.25"
        fill="none"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function ShieldGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="M8 2l4.5 1.8v4.1c0 2.6-1.8 4.7-4.5 5.8-2.7-1.1-4.5-3.2-4.5-5.8V3.8z" stroke="currentColor" strokeWidth="1.25" fill="none" strokeLinejoin="round" />
    </svg>
  )
}
