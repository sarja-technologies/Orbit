import { useEffect, useRef, useState } from 'react'
import type { AttachmentPickerCategory } from '@shared/attachmentPicker'

interface AttachMenuProps {
  disabled: boolean
  /** Opens the native picker for one category. The filters live in the main
   *  process — the renderer only ever names which of the three it wants. */
  onPick: (category: AttachmentPickerCategory) => void
}

const ITEMS: Array<{ id: AttachmentPickerCategory; label: string }> = [
  { id: 'image', label: 'Image' },
  { id: 'video', label: 'Video' },
  { id: 'files', label: 'Files' }
]

/** The + control. It used to open the OS file picker immediately, which
 *  made every attachment the same unfiltered browse; it now asks what kind
 *  first, so the native dialog can open already filtered to it.
 *
 *  Deliberately a small anchored popover rather than a dialog: choosing a
 *  category is one click on the way to the real picker, and a modal in
 *  front of a modal would be two. Closes on Escape and on a click outside,
 *  and the items are ordinary buttons, so it is navigable by keyboard
 *  without any roving-index machinery of its own. */
export function AttachMenu({ disabled, onPick }: AttachMenuProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const firstItemRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    firstItemRef.current?.focus()
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
    <div className="attach-control" ref={wrapperRef}>
      <button
        type="button"
        className="composer-attach"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        aria-label="Add files"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <PlusGlyph />
      </button>

      {open ? (
        <div className="attach-menu menu" role="menu" aria-label="Add files">
          {ITEMS.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className="menu-item"
              ref={index === 0 ? firstItemRef : undefined}
              onClick={() => {
                setOpen(false)
                onPick(item.id)
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function PlusGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
    </svg>
  )
}
