// Terminating everything an agent execution started — and nothing else.
//
// Captured live (agy 1.2.2, macOS): agy runs every `run_command` in a NEW
// process group of its own, as a child of agy:
//
//   45906  ppid 1(Orbit)  pgid 45902   agy --print …
//   45931  ppid 45906     pgid 45931   sh -c 'sleep 301 & sleep 302; wait'
//   45932  ppid 45931     pgid 45931   sleep 301
//
// SIGTERM to agy killed agy and nothing else: the shell's group was
// reparented to launchd (ppid 1) and kept running. Signalling agy's own
// group cannot reach it either, and once agy is gone the parent link that
// identified it as ours is gone too. So the tree is SNAPSHOTTED FIRST, while
// the parent links still exist, and every process in it is then addressed
// directly — by process group where the tree created that group, and by pid
// otherwise.
//
// Identity is pid + start time, never a bare pid, so a pid the OS has since
// reused for an unrelated process is never signalled. Process groups are
// only signalled when their leader is in the snapshot (so the group was
// created by this tree) and is not Orbit's own group.
import { execFile } from 'node:child_process'

export interface ProcessInfo {
  pid: number
  ppid: number
  /** Null where the platform has no process groups (Windows). */
  pgid: number | null
  /** Opaque start-time key. Two entries are the same process only when both
   *  pid and startKey match. */
  startKey: string
}

export type TerminationSignal = 'SIGTERM' | 'SIGKILL'

/** Everything platform-specific, injectable for tests. */
export interface ProcessPlatform {
  readonly kind: 'posix' | 'win32'
  list(): Promise<ProcessInfo[]>
  /** Signals one process. Must not throw for a process that is already gone. */
  signalProcess(pid: number, signal: TerminationSignal): void
  /** Signals a whole process group (POSIX only). Must not throw. */
  signalGroup(pgid: number, signal: TerminationSignal): void
  /** Windows: terminate a process and its descendants while the parent links
   *  still exist. Resolves once the command has run. */
  killTree?(pid: number, force: boolean): Promise<void>
  /** Orbit's own pid, whose group must never be signalled. */
  readonly selfPid: number
}

export interface TerminateOptions {
  /** The execution's own process (agy). */
  rootPid: number
  /** Whether the root itself is terminated, or only what it started. */
  includeRoot: boolean
  /** Narrows which descendants count as this execution's. Applied to the
   *  snapshot; the root is never filtered. */
  include?: (process: ProcessInfo, root: ProcessInfo | undefined) => boolean
  /** How long a polite request is given before survivors are force-killed. */
  graceMs?: number
  /** Taken earlier; when given, used instead of listing now. A caller that is
   *  about to let the root exit takes it while the parent links still exist. */
  snapshot?: ProcessInfo[]
  platform?: ProcessPlatform
}

export interface TerminationReport {
  targeted: number
  /** Processes still alive after the force-kill. Should be empty. */
  survivors: ProcessInfo[]
}

const DEFAULT_GRACE_MS = 1500
const POLL_MS = 100

export function processKey(process: Pick<ProcessInfo, 'pid' | 'startKey'>): string {
  return `${process.pid}@${process.startKey}`
}

/** Every process descended from `rootPid` in a snapshot, breadth first. */
export function descendantsOf(rootPid: number, processes: readonly ProcessInfo[]): ProcessInfo[] {
  const byParent = new Map<number, ProcessInfo[]>()
  for (const process of processes) {
    if (process.pid === process.ppid) continue
    const siblings = byParent.get(process.ppid)
    if (siblings) siblings.push(process)
    else byParent.set(process.ppid, [process])
  }
  const found: ProcessInfo[] = []
  const seen = new Set<number>([rootPid])
  const queue = [rootPid]
  while (queue.length > 0) {
    const parent = queue.shift()!
    for (const child of byParent.get(parent) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      found.push(child)
      queue.push(child.pid)
    }
  }
  return found
}

/** The processes an execution owns right now: its root (when included) and
 *  the descendants `include` accepts. */
export async function snapshotExecution(options: Omit<TerminateOptions, 'graceMs' | 'snapshot'>): Promise<ProcessInfo[]> {
  const platform = options.platform ?? defaultProcessPlatform()
  let processes: ProcessInfo[]
  try {
    processes = await platform.list()
  } catch {
    return []
  }
  return selectTargets(processes, options)
}

function selectTargets(processes: readonly ProcessInfo[], options: Pick<TerminateOptions, 'rootPid' | 'includeRoot' | 'include'>): ProcessInfo[] {
  const root = processes.find((process) => process.pid === options.rootPid)
  const descendants = descendantsOf(options.rootPid, processes).filter((process) => options.include?.(process, root) ?? true)
  return options.includeRoot && root ? [root, ...descendants] : descendants
}

/** Terminates an execution's process tree: a polite request, a bounded
 *  wait, then a force-kill of whatever is verifiably still the same process.
 *
 *  Never throws. Never signals a process that is not in the snapshot, a
 *  group it did not create, or Orbit's own group. */
