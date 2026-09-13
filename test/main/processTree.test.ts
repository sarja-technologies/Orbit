// Process-tree termination: the helpers against a scripted platform, then
// the real thing against real processes arranged the way agy arranges them.
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  descendantsOf,
  parsePosixProcessList,
  parseWindowsProcessList,
  terminateExecution,
  type ProcessInfo,
  type ProcessPlatform,
  type TerminationSignal
} from '../../src/main/process/processTree'

const p = (pid: number, ppid: number, pgid: number | null, startKey = 'T'): ProcessInfo => ({ pid, ppid, pgid, startKey })

/** A process table the test controls, recording every signal sent. */
class ScriptedPlatform implements ProcessPlatform {
  readonly kind: 'posix' | 'win32'
  readonly selfPid = 100
  signals: Array<[string, number, TerminationSignal]> = []
  trees: number[] = []
  /** Pids that ignore SIGTERM. */
  stubborn = new Set<number>()
  constructor(
    public table: ProcessInfo[],
    kind: 'posix' | 'win32' = 'posix'
  ) {
    this.kind = kind
  }
  async list(): Promise<ProcessInfo[]> {
    return [...this.table]
  }
  private remove(predicate: (process: ProcessInfo) => boolean, signal: TerminationSignal): void {
    this.table = this.table.filter((process) => !(predicate(process) && (signal === 'SIGKILL' || !this.stubborn.has(process.pid))))
  }
  signalProcess(pid: number, signal: TerminationSignal): void {
    this.signals.push(['pid', pid, signal])
    this.remove((process) => process.pid === pid, signal)
  }
  signalGroup(pgid: number, signal: TerminationSignal): void {
    this.signals.push(['group', pgid, signal])
    this.remove((process) => process.pgid === pgid, signal)
  }
  async killTree(pid: number): Promise<void> {
    this.trees.push(pid)
    const doomed = new Set([pid, ...descendantsOf(pid, this.table).map((process) => process.pid)])
    this.table = this.table.filter((process) => !doomed.has(process.pid))
  }
}

describe('reading the process table', () => {
  it('parses ps output, keeping the start time as identity', () => {
    const table = parsePosixProcessList('    1     0     1 Sat Sep 12 13:05:02 2026\n45931 45906 45931 Sun Sep 13 21:03:39 2026\n\ngarbage\n')
    expect(table).toEqual([p(1, 0, 1, 'Sat Sep 12 13:05:02 2026'), p(45931, 45906, 45931, 'Sun Sep 13 21:03:39 2026')])
  })

  it('parses the Windows CIM listing', () => {
    const table = parseWindowsProcessList('"ProcessId","ParentProcessId","CreationDate"\r\n"4","0","2026-09-13T08:00:00.0000000+00:00"\r\n"812","4","2026-09-13T09:00:00.0000000+00:00"')
    expect(table).toEqual([p(4, 0, null, '2026-09-13T08:00:00.0000000+00:00'), p(812, 4, null, '2026-09-13T09:00:00.0000000+00:00')])
  })

  it('walks descendants through any depth, and nothing else', () => {
    const table = [p(100, 1, 100), p(200, 100, 100), p(300, 200, 300), p(301, 300, 300), p(999, 1, 999)]
    expect(descendantsOf(200, table).map((process) => process.pid)).toEqual([300, 301])
  })
})

