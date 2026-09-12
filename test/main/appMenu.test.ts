import { describe, expect, it } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { applicationMenuTemplate, editMenuTemplate } from '../../src/main/app/appMenu'

/** The roles that carry the standard editing shortcuts. On macOS these are
 *  the ONLY thing that binds Cmd+V/C/X/A/Z to the focused editable element
 *  — Chromium does not implement them itself there. */
const REQUIRED_EDIT_ROLES = ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'] as const

function submenuOf(item: MenuItemConstructorOptions): MenuItemConstructorOptions[] {
  expect(Array.isArray(item.submenu), `expected ${String(item.label)} to have a submenu`).toBe(true)
  return item.submenu as MenuItemConstructorOptions[]
}

function rolesIn(item: MenuItemConstructorOptions): string[] {
  return submenuOf(item)
    .map((entry) => entry.role)
    .filter((role): role is NonNullable<MenuItemConstructorOptions['role']> => role !== undefined)
}

describe('the Edit menu is what restores standard editing shortcuts', () => {
  it('declares every standard editing role', () => {
    const roles = rolesIn(editMenuTemplate())

    // The regression: with no application menu at all, macOS had no key
    // equivalent for any of these, so Cmd+V never produced a paste event.
    for (const role of REQUIRED_EDIT_ROLES) {
      expect(roles, `expected an Edit item with role "${role}"`).toContain(role)
    }
  })

  it('uses native roles rather than custom clipboard handlers', () => {
    // Every real item is a role — no click handler reimplementing the
    // clipboard, which is what would be able to diverge from the OS.
    for (const entry of submenuOf(editMenuTemplate())) {
      if (entry.type === 'separator') continue
      expect(entry.role, `expected a role, got ${JSON.stringify(entry)}`).toBeTypeOf('string')
      expect(entry.click).toBeUndefined()
      // Roles supply their own platform-correct accelerator: Cmd on macOS,
      // Ctrl elsewhere. Hard-coding one would break the other platform.
      expect(entry.accelerator).toBeUndefined()
    }
  })

  it('is labelled Edit, where macOS expects to find these', () => {
    expect(editMenuTemplate().label).toBe('Edit')
  })
})

describe('the application menu per platform', () => {
  it('gives macOS a menu carrying the Edit roles', () => {
    const template = applicationMenuTemplate('darwin', 'Orbit')

    expect(template).not.toBeNull()
    const edit = template!.find((item) => item.label === 'Edit')
    expect(edit, 'expected macOS to get an Edit menu').toBeDefined()
    for (const role of REQUIRED_EDIT_ROLES) {
      expect(rolesIn(edit!)).toContain(role)
    }
  })

  it('puts the application menu first, as macOS requires', () => {
    const template = applicationMenuTemplate('darwin', 'Orbit')!

    expect(template[0]!.label).toBe('Orbit')
    // Without these the app would have no Quit and no Hide at all.
    expect(rolesIn(template[0]!)).toEqual(expect.arrayContaining(['about', 'hide', 'quit']))
  })

  it('names the application menu after the real app', () => {
    expect(applicationMenuTemplate('darwin', 'Orbit by AgentDock')![0]!.label).toBe('Orbit by AgentDock')
  })

  it('offers no File, View or Help strip anywhere', () => {
    // The original intent stands: Orbit's actions live in Orbit's own UI.
    // Only the menus macOS genuinely needs are present.
    const labels = applicationMenuTemplate('darwin', 'Orbit')!.map((item) => item.label ?? item.role)

    expect(labels).toEqual(['Orbit', 'Edit', 'Window'])
  })

  it('keeps Windows and Linux with no menu at all', () => {
    // Chromium handles Ctrl+C/V/X/A/Z natively in editable fields on these
    // platforms, so a menu would add nothing but an in-window strip.
    expect(applicationMenuTemplate('win32', 'Orbit')).toBeNull()
    expect(applicationMenuTemplate('linux', 'Orbit')).toBeNull()
  })
})
