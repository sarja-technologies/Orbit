// Orbit's application menu.
//
// Orbit deliberately has no File/View/Help strip: every action it offers
// lives in its own UI. That was originally implemented as
// `Menu.setApplicationMenu(null)` on every platform, on the reasoning that
// "the menu's accelerators are conveniences, not capabilities".
//
// That reasoning is false on macOS, and it cost the app Cmd+V.
//
// On macOS the standard editing shortcuts are not implemented by Chromium's
// input handling — they are NSMenu key equivalents. AppKit resolves a
// key-down against the application's menu BEFORE the event ever reaches the
// web contents, and Electron's `role: 'paste'` items are what wire those
// equivalents to the focused editable element. With no application menu
// there are no key equivalents, so Cmd+V/C/X/A/Z do nothing at all in a
// textarea: no `paste` event, no `beforeinput`, nothing for the renderer to
// see or to have swallowed. The composer's own handlers were never
// involved.
//
// On Windows and Linux the same shortcuts are handled natively by Chromium
// inside editable fields whether or not a menu exists, and the in-window
// menu strip is exactly what the original decision wanted gone. So that
// platform keeps no menu, and macOS gets the smallest menu that restores
// real editing: the application menu macOS requires as the first item, and
// Edit.
//
// Every item here is a `role`. Roles are Electron's own native
// implementations — no custom clipboard handling, no `webContents.paste()`
// wrappers, nothing that could diverge from what the OS does. They also act
// on whatever is focused, so they are inert unless a real editable element
// or selection has focus, which is what keeps them from consuming
// shortcuts the app wants for itself.
import type { MenuItemConstructorOptions } from 'electron'

/** The Edit menu. This is the whole fix: these six roles are what give
 *  macOS its key equivalents for the standard editing shortcuts. */
export function editMenuTemplate(): MenuItemConstructorOptions {
  return {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      // Lets a paste into the composer land as plain text when the source
      // carried formatting, which is what a prompt field actually wants.
      { role: 'pasteAndMatchStyle' },
      { role: 'selectAll' }
    ]
  }
}

/** The application menu for a platform, or `null` to have none at all.
 *
 *  Pure and platform-parameterized so the contract can be asserted without
 *  constructing a real `Menu` — the `electron` import above is types only
 *  and is erased at compile time.
 */
export function applicationMenuTemplate(
  platform: NodeJS.Platform,
  appName: string
): MenuItemConstructorOptions[] | null {
  // Chromium already handles Ctrl+C/V/X/A/Z natively in editable fields
  // here, so a menu would buy nothing and would draw a strip inside the
  // window — the thing Orbit removed it to avoid.
  if (platform !== 'darwin') return null

  return [
    // macOS puts the first submenu in the bold application slot and expects
    // it to carry these roles; omitting it would leave the app with no Quit
    // and no Hide.
    {
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    editMenuTemplate(),
    // Cmd+W / Cmd+M are standard macOS window management that users will
    // reach for regardless of whether Orbit draws them.
    {
      label: 'Window',
      role: 'windowMenu'
    }
  ]
}
