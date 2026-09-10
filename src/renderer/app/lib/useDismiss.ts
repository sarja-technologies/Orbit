import { useEffect, type RefObject } from 'react'

interface DismissOptions {
  /** Suspends dismissal while a modal owns the interaction — a click or an
   *  Escape inside that modal belongs to it, not to the popover behind it. */
  suspended?: boolean
}

/** Closes a popover on an outside pointer-down or on Escape.
 *
 *  Every menu in Orbit had its own copy of this listener pair, each with a
 *  slightly different cleanup. One implementation instead, so a popover
 *  cannot forget to remove a document listener. */
export function useDismiss(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
  { suspended = false }: DismissOptions = {}
): void {
  useEffect(() => {
    if (!open || suspended) return
    const onDown = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [ref, open, suspended, onClose])
}
