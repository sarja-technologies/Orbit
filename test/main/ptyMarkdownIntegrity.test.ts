// Case B of the table investigation: does the PTY transport corrupt
// structured text on its way from agy's screen into a stored message?
//
// The reported symptom turned out to be Case A — the renderer had no table
// parser at all (see test/renderer/markdownTables.test.tsx). These tests
// pin the transport's side of the contract so a future change cannot
// quietly introduce a Case B: the screen reader must preserve a table's
// line structure and its pipes exactly, and the terminal it reads must be a
// fixed size that owes nothing to Orbit's window.
import { describe, expect, it } from 'vitest'
import { extractResponseText } from '../../src/main/terminal/TerminalInteractionDetector'
import { TerminalScreenBuffer } from '../../src/main/terminal/TerminalScreenBuffer'

const TABLE_LINES = [
  '| Feature | JavaScript | TypeScript |',
  '|---------|------------|------------|',
  '| Typing | Dynamic | Static |',
  '| Compilation | Interpreted | Transpiled |'
]

/** A realistic agy screen: the prompt echo, the response indented to agy's
 *  own two-column content indent, then its compose box and footer. */
function screenWith(body: string[]): string[] {
  const rule = '─'.repeat(120)
  return ['> Compare JavaScript and TypeScript', '', ...body.map((line) => `  ${line}`), '', rule, '>', rule, '? for shortcuts']
}

describe('the screen reader preserves a Markdown table', () => {
  const extracted = extractResponseText(screenWith(TABLE_LINES))

  it('keeps every row on its own line', () => {
    expect(extracted.split('\n')).toEqual(TABLE_LINES)
  })

  it('does not join rows with spaces the way a paragraph would', () => {
    expect(extracted).not.toContain('| TypeScript | |---')
  })

  it('keeps the delimiter row intact', () => {
    expect(extracted).toContain('|---------|------------|------------|')
  })

  it('removes only agy’s own content indent, not the table', () => {
    // dedent() strips the two columns agy indents content by. A table row
    // must come back flush left, exactly as the model wrote it.
    expect(extracted.startsWith('| Feature |')).toBe(true)
  })

  it('does not mistake a delimiter row for agy’s box rule', () => {
    // agy's rules are box-drawing U+2500; a Markdown delimiter is ASCII
    // hyphens. Confusing the two would delete the row that makes it a table.
    expect(extracted).toContain('|---------|')
  })

  it('survives a table surrounded by prose', () => {
    const text = extractResponseText(screenWith(['Here is the comparison:', '', ...TABLE_LINES, '', 'Both compile to JavaScript.']))

    expect(text.split('\n')).toEqual([
      'Here is the comparison:',
      '',
      ...TABLE_LINES,
      '',
      'Both compile to JavaScript.'
    ])
  })
})

/** xterm parses asynchronously, so the screen is only readable once the
 *  write it was handed has actually been applied. */
async function linesAfterWriting(chunk: string): Promise<string[]> {
  const screen = new TerminalScreenBuffer()
  await new Promise<void>((resolve) => screen.write(chunk, resolve))
  const lines = screen.peekLines()
  screen.dispose()
  return lines
}

describe('the terminal Orbit reads is a fixed size', () => {
  it('defaults to the documented 120x32 regardless of any window', async () => {
    // The whole point: the PTY's width is a constant of the transport, not
    // a function of Orbit's window. Resizing the app cannot re-wrap — and
    // so cannot alter — the text stored for an assistant turn.
    expect(await linesAfterWriting('x'.repeat(119))).toEqual(['x'.repeat(119)])
  })

  it('wraps only at its own fixed width, not at any narrower one', async () => {
    const lines = await linesAfterWriting('y'.repeat(130))

    expect(lines[0]).toHaveLength(120)
    expect(lines[1]).toBe('y'.repeat(10))
  })

  it('keeps a full-width table row on one line', async () => {
    const row = `| ${'a'.repeat(50)} | ${'b'.repeat(50)} |`
    expect(row.length).toBeLessThanOrEqual(120)

    expect(await linesAfterWriting(row)).toEqual([row])
  })
})
