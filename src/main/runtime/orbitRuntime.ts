import path from 'node:path'
import { EventEmitter } from 'node:events'
import type {
  Artifact,
  Conversation,
  ID,
  Project,
  ProjectFile,
  ProjectSnapshot,
  ProviderStatus,
  Reference,
  Run,
  RuntimeErrorInfo,
  SystemStatus
} from '@shared/domain'
import type { ArtifactContent, SendMessageInput } from '@shared/contracts'
import type { RuntimeEvent } from '@shared/runtime-events'
import type { AgentProvider } from './provider'
import type { OrbitStore } from '@main/persistence/store'
import type { ArtifactService } from '@main/artifacts/artifactService'
import { nowIso } from '@main/util/ids'

interface ActiveRunState {
  text: string
}

export class OrbitRuntime extends EventEmitter {
  private readonly activeRuns = new Map<ID, ActiveRunState>()

  constructor(
    private readonly store: OrbitStore,
    private readonly artifactService: ArtifactService,
    private readonly provider: AgentProvider,
    private readonly dataDir: string,
    private readonly version: string
  ) {
    super()
  }

  async getSystemStatus(): Promise<SystemStatus> {
    return {
      appName: 'Orbit by AgentDock',
      version: this.version,
      dataDir: this.dataDir,
      provider: await this.provider.getStatus()
    }
  }

  async getProviderStatus(): Promise<ProviderStatus> {
    return this.provider.getStatus()
  }

  listProjects(): Project[] {
    return this.store.listProjects()
  }

  createProject(name: string): Project {
    if (!name.trim()) throw new Error('Project name is required.')
    const project = this.store.createProject(name)
    this.store.createConversation(project.id, 'Main')
    return project
  }

  openProject(projectId: ID): ProjectSnapshot {
    return this.store.openProjectSnapshot(projectId)
  }

  createConversation(projectId: ID, title = 'New conversation'): Conversation {
    return this.store.createConversation(projectId, title)
  }

  renameConversation(conversationId: ID, title: string): Conversation {
    return this.store.renameConversation(conversationId, title)
  }

  /** Releases any live provider session the conversation owns before
   *  removing it, so deleting an interactive session never orphans a
   *  running process. */
  async deleteConversation(conversationId: ID): Promise<void> {
    const conversation = this.store.requireConversation(conversationId)
    await this.provider.releaseConversation(conversationId)
    this.store.deleteConversation(conversation.id)
  }

  async sendMessage(input: SendMessageInput): Promise<Run> {
    const project = this.store.getProject(input.projectId)
    if (!project) throw new Error('Project not found.')
    const conversation = this.store.requireConversation(input.conversationId)
    if (conversation.projectId !== project.id) throw new Error('Conversation does not belong to this project.')
    if (!input.content.trim()) throw new Error('Message cannot be empty.')

    this.store.createMessage({
      projectId: project.id,
      conversationId: conversation.id,
      runId: null,
      role: 'user',
      content: input.content,
      status: 'completed'
    })
    const run = this.store.createRun({
      projectId: project.id,
      conversationId: conversation.id,
      metadata: {
        attachmentFileIds: input.attachmentFileIds ?? [],
        referencedArtifactIds: input.referencedArtifactIds ?? []
      }
    })
    this.activeRuns.set(run.id, { text: '' })

    const workspacePath = path.join(this.dataDir, 'projects', project.id, 'workspace')
    const saveDir = path.join(this.dataDir, 'projects', project.id, 'agy-save')
    const attachments = (input.attachmentFileIds ?? [])
      .map((fileId) => this.store.getProjectFile(fileId))
      .filter((file): file is ProjectFile => file !== null && file.projectId === project.id)
    const referencedArtifacts = (input.referencedArtifactIds ?? [])
      .map((artifactId) => this.store.getArtifact(artifactId))
      .filter((artifact): artifact is Artifact => artifact !== null && artifact.projectId === project.id)
      .map((artifact) => ({ id: artifact.id, name: artifact.name, location: artifact.location, mimeType: artifact.mimeType }))

    // Automatic capability escalation, decided BEFORE delivery: attaching an
    // image needs the live session, so the conversation moves itself there
    // rather than making the user understand transports. Still one-way — see
    // setConversationTransport.
    const transport = attachments.some(isImageFile)
      ? this.setConversationTransport(conversation.id, 'pty').transport
      : conversation.transport

    void this.provider
      .sendMessage(
        {
          projectId: project.id,
          conversationId: conversation.id,
          runId: run.id,
          prompt: buildPrompt(input.content, referencedArtifacts, attachments, transport),
          nativeConversationId: conversation.nativeConversationId,
          workspacePath,
          saveDir,
          attachments,
          referencedArtifacts,
          transport
        },
        (event) => this.handleProviderEvent(event)
      )
      .catch((error: unknown) => {
        const runtimeError = normalizeError(error)
        const failed: RuntimeEvent = {
          type: 'run.failed',
          projectId: project.id,
          conversationId: conversation.id,
          runId: run.id,
          providerId: 'antigravity',
          createdAt: nowIso(),
          error: runtimeError
        }
        this.handleProviderEvent(failed)
      })

    return run
  }