describe('terminating an execution (scripted)', () => {
  // Orbit 100 (group 100) → agy 200 (its own group) → command group 300.
  const agyTree = (): ProcessInfo[] => [p(1, 0, 1), p(100, 1, 100), p(200, 100, 200), p(300, 200, 300), p(301, 300, 300), p(500, 1, 500)]

  it('terminates agy and the command group agy created, and nothing unrelated', async () => {
    const platform = new ScriptedPlatform(agyTree())
    const report = await terminateExecution({ rootPid: 200, includeRoot: true, platform, graceMs: 50 })
    expect(report.survivors).toEqual([])
    expect(platform.table.map((process) => process.pid)).toEqual([1, 100, 500])
    expect(platform.signals.every(([, id]) => ![1, 100, 500].includes(id))).toBe(true)
  })

  it('never signals Orbit’s own process group, even when agy shares it', async () => {
    const platform = new ScriptedPlatform([p(100, 1, 100), p(200, 100, 100), p(300, 200, 300)])
    await terminateExecution({ rootPid: 200, includeRoot: true, platform, graceMs: 50 })
    expect(platform.signals.filter(([kind, id]) => kind === 'group' && id === 100)).toEqual([])
    expect(platform.table.map((process) => process.pid)).toEqual([100])
  })

  it('force-kills what ignores the polite request', async () => {
    const platform = new ScriptedPlatform(agyTree())
    platform.stubborn.add(301)
    const report = await terminateExecution({ rootPid: 200, includeRoot: true, platform, graceMs: 150 })
    expect(report.survivors).toEqual([])
    expect(platform.signals.some(([, , signal]) => signal === 'SIGKILL')).toBe(true)
  })

  it('does not force-kill a reused pid that is no longer the same process', async () => {
    const platform = new ScriptedPlatform(agyTree())
    platform.stubborn.add(300)
    const original = platform.signalGroup.bind(platform)
    // The command exits on its own after the polite request, and its pid is
    // immediately reused by something unrelated.
    platform.signalGroup = (pgid, signal) => {
      original(pgid, signal)
      if (pgid === 300 && signal === 'SIGTERM') {
        platform.table = platform.table.filter((process) => process.pid !== 300 && process.pid !== 301)
        platform.table.push(p(300, 1, 300, 'LATER'))
      }
    }
    await terminateExecution({ rootPid: 200, includeRoot: true, platform, graceMs: 150 })
    expect(platform.table).toContainEqual(p(300, 1, 300, 'LATER'))
    expect(platform.signals.filter(([, id, signal]) => id === 300 && signal === 'SIGKILL')).toEqual([])
  })

  it('can spare the root and anything the filter excludes', async () => {
    // agy 200 with a long-lived helper in its own group (201) and a command
    // group (300): only the command group goes.
    const platform = new ScriptedPlatform([p(100, 1, 100), p(200, 100, 200), p(201, 200, 200), p(300, 200, 300)])
    await terminateExecution({ rootPid: 200, includeRoot: false, include: (process, root) => process.pgid !== root?.pgid, platform, graceMs: 50 })
    expect(platform.table.map((process) => process.pid)).toEqual([100, 200, 201])
  })

  it('does nothing, and does not throw, for a root that has already gone', async () => {
    const platform = new ScriptedPlatform([p(100, 1, 100)])
    await expect(terminateExecution({ rootPid: 4242, includeRoot: true, platform, graceMs: 50 })).resolves.toEqual({ targeted: 0, survivors: [] })
    expect(platform.signals).toEqual([])
  })

  it('never throws when the process table cannot be read', async () => {
    const platform = new ScriptedPlatform([])
    platform.list = async () => {
      throw new Error('ps missing')
    }
    await expect(terminateExecution({ rootPid: 200, includeRoot: true, platform })).resolves.toEqual({ targeted: 0, survivors: [] })
  })

  it('on Windows, terminates each target’s tree with taskkill while parents still exist', async () => {
    const platform = new ScriptedPlatform([p(100, 1, null), p(200, 100, null), p(300, 200, null), p(301, 300, null)], 'win32')
    await terminateExecution({ rootPid: 200, includeRoot: true, platform, graceMs: 50 })
    expect(platform.trees[0]).toBe(200)
    expect(platform.table.map((process) => process.pid)).toEqual([100])
  })
})

const isPosix = process.platform !== 'win32'
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const spawned: number[] = []
afterEach(() => {
  for (const pid of spawned.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      /* gone */
    }
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
})

/** A real "agy": a parent that starts a command in a process group of its
 *  own, and reports the command's pid. */
async function realAgyWithCommand(ignoreTerm = false): Promise<{ agy: number; command: number }> {
  const script = `
    const { spawn } = require('node:child_process')
    ${ignoreTerm ? "process.on('SIGTERM', () => {})" : ''}
    const command = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: 'ignore' })
    process.stdout.write(String(command.pid) + '\\n')
    setInterval(() => {}, 1000)
  `
  const agy = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] })
  const command = await new Promise<number>((resolve) => agy.stdout!.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim()))))
  spawned.push(agy.pid!, command)
  return { agy: agy.pid!, command }
}

describe.runIf(isPosix)('terminating real processes', () => {
  it('reproduces the bug: killing agy alone leaves its command running', async () => {
    const { agy, command } = await realAgyWithCommand()
    process.kill(agy, 'SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(alive(agy)).toBe(false)
    expect(alive(command)).toBe(true)
  })

  it('terminates agy and its command group, force-killing what ignores SIGTERM', async () => {
    const { agy, command } = await realAgyWithCommand(true)
    const report = await terminateExecution({ rootPid: agy, includeRoot: true, graceMs: 300 })
    expect(report.survivors).toEqual([])
    expect(alive(agy)).toBe(false)
    expect(alive(command)).toBe(false)
  })

  it('still reaches the command after agy has gone, from a snapshot taken first', async () => {
    const { agy, command } = await realAgyWithCommand()
    const { snapshotExecution } = await import('../../src/main/process/processTree')
    const snapshot = await snapshotExecution({ rootPid: agy, includeRoot: false })
    process.kill(agy, 'SIGKILL')
    await new Promise((resolve) => setTimeout(resolve, 200))
    await terminateExecution({ rootPid: agy, includeRoot: false, snapshot, graceMs: 300 })
    expect(alive(command)).toBe(false)
  })

  it('leaves a process that exits naturally alone, and reports nothing', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10)'], { stdio: 'ignore' })
    await new Promise((resolve) => child.once('exit', resolve))
    await expect(terminateExecution({ rootPid: child.pid!, includeRoot: true, graceMs: 100 })).resolves.toEqual({ targeted: 0, survivors: [] })
    expect(alive(process.pid)).toBe(true)
  })
})
