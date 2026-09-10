import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC_CHANNELS, type OrbitApi } from '@shared/contracts'
import type { RuntimeEvent } from '@shared/runtime-events'

const orbitApi: OrbitApi = {
  system: {
    status: () => ipcRenderer.invoke(IPC_CHANNELS.systemStatus)
  },
  providers: {
    status: () => ipcRenderer.invoke(IPC_CHANNELS.providersStatus)
  },
  projects: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.projectsList),
    tree: () => ipcRenderer.invoke(IPC_CHANNELS.projectsTree),
    create: (input) => ipcRenderer.invoke(IPC_CHANNELS.projectsCreate, input),
    open: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.projectsOpen, projectId),
    setRoot: (input) => ipcRenderer.invoke(IPC_CHANNELS.projectsSetRoot, input)
  },
  dialog: {
    pickFolder: (input) => ipcRenderer.invoke(IPC_CHANNELS.dialogPickFolder, input ?? null)
  },
  preferences: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.preferencesGet),
    set: (preferences) => ipcRenderer.invoke(IPC_CHANNELS.preferencesSet, preferences)
  },
  conversations: {
    create: (input) => ipcRenderer.invoke(IPC_CHANNELS.conversationsCreate, input),
    rename: (input) => ipcRenderer.invoke(IPC_CHANNELS.conversationsRename, input),
    delete: (input) => ipcRenderer.invoke(IPC_CHANNELS.conversationsDelete, input),
    setTransport: (input) => ipcRenderer.invoke(IPC_CHANNELS.conversationsSetTransport, input),
    setModel: (input) => ipcRenderer.invoke(IPC_CHANNELS.conversationsSetModel, input),
    setPermissionMode: (input) => ipcRenderer.invoke(IPC_CHANNELS.conversationsSetPermissionMode, input),
    setWorkingDirectory: (input) => ipcRenderer.invoke(IPC_CHANNELS.conversationsSetWorkingDirectory, input)
  },
  clipboard: {
    writeText: (text) => ipcRenderer.invoke(IPC_CHANNELS.clipboardWriteText, text)
  },
  models: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.modelsList)
  },
  messages: {
    send: (input) => ipcRenderer.invoke(IPC_CHANNELS.messagesSend, input)
  },
  runs: {
    cancel: (input) => ipcRenderer.invoke(IPC_CHANNELS.runsCancel, input),
    onEvent: (listener: (event: RuntimeEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, runtimeEvent: RuntimeEvent): void => listener(runtimeEvent)
      ipcRenderer.on(IPC_CHANNELS.runsEvent, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.runsEvent, handler)
    }
  },
  interactions: {
    respond: (input) => ipcRenderer.invoke(IPC_CHANNELS.interactionsRespond, input)
  },
  files: {
    attach: (input) => ipcRenderer.invoke(IPC_CHANNELS.filesAttach, input),
    attachPaths: (input) => ipcRenderer.invoke(IPC_CHANNELS.filesAttachPaths, input),
    attachImage: (input) => ipcRenderer.invoke(IPC_CHANNELS.filesAttachImage, input),
    thumbnail: (fileId) => ipcRenderer.invoke(IPC_CHANNELS.filesThumbnail, fileId),
    // Electron removed File.path in v32+ (verified absent on 33.4.11), so a
    // dropped file's real location is only obtainable through webUtils, and
    // only from this preload context. Reading `file.path` in the renderer
    // silently yields undefined and drag-and-drop attaches nothing.
    pathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file) || null
      } catch {
        return null
      }
    }
  },
  artifacts: {
    list: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.artifactsList, projectId),
    import: (input) => ipcRenderer.invoke(IPC_CHANNELS.artifactsImport, input),
    getContent: (artifactId) => ipcRenderer.invoke(IPC_CHANNELS.artifactsContent, artifactId),
    reveal: (artifactId) => ipcRenderer.invoke(IPC_CHANNELS.artifactsReveal, artifactId)
  },
  references: {
    create: (input) => ipcRenderer.invoke(IPC_CHANNELS.referencesCreate, input)
  }
}

contextBridge.exposeInMainWorld('orbit', orbitApi)
