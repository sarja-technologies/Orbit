// Reconstructs the terminal's actual visible screen from raw PTY bytes,
// instead of regexing raw chunks. `agy`'s interactive TUI redraws lines,
// erases text, moves the cursor, and animates spinners — a real VT parser
// is the only reliable way to know "what does the screen show right now".
// Adapted from AgentDock Pro's proven TerminalScreenBuffer (same approach,
// same @xterm/headless engine), trimmed to what Orbit's PTY transport needs.
import { Terminal } from '@xterm/headless'

export interface ScreenSnapshot {
  /** Visible rows as plain text, trailing blank rows trimmed. */
  lines: string[]
  /** Absolute row index into `lines` (not viewport-relative). */
  cursorRow: number
  cursorCol: number
  /** Raw bytes written since the previous snapshot (diagnostics only). */
  raw: string
}

export class TerminalScreenBuffer {
  private readonly term: Terminal
  private rawSinceSnapshot = ''

  constructor(cols = 120, rows = 32) {
    this.term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 2000 })
  }

  write(chunk: string): void {
    this.rawSinceSnapshot += chunk
    this.term.write(chunk)
  }

  resize(cols: number, rows: number): void {
    try {
      this.term.resize(cols, rows)
    } catch {
      // resize can race a still-initializing buffer; safe to ignore
    }
  }

  /** Reads the current stable state. Only meaningful once the writer has
   *  been idle long enough for xterm's internal write queue to drain (the
   *  idle debounce in the PTY transport guarantees this). */
  snapshot(): ScreenSnapshot {
    const buf = this.term.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i)
      if (line) lines.push(line.translateToString(true))
    }
    while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop()

    const cursorCol = buf.cursorX
    const cursorRow = buf.baseY + buf.cursorY

    const raw = this.rawSinceSnapshot
    this.rawSinceSnapshot = ''
    return { lines, cursorRow, cursorCol, raw }
  }

  dispose(): void {
    this.term.dispose()
  }
}
