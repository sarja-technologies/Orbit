import { useCallback, useEffect, useRef, useState } from 'react'

/** How long a copied action keeps saying so. Long enough to be read, short
 *  enough that the button is back to its normal self before you look again. */
const CONFIRM_MS = 1600

export interface CopyAction {
  copy: (text: string) => void
  copied: boolean
}

/** One-click copy with its own confirmation state.
 *
 *  Clipboard access can be absent (an older Electron surface, a non-secure
 *  context) or rejected. A copy that did not happen must not claim it did,
 *  so the confirmation is set from the resolved promise rather than
 *  optimistically at click time. */
export function useCopy(): CopyAction {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const confirm = useCallback(() => {
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), CONFIRM_MS)
  }, [])

  const copy = useCallback(
    (text: string) => {
      const clipboard = navigator.clipboard
      if (!clipboard?.writeText) return
      void clipboard.writeText(text).then(confirm, () => {
        // Nothing reached the clipboard, so nothing is confirmed. The
        // button simply stays as it was.
      })
    },
    [confirm]
  )

  return { copy, copied }
}
