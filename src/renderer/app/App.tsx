import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import type { ArtifactContent } from '@shared/contracts'
import type {
  Artifact,
  Conversation,
  ID,
  Message,
  ModelOption,
  OrbitPreferences,
  Project,
  ProjectFile,
  ProjectGroup,
  ProjectSnapshot,
  ProviderStatus,
  ReasoningEffort,
  Reference,
  Run
} from '@shared/domain'
import type { InteractionRequiredEvent, RuntimeEvent } from '@shared/runtime-events'
import { EMPTY_PREFERENCES, effortForModel, modelForSelection, preferenceKeyFor, rememberEffort } from '@shared/reasoningPolicy'
import { StartupError } from './ErrorBoundary'
import { getOrbitApi } from './orbitApi'
import { ChromeBar, ProviderBanner } from './components/ChromeBar'
import { ProjectSidebar, type CreateIntent, type SessionIndicator } from './components/ProjectSidebar'
import { CreateProjectDialog, CreateSessionDialog } from './components/CreateDialogs'
import { WorkSession, type ResolvedRecord } from './components/WorkSession'
import { WorkspaceRail } from './components/WorkspaceRail'
import { Composer } from './components/Composer'
import { ComposerHints, EmptySession, type Starter } from './components/EmptySession'
import { ContextPanel, type ContextTab } from './components/ContextPanel'
import { ProviderLogoSprite } from './components/ProviderLogo'
import { applyActivity, emptyActivity, type ActivityState } from './lib/activity'
import { RuntimeEventBatcher, type RuntimeEventBatch } from './lib/runtimeEventBatcher'
import { describeInteraction, describeResolution } from './lib/interactionCopy'
import { draftFromProjectFile, isImage, isNativeImage, projectedState, type DraftAttachment } from './lib/attachments'

/** Which project groups are open in the sidebar. Kept in the renderer rather
 *  than the database: it is view state, and losing it costs one click. */
const EXPANDED_KEY = 'orbit.sidebar.expandedProjects'

interface WorkspaceState {
  activeProjectId: ID | null
  activeConversationId: ID | null
  messages: Message[]
  runs: Run[]
  artifacts: Artifact[]
  projectFiles: ProjectFile[]
  references: Reference[]
}

const emptyWorkspace: WorkspaceState = {
  activeProjectId: null,
  activeConversationId: null,
  messages: [],
  runs: [],
  artifacts: [],
  projectFiles: [],
  references: []
}