export async function terminateExecution(options: TerminateOptions): Promise<TerminationReport> {
  const platform = options.platform ?? defaultProcessPlatform()
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS

  if (platform.kind === 'win32') return terminateWindows(options, platform, graceMs)

  let processes: ProcessInfo[]
  try {
    processes = options.snapshot ? [...options.snapshot] : await platform.list()
  } catch {
    return { targeted: 0, survivors: [] }
  }
  const targets = options.snapshot ? options.snapshot : selectTargets(processes, options)
  if (targets.length === 0) return { targeted: 0, survivors: [] }

  const selfGroup = processes.find((process) => process.pid === platform.selfPid)?.pgid ?? null
  // Groups are decided once, from the full snapshot. A group is signalled
  // only while at least one verified member of it is still alive — a group
  // id cannot be reused while any member exists, so it is still ours — which
  // also reaches members started after the snapshot inside that group.
  const groups = ownedGroups(targets, selfGroup)
  const signalAll = (signal: TerminationSignal, alive: readonly ProcessInfo[]): void => {
    for (const group of groups) if (alive.some((process) => process.pgid === group)) platform.signalGroup(group, signal)
    for (const process of alive) platform.signalProcess(process.pid, signal)
  }

  signalAll('SIGTERM', targets)
  let alive = await waitUntilGone(platform, targets, graceMs)
  if (alive.length === 0) return { targeted: targets.length, survivors: [] }

  signalAll('SIGKILL', alive)
  alive = await waitUntilGone(platform, alive, 1000)
  return { targeted: targets.length, survivors: alive }
}

/** Groups whose leader is itself one of the targets — i.e. groups this
 *  execution created — excluding Orbit's own. */
function ownedGroups(targets: readonly ProcessInfo[], selfGroup: number | null): number[] {
  const leaders = new Set(targets.map((process) => process.pid))
  const groups = new Set<number>()
  for (const process of targets) {
    if (process.pgid === null || process.pgid <= 1 || process.pgid === selfGroup) continue
    if (leaders.has(process.pgid)) groups.add(process.pgid)
  }
  return [...groups]
}

/** The targets still alive — same pid AND same start time — once they have
 *  all gone or `timeoutMs` has passed. */
async function waitUntilGone(platform: ProcessPlatform, targets: readonly ProcessInfo[], timeoutMs: number): Promise<ProcessInfo[]> {
  const deadline = Date.now() + timeoutMs
  const wanted = new Map(targets.map((process) => [processKey(process), process]))
  for (;;) {
    let alive: ProcessInfo[]
    try {
      const current = new Set((await platform.list()).map(processKey))
      alive = [...wanted.entries()].filter(([key]) => current.has(key)).map(([, process]) => process)
    } catch {
      return []
    }
    if (alive.length === 0 || Date.now() >= deadline) return alive
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

/** Windows has no process groups or POSIX signals for console processes.
 *  `taskkill /T` walks parent links, so it runs while the root is alive;
 *  anything the snapshot saw that outlived it is then killed by pid. */
async function terminateWindows(options: TerminateOptions, platform: ProcessPlatform, graceMs: number): Promise<TerminationReport> {
  let targets: ProcessInfo[]
  try {
    targets = options.snapshot ?? selectTargets(await platform.list(), options)
  } catch {
    return { targeted: 0, survivors: [] }
  }
  if (targets.length === 0) return { targeted: 0, survivors: [] }
  // Each target's own subtree, while its parent links still exist. The root
  // is only in `targets` when it was meant to be.
  for (const process of targets) await platform.killTree?.(process.pid, true).catch(() => undefined)
  let alive = await waitUntilGone(platform, targets, graceMs)
  for (const process of alive) platform.signalProcess(process.pid, 'SIGKILL')
  alive = await waitUntilGone(platform, alive, 1000)
  return { targeted: targets.length, survivors: alive }
}

// ---------------------------------------------------------------------------
// Platform implementations

/** `ps -A -o pid=,ppid=,pgid=,lstart=` under the C locale, one per line:
 *  `  45931 45906 45931 Sat Sep 13 21:03:39 2026`. The same columns exist
 *  on macOS and Linux procps. */
export function parsePosixProcessList(output: string): ProcessInfo[] {
  const processes: ProcessInfo[] = []
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    processes.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), startKey: match[4]! })
  }
  return processes
}

/** `Get-CimInstance Win32_Process | ConvertTo-Csv` projected onto
 *  ProcessId,ParentProcessId,CreationDate. */
export function parseWindowsProcessList(output: string): ProcessInfo[] {
  const processes: ProcessInfo[] = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^"?(\d+)"?,"?(\d+)"?,"?([^",]*)"?$/.exec(line.trim())
    if (!match) continue
    processes.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: null, startKey: match[3] || 'unknown' })
  }
  return processes
}

function run(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env: env ?? process.env, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

function posixPlatform(): ProcessPlatform {
  return {
    kind: 'posix',
    selfPid: process.pid,
    list: async () => parsePosixProcessList(await run('ps', ['-A', '-o', 'pid=,ppid=,pgid=,lstart='], { ...process.env, LC_ALL: 'C' })),
    signalProcess: (pid, signal) => {
      try {
        process.kill(pid, signal)
      } catch {
        // Already gone.
      }
    },
    signalGroup: (pgid, signal) => {
      try {
        process.kill(-pgid, signal)
      } catch {
        // Group already empty.
      }
    }
  }
}

function windowsPlatform(): ProcessPlatform {
  return {
    kind: 'win32',
    selfPid: process.pid,
    list: async () =>
      parseWindowsProcessList(
        await run('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{n="CreationDate";e={$_.CreationDate.ToString("o")}} | ConvertTo-Csv -NoTypeInformation'
        ])
      ),
    signalProcess: (pid) => {
      try {
        process.kill(pid)
      } catch {
        // Already gone.
      }
    },
    signalGroup: () => undefined,
    killTree: async (pid, force) => {
      await run('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])]).catch(() => undefined)
    }
  }
}

let cached: ProcessPlatform | null = null
export function defaultProcessPlatform(): ProcessPlatform {
  cached ??= process.platform === 'win32' ? windowsPlatform() : posixPlatform()
  return cached
}
