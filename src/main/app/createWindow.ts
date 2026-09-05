import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { resolvePreloadPath } from './preloadPath'
import { createSecureWebPreferences } from './security'

export function createMainWindow(): BrowserWindow {
  const preloadPath = resolvePreloadPath(__dirname)
  const win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1040,
    minHeight: 680,
    title: 'Orbit by AgentDock',
    backgroundColor: '#111318',
    webPreferences: createSecureWebPreferences(preloadPath)
  })

  win.webContents.on('preload-error', (_event, failedPreloadPath, error) => {
    console.error(`Orbit preload failed at ${failedPreloadPath}: ${error.message}`)
  })

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`Orbit renderer failed to load ${validatedURL}: ${errorCode} ${errorDescription}`)
  })

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) console.warn(`Orbit renderer console: ${message} (${sourceId}:${line})`)
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    const current = win.webContents.getURL()
    if (url !== current && !url.startsWith('http://localhost:') && !url.startsWith('file://')) {
      event.preventDefault()
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:'
  } catch {
    return false
  }
}
