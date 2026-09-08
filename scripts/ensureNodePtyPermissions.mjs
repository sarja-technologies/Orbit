// node-pty ships its macOS `spawn-helper` binaries in the published npm
// tarball with mode 0644 — verified directly against the registry artifact:
//
//   $ tar -tvf node-pty-1.1.0.tgz | grep spawn-helper
//   -rw-r--r--  … package/prebuilds/darwin-arm64/spawn-helper
//   -rw-r--r--  … package/prebuilds/darwin-x64/spawn-helper
//
// It is not a umask, npm-cache or extraction artifact: the mode recorded in
// the tarball is already wrong, so every clean `npm install` on macOS lands a
// non-executable helper. `pty.fork()` passes that path to `posix_spawnp`,
// which then fails with the entirely unhelpful `Error: posix_spawnp failed.`
// — i.e. Orbit's whole interactive (PTY) Antigravity transport is dead on
// arrival on macOS until the bit is restored.
//
// This runs from the root package's `postinstall`, so a clean dependency
// install is enough and nobody has to know about it.
import { createRequire } from 'node:module'
import fsDefault from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** The bits to add. The helper is an executable binary; everything else about
 *  its mode (read/write) is left exactly as the package shipped it. */
export const EXECUTABLE_BITS = 0o111

const HELPER = 'spawn-helper'
const NATIVE_MODULE = 'pty.node'

/** The directories node-pty itself searches for its native module, in its own
 *  order of preference — kept deliberately identical to `loadNativeModule` in
 *  node-pty's `lib/utils.js`, because the helper it will actually execute is
 *  the sibling of whichever `pty.node` wins there. */
export function nativeSearchDirs(platform, arch) {
  return ['build/Release', 'build/Debug', path.posix.join('prebuilds', `${platform}-${arch}`)]
}

/** Every directory in the package that could hold a helper: the two build
 *  output dirs, plus *every* prebuild, not just the current architecture.
 *
 *  Fixing all of them is deliberate. The Node that runs `npm install` and the
 *  Electron that later loads node-pty are not required to be the same
 *  architecture (an x64 Node under Rosetta installing for an arm64 Electron,
 *  or an `--arch` cross-install), so "the arch we happen to be running right
 *  now" is not a safe thing to key the fix on. It also means no node-pty
 *  version or CPU is hardcoded: the prebuild list is read from disk. */
export function helperDirs(packageRoot, fs) {
  const dirs = ['build/Release', 'build/Debug']
  const prebuilds = path.join(packageRoot, 'prebuilds')
  let entries = []
  try {
    entries = fs.readdirSync(prebuilds, { withFileTypes: true })
  } catch {
    // No prebuilds at all is normal — on Linux node-pty has none published
    // and builds from source into build/Release instead.
  }
  for (const entry of entries) {
    if (entry.isDirectory()) dirs.push(path.posix.join('prebuilds', entry.name))
  }
  return dirs
}

/**
 * Makes node-pty's `spawn-helper` binaries executable and verifies that the
 * one node-pty will actually use at runtime is present and usable.
 *
 * @param {object} options
 * @param {string} options.packageRoot Absolute path to the node-pty package.
 * @param {string} options.platform `process.platform` to act for.
 * @param {string} options.arch `process.arch` to act for.
 * @param {typeof import('node:fs')} [options.fs]
 * @returns {{ skipped?: string, fixed: string[], alreadyExecutable: string[], runtimeHelper: string | null }}
 */
export function ensureNodePtyPermissions({ packageRoot, platform, arch, fs = fsDefault }) {
  // Windows has no spawn-helper (it uses conpty/winpty-agent.exe) and NTFS
  // has no executable bit to set, so there is nothing to do and nothing to
  // verify.
  if (platform === 'win32') return { skipped: 'win32', fixed: [], alreadyExecutable: [], runtimeHelper: null }

  const fixed = []
  const alreadyExecutable = []
  for (const dir of helperDirs(packageRoot, fs)) {
    const helper = path.join(packageRoot, dir, HELPER)
    let mode
    try {
      mode = fs.statSync(helper).mode
    } catch {
      continue // this layout simply doesn't exist in this install
    }
    if ((mode & EXECUTABLE_BITS) === EXECUTABLE_BITS) {
      alreadyExecutable.push(helper)
      continue
    }
    fs.chmodSync(helper, mode | EXECUTABLE_BITS)
    fixed.push(helper)
  }

  // Verification, rather than hoping: find the directory node-pty will load
  // `pty.node` from and insist its helper is really there and really
  // executable. A missing one means this install cannot spawn a PTY at all,
  // which is worth failing loudly for instead of discovering it later as
  // `posix_spawnp failed`.
  const runtimeDir = nativeSearchDirs(platform, arch).find((dir) => fs.existsSync(path.join(packageRoot, dir, NATIVE_MODULE)))
  if (!runtimeDir) {
    throw new Error(
      `node-pty has no ${NATIVE_MODULE} for ${platform}-${arch} (looked in ${nativeSearchDirs(platform, arch).join(', ')} under ${packageRoot}). ` +
        'The dependency install did not complete — reinstall with scripts enabled.'
    )
  }
  const runtimeHelper = path.join(packageRoot, runtimeDir, HELPER)
  if (!fs.existsSync(runtimeHelper)) {
    throw new Error(
      `node-pty loaded ${NATIVE_MODULE} from ${runtimeDir} but ${HELPER} is missing beside it (${runtimeHelper}). ` +
        'Orbit\'s interactive Antigravity transport cannot start without it — reinstall node-pty.'
    )
  }
  if ((fs.statSync(runtimeHelper).mode & EXECUTABLE_BITS) !== EXECUTABLE_BITS) {
    throw new Error(`Could not make ${runtimeHelper} executable. Check the file's ownership and permissions.`)
  }

  return { fixed, alreadyExecutable, runtimeHelper }
}

/** Resolves the installed node-pty package directory, wherever npm hoisted
 *  it to — never a hardcoded `node_modules/node-pty`. */
export function resolveNodePtyRoot(fromUrl = import.meta.url) {
  return path.dirname(createRequire(fromUrl).resolve('node-pty/package.json'))
}

function main() {
  let packageRoot
  try {
    packageRoot = resolveNodePtyRoot(pathToFileURL(path.join(process.cwd(), 'package.json')).href)
  } catch {
    throw new Error('node-pty is not installed. Orbit needs it for the interactive Antigravity transport — run `npm install`.')
  }
  const result = ensureNodePtyPermissions({ packageRoot, platform: process.platform, arch: process.arch })
  if (result.skipped) return
  // Only worth a line when something was actually wrong, which upstream makes
  // true on macOS after every clean install.
  if (result.fixed.length > 0) {
    console.log(`> made node-pty's ${HELPER} executable (${result.fixed.length} binar${result.fixed.length === 1 ? 'y' : 'ies'})`)
  }
}

const entry = process.argv[1]
if (entry && pathToFileURL(path.resolve(entry)).href === import.meta.url) {
  try {
    main()
  } catch (error) {
    console.error(`\x1b[31m> ${error instanceof Error ? error.message : String(error)}\x1b[0m`)
    process.exit(1)
  }
}
