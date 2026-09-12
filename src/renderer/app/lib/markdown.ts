// A deliberately small Markdown parser covering what a coding agent
// actually produces: headings, fenced code, lists, blockquotes, rules,
// paragraphs, and inline emphasis/code/links.
//
// It produces a typed AST that the renderer turns into React elements —
// never an HTML string. Model output is untrusted input, so there is no
// `dangerouslySetInnerHTML` anywhere in this path, and no HTML parsing to
// be tricked by. This is also why a full CommonMark dependency was not
// pulled in: the surface we need is small, and keeping it in-repo keeps
// the escaping guarantees obvious.

export type Inline =
  | { type: 'text'; value: string }
  | { type: 'strong'; value: string }
  | { type: 'emphasis'; value: string }
  | { type: 'code'; value: string }
  | { type: 'link'; value: string; href: string }

/** Per-column alignment, from the colons in a GFM delimiter row. `null` is
 *  the default (no colon on either side) — left, but recorded as "not
 *  specified" rather than asserted. */
export type ColumnAlign = 'left' | 'center' | 'right' | null

export type Block =
  | { type: 'paragraph'; content: Inline[] }
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; content: Inline[] }
  | { type: 'code'; language: string | null; value: string }
  | { type: 'list'; ordered: boolean; items: Inline[][] }
  | { type: 'quote'; content: Inline[] }
  | { type: 'table'; align: ColumnAlign[]; header: Inline[][]; rows: Inline[][][] }
  | { type: 'rule' }

