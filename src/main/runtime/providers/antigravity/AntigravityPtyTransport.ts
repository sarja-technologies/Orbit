// Minimal Orbit-owned persistent PTY transport. This intentionally owns no
// renderer concerns: it emits normalized observations to AntigravityProvider.
import * as pty from 'node-pty'

export interface PtyInteraction {
  prompt: string
  options: Array<{ id: string; label: string }>
}

export class AntigravityPtyTransport {
  private proc: pty.IPty | null = null
  private screen = ''
  private pending: PtyInteraction | null = null
  private running = false
  constructor(private readonly executable: string, private readonly cwd: string, private readonly args: string[]) {}

  start(onData: (text: string) => void, onInteraction: (interaction: PtyInteraction) => void, onExit: (code: number, signal?: number) => void): void {
    this.proc = pty.spawn(this.executable, this.args, { name: 'xterm-256color', cols: 120, rows: 32, cwd: this.cwd, env: process.env, useConpty: true })
    this.running = true
    this.proc.onData((chunk) => {
      const clean = stripAnsi(chunk)
      this.screen = `${this.screen}${clean}`.slice(-12_000)
      onData(clean)
      const interaction = parseInteraction(this.screen)
      if (interaction && !this.pending) { this.pending = interaction; onInteraction(interaction) }
    })
    this.proc.onExit(({ exitCode, signal }) => { this.running = false; onExit(exitCode, signal) })
  }
  get isRunning(): boolean { return this.running }
  sendPrompt(prompt: string): void { this.write(`${prompt}\r`) }
  respond(option: string): boolean { if (!this.pending || !this.running) return false; this.pending = null; this.write(`${option}\r`); return true }
  cancelTurn(): void { this.write('\x1b') }
  kill(): void { this.proc?.kill(); this.running = false }
  resize(cols: number, rows: number): void { try { this.proc?.resize(cols, rows) } catch { /* process may be exiting */ } }
  private write(value: string): void { if (this.running) this.proc?.write(value) }
}

function stripAnsi(value: string): string { return value.replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|.)/g, '') }

// Native agy prompt screens have been observed as `Requesting permission for:`
// followed by `Do you want to proceed?` and numbered/lettered options.
function parseInteraction(screen: string): PtyInteraction | null {
  const start = screen.lastIndexOf('Requesting permission')
  const question = screen.lastIndexOf('Do you want to proceed?')
  if (start < 0 || question < start) return null
  const block = screen.slice(start)
  const options = [...block.matchAll(/(?:^|\n)\s*(?:([0-9]+)|([yn]))[.)]?\s+([^\n]+)/gim)].map((match) => ({ id: match[1] ?? match[2] ?? '', label: match[3]!.trim() })).filter((option) => option.id)
  return { prompt: block.slice(0, Math.min(block.length, 4000)), options }
}
