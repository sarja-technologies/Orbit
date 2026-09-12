import { memo, useMemo, useState } from 'react'
import { parseMarkdown, type Block, type ColumnAlign, type Inline } from '../lib/markdown'
import { requireOrbitApi } from '../orbitApi'

/** Renders parsed Markdown as React elements. Model output never becomes
 *  raw HTML — see lib/markdown.ts for why. */
function MarkdownView({ source }: { source: string }): JSX.Element {
  const blocks = useMemo(() => parseMarkdown(source), [source])
  return (
    <div className="prose">
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} />
      ))}
    </div>
  )
}

function BlockView({ block }: { block: Block }): JSX.Element | null {
  switch (block.type) {
    case 'paragraph':
      return (
        <p>
          <InlineList nodes={block.content} />
        </p>
      )
    case 'heading': {
      const Tag = `h${Math.min(block.level + 1, 6)}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      return (
        <Tag>
          <InlineList nodes={block.content} />
        </Tag>
      )
    }
    case 'code':
      return <CodeBlock language={block.language} value={block.value} />
    case 'list':
      return block.ordered ? (
        <ol>
          {block.items.map((item, index) => (
            <li key={index}>
              <InlineList nodes={item} />
            </li>
          ))}
        </ol>
      ) : (
        <ul>
          {block.items.map((item, index) => (
            <li key={index}>
              <InlineList nodes={item} />
            </li>
          ))}
        </ul>
      )
    case 'quote':
      return (
        <blockquote>
          <InlineList nodes={block.content} />
        </blockquote>
      )
    case 'table':
      return <TableBlock block={block} />
    case 'rule':
      return <hr />
    default:
      return null
  }
}

/** A GFM table.
 *
 *  Wrapped in its own scroll container rather than allowed to stretch the
 *  bubble: a table wider than the message measure scrolls sideways inside
 *  its own box, so the transcript's column never moves. Cells are padded to
 *  the header's width so a short row cannot collapse the grid, and a row
 *  with extra cells keeps them rather than silently losing data. */
function TableBlock({ block }: { block: Extract<Block, { type: 'table' }> }): JSX.Element {
  const columns = block.header.length

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {block.header.map((cell, index) => (
              <th key={index} {...alignProps(block.align[index])}>
                <InlineList nodes={cell} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {padCells(row, columns).map((cell, index) => (
                <td key={index} {...alignProps(block.align[index])}>
                  {cell ? <InlineList nodes={cell} /> : null}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Alignment travels as a data attribute so the stylesheet owns the actual
 *  text-align, and an unspecified column is left alone entirely. */
function alignProps(align: ColumnAlign | undefined): { 'data-align'?: string } {
  return align ? { 'data-align': align } : {}
}

/** A row shorter than the header gets empty cells; a longer one keeps every
 *  cell it has. Never truncates — a dropped cell would be lost content. */
function padCells(row: Inline[][], columns: number): (Inline[] | null)[] {
  if (row.length >= columns) return row
  return [...row, ...Array.from({ length: columns - row.length }, () => null)]
}

function InlineList({ nodes }: { nodes: Inline[] }): JSX.Element {
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.type) {
          case 'strong':
            return <strong key={index}>{node.value}</strong>
          case 'emphasis':
            return <em key={index}>{node.value}</em>
          case 'code':
            return (
              <code key={index} className="inline-code">
                {node.value}
              </code>
            )
          case 'link':
            // Rendered as styled text carrying its destination, not a live
            // navigation target — model output should not be able to
            // navigate the app or open arbitrary URLs on click.
            return (
              <span key={index} className="prose-link" title={node.href}>
                {node.value}
              </span>
            )
          default:
            return <span key={index}>{node.value}</span>
        }
      })}
    </>
  )
}

function CodeBlock({ language, value }: { language: string | null; value: string }): JSX.Element {
  const [copied, setCopied] = useState(false)

  // Orbit's own clipboard IPC, for the same reason MessageActions uses it:
  // a packaged Orbit loads over file://, which is not a secure context, so
  // `navigator.clipboard` is undefined there. This button worked in
  // development and did nothing at all in the real app.
  const copy = (): void => {
    void requireOrbitApi()
      .clipboard.writeText(value)
      .then((written) => {
        if (!written) return
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      })
      .catch(() => setCopied(false))
  }

  return (
    <figure className="code-block">
      <div className="code-block-bar">
        <span className="code-block-language">{language ?? 'code'}</span>
        <button type="button" className="code-copy" onClick={copy} aria-label={copied ? 'Copied' : 'Copy code'}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>{value}</code>
      </pre>
    </figure>
  )
}

export const Markdown = memo(MarkdownView)