const FENCE = /^\s*```(.*)$/
const HEADING = /^(#{1,6})\s+(.*)$/
const UNORDERED = /^\s*[-*+]\s+(.*)$/
const ORDERED = /^\s*\d{1,3}[.)]\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/
const RULE = /^\s*(?:---+|\*\*\*+|___+)\s*$/

/** One cell of a GFM delimiter row: dashes, optionally colon-anchored. */
const DELIMITER_CELL = /^:?-+:?$/

/** Splits one table row into its cells.
 *
 *  A leading and trailing pipe are optional in GFM, so they are stripped
 *  rather than required. `\|` is a literal pipe inside a cell and must not
 *  split it — which is the only reason this cannot be `line.split('|')`. */
function splitRow(line: string): string[] {
  const cells: string[] = []
  let current = ''
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!
    if (char === '\\' && line[i + 1] === '|') {
      current += '|'
      i++
      continue
    }
    if (char === '|') {
      cells.push(current)
      current = ''
      continue
    }
    current += char
  }
  cells.push(current)
  // Drop the empty cells a leading/trailing pipe produces — but only those,
  // so a genuinely empty interior cell survives.
  if (cells.length > 0 && cells[0]!.trim() === '' && line.trimStart().startsWith('|')) cells.shift()
  if (cells.length > 0 && cells[cells.length - 1]!.trim() === '' && line.trimEnd().endsWith('|')) cells.pop()
  return cells.map((cell) => cell.trim())
}

/** The alignments a delimiter row specifies, or null when this line is not
 *  a delimiter row at all.
 *
 *  Deliberately strict: every cell must be a dash run. Without that, an
 *  ordinary sentence containing a pipe and a dash could open a table. */
function delimiterAlignments(line: string): ColumnAlign[] | null {
  if (!line.includes('-')) return null
  const cells = splitRow(line)
  if (cells.length === 0) return null
  if (!cells.every((cell) => DELIMITER_CELL.test(cell))) return null
  return cells.map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return null
  })
}

/** Whether a table genuinely starts at `index`.
 *
 *  GFM requires a header row followed immediately by a delimiter row. Both
 *  conditions are required here, which is what stops prose that happens to
 *  contain a pipe from being read as a table. */
function tableStartsAt(lines: string[], index: number): boolean {
  const header = lines[index]
  const delimiter = lines[index + 1]
  if (header === undefined || delimiter === undefined) return false
  if (!header.includes('|')) return false
  if (delimiterAlignments(delimiter) === null) return false
  return splitRow(header).length > 0
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]!

    if (line.trim() === '') {
      index++
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const language = fence[1]!.trim() || null
      const body: string[] = []
      index++
      while (index < lines.length && !FENCE.test(lines[index]!)) {
        body.push(lines[index]!)
        index++
      }
      index++ // consume the closing fence (tolerates an unclosed one at EOF)
      blocks.push({ type: 'code', language, value: body.join('\n') })
      continue
    }

    // Before RULE: a delimiter row of bare dashes (`---|---`) contains a
    // dash run, and a single-column one would otherwise be eaten as a
    // horizontal rule before the table it belongs to is ever recognized.
    if (tableStartsAt(lines, index)) {
      const align = delimiterAlignments(lines[index + 1]!)!
      const header = splitRow(lines[index]!).map(parseInline)
      const rows: Inline[][][] = []
      index += 2
      // A table runs until the first line that is not a row of it. A blank
      // line, a heading, a fence or a list all end it, the same way they
      // end a paragraph.
      while (index < lines.length) {
        const candidate = lines[index]!
        if (candidate.trim() === '' || !candidate.includes('|')) break
        if (FENCE.test(candidate) || HEADING.test(candidate) || QUOTE.test(candidate)) break
        rows.push(splitRow(candidate).map(parseInline))
        index++
      }
      blocks.push({ type: 'table', align, header, rows })
      continue
    }

    if (RULE.test(line)) {
      blocks.push({ type: 'rule' })
      index++
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6,
        content: parseInline(heading[2]!)
      })
      index++
      continue
    }

    if (UNORDERED.test(line) || ORDERED.test(line)) {
      const ordered = !UNORDERED.test(line)
      const items: Inline[][] = []
      while (index < lines.length) {
        const candidate = lines[index]!
        const match = ordered ? ORDERED.exec(candidate) : UNORDERED.exec(candidate)
        if (!match) break
        // Only stay in this list while the marker style keeps matching.
        if (ordered ? UNORDERED.test(candidate) : ORDERED.test(candidate)) break
        items.push(parseInline(match[1]!))
        index++
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }

    const quote = QUOTE.exec(line)
    if (quote) {
      const body: string[] = [quote[1]!]
      index++
      while (index < lines.length) {
        const next = QUOTE.exec(lines[index]!)
        if (!next) break
        body.push(next[1]!)
        index++
      }
      blocks.push({ type: 'quote', content: parseInline(body.join(' ').trim()) })
      continue
    }

    // Paragraph: consume until a blank line or the start of another block.
    const paragraph: string[] = []
    while (index < lines.length) {
      const candidate = lines[index]!
      if (
        candidate.trim() === '' ||
        FENCE.test(candidate) ||
        HEADING.test(candidate) ||
        UNORDERED.test(candidate) ||
        ORDERED.test(candidate) ||
        QUOTE.test(candidate) ||
        RULE.test(candidate) ||
        // A table needs no blank line before it. Without this, a table
        // introduced by a sentence was swallowed into that sentence's
        // paragraph and its rows joined with spaces — which is exactly how
        // "Feature | JavaScript | TypeScript -----|-----" was produced.
        tableStartsAt(lines, index)
      ) {
        break
      }
      paragraph.push(candidate.trim())
      index++
    }
    if (paragraph.length > 0) blocks.push({ type: 'paragraph', content: parseInline(paragraph.join(' ')) })
  }

  return blocks
}

// Inline code first so emphasis markers inside a code span stay literal.
const INLINE_PATTERN = /(`+)([\s\S]*?)\1|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\n]+?)\*|_([^_\n]+?)_/

export function parseInline(source: string): Inline[] {
  const nodes: Inline[] = []
  let rest = source

  while (rest.length > 0) {
    const match = INLINE_PATTERN.exec(rest)
    if (!match || match.index === undefined) break

    if (match.index > 0) nodes.push({ type: 'text', value: rest.slice(0, match.index) })

    if (match[2] !== undefined) nodes.push({ type: 'code', value: match[2].trim() })
    else if (match[3] !== undefined && match[4] !== undefined) nodes.push({ type: 'link', value: match[3], href: match[4] })
    else if (match[5] !== undefined) nodes.push({ type: 'strong', value: match[5] })
    else if (match[6] !== undefined) nodes.push({ type: 'strong', value: match[6] })
    else if (match[7] !== undefined) nodes.push({ type: 'emphasis', value: match[7] })
    else if (match[8] !== undefined) nodes.push({ type: 'emphasis', value: match[8] })

    rest = rest.slice(match.index + match[0].length)
  }

  if (rest.length > 0) nodes.push({ type: 'text', value: rest })
  return nodes.length > 0 ? nodes : [{ type: 'text', value: source }]
}
