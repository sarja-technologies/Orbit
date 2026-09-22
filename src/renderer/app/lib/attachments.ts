// The composer's attachment model. States describe user-visible outcomes
// only — how a file actually reaches Antigravity (native media vs. a
// workspace reference) is presented as an outcome, never as transport
// terminology.
import type { ID, ProjectFile } from '@shared/domain'

export type AttachmentState =
  /** Chosen locally, not sent yet. */
  | 'ready'
  /** Being handed to Antigravity as native media. */
  | 'attaching'
  /** Antigravity confirmed it received the media directly. */
  | 'attached'
  /** Antigravity gets a workspace reference instead of the media itself. */
  | 'reference'
  /** Genuinely failed to load or attach. */
  | 'failed'

export interface DraftAttachment {
  fileId: ID
  name: string
  mimeType: string | null
  byteSize: number
  /** data: URL for image thumbnails; null for non-image files. */
  thumbnail: string | null
  state: AttachmentState
  error: string | null
}

const NATIVE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const NATIVE_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp']
/** Mirrors the main process's own application policy. Kept in sync
 *  deliberately so the composer can explain the outcome before sending. */
export const MAX_NATIVE_IMAGE_BYTES = 15 * 1024 * 1024

/** True when this file can be delivered to Antigravity as real media.
 *  SVG is excluded on purpose: it cannot be rasterized for native
 *  delivery, so it is shared as a workspace reference instead. */
export function isNativeImage(file: { name: string; mimeType: string | null; byteSize: number }): boolean {
  if (file.byteSize > MAX_NATIVE_IMAGE_BYTES) return false
  if (file.mimeType === 'image/svg+xml') return false
  if (file.mimeType && NATIVE_IMAGE_TYPES.has(file.mimeType)) return true
  if (file.mimeType?.startsWith('image/')) return true
  const lower = file.name.toLowerCase()
  return NATIVE_IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

export function isImage(file: { name: string; mimeType: string | null }): boolean {
  if (file.mimeType?.startsWith('image/')) return true
  const lower = file.name.toLowerCase()
  return [...NATIVE_IMAGE_EXTENSIONS, '.svg'].some((extension) => lower.endsWith(extension))
}

export function draftFromProjectFile(file: ProjectFile, thumbnail: string | null = null): DraftAttachment {
  return {
    fileId: file.id,
    name: file.name,
    mimeType: file.mimeType,
    byteSize: file.byteSize,
    thumbnail,
    state: 'ready',
    error: null
  }
}

/** What a given attachment will become once the turn is delivered, given
 *  whether this machine can hand Antigravity real media at all. */
export function projectedState(file: DraftAttachment, nativeMediaAvailable: boolean): AttachmentState {
  if (file.state === 'failed') return 'failed'
  if (!isNativeImage(file)) return 'reference'
  return nativeMediaAvailable ? 'attaching' : 'reference'
}

export function stateLabel(state: AttachmentState): string {
  switch (state) {
    case 'ready':
      return 'Ready'
    case 'attaching':
      return 'Attaching…'
    case 'attached':
      return 'Attached'
    case 'reference':
      return 'Shared as reference'
    case 'failed':
      return 'Couldn’t attach'
  }
}

export function stateHint(state: AttachmentState): string | null {
  switch (state) {
    case 'reference':
      return 'Antigravity will use this file from the project workspace.'
    case 'attached':
      return 'Antigravity received this image directly.'
    case 'attaching':
      return 'Handing this image to Antigravity.'
    case 'failed':
      return 'This file couldn’t be attached. Retry, or remove it and send without it.'
    default:
      return null
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Clipboard payloads only become attachments when they are real images.
 *  Ordinary copied text must fall through to the textarea untouched. */
export function imageItemsFromClipboard(items: DataTransferItemList | null | undefined): DataTransferItem[] {
  if (!items) return []
  return Array.from(items).filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
}

/** What a paste into the composer should actually do.
 *
 *  The composer used to ask only "are there image items?" and, if so,
 *  swallow the paste with `preventDefault()`. That is wrong for a very
 *  ordinary clipboard: copying a table out of a spreadsheet, a block out of
 *  a PDF viewer, or formatted text out of almost any Mac app puts a
 *  *rendered image* on the clipboard alongside the text. The image branch
 *  won, the real text was silently dropped, and Cmd+V looked broken.
 *
 *  So the text wins whenever there is any. An image-only clipboard (a
 *  screenshot, an image copied from a page) still becomes an attachment,
 *  which is the case the branch was built for.
 */
export function pasteIntent(clipboard: DataTransfer | null | undefined): 'text' | 'attach-images' {
  if (!clipboard) return 'text'
  // `getData` is only readable synchronously inside the paste event, which
  // is exactly where this is called from.
  let text = ''
  try {
    text = clipboard.getData('text/plain') ?? ''
  } catch {
    text = ''
  }
  if (text.length > 0) return 'text'
  return imageItemsFromClipboard(clipboard.items).length > 0 ? 'attach-images' : 'text'
}
