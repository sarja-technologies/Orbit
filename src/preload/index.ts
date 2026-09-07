import { contextBridge, ipcRenderer } from 'electron'
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
    create: (input) => ipcRenderer.invoke(IPC_CHANNELS.projectsCreate, input),
    open: (projectId) => ipcRenderer.invoke(IPC_CHANNELS.projectsOpen, projectId)
  },
  conversations: {
    create: (input) => ipcRenderer.invoke(IPC_CHANNELS.conversationsCreate, input),
    rename: (input) => ipcRenderer.invoke(IPC_CHANNELS.conversationsRename, input),
    delete: (input) => ipcRenderer.invoke(IPC_CHANNELS.conversationsDelete, input),
    setTransport: (input) => ipcRenderer.invoke(IPC_CHANNELS.conversationsSetTransport, input)
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
    attachImage: (input) => ipcRenderer.invoke(IPC_CHANNELS.filesAttachImage, input)
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
