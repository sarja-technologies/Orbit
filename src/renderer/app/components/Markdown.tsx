import { memo, useMemo, useState } from 'react'
import { parseMarkdown, type Block, type Inline } from '../lib/markdown'

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
    case 'rule':
      return <hr />
    default:
      return null
  }
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

  const copy = (): void => {
    void navigator.clipboard
      .writeText(value)
      .then(() => {
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
