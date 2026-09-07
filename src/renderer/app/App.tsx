import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import type { ArtifactContent } from '@shared/contracts'
import type {
  Artifact,
  Conversation,
  ID,
  Message,
  ModelOption,
  Project,
  ProjectFile,
  ProjectSnapshot,
  ProviderStatus,
  ReasoningEffort,
  Reference,
  Run
} from '@shared/domain'
import type { InteractionRequiredEvent, RuntimeEvent } from '@shared/runtime-events'
import { StartupError } from './ErrorBoundary'
import { getOrbitApi } from './orbitApi'
import { ChromeBar, ProviderBanner } from './components/ChromeBar'
import { SessionSidebar, type SessionIndicator } from './components/SessionSidebar'
import { WorkSession, type ResolvedRecord } from './components/WorkSession'
import { Composer } from './components/Composer'
import { EmptySession, type Starter } from './components/EmptySession'
import { ContextPanel } from './components/ContextPanel'
import { applyActivity, emptyActivity, type ActivityState } from './lib/activity'
import { describeInteraction, describeResolution } from './lib/interactionCopy'
import { draftFromProjectFile, isImage, isNativeImage, projectedState, type DraftAttachment } from './lib/attachments'

interface WorkspaceState {
  projects: Project[]
  activeProject: Project | null
  conversations: Conversation[]
  activeConversationId: ID | null
  messages: Message[]
  runs: Run[]
  artifacts: Artifact[]
  projectFiles: ProjectFile[]
  references: Reference[]
}

const emptyWorkspace: WorkspaceState = {
  projects: [],
  activeProject: null,
  conversations: [],
  activeConversationId: null,
  messages: [],
  runs: [],
  artifacts: [],
  projectFiles: [],
  references: []
}