  async cancelRun(runId: ID): Promise<Run> {
    const run = this.store.updateRunState(runId, 'cancelling')
    await this.provider.cancelRun(runId)
    return run
  }

  /** 'pty' is sticky by design (see ConversationTransport's doc comment) —
   *  requesting 'structured' on an already-'pty' conversation is a no-op
   *  rather than a silent downgrade of an interactive session. */
  setConversationTransport(conversationId: ID, transport: Conversation['transport']): Conversation {
    const conversation = this.store.requireConversation(conversationId)
    if (conversation.transport === 'pty' && transport === 'structured') return conversation
    return this.store.setConversationTransport(conversationId, transport)
  }

  async respondToInteraction(input: { conversationId: ID; runId: ID; interactionId: string; optionId: string }): Promise<void> {
    const run = this.store.requireRun(input.runId)
    if (run.conversationId !== input.conversationId) throw new Error('Interaction does not belong to this conversation.')
    if (run.state !== 'waiting_for_interaction') throw new Error('This run has no pending interaction to respond to.')
    await this.provider.respondToInteraction(input)
  }

  attachFiles(projectId: ID, paths: string[]): ProjectFile[] {
    return this.artifactService.attachProjectFiles(projectId, paths)
  }

  /** Used by clipboard paste, which supplies bytes rather than a path. */
  attachFileBytes(projectId: ID, name: string, bytes: Uint8Array): ProjectFile {
    if (!this.store.getProject(projectId)) throw new Error('Project not found.')
    return this.artifactService.attachProjectBytes(projectId, name, bytes)
  }

  importArtifacts(projectId: ID, paths: string[], conversationId: ID | null = null): Artifact[] {
    return this.artifactService.importUserArtifacts(projectId, paths, conversationId)
  }

  listArtifacts(projectId: ID): Artifact[] {
    return this.store.listArtifacts(projectId)
  }

  getArtifactContent(artifactId: ID): ArtifactContent {
    return this.artifactService.getContent(artifactId)
  }

  async revealArtifact(artifactId: ID): Promise<void> {
    await this.artifactService.reveal(artifactId)
  }

  createReference(projectId: ID, artifactId: ID, destinationConversationId: ID): Reference {
    return this.store.createReference({ projectId, artifactId, destinationConversationId })
  }

  async shutdown(): Promise<void> {
    await this.provider.shutdown()
  }

