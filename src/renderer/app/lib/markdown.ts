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

export type Block =
  | { type: 'paragraph'; content: Inline[] }
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; content: Inline[] }
  | { type: 'code'; language: string | null; value: string }
  | { type: 'list'; ordered: boolean; items: Inline[][] }
  | { type: 'quote'; content: Inline[] }
  | { type: 'rule' }

const FENCE = /^\s*```(.*)$/
const HEADING = /^(#{1,6})\s+(.*)$/
const UNORDERED = /^\s*[-*+]\s+(.*)$/
const ORDERED = /^\s*\d{1,3}[.)]\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/
const RULE = /^\s*(?:---+|\*\*\*+|___+)\s*$/

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
        RULE.test(candidate)
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
