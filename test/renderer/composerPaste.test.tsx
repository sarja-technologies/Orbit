// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { pasteIntent } from '../../src/renderer/app/lib/attachments'

/** A DataTransfer stand-in shaped exactly like the one a paste event
 *  carries: `getData` for the flavours, `items` for the files. jsdom does
 *  not build real ones, and the real bug lived in how the two disagree. */
function clipboard(options: { text?: string; items?: { kind: string; type: string }[] }): DataTransfer {
  return {
    getData: (type: string) => (type === 'text/plain' ? (options.text ?? '') : ''),
    items: (options.items ?? []) as unknown as DataTransferItemList
  } as unknown as DataTransfer
}

describe('pasting into the composer', () => {
  it('pastes text as text', () => {
    expect(pasteIntent(clipboard({ text: 'hello' }))).toBe('text')
  })

  it('attaches an image-only clipboard', () => {
    // A screenshot: one file flavour, no text at all.
    expect(pasteIntent(clipboard({ items: [{ kind: 'file', type: 'image/png' }] }))).toBe('attach-images')
  })

  it('pastes the text when the clipboard carries text AND a rendered image', () => {
    // THE BUG. Copying a table out of a spreadsheet, a block out of a PDF
    // viewer, or formatted text out of most Mac apps puts a rendered image
    // on the clipboard beside the text. The composer saw the image, called
    // preventDefault(), and the user's actual text vanished — Cmd+V simply
    // looked broken.
    const both = clipboard({
      text: '| Feature | Value |\n| --- | --- |\n| Speed | Fast |',
      items: [
        { kind: 'string', type: 'text/plain' },
        { kind: 'file', type: 'image/png' }
      ]
    })
    expect(pasteIntent(both)).toBe('text')
  })

  it('pastes as text when the clipboard holds neither text nor an image', () => {
    expect(pasteIntent(clipboard({ items: [{ kind: 'file', type: 'application/pdf' }] }))).toBe('text')
  })

  it('pastes as text when there is no clipboard at all', () => {
    expect(pasteIntent(null)).toBe('text')
    expect(pasteIntent(undefined)).toBe('text')
  })

  it('still pastes as text when reading the clipboard throws', () => {
    // Never swallow the paste on the strength of an unreadable clipboard:
    // letting the browser handle it is always the recoverable outcome.
    const hostile = {
      getData: vi.fn(() => {
        throw new Error('blocked')
      }),
      items: [] as unknown as DataTransferItemList
    } as unknown as DataTransfer
    expect(pasteIntent(hostile)).toBe('text')
  })
})
