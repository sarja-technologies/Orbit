import { BrowserWindow, clipboard, dialog, ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/contracts'
import type { RuntimeEvent } from '@shared/runtime-events'
import type { OrbitRuntime } from '@main/runtime/orbitRuntime'
import { isAbsolute } from 'node:path'
import {
  attachFilesSchema,
  attachImageSchema,
  attachPathsSchema,
  cancelRunSchema,
  createConversationSchema,
  setPermissionModeSchema,
  clipboardTextSchema,
  createProjectSchema,
  createReferenceSchema,
  deleteConversationSchema,
  idSchema,
  importArtifactSchema,
  pickFolderSchema,
  preferencesSchema,
  renameConversationSchema,
  setConversationWorkingDirectorySchema,
  setProjectRootSchema,
  respondToInteractionSchema,
  sendMessageSchema,
  setConversationModelSchema,
  setConversationTransportSchema
} from './validation'

export function registerIpc(runtime: OrbitRuntime): void {
  ipcMain.handle(IPC_CHANNELS.systemStatus, () => runtime.getSystemStatus())
  ipcMain.handle(IPC_CHANNELS.providersStatus, () => runtime.getProviderStatus())
  ipcMain.handle(IPC_CHANNELS.projectsList, () => runtime.listProjects())
  ipcMain.handle(IPC_CHANNELS.projectsTree, () => runtime.listProjectTree())
  ipcMain.handle(IPC_CHANNELS.projectsCreate, (_event, input: unknown) => {
    const parsed = createProjectSchema.parse(input)
    return runtime.createProject(parsed.name, parsed.rootPath ?? null)
  })
  ipcMain.handle(IPC_CHANNELS.projectsOpen, (_event, projectId: unknown) => runtime.openProject(idSchema.parse(projectId)))
  ipcMain.handle(IPC_CHANNELS.projectsSetRoot, (_event, input: unknown) => {
    const parsed = setProjectRootSchema.parse(input)
    return runtime.setProjectRoot(parsed.projectId, parsed.rootPath)
  })
  ipcMain.handle(IPC_CHANNELS.conversationsCreate, (_event, input: unknown) => {
    const parsed = createConversationSchema.parse(input)
    return runtime.createConversation(parsed.projectId, parsed.title, parsed.workingDirectory ?? null)
  })
  ipcMain.handle(IPC_CHANNELS.conversationsSetPermissionMode, (_event, input: unknown) => {
    const parsed = setPermissionModeSchema.parse(input)
    return runtime.setConversationPermissionMode(parsed.conversationId, parsed.permissionMode)
  })
  // Narrowly typed: text only, size-bounded, and it reports whether the
  // write actually happened so the UI never claims a copy it did not make.
  ipcMain.handle(IPC_CHANNELS.clipboardWriteText, (_event, input: unknown) => {
    const text = clipboardTextSchema.parse(input)
    clipboard.writeText(text)
    return clipboard.readText() === text
  })
  ipcMain.handle(IPC_CHANNELS.conversationsSetWorkingDirectory, (_event, input: unknown) => {
    const parsed = setConversationWorkingDirectorySchema.parse(input)
    return runtime.setConversationWorkingDirectory(parsed.conversationId, parsed.workingDirectory)
  })
  ipcMain.handle(IPC_CHANNELS.preferencesGet, () => runtime.getPreferences())
  ipcMain.handle(IPC_CHANNELS.preferencesSet, (_event, input: unknown) => runtime.setPreferences(preferencesSchema.parse(input)))
  // The one place Orbit asks the OS where work should happen. Directory-only
  // and always user-driven — nothing here can pick a folder on its own.
  ipcMain.handle(IPC_CHANNELS.dialogPickFolder, async (_event, input: unknown) => {
    const parsed = pickFolderSchema.parse(input) ?? undefined
    const result = await dialog.showOpenDialog({
      title: parsed?.title ?? 'Choose a working folder',
      properties: ['openDirectory', 'createDirectory'],
      ...(parsed?.defaultPath ? { defaultPath: parsed.defaultPath } : {})
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0] ?? null
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
  ipcMain.handle(IPC_CHANNELS.conversationsDelete, (_event, input: unknown) =>
    runtime.deleteConversation(deleteConversationSchema.parse(input).conversationId)
  )
  ipcMain.handle(IPC_CHANNELS.modelsList, () => runtime.listModels())
  ipcMain.handle(IPC_CHANNELS.conversationsSetModel, (_event, input: unknown) => {
    const parsed = setConversationModelSchema.parse(input)
    return runtime.setConversationModel(parsed.conversationId, parsed.model, parsed.reasoningEffort)
  })
  ipcMain.handle(IPC_CHANNELS.conversationsSetTransport, (_event, input: unknown) => {
    const parsed = setConversationTransportSchema.parse(input)
    return runtime.setConversationTransport(parsed.conversationId, parsed.transport)
  })
  ipcMain.handle(IPC_CHANNELS.runsCancel, (_event, input: unknown) => runtime.cancelRun(cancelRunSchema.parse(input).runId))
  ipcMain.handle(IPC_CHANNELS.interactionsRespond, (_event, input: unknown) => runtime.respondToInteraction(respondToInteractionSchema.parse(input)))
  ipcMain.handle(IPC_CHANNELS.filesAttach, async (_event, input: unknown) => {
    const parsed = attachFilesSchema.parse(input)
    const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
    if (result.canceled || result.filePaths.length === 0) return []
    return runtime.attachFiles(parsed.projectId, result.filePaths)
  })
  ipcMain.handle(IPC_CHANNELS.filesAttachPaths, (_event, input: unknown) => {
    const parsed = attachPathsSchema.parse(input)
    // A dragged file always resolves to an absolute OS path; anything else
    // did not come from a real drag and is refused.
    const paths = parsed.paths.filter((candidate) => isAbsolute(candidate))
    if (paths.length === 0) return []
    return runtime.attachFiles(parsed.projectId, paths)
  })
  ipcMain.handle(IPC_CHANNELS.filesAttachImage, (_event, input: unknown) => {
    const parsed = attachImageSchema.parse(input)
    return runtime.attachFileBytes(parsed.projectId, parsed.name, parsed.data)
  })
  ipcMain.handle(IPC_CHANNELS.filesThumbnail, (_event, fileId: unknown) => runtime.getProjectFileThumbnail(idSchema.parse(fileId)))
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