  private handleProviderEvent(event: RuntimeEvent): void {
    const active = this.activeRuns.get(event.runId)
    const run = safeRequireRun(this.store, event.runId)
    if (!run || run.projectId !== event.projectId || run.conversationId !== event.conversationId) return

    if (event.type === 'text.delta') active && (active.text += event.delta)
    if (event.type === 'run.started' && event.nativeConversationId) this.store.updateConversationNativeId(event.conversationId, event.nativeConversationId)
    if (event.type === 'interaction.required' && event.canRespond) this.store.updateRunState(event.runId, 'waiting_for_interaction')
    // Antigravity needed to ask something the headless path cannot present.
    // Escalate the conversation so the next turn can ask the user directly,
    // without ever asking the user to pick a transport themselves.
    if (event.type === 'interaction.required' && !event.canRespond) {
      this.setConversationTransport(event.conversationId, 'pty')
    }
    if (event.type === 'interaction.resolved' && event.outcome !== 'cancelled' && run.state === 'waiting_for_interaction') {
      this.store.updateRunState(event.runId, 'running')
    }
    if (event.type === 'artifact.discovered') {
      try {
        const artifact = this.artifactService.registerProviderArtifact({
          projectId: event.projectId,
          conversationId: event.conversationId,
          runId: event.runId,
          sourcePath: event.sourcePath,
          metadata: event.metadata ?? {}
        })
        const produced: RuntimeEvent = {
          type: 'artifact.produced',
          projectId: event.projectId,
          conversationId: event.conversationId,
          runId: event.runId,
          providerId: 'antigravity',
          createdAt: nowIso(),
          artifact
        }
        this.store.addRunEvent(produced)
        this.emit('event', produced)
      } catch (error) {
        const failed: RuntimeEvent = {
          type: 'run.failed',
          projectId: event.projectId,
          conversationId: event.conversationId,
          runId: event.runId,
          providerId: 'antigravity',
          createdAt: nowIso(),
          error: normalizeError(error)
        }
        this.handleProviderEvent(failed)
        return
      }
    }
    if (event.type === 'run.completed') {
      const text = event.finalText || active?.text || ''
      if (event.nativeConversationId) this.store.updateConversationNativeId(event.conversationId, event.nativeConversationId)
      this.store.createMessage({
        projectId: event.projectId,
        conversationId: event.conversationId,
        runId: event.runId,
        role: 'assistant',
        content: text,
        status: 'completed'
      })
      this.store.updateRunState(event.runId, 'completed')
      this.activeRuns.delete(event.runId)
    }
    if (event.type === 'run.failed') {
      this.store.createMessage({
        projectId: event.projectId,
        conversationId: event.conversationId,
        runId: event.runId,
        role: 'assistant',
        content: event.error.message,
        status: 'failed'
      })
      this.store.updateRunState(event.runId, 'failed', event.error)
      this.activeRuns.delete(event.runId)
    }
    if (event.type === 'run.cancelled') {
      this.store.createMessage({
        projectId: event.projectId,
        conversationId: event.conversationId,
        runId: event.runId,
        role: 'assistant',
        content: 'Request cancelled.',
        status: 'cancelled'
      })
      this.store.updateRunState(event.runId, 'cancelled')
      this.activeRuns.delete(event.runId)
    }
    this.store.addRunEvent(event)
    this.emit('event', event)
  }
}

function safeRequireRun(store: OrbitStore, runId: ID): Run | null {
  try {
    return store.requireRun(runId)
  } catch {
    return null
  }
}

function normalizeError(error: unknown): RuntimeErrorInfo {
  if (error instanceof Error) {
    const code = typeof (error as Error & { code?: unknown }).code === 'string' ? String((error as Error & { code?: unknown }).code) : 'provider.failed'
    return { code, message: error.message, retryable: false }
  }
  return { code: 'provider.failed', message: 'Provider failed.', retryable: false }
}

// Kept in sync with AntigravityPtySession's identical isSupportedImage —
// SVG is deliberately excluded (Electron's nativeImage can't rasterize it
// for a native clipboard paste), even though it's an "image/*" mime type.
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp']
function isImageFile(file: ProjectFile): boolean {
  if (file.mimeType === 'image/svg+xml') return false
  if (file.mimeType?.startsWith('image/')) return true
  const lower = file.name.toLowerCase()
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

function buildPrompt(
  content: string,
  artifacts: Array<{ id: ID; name: string; location: string }>,
  attachments: ProjectFile[],
  transport: Conversation['transport']
): string {
  const sections = [content]
  if (artifacts.length) sections.push(`Referenced Orbit artifacts:\n${artifacts.map((artifact) => `- ${artifact.name} (${artifact.id}) at ${artifact.location}`).join('\n')}`)
  // PTY transport attaches images natively (clipboard paste, before this
  // prompt is even sent) — the structured `view_file` fallback hint is
  // only needed for non-image attachments there, and for every attachment
  // under structured transport (which has no native attachment mechanism).
  const needsViewFileHint = transport === 'structured' ? attachments : attachments.filter((file) => !isImageFile(file))
  if (needsViewFileHint.length) sections.push(`Attached Orbit files (inspect these managed paths with view_file when relevant):\n${needsViewFileHint.map((file) => `- ${file.name}: ${file.storedPath}`).join('\n')}`)
  return sections.join('\n\n')
}
