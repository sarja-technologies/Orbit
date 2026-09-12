import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  IMAGE_PICKER_EXTENSIONS,
  VIDEO_PICKER_EXTENSIONS,
  isAttachmentPickerCategory,
  pickerFilters,
  pickerTitle
} from '../../src/shared/attachmentPicker'

describe('the native picker each + category opens', () => {
  it('filters the image picker to the types Orbit really attaches as images', () => {
    const filters = pickerFilters('image')

    expect(filters).toHaveLength(1)
    expect(filters[0]!.extensions).toEqual(['png', 'jpg', 'jpeg', 'gif', 'webp'])
  })

  it('advertises no image type the attachment pipeline would not treat as one', () => {
    // The picker must not offer a type that then attaches as a plain file.
    const recognized = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/app/lib/attachments.ts'), 'utf8')
    for (const extension of IMAGE_PICKER_EXTENSIONS) {
      expect(recognized, `attachments.ts should recognize .${extension}`).toContain(extension)
    }
  })

  it('filters the video picker to the common container formats', () => {
    const filters = pickerFilters('video')

    expect(filters).toHaveLength(1)
    expect(filters[0]!.extensions).toEqual(['mp4', 'mov', 'm4v', 'webm', 'mkv'])
    expect(VIDEO_PICKER_EXTENSIONS).toContain('mp4')
  })

  it('leaves the Files picker unrestricted', () => {
    // No filters at all — the ordinary browse, not a fourth list to keep
    // in sync with the other two.
    expect(pickerFilters('files')).toEqual([])
  })

  it('titles each dialog after the category that opened it', () => {
    expect(pickerTitle('image')).toBe('Add images')
    expect(pickerTitle('video')).toBe('Add video')
    expect(pickerTitle('files')).toBe('Add files')
  })

  it('recognizes only the three real categories', () => {
    expect(isAttachmentPickerCategory('image')).toBe(true)
    expect(isAttachmentPickerCategory('video')).toBe(true)
    expect(isAttachmentPickerCategory('files')).toBe(true)
    expect(isAttachmentPickerCategory('folder')).toBe(false)
    expect(isAttachmentPickerCategory(null)).toBe(false)
  })
})

describe('Orbit’s window chrome', () => {
  const mainSource = fs.readFileSync(path.resolve(__dirname, '../../src/main/index.ts'), 'utf8')

  it('sets the application menu from Orbit’s own template, before the window exists', () => {
    // This used to assert `Menu.setApplicationMenu(null)` on every
    // platform. That removed Electron's File/Edit/View/Window/Help strip —
    // and on macOS it also removed the NSMenu key equivalents that ARE the
    // standard editing shortcuts, so Cmd+V stopped working entirely. The
    // menu is now per-platform (see app/appMenu.ts and appMenu.test.ts):
    // null on Windows and Linux, and the minimum macOS needs.
    expect(mainSource).toMatch(/Menu\.setApplicationMenu\(menuTemplate \? Menu\.buildFromTemplate\(menuTemplate\) : null\)/)
    expect(mainSource).toMatch(/applicationMenuTemplate\(process\.platform, app\.name\)/)
    // Still before the window is created, so a menu never paints once and
    // changes afterwards.
    expect(mainSource.indexOf('Menu.setApplicationMenu(')).toBeLessThan(mainSource.indexOf('createMainWindow()'))
  })

  it('still offers no File, View or Help strip of its own', () => {
    const menu = fs.readFileSync(path.resolve(__dirname, '../../src/main/app/appMenu.ts'), 'utf8')

    // The original intent is intact: Orbit's actions live in Orbit's UI.
    expect(menu).not.toMatch(/label:\s*'File'/)
    expect(menu).not.toMatch(/label:\s*'View'/)
    expect(menu).not.toMatch(/label:\s*'Help'/)
  })

  it('does not weaken the renderer’s sandbox to do it', () => {
    const security = fs.readFileSync(path.resolve(__dirname, '../../src/main/app/security.ts'), 'utf8')

    expect(security).toMatch(/contextIsolation:\s*true/)
    expect(security).toMatch(/nodeIntegration:\s*false/)
    expect(security).toMatch(/sandbox:\s*true/)
  })
})
