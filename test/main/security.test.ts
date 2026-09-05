import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePreloadPath } from '../../src/main/app/preloadPath'
import { createSecureWebPreferences } from '../../src/main/app/security'

describe('Electron security preferences', () => {
  it('keeps renderer privileges disabled', () => {
    const prefs = createSecureWebPreferences('/tmp/preload.js')
    expect(prefs.contextIsolation).toBe(true)
    expect(prefs.nodeIntegration).toBe(false)
    expect(prefs.sandbox).toBe(true)
    expect(prefs.preload).toBe('/tmp/preload.js')
  })

  it('resolves the electron-vite CommonJS preload bundle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbit-preload-'))
    const mainDir = join(dir, 'out', 'main')
    const preloadDir = join(dir, 'out', 'preload')

    try {
      mkdirSync(mainDir, { recursive: true })
      mkdirSync(preloadDir, { recursive: true })
      const cjsPreload = join(preloadDir, 'index.cjs')
      writeFileSync(cjsPreload, '')

      expect(resolvePreloadPath(mainDir)).toBe(cjsPreload)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
