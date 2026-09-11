import fs from 'node:fs'
import path from 'node:path'

export { CLEAR_DATA_CONFIRMATION } from '@shared/clearData'

export interface ClearAllDataInput {
  /** Orbit's own application data directory — the only place anything is
   *  deleted from. */
  dataDir: string
  /** Stops everything holding the data open: live agy processes and the
   *  database. Awaited before a single file is removed, so nothing is
   *  writing while the directory is emptied and no handle survives it. */
  shutdown: () => Promise<void>
}

export interface ClearAllDataResult {
  /** Entry names removed from the data directory, for the caller to log. */
  removed: string[]
}

/** Refuses to treat a path as Orbit's data directory when it is obviously
 *  not one. A clear is irreversible, so the cheap structural checks are
 *  worth having: a root, or a path with nothing under it, means something
 *  has gone wrong upstream and deleting its contents would be a disaster
 *  rather than a feature. */
function assertClearable(dataDir: string): string {
  const resolved = path.resolve(dataDir)
  const { root } = path.parse(resolved)
  if (resolved === root) throw new Error('Refusing to clear a filesystem root.')
  // A real userData path is always several levels down. Two segments is
  // already more permissive than anything Electron produces.
  const depth = resolved.slice(root.length).split(path.sep).filter(Boolean).length
  if (depth < 2) throw new Error(`Refusing to clear a path this shallow: ${resolved}`)
  return resolved
}

/** Empties Orbit's own data directory, and nothing else.
 *
 *  This deletes what Orbit owns: its database (projects, sessions,
 *  messages, run history, preferences), the files it copied in as
 *  attachments, the artifacts it created, and the workspaces it manages
 *  for projects that have no folder of their own.
 *
 *  It does NOT delete a user's own project folders. A project can point at
 *  somewhere like ~/Documents/MyProject; that path is stored in Orbit's
 *  database as a reference, and clearing removes the reference. The folder
 *  it referred to is outside this directory and is never walked, opened or
 *  removed — deletion is scoped to the direct children of `dataDir` and
 *  cannot escape it, whatever a project row happens to contain.
 *
 *  The directory itself is kept (emptied, not removed) so the next launch
 *  reinitializes into a path that already exists. */
export async function clearAllData({ dataDir, shutdown }: ClearAllDataInput): Promise<ClearAllDataResult> {
  const resolved = assertClearable(dataDir)
  // Everything holding the data open goes first — a PTY still writing into
  // a workspace, or an open sqlite handle, would otherwise survive the
  // clear and recreate part of what was just removed.
  await shutdown()

  if (!fs.existsSync(resolved)) return { removed: [] }

  const removed: string[] = []
  for (const entry of fs.readdirSync(resolved)) {
    // Joining a readdir name can only ever produce a direct child, so this
    // stays inside the data directory by construction.
    fs.rmSync(path.join(resolved, entry), { recursive: true, force: true })
    removed.push(entry)
  }
  return { removed }
}
