// Finds outputs an agent actually produced in the workspace during a turn.
//
// Why a filesystem diff rather than reading it off the tool stream: agy's
// structured events only exist on the structured transport, and a session
// in "Ask first" mode runs on the PTY, where there is no tool stream at
// all — only a terminal screen. And even on the structured transport a
// file written by `run_command` (a Python script rendering a chart, `zip`,
// `pandoc`) never appears as a write event. The filesystem is the same for
// both transports and is the actual evidence: the file is either there
// afterwards or it is not.
//
// Nothing here invents an artifact. A file is reported only when it is
// genuinely new, or genuinely changed, between the snapshot taken as the
// turn starts and the one taken when it ends — and only when its format is
// a deliverable (see shared/outputArtifacts.ts), so the source files an
// agent writes constantly never become cards.
import fs from 'node:fs'
import path from 'node:path'
import { isSkippedDirectory, outputFormatFor } from '@shared/outputArtifacts'

/** Bounds, so a scan of a large repository stays cheap enough to run on
 *  every turn. Generated output lands in the workspace or a folder just
 *  inside it, never eight levels down a vendored tree. */
const MAX_DEPTH = 6
const MAX_FILES = 5000
/** Directory entries visited before the walk gives up. Separate from
 *  MAX_FILES, which counts only candidates: a repository with a huge
 *  un-ignored tree of source must still not stall a send. */
const MAX_ENTRIES = 60_000
/** Ignores anything implausible as a generated output — almost always a
 *  stray large binary that happens to share an extension. Matches the
 *  per-file cap FileStorage enforces when it keeps a copy. */
export const MAX_OUTPUT_BYTES = 100 * 1024 * 1024

export interface OutputFile {
  /** Absolute path on disk. */
  filePath: string
  byteSize: number
  modifiedMs: number
}

/** Every candidate output file in `root`, keyed by absolute path.
 *
 *  `excludedDirectories` are skipped by absolute path.
 *
 *  Never throws: an unreadable directory is skipped rather than failing the
 *  scan, because a turn must not fail over a permissions error in a folder
 *  that has nothing to do with it. */
export function scanOutputs(root: string, excludedDirectories: readonly string[] = []): Map<string, OutputFile> {
  const found = new Map<string, OutputFile>()
  if (!root) return found
  let visited = 0
  // Orbit's own data folder, when a workspace happens to contain it: the
  // copies Orbit stores there are not outputs of the turn.
  const excluded = new Set(excludedDirectories.map((dir) => path.resolve(dir)))

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || found.size >= MAX_FILES || visited >= MAX_ENTRIES) return

    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (found.size >= MAX_FILES || ++visited > MAX_ENTRIES) return
      // A symlink is not followed: it can point outside the workspace
      // entirely, and a cycle would never terminate.
      if (entry.isSymbolicLink()) continue

      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (isSkippedDirectory(entry.name) || excluded.has(full)) continue
        walk(full, depth + 1)
        continue
      }
      if (!entry.isFile() || !outputFormatFor(entry.name)) continue

      try {
        const stat = fs.statSync(full)
        if (stat.size === 0 || stat.size > MAX_OUTPUT_BYTES) continue
        found.set(full, { filePath: full, byteSize: stat.size, modifiedMs: stat.mtimeMs })
      } catch {
        // Written and removed again while the scan ran — not an output.
      }
    }
  }

  try {
    if (!fs.statSync(root).isDirectory()) return found
  } catch {
    return found
  }
  walk(root, 0)
  return found
}

export interface ChangedOutput extends OutputFile {
  /** True when the path did not exist at all when the turn started. */
  created: boolean
}

/** The outputs that appeared, or changed, between two scans.
 *
 *  Size-or-mtime is what distinguishes a regenerated file from one that
 *  merely sat there: an agent asked to "make the sky darker" overwrites the
 *  same path, and that is a new output for this turn, not a no-op. A file
 *  that is byte-identical and untouched is not reported at all, which is
 *  what stops a turn that generated nothing from surfacing the whole
 *  folder. */
export function newOrChangedOutputs(before: Map<string, OutputFile>, after: Map<string, OutputFile>): ChangedOutput[] {
  const produced: ChangedOutput[] = []
  for (const [filePath, file] of after) {
    const previous = before.get(filePath)
    if (!previous) {
      produced.push({ ...file, created: true })
      continue
    }
    if (previous.byteSize !== file.byteSize || previous.modifiedMs !== file.modifiedMs) produced.push({ ...file, created: false })
  }
  // Oldest first, so a turn that produced several shows them in the order
  // they were written.
  return produced.sort((a, b) => a.modifiedMs - b.modifiedMs)
}