export function App(): JSX.Element {
  const [tree, setTree] = useState<ProjectGroup[]>([])
  const [workspace, setWorkspace] = useState<WorkspaceState>(emptyWorkspace)
  const [providerStatus, setProviderStatus] = useState<ProviderStatus | null>(null)
  const [models, setModels] = useState<ModelOption[]>([])
  const [preferences, setPreferences] = useState<OrbitPreferences>(EMPTY_PREFERENCES)
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
  const [contextTab, setContextTab] = useState<ContextTab | null>(null)
  const [expandedProjectIds, setExpandedProjectIds] = useState<ID[]>(readExpanded)
  const [creating, setCreating] = useState<CreateIntent | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [selectedArtifactId, setSelectedArtifactId] = useState<ID | null>(null)
  const [artifactContent, setArtifactContent] = useState<ArtifactContent | null>(null)
  const [dragging, setDragging] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [startupError, setStartupError] = useState<{ message: string; detail?: string | undefined } | null>(null)
  const dragDepth = useRef(0)
  const composerFocusRef = useRef<(() => void) | null>(null)
  /** Sessions whose reasoning tier has already been settled this launch, so
   *  seeding a migrated session can never turn into a write loop. */
  const seededEffortIds = useRef(new Set<ID>())

  const projects = useMemo(() => tree.map((group) => group.project), [tree])
  const activeProject = projects.find((project) => project.id === workspace.activeProjectId) ?? null
  const activeGroup = tree.find((group) => group.project.id === workspace.activeProjectId) ?? null
  const conversations = activeGroup?.conversations ?? []
  const activeConversation = conversations.find((item) => item.id === workspace.activeConversationId) ?? null
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
    const batcher = new RuntimeEventBatcher(flushRuntimeEventBatch, applyRuntimeEvent)
    const unsubscribe = orbit.runs.onEvent((event) => batcher.push(event))
    return () => {
      unsubscribe()
      batcher.dispose()
    }
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

  useEffect(() => {
    writeExpanded(expandedProjectIds)
  }, [expandedProjectIds])

  // A session carried over from before Orbit had a reasoning preference has
  // no tier at all. Rather than leaving it on "Auto" forever, settle it once
  // from the same policy a new session uses — the user's remembered level.
  useEffect(() => {
    if (!activeConversation || models.length === 0) return
    if (activeConversation.reasoningEffort !== null) return
    if (seededEffortIds.current.has(activeConversation.id)) return
    const target = modelForSelection(models, activeConversation.model)
    const effort = effortForModel(target, preferences)
    if (!effort) return
    seededEffortIds.current.add(activeConversation.id)
    void persistModel(activeConversation.id, activeConversation.model, effort)
  }, [activeConversation, models, preferences])

  if (startupError) return <StartupError message={startupError.message} detail={startupError.detail} />

  async function loadInitial(): Promise<void> {
    const orbit = requireOrbitApi()
    const [groups, status, storedPreferences] = await Promise.all([
      orbit.projects.tree(),
      orbit.providers.status(),
      orbit.preferences.get()
    ])
    setProviderStatus(status)
    setPreferences(storedPreferences)
    setTree(groups)
    // The catalogue comes from Antigravity itself. If it cannot be read we
    // show no models at all rather than inventing plausible-looking ones.
    void orbit.models
      .list()
      .then(setModels)
      .catch(() => setModels([]))
    const first = groups[0]?.project
    if (!first) return
    setExpandedProjectIds((current) => (current.includes(first.id) ? current : [...current, first.id]))
    await openProject(first.id)
  }

  async function openProject(projectId: ID, preferredConversationId?: ID | null): Promise<void> {
    const orbit = requireOrbitApi()
    const [snapshot, groups] = await Promise.all([orbit.projects.open(projectId), orbit.projects.tree()])
    setTree(groups)
    setWorkspace(fromSnapshot(snapshot, preferredConversationId ?? workspaceConversationFor(groups, projectId, preferredConversationId)))
    setSelectedArtifactId((current) => current ?? snapshot.artifacts[0]?.id ?? null)
  }

  async function refreshProject(preferred?: ID | null): Promise<void> {
    if (!workspace.activeProjectId) return
    await openProject(workspace.activeProjectId, preferred ?? workspace.activeConversationId)
  }

  function flushRuntimeEventBatch(batch: RuntimeEventBatch): void {
    if (Object.keys(batch.textDeltas).length > 0) {
      setStreamTextByRun((current) => {
        let changed = false
        const next = { ...current }
        for (const [runId, delta] of Object.entries(batch.textDeltas)) {
          if (!delta) continue
          next[runId] = `${next[runId] ?? ''}${delta}`
          changed = true
        }
        return changed ? next : current
      })
    }

    if (batch.toolActivities.length > 0) {
      setActivityByRun((current) => {
        let next = current
        for (const event of batch.toolActivities) {
          next = { ...next, [event.runId]: applyActivity(next[event.runId] ?? emptyActivity(), event) }
        }
        return next
      })
    }
  }

  /** Reloads the project, then — and only then — retires the run's live
   *  state, so the streamed reply stays on screen until the stored
   *  assistant message has taken over from it. */
  async function refreshAfterRun(projectId: ID, conversationId: ID, runId: ID): Promise<void> {
    try {
      await openProject(projectId, conversationId)
    } finally {
      setRunningRunByConversation((current) => {
        if (current[conversationId] !== runId) return current
        const next = { ...current }
        delete next[conversationId]
        return next
      })
      setStreamTextByRun((current) => {
        if (!(runId in current)) return current
        const next = { ...current }
        delete next[runId]
        return next
      })
    }
  }

  function applyRuntimeEvent(event: RuntimeEvent): void {
    if (event.type === 'interaction.required') {
      if (event.canRespond) {
        setPendingByRun((current) => ({ ...current, [event.runId]: event }))
        // Antigravity can raise a prompt after it has already reported the
        // turn complete (the PTY screen is read asynchronously). Without
        // this the card would have nowhere to render and the session would
        // sit blocked behind a request the user was never shown.
        setRunningRunByConversation((current) =>
          current[event.conversationId] === event.runId ? current : { ...current, [event.conversationId]: event.runId }
        )
      } else setUnavailableByRun((current) => ({ ...current, [event.runId]: event }))
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
      void openProject(event.projectId, event.conversationId)
    }
    if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') {
      setPendingByRun((current) => {
        const next = { ...current }
        delete next[event.runId]
        return next
      })
      // The live run and its streamed text are what the transcript is
      // currently drawing the reply from; the persisted assistant message
      // only exists after the refresh below has come back. Dropping them
      // first blanks a finished answer for as long as that round trip
      // takes — so the hand-off happens the other way round, and the reply
      // is never off screen for a frame.
      void refreshAfterRun(event.projectId, event.conversationId, event.runId)
    }
  }

  async function createProject(input: { name: string; rootPath: string | null }): Promise<void> {
    const orbit = requireOrbitApi()
    try {
      const project = await orbit.projects.create({ name: input.name, rootPath: input.rootPath })
      setCreating(null)
      setExpandedProjectIds((current) => (current.includes(project.id) ? current : [...current, project.id]))
      await openProject(project.id)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'That project could not be created.')
    }
  }

  async function createSession(input: { projectId: ID; title: string | null; workingDirectory: string | null }): Promise<void> {
    const orbit = requireOrbitApi()
    try {
      const conversation = await orbit.conversations.create({
        projectId: input.projectId,
        ...(input.title ? { title: input.title } : {}),
        workingDirectory: input.workingDirectory
      })
      setCreating(null)
      setExpandedProjectIds((current) => (current.includes(input.projectId) ? current : [...current, input.projectId]))
      await openProject(input.projectId, conversation.id)
      composerFocusRef.current?.()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'That session could not be created.')
    }
  }

  async function renameSession(conversationId: ID, title: string): Promise<void> {
    await requireOrbitApi().conversations.rename({ conversationId, title })
    await refreshProject()
  }

  async function deleteSession(conversationId: ID): Promise<void> {
    await requireOrbitApi().conversations.delete({ conversationId })
    const remaining = conversations.filter((item) => item.id !== conversationId)
    await refreshProject(remaining[0]?.id ?? null)
  }

  async function selectSession(projectId: ID, conversationId: ID): Promise<void> {
    if (projectId === workspace.activeProjectId) {
      setWorkspace((current) => ({ ...current, activeConversationId: conversationId }))
      return
    }
    await openProject(projectId, conversationId)
  }

  async function send(): Promise<void> {
    if (!workspace.activeProjectId || !activeConversation) return
    if (!composer.trim() && attachments.length === 0) return
    const content = composer.trim() || 'See the attached files.'
    const fileIds = attachments.map((attachment) => attachment.fileId)

    // Reflect the outcome each attachment is heading for before the turn
    // starts, so nothing silently changes meaning mid-send.
    setAttachments((current) => current.map((item) => ({ ...item, state: projectedState(item, nativeMediaAvailable) })))
    setComposer('')

    try {
      const run = await requireOrbitApi().messages.send({
        projectId: workspace.activeProjectId,
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
  async function persistModel(conversationId: ID, model: string | null, reasoningEffort: ReasoningEffort | null): Promise<void> {
    setTree((current) =>
      current.map((group) => ({
        ...group,
        conversations: group.conversations.map((item) => (item.id === conversationId ? { ...item, model, reasoningEffort } : item))
      }))
    )
    try {
      await requireOrbitApi().conversations.setModel({ conversationId, model, reasoningEffort })
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'That model could not be selected.')
      await refreshProject()
    }
  }

  /** Choosing a model does not choose a tier: the tier comes from what this
   *  user has chosen before, mapped onto what the new model genuinely
   *  offers. A model with no tiers lands on none. */
  function selectModel(modelId: string | null): void {
    if (!activeConversation) return
    const target = modelForSelection(models, modelId)
    void persistModel(activeConversation.id, modelId, effortForModel(target, preferences))
  }

  /** The only thing that updates the remembered preference: an explicit
   *  click or keypress on a tier. */
  function selectEffort(effort: ReasoningEffort): void {
    if (!activeConversation) return
    const next = rememberEffort(preferences, preferenceKeyFor(activeConversation.model), effort)
    setPreferences(next)
    void requireOrbitApi()
      .preferences.set(next)
      .catch(() => {
        // A preference that failed to persist still applies to this session;
        // it simply will not be remembered next launch.
      })
    void persistModel(activeConversation.id, activeConversation.model, effort)
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
    if (!workspace.activeProjectId) return
    const files = await requireOrbitApi().files.attach({ projectId: workspace.activeProjectId })
    if (files.length === 0) return
    addProjectFiles(files)
    await refreshProject()
  }

  async function attachDroppedPaths(paths: string[]): Promise<void> {
    if (!workspace.activeProjectId || paths.length === 0) return
    try {
      const files = await requireOrbitApi().files.attachPaths({ projectId: workspace.activeProjectId, paths })
      addProjectFiles(files)
      await refreshProject()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Those files could not be attached.')
    }
  }

  async function attachPastedImages(files: File[]): Promise<void> {
    if (!workspace.activeProjectId) return
    for (const file of files) {
      try {
        const data = new Uint8Array(await file.arrayBuffer())
        const name = file.name || `pasted-image-${Date.now()}.png`
        const stored = await requireOrbitApi().files.attachImage({ projectId: workspace.activeProjectId, name, data })
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
      <ProviderLogoSprite />
      <ProjectSidebar
        groups={tree}
        activeProjectId={workspace.activeProjectId}
        activeConversationId={workspace.activeConversationId}
        expandedProjectIds={expandedProjectIds}
        indicatorFor={indicatorFor}
        collapsed={sidebarCollapsed}
        onToggleProject={(projectId) =>
          setExpandedProjectIds((current) =>
            current.includes(projectId) ? current.filter((id) => id !== projectId) : [...current, projectId]
          )
        }
        onSelectSession={(projectId, conversationId) => void selectSession(projectId, conversationId)}
        onCreate={setCreating}
        onRename={(conversationId, title) => void renameSession(conversationId, title)}
        onDelete={(conversationId) => void deleteSession(conversationId)}
        onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
      />

      <div className="workspace">
        <ChromeBar
          activeProject={activeProject}
          sessionTitle={activeConversation?.title ?? null}
          workingPath={workingPathFor(activeProject, activeConversation)}
          live={activeConversation?.transport === 'pty'}
        />
        <ProviderBanner providerStatus={providerStatus} />
        {notice ? (
          <button type="button" className="notice" onClick={() => setNotice(null)}>
            {notice}
          </button>
        ) : null}

        <div className="body">
          <main
            className={`session${dragging ? ' dragging' : ''}${blankSession ? ' session-blank' : ''}`}
            onDragOver={onDragOver}
            onDragEnter={onDragEnter}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          >
            <WorkSession
              project={activeProject}
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
                projectName={activeProject?.name ?? null}
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
                onSelectModel={selectModel}
                onSelectEffort={selectEffort}
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

            {blankSession && activeConversation ? <ComposerHints /> : null}

            {dragging ? <div className="drop-overlay">Drop to attach</div> : null}
          </main>

          <ContextPanel
            tab={contextTab}
            onSelectTab={setContextTab}
            projectFiles={workspace.projectFiles}
            artifacts={workspace.artifacts}
            conversations={conversations}
            activeConversationId={workspace.activeConversationId}
            selectedArtifactId={selectedArtifactId}
            artifactContent={artifactContent}
            attachedFileIds={attachments.map((attachment) => attachment.fileId)}
            onClose={() => setContextTab(null)}
            onAddFiles={() => void pickFiles()}
            onImportArtifacts={() => void importArtifacts()}
            onAttachFile={(file) => addProjectFiles([file])}
            onSelectArtifact={setSelectedArtifactId}
            onRevealArtifact={(artifactId) => void requireOrbitApi().artifacts.reveal(artifactId)}
            onReferenceArtifact={(artifactId, conversationId) => void referenceArtifact(artifactId, conversationId)}
          />

          {/* The drawer's own controls, on the edge the drawer comes from. */}
          <WorkspaceRail
            tab={contextTab}
            fileCount={workspace.projectFiles.length}
            artifactCount={workspace.artifacts.length}
            onSelect={(tab) => setContextTab((current) => (current === tab ? null : tab))}
          />
        </div>
      </div>

      {creating?.kind === 'project' ? (
        <CreateProjectDialog
          onCancel={() => setCreating(null)}
          onCreate={(input) => void createProject(input)}
          pickFolder={() => requireOrbitApi().dialog.pickFolder({ title: 'Choose the project folder' })}
        />
      ) : null}

      {creating?.kind === 'session' && projects.length > 0 ? (
        <CreateSessionDialog
          projects={projects}
          initialProjectId={creating.projectId ?? workspace.activeProjectId}
          onCancel={() => setCreating(null)}
          onCreate={(input) => void createSession(input)}
          pickFolder={(defaultPath) =>
            requireOrbitApi().dialog.pickFolder({ title: 'Choose the session folder', defaultPath })
          }
        />
      ) : null}
    </div>
  )

  async function importArtifacts(): Promise<void> {
    if (!workspace.activeProjectId) return
    const imported = await requireOrbitApi().artifacts.import({
      projectId: workspace.activeProjectId,
      conversationId: activeConversation?.id ?? null
    })
    if (imported.length === 0) return
    setSelectedArtifactId(imported[0]!.id)
    await refreshProject()
  }

  async function referenceArtifact(artifactId: ID, destinationConversationId: ID): Promise<void> {
    if (!workspace.activeProjectId) return
    await requireOrbitApi().references.create({
      projectId: workspace.activeProjectId,
      artifactId,
      destinationConversationId
    })
    const target = conversations.find((item) => item.id === destinationConversationId)
    setNotice(`Referenced in ${target?.title ?? 'session'}.`)
    await refreshProject()
  }
}

function requireOrbitApi(): NonNullable<ReturnType<typeof getOrbitApi>> {
  const orbit = getOrbitApi()
  if (!orbit) throw new Error('The Orbit preload API is unavailable.')
  return orbit
}

/** The folder the header reports. A session override wins; otherwise the
 *  project's own folder; otherwise nothing is claimed, because the managed
 *  workspace is an internal location and not a place the user chose. */
function workingPathFor(project: Project | null, conversation: Conversation | null): string | null {
  return conversation?.workingDirectory ?? project?.rootPath ?? null
}

function workspaceConversationFor(groups: ProjectGroup[], projectId: ID, preferred?: ID | null): ID | null {
  const group = groups.find((candidate) => candidate.project.id === projectId)
  if (!group) return null
  if (preferred && group.conversations.some((conversation) => conversation.id === preferred)) return preferred
  return group.conversations[0]?.id ?? null
}

function fromSnapshot(snapshot: ProjectSnapshot, activeConversationId: ID | null): WorkspaceState {
  return {
    activeProjectId: snapshot.project.id,
    activeConversationId:
      activeConversationId && snapshot.conversations.some((conversation) => conversation.id === activeConversationId)
        ? activeConversationId
        : (snapshot.conversations[0]?.id ?? null),
    messages: snapshot.messages,
    runs: snapshot.runs,
    artifacts: snapshot.artifacts,
    projectFiles: snapshot.projectFiles,
    references: snapshot.references
  }
}

function readExpanded(): ID[] {
  try {
    const raw = window.localStorage.getItem(EXPANDED_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  } catch {
    return []
  }
}

function writeExpanded(ids: readonly ID[]): void {
  try {
    window.localStorage.setItem(EXPANDED_KEY, JSON.stringify(ids))
  } catch {
    // Sidebar view state is not worth surfacing an error for.
  }
}

// Referenced for its side effect of keeping the native-image policy shared
// between composer preview and the main process's own filter.
void isNativeImage
