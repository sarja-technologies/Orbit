import { app } from 'electron'
import path from 'node:path'
import { createMainWindow } from './app/createWindow'
import { OrbitDatabase } from './persistence/database'
import { OrbitStore } from './persistence/store'
import { FileStorage } from './files/fileStorage'
import { ArtifactService } from './artifacts/artifactService'
import { AntigravityProvider } from './runtime/providers/antigravity/AntigravityProvider'
import { OrbitRuntime } from './runtime/orbitRuntime'
import { registerIpc } from './ipc/registerIpc'

let runtime: OrbitRuntime | null = null
let database: OrbitDatabase | null = null
let quitting = false

configureGpu()

async function bootstrap(): Promise<void> {
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
    return
  }

  await app.whenReady()
  void logGpuStatus('app-ready')
  const dataDir = process.env.ORBIT_USER_DATA_DIR || app.getPath('userData')
  database = new OrbitDatabase({ dataDir })
  await database.init()
  const store = new OrbitStore(database)
  const storage = new FileStorage(dataDir)
  const artifactService = new ArtifactService(store, storage)
  const provider = new AntigravityProvider()
  runtime = new OrbitRuntime(store, artifactService, provider, dataDir, app.getVersion())
  registerIpc(runtime)
  const mainWindow = createMainWindow()
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      void logGpuStatus('renderer-loaded')
    }, 1000)
  })

  app.on('activate', () => {
    if (process.platform === 'darwin' && !runtime) return
    if (process.platform === 'darwin') createMainWindow()
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  void shutdown().finally(() => app.quit())
})

process.on('uncaughtException', (error) => {
  console.error('[orbit] uncaught exception', sanitizeError(error))
})

process.on('unhandledRejection', (reason) => {
  console.error('[orbit] unhandled rejection', sanitizeError(reason))
})

void bootstrap().catch((error) => {
  console.error('[orbit] failed to start', sanitizeError(error))
  app.quit()
})

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.stack || error.message : String(error)
  return message
}

async function shutdown(): Promise<void> {
  if (runtime) await runtime.shutdown()
  database?.close()
}

export const __orbitMain = { appRoot: path.resolve('.') }

function configureGpu(): void {
  // Hardware acceleration is the Chromium default and is required for smooth
  // Retina rendering on macOS. ORBIT_DISABLE_GPU is a diagnostic escape hatch,
  // not a platform policy.
  if (process.env.ORBIT_DISABLE_GPU === '1') {
    console.warn('[orbit] hardware acceleration disabled by ORBIT_DISABLE_GPU=1')
    app.disableHardwareAcceleration()
  }
}

async function logGpuStatus(phase: string): Promise<void> {
  try {
    console.info(`[orbit] GPU feature status (${phase})`, app.getGPUFeatureStatus())
    console.info(`[orbit] GPU info (${phase})`, await app.getGPUInfo('basic'))
  } catch (error) {
    console.warn('[orbit] unable to read GPU feature status', sanitizeError(error))
  }
}
