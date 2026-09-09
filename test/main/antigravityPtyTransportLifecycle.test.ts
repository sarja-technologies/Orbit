import { describe, expect, it } from 'vitest'
import { AntigravityPtyTransport } from '../../src/main/runtime/providers/antigravity/AntigravityPtyTransport'
import type { AntigravityPtyHandlers } from '../../src/main/runtime/providers/antigravity/AntigravityPtyTransport'

// These drive a real PTY (a trivial `sh`, never `agy`), because the property
// under test is precisely the one a fake cannot vouch for: what the transport
// reports between "termination requested" and "process actually gone".
const unix = process.platform !== 'win32'

const noopHandlers = (onExit: (code: number) => void = () => undefined): AntigravityPtyHandlers => ({
  onInteraction: () => undefined,
  onReadyForInput: () => undefined,
  onBusy: () => undefined,
  onExit
})

/** Starts the transport and waits until the child has printed `marker`, so a
 *  test never signals a shell that has not finished setting itself up yet. */
function startAndWaitFor(transport: AntigravityPtyTransport, marker: string): Promise<void> {
  return new Promise<void>((resolve) => {
    transport.start({
      ...noopHandlers(),
      onScreenText: (lines) => {
        if (lines.some((line) => line.includes(marker))) resolve()
      }
    })
  })
}

const settled = async <T,>(promise: Promise<T>, ms: number): Promise<boolean> => {
  const marker = Symbol('pending')
  const result = await Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(marker), ms))])
  return result !== marker
}

describe('AntigravityPtyTransport process lifecycle', () => {
  it.runIf(unix)('keeps reporting isRunning until the process has really exited', async () => {
    // A shell that deliberately ignores the polite signals, standing in for
    // an agy process that is slow to die.
    const transport = new AntigravityPtyTransport('/bin/sh', process.cwd(), [
      '-c',
      'trap "" TERM HUP INT; echo TRAPS_INSTALLED; while true; do sleep 1; done'
    ])
    await startAndWaitFor(transport, 'TRAPS_INSTALLED')
    expect(transport.isRunning).toBe(true)

    transport.kill()
    // The regression: this used to report false the instant termination was
    // requested, so a replacement agy could be spawned against the same
    // native conversation while its predecessor was still alive.
    expect(transport.isRunning, 'kill() must not claim the process is gone').toBe(true)
    expect(await settled(transport.whenExited(), 600), 'whenExited() must not resolve on request alone').toBe(false)
    expect(transport.isRunning).toBe(true)

    transport.kill('SIGKILL')
    expect(await settled(transport.whenExited(), 4_000), 'SIGKILL must actually end it').toBe(true)
    expect(transport.isRunning).toBe(false)
  }, 20_000)

  it.runIf(unix)('resolves whenExited on a process that ends on its own', async () => {
    const transport = new AntigravityPtyTransport('/bin/sh', process.cwd(), ['-c', 'exit 0'])
    let exitCode: number | null = null
    transport.start(noopHandlers((code) => { exitCode = code }))

    expect(await settled(transport.whenExited(), 5_000)).toBe(true)
    expect(transport.isRunning).toBe(false)
    expect(exitCode).toBe(0)
  }, 20_000)

  it.runIf(unix)('honours a polite kill when the process does not ignore it', async () => {
    const transport = new AntigravityPtyTransport('/bin/sh', process.cwd(), ['-c', 'sleep 30'])
    transport.start(noopHandlers())
    transport.kill()
    expect(await settled(transport.whenExited(), 5_000)).toBe(true)
    expect(transport.isRunning).toBe(false)
  }, 20_000)

  it('resolves whenExited immediately for a transport that was never started', async () => {
    const transport = new AntigravityPtyTransport('/bin/sh', process.cwd(), ['-c', 'true'])
    transport.kill()
    expect(await settled(transport.whenExited(), 200)).toBe(true)
    expect(transport.isRunning).toBe(false)
  })
})
