// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { render, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Markdown } from '../../src/renderer/app/components/Markdown'
import { parseMarkdown } from '../../src/renderer/app/lib/markdown'

/** The exact shape that came back mangled in the running app. */
const TABLE = [
  '| Feature | JavaScript | TypeScript |',
  '|---------|------------|------------|',
  '| Typing | Dynamic | Static |',
  '| Compilation | Interpreted | Transpiled |'
].join('\n')

function rowsOf(container: HTMLElement): string[][] {
  return Array.from(container.querySelectorAll('tbody tr')).map((row) =>
    Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent ?? '')
  )
}

describe('a Markdown table parses as a table', () => {
  it('produces a table block rather than a paragraph', () => {
    const blocks = parseMarkdown(TABLE)

    // The bug: with no table rule, every line fell through to the paragraph
    // branch, which joins lines with a space — producing exactly
    // "Feature | JavaScript | TypeScript -----|-----".
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.type).toBe('table')
  })

  it('keeps the header cells separate', () => {
    const block = parseMarkdown(TABLE)[0]!
    expect(block.type === 'table' && block.header.map((cell) => cell.map((n) => n.value).join(''))).toEqual([
      'Feature',
      'JavaScript',
      'TypeScript'
    ])
  })

  it('never joins the separator row into the content', () => {
    const rendered = render(<Markdown source={TABLE} />)
    expect(rendered.container.textContent).not.toContain('---')
    expect(rendered.container.textContent).not.toContain('|')
  })

  it('accepts a table with no leading or trailing pipes', () => {
    const blocks = parseMarkdown('Feature | Value\n--- | ---\nSpeed | Fast')
    expect(blocks[0]!.type).toBe('table')
  })

  it('reads column alignment from the delimiter row', () => {
    const block = parseMarkdown('| a | b | c | d |\n|:--|:-:|--:|---|\n| 1 | 2 | 3 | 4 |')[0]!
    expect(block.type === 'table' && block.align).toEqual(['left', 'center', 'right', null])
  })

  it('does not turn ordinary prose containing a pipe into a table', () => {
    // A delimiter row is required, so a sentence with a pipe stays prose.
    const blocks = parseMarkdown('Use a | b to pipe one into the other.')
    expect(blocks[0]!.type).toBe('paragraph')
  })

  it('does not read a horizontal rule as a one-column table', () => {
    expect(parseMarkdown('above\n\n---\n\nbelow').map((block) => block.type)).toEqual([
      'paragraph',
      'rule',
      'paragraph'
    ])
  })

  it('keeps a literal escaped pipe inside a cell', () => {
    const block = parseMarkdown('| Op | Meaning |\n|---|---|\n| a \\| b | or |')[0]!
    expect(block.type === 'table' && block.rows[0]![0]!.map((n) => n.value).join('')).toBe('a | b')
  })

  it('starts a table that follows a sentence with no blank line between', () => {
    const blocks = parseMarkdown(`Here is the comparison:\n${TABLE}`)
    expect(blocks.map((block) => block.type)).toEqual(['paragraph', 'table'])
  })

  it('ends the table at the next blank line', () => {
    const blocks = parseMarkdown(`${TABLE}\n\nAfter the table.`)
    expect(blocks.map((block) => block.type)).toEqual(['table', 'paragraph'])
  })
})

describe('a Markdown table renders as a real table', () => {
  it('renders header and body cells into real table elements', () => {
    const { container } = render(<Markdown source={TABLE} />)

    const table = container.querySelector('table')
    expect(table).not.toBeNull()

    const headers = Array.from(table!.querySelectorAll('thead th')).map((cell) => cell.textContent)
    expect(headers).toEqual(['Feature', 'JavaScript', 'TypeScript'])
    expect(rowsOf(container)).toEqual([
      ['Typing', 'Dynamic', 'Static'],
      ['Compilation', 'Interpreted', 'Transpiled']
    ])
  })

  it('renders inline formatting inside cells', () => {
    const { container } = render(
      <Markdown source={'| Name | Note |\n|---|---|\n| **bold** | `code` |'} />
    )

    const row = container.querySelector('tbody tr')!
    expect(within(row as HTMLElement).getByText('bold').tagName).toBe('STRONG')
    expect(within(row as HTMLElement).getByText('code')).toHaveClass('inline-code')
  })

  it('puts the table in its own scroll container', () => {
    const { container } = render(<Markdown source={TABLE} />)

    // A <table> cannot scroll itself, so the wrapper is what keeps a wide
    // table from stretching the transcript.
    const wrapper = container.querySelector('.table-scroll')
    expect(wrapper).not.toBeNull()
    expect(wrapper!.querySelector('table')).not.toBeNull()
  })

  it('pads a short row rather than collapsing the grid', () => {
    const { container } = render(<Markdown source={'| a | b | c |\n|---|---|---|\n| 1 |'} />)
    expect(rowsOf(container)).toEqual([['1', '', '']])
  })

  it('keeps every cell of an over-long row rather than dropping content', () => {
    const { container } = render(<Markdown source={'| a | b |\n|---|---|\n| 1 | 2 | 3 |'} />)
    expect(rowsOf(container)).toEqual([['1', '2', '3']])
  })

  it('carries alignment onto the cells', () => {
    const { container } = render(<Markdown source={'| a | b |\n|:-:|--:|\n| 1 | 2 |'} />)

    const cells = container.querySelectorAll('tbody td')
    expect(cells[0]!.getAttribute('data-align')).toBe('center')
    expect(cells[1]!.getAttribute('data-align')).toBe('right')
  })
})

