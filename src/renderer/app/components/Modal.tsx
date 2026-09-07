import { useEffect, useRef, type ReactNode } from 'react'

interface ModalProps {
  label: string
  /** Widens the panel for content that genuinely needs it (the model
   *  browser); creation forms stay narrow. */
  wide?: boolean
  onClose: () => void
  children: ReactNode
}

/** Orbit's one modal shell: a translucent backdrop over the real app, a
 *  centred panel, and the two dismissals people always try — click outside
 *  and Escape. The background stays visible so the modal reads as something
 *  on top of Orbit rather than a separate screen. */
export function Modal({ label, wide = false, onClose, children }: ModalProps): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    panelRef.current?.focus()
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div
      className="modal-backdrop"
      // Only a click that both starts and ends on the backdrop dismisses:
      // a drag that began inside the panel (selecting text, dragging the
      // search field) must never close the modal on release.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        className={wide ? 'modal-panel modal-panel-wide' : 'modal-panel'}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  )
}

export function ModalHeader({ title, onClose, children }: { title: string; onClose: () => void; children?: ReactNode }): JSX.Element {
  return (
    <div className="modal-head">
      <h2 className="modal-title">{title}</h2>
      {children}
      <button type="button" className="icon-button modal-close" onClick={onClose} aria-label="Close">
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}
