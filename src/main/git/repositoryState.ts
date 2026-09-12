// Reads the small amount of git state Orbit needs to decide which
// repository quick actions are worth offering.
//
// This is the ONLY place Orbit runs git, and it runs nothing that changes
// anything: every command below is a read. The actions themselves never
// execute git at all — they submit a prompt and the agent does the work
// under the session's own permission mode (see shared/repositoryActions.ts).
//
// Every invocation is `shell: false` with a fixed argument list and a
// timeout, so a repository path can never become a shell fragment, and a
// hung git (a network remote, a stale index lock) cannot hang the UI. Any
// failure resolves to "not a repository", which simply shows no chips —
// failing closed is right here, because a wrong answer would offer an
// action that cannot work.
import { spawn } from 'node:child_process'
import { NO_REPOSITORY, type RepositoryState } from '@shared/repositoryActions'

/** Long enough for a cold index on a large repository, short enough that a
 *  wedged git never becomes a wedged composer. Nothing below touches the
 *  network. */
const GIT_TIMEOUT_MS = 3000

interface GitResult {
  ok: boolean
  stdout: string
}

/** One read-only git command. Never throws: a missing git, a non-zero exit
 *  and a timeout are all just `ok: false`. */
function git(args: readonly string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let settled = false
    const finish = (result: GitResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    try {
      const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], shell: false })
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish({ ok: false, stdout: '' })
      }, GIT_TIMEOUT_MS)

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      child.on('error', () => {
        clearTimeout(timer)
        finish({ ok: false, stdout: '' })
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        finish({ ok: code === 0, stdout })
      })
    } catch {
      finish({ ok: false, stdout: '' })
    }
  })
}

/** The repository state of a workspace folder.
 *
 *  `workspacePath` is a directory Orbit already owns — a project root or a
 *  managed session workspace — never anything the renderer supplied. */
export async function readRepositoryState(workspacePath: string | null): Promise<RepositoryState> {
  if (!workspacePath) return NO_REPOSITORY

  // `--is-inside-work-tree` is the real question: a bare repository, or the
  // .git directory itself, is not somewhere these actions make sense.
  const inside = await git(['rev-parse', '--is-inside-work-tree'], workspacePath)
  if (!inside.ok || inside.stdout.trim() !== 'true') return NO_REPOSITORY

  const [status, branch] = await Promise.all([
    // `--porcelain` is the stable, parse-safe format, and its output is
    // empty exactly when the tree is clean. Untracked files count: a
    // brand-new file the agent just wrote is uncommitted work.
    git(['status', '--porcelain'], workspacePath),
    git(['rev-parse', '--abbrev-ref', 'HEAD'], workspacePath)
  ])

  // 'HEAD' from --abbrev-ref means a detached HEAD, which has no branch to
  // push or open a PR from.
  const branchName = branch.ok ? branch.stdout.trim() : ''
  const currentBranch = branchName && branchName !== 'HEAD' ? branchName : null

  const upstream = currentBranch ? await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], workspacePath) : { ok: false, stdout: '' }
  const hasUpstream = upstream.ok && upstream.stdout.trim().length > 0

  // Only meaningful against an upstream; without one there is nothing to be
  // ahead of, and 0 is the honest answer rather than a count of every
  // commit on the branch.
  let ahead = 0
  if (hasUpstream) {
    const counted = await git(['rev-list', '--count', '@{u}..HEAD'], workspacePath)
    const parsed = Number.parseInt(counted.stdout.trim(), 10)
    if (counted.ok && Number.isFinite(parsed)) ahead = parsed
  }

  return {
    isRepository: true,
    branch: currentBranch,
    hasChanges: status.ok && status.stdout.trim().length > 0,
    hasUpstream,
    ahead
  }
}
