import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODES,
  normalizePermissionMode,
  permissionArgs,
  permissionModeInfo
} from '../../src/shared/permissionMode'

/** These assertions are the contract between Orbit's control and the real
 *  agy CLI. Every expectation below was verified against the installed agy
 *  1.2.0 by reading the `permission_mode` it reports in its own `init`
 *  event — see permissionMode.ts. */
describe('permission modes', () => {
  it('offers only modes agy genuinely has', () => {
    // Two, not three. If this list grows, it must be because agy grew a
    // real permission state — not because a third one would look tidier.
    expect(PERMISSION_MODES.map((mode) => mode.id)).toEqual(['ask', 'skip'])
  })

  it('maps each mode to the agy permission_mode it actually produces', () => {
    expect(permissionModeInfo('ask').nativeMode).toBe('request-review')
    expect(permissionModeInfo('skip').nativeMode).toBe('always-proceed')
  })

  it('does not present agy’s execution modes as permission modes', () => {
    // `--mode accept-edits` and `--mode plan` leave permission_mode at
    // request-review, so offering either as a permission level would be a
    // control that changes nothing the user could observe.
    const ids = PERMISSION_MODES.map((mode) => mode.id) as string[]
    expect(ids).not.toContain('accept-edits')
    expect(ids).not.toContain('plan')
    expect(ids).not.toContain('auto')
    for (const mode of PERMISSION_MODES) {
      expect(permissionArgs(mode.id).join(' ')).not.toContain('--mode')
      expect(permissionArgs(mode.id).join(' ')).not.toContain('--sandbox')
    }
  })

  it('turns each mode into the real launch flags, and asking needs none', () => {
    // 'ask' IS agy's own default, so adding a flag for it would be inventing
    // one that does not exist.
    expect(permissionArgs('ask')).toEqual([])
    expect(permissionArgs('skip')).toEqual(['--dangerously-skip-permissions'])
  })

  it('falls back to asking for anything it does not recognize', () => {
    // A row from an older Orbit, a hand-edited value, or a mode a future
    // Orbit wrote. Failing towards "ask" is the safe direction.
    expect(DEFAULT_PERMISSION_MODE).toBe('ask')
    for (const value of [null, undefined, '', 'plan', 'accept-edits', 'always-proceed', 42, {}]) {
      expect(normalizePermissionMode(value)).toBe('ask')
    }
    expect(normalizePermissionMode('skip')).toBe('skip')
  })

  it('describes what each mode does without restating the flag', () => {
    for (const mode of PERMISSION_MODES) {
      expect(mode.label.length).toBeGreaterThan(0)
      expect(mode.description.length).toBeGreaterThan(0)
      expect(mode.description).not.toContain('--')
    }
  })
})