export function App(): JSX.Element {
  const [workspace, setWorkspace] = useState<WorkspaceState>(emptyWorkspace)
  const [providerStatus, setProviderStatus] = useState<ProviderStatus | null>(null)
  const [models, setModels] = useState<ModelOption[]>([])
  const [composer, setComposer] = useState('')
  const [attachments, setAttachments] = useState<DraftAttachment[]>([])
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({})
  const [streamTextByRun, setStreamTextByRun] = useState<Record<string, string>>({})
  const [runningRunByConversation, setRunningRunByConversation] = useState<Record<string, string>>({})
  const [activityByRun, setActivityByRun] = useState<Record<string, ActivityState>>({})
  const [pendingByRun, setPendingByRun] = useState<Record<string, InteractionRequiredEvent>>({})
  const [unavailableByRun, setUnavailableByRun] = useState<Record<string, InteractionRequiredEvent>>({})
  const [resolvedRecords, setResolvedRecords] = useState<ResolvedRecord[]>([])
  const [respondingId, setRespondingId] = useState<string | null>(null)
  const [staleRunIds, setStaleRunIds] = useState<string[]>([])
  const [contextOpen, setContextOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [selectedArtifactId, setSelectedArtifactId] = useState<ID | null>(null)
  const [artifactContent, setArtifactContent] = useState<ArtifactContent | null>(null)
  const [dragging, setDragging] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [startupError, setStartupError] = useState<{ message: string; detail?: string | undefined } | null>(null)
  const dragDepth = useRef(0)
  const composerFocusRef = useRef<(() => void) | null>(null)

  const activeConversation = workspace.conversations.find((item) => item.id === workspace.activeConversationId) ?? null
  const activeRunId = activeConversation ? runningRunByConversation[activeConversation.id] ?? null : null
  const nativeMediaAvailable = providerStatus?.details?.nativeMedia !== false

  // An attachment that can only ever be shared as a workspace reference
  // says so while it is still sitting in the composer, so the user learns
  // the real outcome before sending rather than from a flash mid-send.
  const displayAttachments = useMemo(
    () =>
      attachments.map((attachment) =>
        attachment.state === 'ready' && projectedState(attachment, nativeMediaAvailable) === 'reference'
          ? { ...attachment, state: 'reference' as const }
          : attachment
      ),
    [attachments, nativeMediaAvailable]
  )

  const activeMessages = useMemo(
    () =>
      workspace.messages
        .filter((message) => message.conversationId === workspace.activeConversationId)
        .sort((a, b) => a.sequence - b.sequence),
    [workspace.messages, workspace.activeConversationId]
  )

  // A session with nothing in it yet: the invitation and the composer sit
  // together in the middle rather than clinging to the bottom of a void.
  const blankSession = Boolean(activeConversation) && activeMessages.length === 0 && !activeRunId

  // Antigravity's questions are ordinary prose, so "replying" simply means
  // the last thing in the session was an assistant turn that asked one.
  const replying = useMemo(() => {
    if (activeRunId) return false
    const last = activeMessages[activeMessages.length - 1]
    return Boolean(last && last.role === 'assistant' && last.status === 'completed' && last.content.trimEnd().endsWith('?'))
  }, [activeMessages, activeRunId])

  useEffect(() => {
    const orbit = getOrbitApi()
    if (!orbit) {
      setStartupError({
        message: 'The Orbit preload API is unavailable. The renderer loaded, but Electron did not initialize window.orbit.',
        detail: 'Check the BrowserWindow preload path and Electron preload errors.'
      })
      return
    }
    void loadInitial().catch((error: unknown) => {
      setStartupError({
        message: error instanceof Error ? error.message : 'Runtime initialization failed.',
        detail: error instanceof Error ? error.stack : undefined
      })
    })
    return orbit.runs.onEvent(applyRuntimeEvent)
  }, [])

  useEffect(() => {
    if (!selectedArtifactId) {
      setArtifactContent(null)
      return
    }
    const orbit = getOrbitApi()
    if (!orbit) return
    void orbit.artifacts
      .getContent(selectedArtifactId)
      .then(setArtifactContent)
      .catch((error: unknown) => setNotice(error instanceof Error ? error.message : 'Unable to load artifact.'))
  }, [selectedArtifactId])

  if (startupError) return <StartupError message={startupError.message} detail={startupError.detail} />

  async function loadInitial(): Promise<void> {
    const orbit = requireOrbitApi()
    const [projects, status] = await Promise.all([orbit.projects.list(), orbit.providers.status()])
    setProviderStatus(status)
    // The catalogue comes from Antigravity itself. If it cannot be read we
    // show no models at all rather than inventing plausible-looking ones.
    void orbit.models
      .list()
      .then(setModels)
      .catch(() => setModels([]))
    if (projects.length === 0) {
      setWorkspace((current) => ({ ...current, projects }))
      return
    }
    await openProject(projects[0]!.id, projects)
  }

  async function openProject(projectId: ID, knownProjects = workspace.projects, preferredConversationId?: ID | null): Promise<void> {
    const orbit = requireOrbitApi()
    const snapshot = await orbit.projects.open(projectId)
    const projects = knownProjects.length ? knownProjects : await orbit.projects.list()
    setWorkspace(fromSnapshot(snapshot, projects, preferredConversationId))
    setSelectedArtifactId((current) => current ?? snapshot.artifacts[0]?.id ?? null)
  }

  async function refreshProject(preferred?: ID | null): Promise<void> {
    if (!workspace.activeProject) return
    await openProject(workspace.activeProject.id, workspace.projects, preferred ?? workspace.activeConversationId)
  }

  function applyRuntimeEvent(event: RuntimeEvent): void {
    if (event.type === 'text.delta') {
      setStreamTextByRun((current) => ({ ...current, [event.runId]: `${current[event.runId] ?? ''}${event.delta}` }))
    }
    if (event.type === 'tool.activity') {
      setActivityByRun((current) => ({ ...current, [event.runId]: applyActivity(current[event.runId] ?? emptyActivity(), event) }))
    }
    if (event.type === 'interaction.required') {
      if (event.canRespond) setPendingByRun((current) => ({ ...current, [event.runId]: event }))
      else setUnavailableByRun((current) => ({ ...current, [event.runId]: event }))
    }
    if (event.type === 'interaction.resolved') {
      setPendingByRun((current) => {
        const pending = current[event.runId]
        if (pending && pending.interactionId === event.interactionId) {
          const summary = describeResolution(event.outcome, describeInteraction(pending))
          setResolvedRecords((records) =>
            records.some((record) => record.interactionId === event.interactionId)
              ? records
              : [...records, { interactionId: event.interactionId, runId: event.runId, summary }]
          )
          const next = { ...current }
          delete next[event.runId]
          return next
        }
        return current
      })
    }
    if (event.type === 'artifact.produced') {
      setSelectedArtifactId(event.artifact.id)
      void openProject(event.projectId, [], event.conversationId)
    }
    if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') {
      setRunningRunByConversation((current) => {
        const next = { ...current }
        delete next[event.conversationId]
        return next
      })
      setPendingByRun((current) => {
        const next = { ...current }
        delete next[event.runId]
        return next
      })
      setStreamTextByRun((current) => {
        const next = { ...current }
        delete next[event.runId]
        return next
      })
      void openProject(event.projectId, [], event.conversationId)
    }
  }

  async function createProject(name: string): Promise<void> {
    const orbit = requireOrbitApi()
    const project = await orbit.projects.create({ name })
    await openProject(project.id, await orbit.projects.list())
  }

  async function createSession(): Promise<void> {
    if (!workspace.activeProject) return
    const conversation = await requireOrbitApi().conversations.create({
      projectId: workspace.activeProject.id,
      title: 'New session'
    })
    await refreshProject(conversation.id)
  }

  async function renameSession(conversationId: ID, title: string): Promise<void> {
    await requireOrbitApi().conversations.rename({ conversationId, title })
    await refreshProject()
  }

  async function deleteSession(conversationId: ID): Promise<void> {
    await requireOrbitApi().conversations.delete({ conversationId })
    const remaining = workspace.conversations.filter((item) => item.id !== conversationId)
    await refreshProject(remaining[0]?.id ?? null)
  }

  async function send(): Promise<void> {
    if (!workspace.activeProject || !activeConversation) return
    if (!composer.trim() && attachments.length === 0) return
    const content = composer.trim() || 'See the attached files.'
    const fileIds = attachments.map((attachment) => attachment.fileId)

    // Reflect the outcome each attachment is heading for before the turn
    // starts, so nothing silently changes meaning mid-send.
    setAttachments((current) => current.map((item) => ({ ...item, state: projectedState(item, nativeMediaAvailable) })))
    setComposer('')

    try {
      const run = await requireOrbitApi().messages.send({
        projectId: workspace.activeProject.id,
        conversationId: activeConversation.id,
        content,
        attachmentFileIds: fileIds
      })
      setRunningRunByConversation((current) => ({ ...current, [activeConversation.id]: run.id }))
      setActivityByRun((current) => ({ ...current, [run.id]: emptyActivity() }))
      setAttachments([])
      await refreshProject()
    } catch (error) {
      setComposer(content)
      setNotice(error instanceof Error ? error.message : 'Message could not be sent.')
    }
  }

  /** Persisted per conversation, so a session keeps the model it was
   *  started with instead of silently drifting to whatever was picked last. */
  async function changeModel(model: string | null, reasoningEffort: ReasoningEffort | null): Promise<void> {
    if (!activeConversation) return
    const conversationId = activeConversation.id
    setWorkspace((current) => ({
      ...current,
      conversations: current.conversations.map((item) => (item.id === conversationId ? { ...item, model, reasoningEffort } : item))
    }))
    try {
      await requireOrbitApi().conversations.setModel({ conversationId, model, reasoningEffort })
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'That model could not be selected.')
      await refreshProject()
    }
  }

  async function cancel(): Promise<void> {
    if (!activeRunId) return
    await requireOrbitApi().runs.cancel({ runId: activeRunId })
  }

  async function respond(optionId: string): Promise<void> {
    if (!activeConversation || !activeRunId) return
    const pending = pendingByRun[activeRunId]
    if (!pending || respondingId === pending.interactionId) return
    setRespondingId(pending.interactionId)
    try {
      await requireOrbitApi().interactions.respond({
        conversationId: activeConversation.id,
        runId: activeRunId,
        interactionId: pending.interactionId,
        optionId
      })
    } catch {
      // The backend rejects stale/duplicate answers by design — surface that
      // as an inactive request rather than a raw error.
      setStaleRunIds((current) => (current.includes(activeRunId) ? current : [...current, activeRunId]))
      setPendingByRun((current) => {
        const next = { ...current }
        delete next[activeRunId]
        return next
      })
    } finally {
      setRespondingId(null)
    }
  }

  function addProjectFiles(files: ProjectFile[]): void {
    setAttachments((current) => {
      const existing = new Set(current.map((item) => item.fileId))
      const additions = files.filter((file) => !existing.has(file.id)).map((file) => draftFromProjectFile(file))
      return [...current, ...additions]
    })
    for (const file of files) void loadThumbnail(file)
  }

  /** Thumbnails arrive as data URLs from main: the renderer's CSP forbids
   *  `file:`, so pointing an <img> at the stored path renders nothing. */
  async function loadThumbnail(file: ProjectFile): Promise<void> {
    if (!isImage(file)) return
    if (thumbnails[file.id]) return
    try {
      const dataUrl = await requireOrbitApi().files.thumbnail(file.id)
      if (!dataUrl) return
      setThumbnails((current) => ({ ...current, [file.id]: dataUrl }))
      setAttachments((current) => current.map((item) => (item.fileId === file.id ? { ...item, thumbnail: dataUrl } : item)))
    } catch {
      // A missing preview is cosmetic — the attachment itself still stands.
    }
  }

  async function pickFiles(): Promise<void> {
    if (!workspace.activeProject) return
    const files = await requireOrbitApi().files.attach({ projectId: workspace.activeProject.id })
    if (files.length === 0) return
    addProjectFiles(files)
    await refreshProject()
  }

  async function attachDroppedPaths(paths: string[]): Promise<void> {
    if (!workspace.activeProject || paths.length === 0) return
    try {
      const files = await requireOrbitApi().files.attachPaths({ projectId: workspace.activeProject.id, paths })
      addProjectFiles(files)
      await refreshProject()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Those files could not be attached.')
    }
  }

  async function attachPastedImages(files: File[]): Promise<void> {
    if (!workspace.activeProject) return
    for (const file of files) {
      try {
        const data = new Uint8Array(await file.arrayBuffer())
        const name = file.name || `pasted-image-${Date.now()}.png`
        const stored = await requireOrbitApi().files.attachImage({ projectId: workspace.activeProject.id, name, data })
        addProjectFiles([stored])
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'That image could not be attached.')
      }
    }
    await refreshProject()
  }

  function indicatorFor(conversationId: ID): SessionIndicator {
    const runId = runningRunByConversation[conversationId]
    if (!runId) return null
    return pendingByRun[runId] ? 'attention' : 'running'
  }

  const onDragOver = (event: DragEvent): void => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
  }
  const onDragEnter = (event: DragEvent): void => {
    if (!event.dataTransfer.types.includes('Files')) return
    dragDepth.current += 1
    setDragging(true)
  }
  const onDragLeave = (): void => {
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }
  const onDrop = (event: DragEvent): void => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    // Electron 32+ removed File.path (verified absent on 33.4.11), so the
    // real location must come from webUtils via the preload.
    const orbit = getOrbitApi()
    const paths = Array.from(event.dataTransfer.files)
      .map((file) => orbit?.files.pathForFile(file) ?? null)
      .filter((path): path is string => typeof path === 'string' && path.length > 0)
    void attachDroppedPaths(paths)
  }

  return (
    <div className="app">
      <ChromeBar
        projects={workspace.projects}
        activeProject={workspace.activeProject}
        providerStatus={providerStatus}
        onSelectProject={(projectId) => void openProject(projectId)}
        onCreateProject={(name) => void createProject(name)}
      />
      <ProviderBanner providerStatus={providerStatus} />
      {notice ? (
        <button type="button" className="notice" onClick={() => setNotice(null)}>
          {notice}
        </button>
      ) : null}

      <div className="body">
        <SessionSidebar
          conversations={workspace.conversations}
          activeConversationId={workspace.activeConversationId}
          indicatorFor={indicatorFor}
          collapsed={sidebarCollapsed}
          disabled={!workspace.activeProject}
          onSelect={(conversationId) => setWorkspace((current) => ({ ...current, activeConversationId: conversationId }))}
          onCreate={() => void createSession()}
          onRename={(conversationId, title) => void renameSession(conversationId, title)}
          onDelete={(conversationId) => void deleteSession(conversationId)}
          onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
        />

        <main
          className={`session${dragging ? ' dragging' : ''}${blankSession ? ' session-blank' : ''}`}
          onDragOver={onDragOver}
          onDragEnter={onDragEnter}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          <div className="session-head">
            <div className="session-heading">
              <h1>{activeConversation?.title ?? (workspace.activeProject ? 'No session selected' : 'Welcome to Orbit')}</h1>
              {activeConversation?.transport === 'pty' ? (
                <span className="live-badge" title="This conversation can ask for approval and receive images directly.">
                  Live session
                </span>
              ) : null}
            </div>
            <button
              type="button"
              className={contextOpen ? 'files-toggle active' : 'files-toggle'}
              onClick={() => setContextOpen((value) => !value)}
              aria-expanded={contextOpen}
            >
              <FilesGlyph />
              <span>Files</span>
              {workspace.projectFiles.length > 0 ? <span className="files-count">{workspace.projectFiles.length}</span> : null}
            </button>
          </div>

          <WorkSession
            project={workspace.activeProject}
            conversation={activeConversation}
            messages={activeMessages}
            runs={workspace.runs}
            projectFiles={workspace.projectFiles}
            thumbnails={thumbnails}
            activeRunId={activeRunId}
            streamText={activeRunId ? streamTextByRun[activeRunId] ?? '' : ''}
            activityByRun={activityByRun}
            pendingInteraction={activeRunId ? pendingByRun[activeRunId] ?? null : null}
            unavailableInteraction={activeRunId ? unavailableByRun[activeRunId] ?? null : null}
            staleInteraction={Boolean(activeRunId && staleRunIds.includes(activeRunId))}
            respondingInteractionId={respondingId}
            resolvedRecords={resolvedRecords}
            onRespond={(optionId) => void respond(optionId)}
          />

          {blankSession ? (
            <EmptySession
              projectName={workspace.activeProject?.name ?? null}
              onPick={(starter: Starter) => {
                setComposer(starter.prompt)
                composerFocusRef.current?.()
              }}
            />
          ) : null}

          {activeConversation ? (
            <Composer
              models={models}
              selectedModel={activeConversation.model}
              selectedEffort={activeConversation.reasoningEffort}
              onModelChange={(model, effort) => void changeModel(model, effort)}
              registerFocus={(focus) => {
                composerFocusRef.current = focus
              }}
              value={composer}
              attachments={displayAttachments}
              disabled={!activeConversation}
              running={Boolean(activeRunId)}
              replying={replying}
              onChange={setComposer}
              onSend={() => void send()}
              onCancel={() => void cancel()}
              onPickFiles={() => void pickFiles()}
              onPasteImages={(files) => void attachPastedImages(files)}
              onRemoveAttachment={(fileId) => setAttachments((current) => current.filter((item) => item.fileId !== fileId))}
              onRetryAttachment={(fileId) =>
                setAttachments((current) => current.map((item) => (item.fileId === fileId ? { ...item, state: 'ready', error: null } : item)))
              }
            />
          ) : null}

          {dragging ? <div className="drop-overlay">Drop to attach</div> : null}
        </main>

        <ContextPanel
          open={contextOpen}
          projectFiles={workspace.projectFiles}
          artifacts={workspace.artifacts}
          conversations={workspace.conversations}
          activeConversationId={workspace.activeConversationId}
          selectedArtifactId={selectedArtifactId}
          artifactContent={artifactContent}
          attachedFileIds={attachments.map((attachment) => attachment.fileId)}
          onClose={() => setContextOpen(false)}
          onAddFiles={() => void pickFiles()}
          onImportArtifacts={() => void importArtifacts()}
          onAttachFile={(file) => addProjectFiles([file])}
          onSelectArtifact={setSelectedArtifactId}
          onRevealArtifact={(artifactId) => void requireOrbitApi().artifacts.reveal(artifactId)}
          onReferenceArtifact={(artifactId, conversationId) => void referenceArtifact(artifactId, conversationId)}
        />
      </div>
    </div>
  )

  async function importArtifacts(): Promise<void> {
    if (!workspace.activeProject) return
    const imported = await requireOrbitApi().artifacts.import({
      projectId: workspace.activeProject.id,
      conversationId: activeConversation?.id ?? null
    })
    if (imported.length === 0) return
    setSelectedArtifactId(imported[0]!.id)
    await refreshProject()
  }

  async function referenceArtifact(artifactId: ID, destinationConversationId: ID): Promise<void> {
    if (!workspace.activeProject) return
    await requireOrbitApi().references.create({ projectId: workspace.activeProject.id, artifactId, destinationConversationId })
    const target = workspace.conversations.find((item) => item.id === destinationConversationId)
    setNotice(`Referenced in ${target?.title ?? 'session'}.`)
    await refreshProject()
  }
}

function FilesGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="M4 2h4l3 3v9H4z"
        stroke="currentColor"
        strokeWidth="1.25"
        fill="none"
        strokeLinejoin="round"
      />
      <path d="M8 2v3h3" stroke="currentColor" strokeWidth="1.25" fill="none" strokeLinejoin="round" />
    </svg>
  )
}

function requireOrbitApi(): NonNullable<ReturnType<typeof getOrbitApi>> {
  const orbit = getOrbitApi()
  if (!orbit) throw new Error('The Orbit preload API is unavailable.')
  return orbit
}

function fromSnapshot(snapshot: ProjectSnapshot, projects: Project[], preferredConversationId?: ID | null): WorkspaceState {
  const activeConversationId =
    preferredConversationId && snapshot.conversations.some((conversation) => conversation.id === preferredConversationId)
      ? preferredConversationId
      : (snapshot.conversations[0]?.id ?? null)
  return {
    projects,
    activeProject: snapshot.project,
    conversations: snapshot.conversations,
    activeConversationId,
    messages: snapshot.messages,
    runs: snapshot.runs,
    artifacts: snapshot.artifacts,
    projectFiles: snapshot.projectFiles,
    references: snapshot.references
  }
}

// Referenced for its side effect of keeping the native-image policy shared
// between composer preview and the main process's own filter.
void isNativeImage