describe('the other Markdown a coding agent produces still renders', () => {
  it('renders headings, lists, quotes, code and emphasis alongside tables', () => {
    const source = [
      '## Heading',
      '',
      'A paragraph with `inline code`, **bold**, *italic* and [a link](https://example.com).',
      '',
      '- first',
      '- second',
      '',
      '1. one',
      '2. two',
      '',
      '> a quotation',
      '',
      '```ts',
      'const x = 1',
      '```',
      '',
      TABLE
    ].join('\n')

    const { container } = render(<Markdown source={source} />)

    expect(container.querySelector('h3')).not.toBeNull()
    expect(container.querySelectorAll('ul li')).toHaveLength(2)
    expect(container.querySelectorAll('ol li')).toHaveLength(2)
    expect(container.querySelector('blockquote')!.textContent).toBe('a quotation')
    expect(container.querySelector('.code-block code')!.textContent).toBe('const x = 1')
    expect(container.querySelector('.inline-code')!.textContent).toBe('inline code')
    expect(container.querySelector('strong')!.textContent).toBe('bold')
    expect(container.querySelector('em')!.textContent).toBe('italic')
    expect(container.querySelector('.prose-link')!.textContent).toBe('a link')
    expect(container.querySelector('table')).not.toBeNull()
  })
})

/** The width behaviour is CSS, which jsdom does not apply — so it is
 *  asserted against the stylesheet, the same way the message-action layout
 *  contract is. */
describe('a wide table cannot stretch the conversation', () => {
  const STYLES = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/styles.css'), 'utf8')

  function ruleFor(selector: string): string {
    const start = STYLES.indexOf(`${selector} {`)
    expect(start, `expected a rule for ${selector}`).toBeGreaterThan(-1)
    return STYLES.slice(start, STYLES.indexOf('}', start))
  }

  it('scrolls the wrapper rather than the table', () => {
    const rule = ruleFor('.table-scroll')
    expect(rule).toMatch(/max-width:\s*100%/)
    expect(rule).toMatch(/overflow-x:\s*auto/)
  })

  it('lets cells wrap instead of forcing the column open', () => {
    expect(ruleFor('.prose th,\n.prose td')).toMatch(/overflow-wrap:\s*break-word/)
  })

  it('sizes columns by their content so the wrapper has something to scroll', () => {
    // `width: 100%` alone let the browser squeeze every column down to fit
    // the bubble, so a wide table was never scrolled — it was crushed, and
    // short values wrapped one word per line. `max-content` is what makes
    // the wrapper's overflow-x mean anything.
    const rule = ruleFor('.prose table')
    expect(rule).toMatch(/width:\s*max-content/)
    expect(rule).toMatch(/min-width:\s*100%/)
  })

  it('caps a cell so one prose-heavy column cannot set the whole width', () => {
    expect(ruleFor('.prose th,\n.prose td')).toMatch(/max-width:\s*\d+ch/)
  })

  it('never forces a header to stay on one line', () => {
    // With content-sized columns a short header already never wraps, and
    // forcing it let one long header widen its column past the cell cap.
    expect(ruleFor('.prose thead th')).not.toMatch(/white-space:\s*nowrap/)
  })

  it('styles the table for the dark surface it renders on', () => {
    // Explicit colours from the theme's own tokens — never a browser
    // default that would render as black-on-dark.
    expect(ruleFor('.prose thead th')).toMatch(/color:\s*var\(--text-secondary\)/)
    expect(ruleFor('.table-scroll')).toMatch(/border:\s*1px solid var\(--border\)/)
  })
})
