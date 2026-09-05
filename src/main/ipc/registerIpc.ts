import { BrowserWindow, dialog, ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/contracts'
import type { RuntimeEvent } from '@shared/runtime-events'
import type { OrbitRuntime } from '@main/runtime/orbitRuntime'
import {
  attachFilesSchema,
  cancelRunSchema,
  createConversationSchema,
  createProjectSchema,
  createReferenceSchema,
  idSchema,
  importArtifactSchema,
  renameConversationSchema,
  sendMessageSchema
} from './validation'

export function registerIpc(runtime: OrbitRuntime): void {
  ipcMain.handle(IPC_CHANNELS.systemStatus, () => runtime.getSystemStatus())
  ipcMain.handle(IPC_CHANNELS.providersStatus, () => runtime.getProviderStatus())
  ipcMain.handle(IPC_CHANNELS.projectsList, () => runtime.listProjects())
  ipcMain.handle(IPC_CHANNELS.projectsCreate, (_event, input: unknown) => runtime.createProject(createProjectSchema.parse(input).name))
  ipcMain.handle(IPC_CHANNELS.projectsOpen, (_event, projectId: unknown) => runtime.openProject(idSchema.parse(projectId)))
  ipcMain.handle(IPC_CHANNELS.conversationsCreate, (_event, input: unknown) => {
    const parsed = createConversationSchema.parse(input)
    return runtime.createConversation(parsed.projectId, parsed.title)
  })
  ipcMain.handle(IPC_CHANNELS.conversationsRename, (_event, input: unknown) => {
    const parsed = renameConversationSchema.parse(input)
    return runtime.renameConversation(parsed.conversationId, parsed.title)
  })
  ipcMain.handle(IPC_CHANNELS.messagesSend, (_event, input: unknown) => {
    const parsed = sendMessageSchema.parse(input)
    return runtime.sendMessage({
      projectId: parsed.projectId,
      conversationId: parsed.conversationId,
      content: parsed.content,
      attachmentFileIds: parsed.attachmentFileIds ?? [],
      referencedArtifactIds: parsed.referencedArtifactIds ?? []
    })
  })
  ipcMain.handle(IPC_CHANNELS.runsCancel, (_event, input: unknown) => runtime.cancelRun(cancelRunSchema.parse(input).runId))
  ipcMain.handle(IPC_CHANNELS.filesAttach, async (_event, input: unknown) => {
    const parsed = attachFilesSchema.parse(input)
    const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
    if (result.canceled || result.filePaths.length === 0) return []
    return runtime.attachFiles(parsed.projectId, result.filePaths)
  })
  ipcMain.handle(IPC_CHANNELS.artifactsList, (_event, projectId: unknown) => runtime.listArtifacts(idSchema.parse(projectId)))
  ipcMain.handle(IPC_CHANNELS.artifactsImport, async (_event, input: unknown) => {
    const parsed = importArtifactSchema.parse(input)
    const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
    if (result.canceled || result.filePaths.length === 0) return []
    return runtime.importArtifacts(parsed.projectId, result.filePaths, parsed.conversationId ?? null)
  })
  ipcMain.handle(IPC_CHANNELS.artifactsContent, (_event, artifactId: unknown) => runtime.getArtifactContent(idSchema.parse(artifactId)))
  ipcMain.handle(IPC_CHANNELS.artifactsReveal, async (_event, artifactId: unknown) => runtime.revealArtifact(idSchema.parse(artifactId)))
  ipcMain.handle(IPC_CHANNELS.referencesCreate, (_event, input: unknown) => {
    const parsed = createReferenceSchema.parse(input)
    return runtime.createReference(parsed.projectId, parsed.artifactId, parsed.destinationConversationId)
  })

  runtime.on('event', (event: RuntimeEvent) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(IPC_CHANNELS.runsEvent, event)
    }
  })
}
