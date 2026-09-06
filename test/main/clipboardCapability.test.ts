import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkClipboardCapability } from '../../src/main/runtime/providers/antigravity/clipboardCapability'

const originalPath = process.env.PATH
const originalPlatform = process.platform
const originalWayland = process.env.WAYLAND_DISPLAY
const originalXdgSession = process.env.XDG_SESSION_TYPE
const originalDisplay = process.env.DISPLAY

let binDir = ''

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

function makeExecutable(name: string): void {
  fs.writeFileSync(path.join(binDir, name), '#!/bin/sh\n')
}

beforeEach(() => {
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-clipboard-bin-'))
  process.env.PATH = binDir
  delete process.env.WAYLAND_DISPLAY
  delete process.env.XDG_SESSION_TYPE
  delete process.env.DISPLAY
})

afterEach(() => {
  process.env.PATH = originalPath
  setPlatform(originalPlatform)
  if (originalWayland === undefined) delete process.env.WAYLAND_DISPLAY
  else process.env.WAYLAND_DISPLAY = originalWayland
  if (originalXdgSession === undefined) delete process.env.XDG_SESSION_TYPE
  else process.env.XDG_SESSION_TYPE = originalXdgSession
  if (originalDisplay === undefined) delete process.env.DISPLAY
  else process.env.DISPLAY = originalDisplay
  fs.rmSync(binDir, { recursive: true, force: true })
})

describe('checkClipboardCapability', () => {
  it('assumes macOS needs no external helper (not live-verified)', () => {
    setPlatform('darwin')
    const result = checkClipboardCapability()
    expect(result).toEqual({ available: true, platform: 'darwin', sessionType: 'not-applicable', helper: null, reason: null })
  })

  it('assumes Windows needs no external helper (not live-verified)', () => {
    setPlatform('win32')
    const result = checkClipboardCapability()
    expect(result.available).toBe(true)
    expect(result.sessionType).toBe('not-applicable')
  })

  it('reports available on Wayland when wl-copy and wl-paste are both present', () => {
    setPlatform('linux')
    process.env.WAYLAND_DISPLAY = 'wayland-0'
    makeExecutable('wl-copy')
    makeExecutable('wl-paste')
    const result = checkClipboardCapability()
    expect(result).toEqual({ available: true, platform: 'linux', sessionType: 'wayland', helper: 'wl-clipboard', reason: null })
  })

  it('reports a concrete, actionable reason on Wayland when wl-clipboard is missing', () => {
    setPlatform('linux')
    process.env.WAYLAND_DISPLAY = 'wayland-0'
    const result = checkClipboardCapability()
    expect(result.available).toBe(false)
    expect(result.reason).toContain('wl-clipboard')
  })

  it('reports available on X11 when xclip is present', () => {
    setPlatform('linux')
    process.env.DISPLAY = ':0'
    makeExecutable('xclip')
    const result = checkClipboardCapability()
    expect(result).toEqual({ available: true, platform: 'linux', sessionType: 'x11', helper: 'xclip', reason: null })
  })

  it('falls back to xsel on X11 when xclip is missing but xsel is present', () => {
    setPlatform('linux')
    process.env.DISPLAY = ':0'
    makeExecutable('xsel')
    const result = checkClipboardCapability()
    expect(result.available).toBe(true)
    expect(result.helper).toBe('xsel')
  })

  it('reports a concrete, actionable reason on X11 when neither xclip nor xsel is present', () => {
    setPlatform('linux')
    process.env.DISPLAY = ':0'
    const result = checkClipboardCapability()
    expect(result.available).toBe(false)
    expect(result.reason).toMatch(/xclip|xsel/)
  })

  it('reports a specific reason when the session type cannot be determined at all', () => {
    setPlatform('linux')
    const result = checkClipboardCapability()
    expect(result.available).toBe(false)
    expect(result.sessionType).toBe('unknown')
    expect(result.reason).toMatch(/could not determine/i)
  })

  it('prefers XDG_SESSION_TYPE=wayland over a stray DISPLAY variable (XWayland compatibility layer)', () => {
    setPlatform('linux')
    process.env.XDG_SESSION_TYPE = 'wayland'
    process.env.DISPLAY = ':0' // XWayland often sets this too
    makeExecutable('wl-copy')
    makeExecutable('wl-paste')
    const result = checkClipboardCapability()
    expect(result.sessionType).toBe('wayland')
  })

  it('reports unavailable with a clear reason on an unsupported platform', () => {
    setPlatform('freebsd' as NodeJS.Platform)
    const result = checkClipboardCapability()
    expect(result.available).toBe(false)
    expect(result.reason).toContain('freebsd')
  })
})
