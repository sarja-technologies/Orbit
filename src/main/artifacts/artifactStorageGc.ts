// Reclaiming artifact copies nothing refers to any more.
//
// Orbit keeps its own copy of every output a turn produced, so history shows
// exactly what that turn made. Those copies are legitimate data for as long
// as a row refers to them, however old — this is garbage collection, never
// retention expiry. What it reclaims is only what has become garbage: the copy
// behind a deleted artifact or session, a copy whose row was never written,
// and a half-finished copy left by an interrupted write.
//
// The rules, every one enforced here rather than trusted to a caller:
//
//   - Only inside Orbit's artifact storage: `<dataDir>/projects/<id>/artifacts`
//     and `<dataDir>/conversations/<id>/artifacts`. Every directory on the way
//     must be a real directory, not a symlink, and canonically inside dataDir.
//   - Only files Orbit itself named: `artifact_<uuid>-…` for a finished copy,
//     or the temporary prefix FileStorage copies under. Anything else found
//     there is not Orbit's and is left alone.
//   - Only regular files. A symlink is never followed and never removed.
//   - Never a file any artifact or artifact-version row still names, however
//     many rows that is — checked against the database at the moment of
//     deletion, not remembered from earlier.
//   - Never the user's original: an original lives in the project or in
//     agy's own folder, both of which are outside these roots by construction.
//
// Deletion order is always database first, files second. A crash in between
// leaves an unreferenced file — which the next sweep reclaims — and never a
// row pointing at a file that was deleted from under it.
import fs from 'node:fs'
import path from 'node:path'
import { TEMPORARY_PREFIX } from '@main/files/fileStorage'
import { canonicalDirectory, isWithin } from './safePaths'

const MANAGED_COPY = /^artifact_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i
const OWNER_SCOPES = ['projects', 'conversations'] as const

/** What cleanup needs from the database: every location any row names. */
export interface ArtifactReferences {
  referencedArtifactLocations(): string[]
}

export interface CleanupReport {
  removed: string[]
  /** Candidates that were eligible but could not be removed (permissions,
   *  a file in use). They stay unreferenced and a later sweep retries. */
  failed: string[]
}

export function isManagedCopyName(name: string): boolean {
  return MANAGED_COPY.test(name)
}

export function isIncompleteCopyName(name: string): boolean {
  return name.startsWith(TEMPORARY_PREFIX)
}

/** The artifact storage directories that really are Orbit's: real (not
 *  symlinked) directories, canonically inside the data folder. */
export function artifactStorageRoots(dataDir: string): string[] {
  const data = canonicalDirectory(dataDir)
  if (!data) return []
  const roots: string[] = []
  for (const scope of OWNER_SCOPES) {
    const scopeDir = path.join(data, scope)
    if (!isRealDirectory(scopeDir)) continue
    let owners: fs.Dirent[]
    try {
      owners = fs.readdirSync(scopeDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const owner of owners) {
      if (!owner.isDirectory()) continue // symlinks report false here
      const artifacts = path.join(scopeDir, owner.name, 'artifacts')
      if (!isRealDirectory(artifacts)) continue
      const canonical = canonicalDirectory(artifacts)
      if (canonical && isWithin(data, canonical)) roots.push(canonical)
    }
  }
  return roots
}

/** Removes the stored copies at `locations` that no row references any
 *  more. Called after the rows that named them were deleted. Locations that
 *  are not Orbit-managed copies are ignored, never deleted. */
export function removeUnreferencedCopies(locations: readonly string[], dataDir: string, references: ArtifactReferences): CleanupReport {
  const report: CleanupReport = { removed: [], failed: [] }
  if (locations.length === 0) return report
  const roots = artifactStorageRoots(dataDir)
  const referenced = referencedSet(references)
  for (const location of new Set(locations)) {
    const candidate = managedCopyAt(location, roots)
    if (!candidate || referenced.has(candidate)) continue
    remove(candidate, report)
  }
  return report
}

/** Reconciles artifact storage with the database: every Orbit-named file no
 *  row references is removed, as is any incomplete copy.
 *
 *  `minAgeMs` protects a copy written moments ago whose row is about to be
 *  inserted; at startup nothing is in flight and it can be zero. Idempotent:
 *  a second sweep finds nothing, and a sweep interrupted part-way is simply
 *  finished by the next. */
export function sweepArtifactStorage(dataDir: string, references: ArtifactReferences, options: { minAgeMs?: number; now?: number } = {}): CleanupReport {
  const report: CleanupReport = { removed: [], failed: [] }
  const minAgeMs = options.minAgeMs ?? 10 * 60 * 1000
  const now = options.now ?? Date.now()
  const referenced = referencedSet(references)

  for (const root of artifactStorageRoots(dataDir)) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue // directories and symlinks are not Orbit's copies
      if (!isManagedCopyName(entry.name) && !isIncompleteCopyName(entry.name)) continue
      const full = path.join(root, entry.name)
      let stat: fs.Stats
      try {
        stat = fs.lstatSync(full)
      } catch {
        continue // Already gone.
      }
      if (!stat.isFile()) continue
      if (minAgeMs > 0 && now - stat.mtimeMs < minAgeMs) continue
      if (isManagedCopyName(entry.name) && referenced.has(full)) continue
      remove(full, report)
    }
    removeIfEmpty(root)
  }
  return report
}

/** The canonical path of `location` if it is an Orbit-managed copy: a regular
 *  file (not a symlink) with an Orbit-owned name, directly inside one of the
 *  artifact storage roots. */
function managedCopyAt(location: string, roots: readonly string[]): string | null {
  if (!location || !path.isAbsolute(location) || location.includes('\0')) return null
  const parent = canonicalDirectory(path.dirname(location))
  if (!parent || !roots.includes(parent)) return null
  const name = path.basename(location)
  if (!isManagedCopyName(name)) return null
  const full = path.join(parent, name)
  try {
    return fs.lstatSync(full).isFile() ? full : null
  } catch {
    return null
  }
}

function referencedSet(references: ArtifactReferences): Set<string> {
  const set = new Set<string>()
  for (const location of references.referencedArtifactLocations()) {
    if (!location) continue
    set.add(location)
    // Compare canonically too, so a data folder reached through a symlinked
    // path (macOS's /var → /private/var) is recognised as the same file.
    const parent = canonicalDirectory(path.dirname(location))
    if (parent) set.add(path.join(parent, path.basename(location)))
  }
  return set
}

function remove(file: string, report: CleanupReport): void {
  try {
    fs.unlinkSync(file)
    report.removed.push(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    report.failed.push(file)
  }
}

/** Removes an artifacts directory left empty, and its owner directory if that
 *  is now empty too. Never recursive: a directory with anything in it stays. */
function removeIfEmpty(root: string): void {
  for (const dir of [root, path.dirname(root)]) {
    try {
      if (fs.readdirSync(dir).length > 0) return
      fs.rmdirSync(dir)
    } catch {
      return
    }
  }
}

function isRealDirectory(candidate: string): boolean {
  try {
    return fs.lstatSync(candidate).isDirectory()
  } catch {
    return false
  }
}
