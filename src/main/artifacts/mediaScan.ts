// Finds media an agent actually produced during a turn.
//
// Why a filesystem diff rather than reading it off the tool stream: agy's
// structured events only exist on the structured transport, and a session
// in "Ask first" mode runs on the PTY, where there is no tool stream at
// all — only a terminal screen. A turn that generates an image in that mode
// would be invisible to any event-based detection. The filesystem, by
// contrast, is the same for both transports and is the actual evidence:
// the file is either there afterwards or it is not.
//
// Nothing here invents an artifact. A file is reported only when it is
// genuinely new, or genuinely changed, between the snapshot taken as the
// turn starts and the one taken when it ends — and only when it is media
// Orbit can preview (see shared/mediaArtifacts.ts), so the source files an
// agent writes constantly stay in Files where they belong.
import fs from 'node:fs'
import path from 'node:path'
import { SKIPPED_DIRECTORIES, isMediaArtifact } from '@shared/mediaArtifacts'

/** Bounds, so a scan of a large repository stays cheap enough to run on
 *  every turn. Generated output lands in the workspace or a folder just
 *  inside it, never eight levels down a vendored tree. */
const MAX_DEPTH = 6
const MAX_FILES = 5000
/** Ignores anything implausible as generated media, which is almost always
 *  a stray large binary that happens to share an extension. */
const MAX_BYTES = 512 * 1024 * 1024

export interface MediaFile {
  /** Absolute path on disk. */
  filePath: string
  byteSize: number
  modifiedMs: number
}

/** Every previewable media file in `root`, keyed by absolute path.
 *
 *  Never throws: an unreadable directory is skipped rather than failing the
 *  scan, because a turn must not fail over a permissions error in a folder
 *  that has nothing to do with it. */
export function scanMedia(root: string): Map<string, MediaFile> {
  const found = new Map<string, MediaFile>()
  if (!root) return found

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || found.size >= MAX_FILES) return

    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (found.size >= MAX_FILES) return
      // A symlink is not followed: it can point outside the workspace
      // entirely, and a cycle would never terminate.
      if (entry.isSymbolicLink()) continue

      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue
        walk(full, depth + 1)
        continue
      }
      if (!entry.isFile() || !isMediaArtifact(entry.name)) continue

      try {
        const stat = fs.statSync(full)
        if (stat.size === 0 || stat.size > MAX_BYTES) continue
        found.set(full, { filePath: full, byteSize: stat.size, modifiedMs: stat.mtimeMs })
      } catch {
        // Written and removed again while the scan ran — not an artifact.
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

/** The media that appeared, or changed, between two scans.
 *
 *  Size-or-mtime is what distinguishes a regenerated file from one that
 *  merely sat there: an agent asked to "make the sky darker" overwrites the
 *  same path, and that is a new artifact version, not a no-op. A file that
 *  is byte-identical and untouched is not reported at all, which is what
 *  stops a turn that generated nothing from registering the whole folder. */
export function newOrChangedMedia(before: Map<string, MediaFile>, after: Map<string, MediaFile>): MediaFile[] {
  const produced: MediaFile[] = []
  for (const [filePath, file] of after) {
    const previous = before.get(filePath)
    if (!previous) {
      produced.push(file)
      continue
    }
    if (previous.byteSize !== file.byteSize || previous.modifiedMs !== file.modifiedMs) produced.push(file)
  }
  // Oldest first, so a turn that produced several registers them in the
  // order they were written.
  return produced.sort((a, b) => a.modifiedMs - b.modifiedMs)
}
