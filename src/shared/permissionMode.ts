// How Orbit asks Antigravity to handle tool-permission requests.
//
// These are not Orbit's invention and they are not a superset of what agy
// can do: they are exactly the permission states the installed CLI really
// has, verified against agy 1.2.0 by reading the `permission_mode` it
// reports back in its own `init` event.
//
//   (no flag)                        -> permission_mode "request-review"
//   --dangerously-skip-permissions   -> permission_mode "always-proceed"
//
// There is deliberately no third "auto approve edits only" mode. agy does
// expose `--mode accept-edits`, and it is tempting to present that as one —
// but it is an agent *execution* mode, not a permission mode: launching
// with it leaves `permission_mode` at "request-review", so a control
// offering it as a permission level would be a switch that changes nothing
// a user could observe. `--sandbox` likewise leaves permissions untouched
// (it restricts the terminal), so it is not one of these either.
//
// If agy gains a real intermediate permission state, it belongs here — with
// the same standard of evidence.

/** The permission states agy genuinely has. */
export type PermissionMode = 'ask' | 'skip'

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'ask'

export interface PermissionModeInfo {
  id: PermissionMode
  label: string
  /** What actually happens, in the user's terms. */
  description: string
  /** agy's own name for the resulting state, as reported by its `init`
   *  event — the fact this mapping is answerable to. */
  nativeMode: string
}

export const PERMISSION_MODES: readonly PermissionModeInfo[] = [
  {
    id: 'ask',
    label: 'Ask first',
    description: 'Antigravity asks before running tools that need permission.',
    nativeMode: 'request-review'
  },
  {
    id: 'skip',
    label: 'Skip approvals',
    description: 'Every permission request is approved automatically. Tools run without asking.',
    nativeMode: 'always-proceed'
  }
]

export function permissionModeInfo(mode: PermissionMode): PermissionModeInfo {
  return PERMISSION_MODES.find((candidate) => candidate.id === mode) ?? PERMISSION_MODES[0]!
}

/** Whatever was persisted, as a real mode. Anything unrecognized — an older
 *  row, a hand-edited value, a mode a future Orbit added — falls back to
 *  asking, which is the safe direction to fail in. */
export function normalizePermissionMode(value: unknown): PermissionMode {
  return value === 'skip' ? 'skip' : DEFAULT_PERMISSION_MODE
}

/** The real agy launch flags for a mode. `ask` is agy's own default and
 *  needs no flag at all. */
export function permissionArgs(mode: PermissionMode): string[] {
  return mode === 'skip' ? ['--dangerously-skip-permissions'] : []
}
