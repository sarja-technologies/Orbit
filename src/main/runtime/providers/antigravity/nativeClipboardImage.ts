// Native image-attachment clipboard choreography for the Antigravity PTY
// transport. `agy` has no `--image`-style CLI flag (confirmed: none exists
// in `agy --help`) — its genuine native mechanism is real OS-clipboard
// paste. This mirrors AgentDock Pro's proven, live-verified approach:
// Electron's own `clipboard`/`nativeImage` modules, NOT an external tool
// like xclip/wl-copy — Electron already abstracts X11 vs. Wayland vs.
// Windows vs. macOS clipboard access, so there is no platform-specific
// helper-process code here to get wrong. Isolated in its own module (rather
// than inline in AntigravityPtySession) so the rest of the PTY transport
// stays importable and testable under plain Node/vitest, where `electron`
// resolves to a path string, not the runtime API — this module's functions
// are simply never called outside a real Electron main process.
import { clipboard, nativeImage } from 'electron'

export interface SavedClipboard {
  image: Electron.NativeImage | null
  text: string | null
}

/** Saves whatever the user's real clipboard currently holds, so it can be
 *  restored after the paste choreography below completes. */
export function saveCurrentClipboard(): SavedClipboard {
  try {
    const image = clipboard.readImage()
    if (!image.isEmpty()) return { image, text: null }
    return { image: null, text: clipboard.readText() }
  } catch (error) {
    console.warn('[antigravity-pty] could not read the current clipboard to restore it later:', error)
    return { image: null, text: null }
  }
}

export function restoreClipboard(saved: SavedClipboard): void {
  try {
    if (saved.image) clipboard.writeImage(saved.image)
    else if (saved.text) clipboard.writeText(saved.text)
    else clipboard.clear()
  } catch (error) {
    console.warn('[antigravity-pty] could not restore the original clipboard content:', error)
  }
}

/** Loads a managed image file and writes it onto the OS clipboard. Returns
 *  false (never throws) when the file can't be loaded as an image — the
 *  caller treats that as "this one attachment failed", not a hard error. */
export function writeImageToClipboard(imagePath: string): boolean {
  try {
    const image = nativeImage.createFromPath(imagePath)
    if (image.isEmpty()) return false
    clipboard.writeImage(image)
    return true
  } catch (error) {
    console.warn(`[antigravity-pty] failed to load "${imagePath}" onto the clipboard:`, error)
    return false
  }
}
