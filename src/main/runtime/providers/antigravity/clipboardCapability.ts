// Detects whether native image-clipboard attachment can actually work on
// this machine, BEFORE the first attempt — rather than discovering it only
// when a paste silently fails inside a live PTY session (which is exactly
// what happened during development: agy printed its own
// "no supported clipboard tool found (install wl-clipboard or xclip)"
// message, live-confirmed on this Wayland session, only after a real
// attachment attempt).
//
// Electron's `clipboard`/`nativeImage` API is NOT self-contained for
// images on Linux the way one might assume from its cross-platform
// surface: under the hood it shells out to a platform clipboard helper —
// `wl-copy`/`wl-paste` (package `wl-clipboard`) on Wayland, `xclip` or
// `xsel` on X11 — and simply fails if none is installed. macOS and
// Windows are assumed to need no such helper (Electron's clipboard talks
// directly to NSPasteboard / the Win32 clipboard API there), but that
// assumption itself has not been live-verified on those platforms.
import { execFileSync } from 'node:child_process'
import { delimiter, join } from 'node:path'
import { existsSync } from 'node:fs'

export type ClipboardSessionType = 'wayland' | 'x11' | 'unknown' | 'not-applicable'

export interface ClipboardCapability {
  available: boolean
  platform: NodeJS.Platform
  sessionType: ClipboardSessionType
  /** The helper binary found and relied on, if any (Linux only). */
  helper: string | null
  /** Present only when `available` is false — always a concrete,
   *  actionable reason (never a generic "clipboard unavailable"). */
  reason: string | null
}

function isOnPath(binary: string): boolean {
  const dirs = process.env.PATH?.split(delimiter) ?? []
  return dirs.some((dir) => existsSync(join(dir, binary)))
}

function detectLinuxSessionType(): ClipboardSessionType {
  if (process.env.WAYLAND_DISPLAY) return 'wayland'
  if (process.env.XDG_SESSION_TYPE === 'wayland') return 'wayland'
  if (process.env.XDG_SESSION_TYPE === 'x11') return 'x11'
  if (process.env.DISPLAY) return 'x11'
  return 'unknown'
}

/** Synchronous and cheap (PATH existence checks only, no process spawns)
 *  — safe to call before every attachment attempt, but callers should
 *  still cache the result for the lifetime of one Orbit session since the
 *  answer cannot meaningfully change while the app is running. */
export function checkClipboardCapability(): ClipboardCapability {
  const platform = process.platform

  if (platform === 'darwin' || platform === 'win32') {
    // Electron talks to the native pasteboard/clipboard API directly on
    // both — no external helper is expected to be needed. NOT LIVE
    // VERIFIED on either platform; see docs/antigravity-transports.md.
    return { available: true, platform, sessionType: 'not-applicable', helper: null, reason: null }
  }

  if (platform !== 'linux') {
    return { available: false, platform, sessionType: 'unknown', helper: null, reason: `Native image attachment has not been implemented or verified on platform "${platform}".` }
  }

  const sessionType = detectLinuxSessionType()
  if (sessionType === 'wayland') {
    if (isOnPath('wl-copy') && isOnPath('wl-paste')) return { available: true, platform, sessionType, helper: 'wl-clipboard', reason: null }
    return {
      available: false,
      platform,
      sessionType,
      helper: null,
      reason: 'Native image attachment needs the "wl-clipboard" package (provides wl-copy/wl-paste) on this Wayland session. Install it with your system package manager, e.g. "sudo apt install wl-clipboard".'
    }
  }
  if (sessionType === 'x11') {
    if (isOnPath('xclip')) return { available: true, platform, sessionType, helper: 'xclip', reason: null }
    if (isOnPath('xsel')) return { available: true, platform, sessionType, helper: 'xsel', reason: null }
    return {
      available: false,
      platform,
      sessionType,
      helper: null,
      reason: 'Native image attachment needs "xclip" or "xsel" on this X11 session. Install one with your system package manager, e.g. "sudo apt install xclip".'
    }
  }
  return {
    available: false,
    platform,
    sessionType: 'unknown',
    helper: null,
    reason: 'Could not determine whether this is a Wayland or X11 session (neither WAYLAND_DISPLAY, XDG_SESSION_TYPE, nor DISPLAY is set), so native image attachment support could not be verified.'
  }
}

// Exported for the (currently unused) possibility of a stricter live probe
// — actually invoking the helper — without changing the cheap default
// PATH-existence check callers rely on today.
export function probeHelperVersion(binary: string): boolean {
  try {
    execFileSync(binary, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
