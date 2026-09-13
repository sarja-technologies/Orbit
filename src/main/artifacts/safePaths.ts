// Path containment for files an agent created.
//
// Every path in here originated with an agent, so it is untrusted however
// it reached Orbit. The only question these answer is the safe one: "is
// this, right now, a real regular file physically inside a folder Orbit
// deliberately allows?" — asked again at the moment of use, not just at
// detection, because a file can be swapped for a symlink to somewhere else
// between the two.
import fs from 'node:fs'
import path from 'node:path'

/** The canonical, symlink-free form of a directory, or null if it is not a
 *  real directory. */
export function canonicalDirectory(candidate: string | null | undefined): string | null {
  if (!candidate || !path.isAbsolute(candidate)) return null
  try {
    const real = fs.realpathSync.native(candidate)
    return fs.statSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

/** Whether `child` is `parent` or lies beneath it. Both must already be
 *  canonical. Compared by path segments, so `/work/app-old` is never
 *  mistaken for being inside `/work/app`. */
export function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** The canonical path of `candidate` if — and only if — it is an existing
 *  regular file whose real location is inside one of `roots`.
 *
 *  Symlinks anywhere along the way are resolved before the containment
 *  check, so a link inside the workspace pointing at `~/.ssh` resolves to
 *  `~/.ssh` and is refused. `..` segments are resolved the same way. A
 *  relative path is refused outright: nothing Orbit stores is relative, so
 *  one can only have come from somewhere it should not have. */
export function resolveContainedFile(candidate: string | null | undefined, roots: ReadonlyArray<string | null | undefined>): string | null {
  if (!candidate || typeof candidate !== 'string' || !path.isAbsolute(candidate) || candidate.includes('\0')) return null
  let real: string
  try {
    real = fs.realpathSync.native(candidate)
    if (!fs.statSync(real).isFile()) return null
  } catch {
    return null
  }
  for (const root of roots) {
    const canonicalRoot = canonicalDirectory(root)
    if (canonicalRoot && isWithin(canonicalRoot, real)) return real
  }
  return null
}
