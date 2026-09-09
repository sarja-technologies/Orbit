import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error - plain ESM install script, deliberately not TypeScript so
// `postinstall` can run it with no build step.
import { EXECUTABLE_BITS, ensureNodePtyPermissions, helperDirs, nativeSearchDirs, resolveNodePtyRoot } from '../../scripts/ensureNodePtyPermissions.mjs'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** Builds a throwaway node-pty-shaped package. `mode` is what the published
 *  tarball really records for spawn-helper: 0o644. */
function fakeNodePty(layout: Record<string, { native?: boolean; helper?: number | false }>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-node-pty-'))
  dirs.push(root)
  for (const [dir, spec] of Object.entries(layout)) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
    if (spec.native) fs.writeFileSync(path.join(root, dir, 'pty.node'), 'binary')
    if (spec.helper !== false && spec.helper !== undefined) {
      const helper = path.join(root, dir, 'spawn-helper')
      fs.writeFileSync(helper, 'binary')
      fs.chmodSync(helper, spec.helper)
    }
  }
  return root
}

const modeOf = (file: string): number => fs.statSync(file).mode & 0o777

describe('ensureNodePtyPermissions', () => {
  it('makes the shipped macOS helper executable, which is the actual bug', () => {
    // Exactly what a clean `npm install` lands on macOS: both prebuilt
    // helpers present, both 0o644.
    const root = fakeNodePty({
      'prebuilds/darwin-arm64': { native: true, helper: 0o644 },
      'prebuilds/darwin-x64': { native: true, helper: 0o644 }
    })

    const result = ensureNodePtyPermissions({ packageRoot: root, platform: 'darwin', arch: 'arm64' })

    expect(result.fixed).toHaveLength(2)
    expect(modeOf(path.join(root, 'prebuilds/darwin-arm64/spawn-helper'))).toBe(0o755)
    expect(modeOf(path.join(root, 'prebuilds/darwin-x64/spawn-helper'))).toBe(0o755)
    expect(result.runtimeHelper).toBe(path.join(root, 'prebuilds/darwin-arm64/spawn-helper'))
  })

  it('fixes every prebuilt architecture, not just the one running the install', () => {
    // The Node running `npm install` and the Electron that later loads
    // node-pty need not share an architecture (x64 Node under Rosetta, or an
    // --arch cross-install), so keying the fix on the current arch would
    // leave the one that actually gets used broken.
    const root = fakeNodePty({
      'prebuilds/darwin-arm64': { native: true, helper: 0o644 },
      'prebuilds/darwin-x64': { native: true, helper: 0o644 }
    })

    ensureNodePtyPermissions({ packageRoot: root, platform: 'darwin', arch: 'x64' })

    expect(modeOf(path.join(root, 'prebuilds/darwin-arm64/spawn-helper'))).toBe(0o755)
    expect(modeOf(path.join(root, 'prebuilds/darwin-x64/spawn-helper'))).toBe(0o755)
  })

  it('preserves the rest of the mode instead of forcing one', () => {
    const root = fakeNodePty({ 'prebuilds/darwin-arm64': { native: true, helper: 0o600 } })
    ensureNodePtyPermissions({ packageRoot: root, platform: 'darwin', arch: 'arm64' })
    expect(modeOf(path.join(root, 'prebuilds/darwin-arm64/spawn-helper'))).toBe(0o711)
  })

  it('is idempotent: a second run changes nothing', () => {
    const root = fakeNodePty({ 'prebuilds/darwin-arm64': { native: true, helper: 0o644 } })
    expect(ensureNodePtyPermissions({ packageRoot: root, platform: 'darwin', arch: 'arm64' }).fixed).toHaveLength(1)
    const second = ensureNodePtyPermissions({ packageRoot: root, platform: 'darwin', arch: 'arm64' })
    expect(second.fixed).toHaveLength(0)
    expect(second.alreadyExecutable).toHaveLength(1)
  })

  it('handles a source build, where node-pty compiles into build/Release', () => {
    // Linux has no published prebuild, so this is the normal layout there —
    // and node-pty's binding.gyp builds spawn-helper only for `OS=="mac"`,
    // so there is genuinely no helper next to the module it just compiled.
    const root = fakeNodePty({ 'build/Release': { native: true, helper: false } })
    const result = ensureNodePtyPermissions({ packageRoot: root, platform: 'linux', arch: 'x64' })
    expect(result.fixed).toHaveLength(0)
    expect(result.runtimeHelper).toBeNull()
  })

  it('does not demand a spawn-helper on a platform that never builds one', () => {
    // The regression: requiring the helper everywhere failed a healthy Linux
    // install outright, because `postinstall` throws and takes `npm install`
    // down with it.
    const root = fakeNodePty({ 'build/Release': { native: true, helper: false } })
    expect(() => ensureNodePtyPermissions({ packageRoot: root, platform: 'linux', arch: 'x64' })).not.toThrow()
  })

  it('still fixes darwin prebuilds when a non-darwin install is what runs', () => {
    // A cross-install (`npm install --platform=darwin`, or a Linux CI job
    // packaging for macOS) must still land executable helpers, since the
    // machine that later runs them never gets a postinstall of its own.
    const root = fakeNodePty({
      'build/Release': { native: true, helper: false },
      'prebuilds/darwin-arm64': { native: true, helper: 0o644 }
    })
    const result = ensureNodePtyPermissions({ packageRoot: root, platform: 'linux', arch: 'x64' })
    expect(result.fixed).toEqual([path.join(root, 'prebuilds/darwin-arm64/spawn-helper')])
    expect(modeOf(path.join(root, 'prebuilds/darwin-arm64/spawn-helper'))).toBe(0o755)
  })

  it('prefers a source build over a prebuild, exactly as node-pty does', () => {
    const root = fakeNodePty({
      'build/Release': { native: true, helper: 0o644 },
      'prebuilds/darwin-arm64': { native: true, helper: 0o644 }
    })
    const result = ensureNodePtyPermissions({ packageRoot: root, platform: 'darwin', arch: 'arm64' })
    expect(result.runtimeHelper).toBe(path.join(root, 'build/Release/spawn-helper'))
  })

  it('does nothing on Windows, which has no spawn-helper and no executable bit', () => {
    const root = fakeNodePty({ 'prebuilds/win32-x64': { native: true, helper: false } })
    const result = ensureNodePtyPermissions({ packageRoot: root, platform: 'win32', arch: 'x64' })
    expect(result.skipped).toBe('win32')
    expect(result.fixed).toHaveLength(0)
  })

  it('fails loudly when the helper the runtime needs is missing', () => {
    // A broken install must not look like a successful one — otherwise it
    // resurfaces much later as an unexplained `posix_spawnp failed`.
    const root = fakeNodePty({ 'prebuilds/darwin-arm64': { native: true, helper: false } })
    expect(() => ensureNodePtyPermissions({ packageRoot: root, platform: 'darwin', arch: 'arm64' })).toThrow(/spawn-helper is missing beside it/)
  })

  it('fails loudly when there is no native module for this platform at all', () => {
    const root = fakeNodePty({ 'prebuilds/darwin-x64': { native: true, helper: 0o644 } })
    expect(() => ensureNodePtyPermissions({ packageRoot: root, platform: 'darwin', arch: 'arm64' })).toThrow(/has no pty.node for darwin-arm64/)
  })

  it('tolerates a package with no prebuilds directory', () => {
    const root = fakeNodePty({ 'build/Release': { native: true, helper: 0o755 } })
    expect(helperDirs(root, fs)).toEqual(['build/Release', 'build/Debug'])
  })

  it('searches the same directories, in the same order, as node-pty itself', () => {
    // Mirrors loadNativeModule in node-pty's lib/utils.js — if that ever
    // changes, the helper this script verifies would stop being the one the
    // runtime executes.
    expect(nativeSearchDirs('darwin', 'arm64')).toEqual(['build/Release', 'build/Debug', 'prebuilds/darwin-arm64'])
  })

  it('EXECUTABLE_BITS is the executable triplet and nothing else', () => {
    expect(EXECUTABLE_BITS).toBe(0o111)
  })
})

