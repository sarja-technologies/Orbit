/** Which native file picker the + menu opens.
 *
 *  The categories are Orbit's, but the filters are not invented: the image
 *  list is exactly what Orbit's own attachment pipeline treats as an image
 *  (see renderer/app/lib/attachments.ts), so the picker never advertises a
 *  type that would then fail to attach as one. Video has no native path
 *  through agy at all — a chosen video attaches as an ordinary file, which
 *  is honest and still useful — so the list is simply the common container
 *  formats a user would expect to see. */
export type AttachmentPickerCategory = 'image' | 'video' | 'files'

export const ATTACHMENT_PICKER_CATEGORIES: readonly AttachmentPickerCategory[] = ['image', 'video', 'files']

export interface PickerFilter {
  name: string
  /** Extensions without the dot, as Electron's dialog expects. */
  extensions: string[]
}

export const IMAGE_PICKER_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'] as const
export const VIDEO_PICKER_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm', 'mkv'] as const

/** The dialog filters for a category. `files` returns none, which is what
 *  makes it the ordinary unrestricted picker rather than a fourth list to
 *  keep in sync. */
export function pickerFilters(category: AttachmentPickerCategory): PickerFilter[] {
  if (category === 'image') return [{ name: 'Images', extensions: [...IMAGE_PICKER_EXTENSIONS] }]
  if (category === 'video') return [{ name: 'Video', extensions: [...VIDEO_PICKER_EXTENSIONS] }]
  return []
}

/** What the native dialog is titled, so the window says which of the three
 *  the user picked. */
export function pickerTitle(category: AttachmentPickerCategory): string {
  if (category === 'image') return 'Add images'
  if (category === 'video') return 'Add video'
  return 'Add files'
}

export function isAttachmentPickerCategory(value: unknown): value is AttachmentPickerCategory {
  return value === 'image' || value === 'video' || value === 'files'
}