describe('the real installed node-pty', () => {
  it('resolves without a hardcoded node_modules path', () => {
    const root = resolveNodePtyRoot()
    expect(fs.existsSync(path.join(root, 'package.json'))).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name).toBe('node-pty')
  })

  it.runIf(process.platform !== 'win32')('has the native module the running platform will load', () => {
    // The end state the postinstall script guarantees, asserted against the
    // real install rather than a fixture.
    const root = resolveNodePtyRoot()
    const dir = nativeSearchDirs(process.platform, process.arch).find((candidate: string) => fs.existsSync(path.join(root, candidate, 'pty.node')))
    expect(dir, 'no node-pty native module for this platform').toBeDefined()
    // spawn-helper exists only on macOS (node-pty builds it under
    // `OS=="mac"` alone), so it is asserted only where it is real.
    if (process.platform !== 'darwin') return
    const helper = path.join(root, dir as string, 'spawn-helper')
    expect(fs.existsSync(helper)).toBe(true)
    expect(fs.statSync(helper).mode & 0o111).toBe(0o111)
  })

  it.runIf(process.platform !== 'win32')('runs clean against the real install', () => {
    // The postinstall script itself must succeed here — it runs on every
    // `npm install`, so throwing takes the whole dependency install down.
    expect(() => ensureNodePtyPermissions({ packageRoot: resolveNodePtyRoot(), platform: process.platform, arch: process.arch })).not.toThrow()
  })
})
