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
import { resolveModelId } from '@shared/defaultModel'
import { resolveSidebarWidth } from '@shared/reasoningPolicy'
import type { PermissionMode } from '@shared/permissionMode'
import type { ResolvedDefaultModel } from '@shared/newSessionDefaults'
import type { AttachmentPickerCategory } from '@shared/attachmentPicker'
import { SettingsPanel } from './components/SettingsPanel'
import { SidebarResizer } from './components/SidebarResizer'
import { StartupError } from './ErrorBoundary'
import { getOrbitApi, requireOrbitApi } from './orbitApi'
import { ChromeBar, ProviderBanner } from './components/ChromeBar'
import { ProjectSidebar, type SessionIndicator } from './components/ProjectSidebar'
import { CreateProjectDialog } from './components/CreateDialogs'
import { WorkSession, type ResolvedRecord } from './components/WorkSession'
import { WorkspaceRail } from './components/WorkspaceRail'
import { Composer } from './components/Composer'
import { ComposerHints, EmptySession, type Starter } from './components/EmptySession'
import { ContextPanel, type ContextTab } from './components/ContextPanel'
import { ProviderLogoSprite } from './components/ProviderLogo'
import { applyActivity, emptyActivity, finalizeActivity, pruneActivity, type ActivityState } from './lib/activity'
import { agentIdentity } from './lib/agentIdentity'
import { NO_REPOSITORY, type RepositoryState } from '@shared/repositoryActions'
import { mediaKindFor } from '@shared/outputArtifacts'
import { ArtifactToasts, type ArtifactNotice } from './components/ArtifactToast'
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
  const [repository, setRepository] = useState<RepositoryState>(NO_REPOSITORY)
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
  /** Runs the user has pressed Stop on that have not reported their ending
   *  yet. Purely presentational: it turns the gap between the request and
   *  the acknowledgement into a stated "Stopping…" rather than a stall that
   *  looks like the app hanging. Cleared by the run's real ending. */
  const [stoppingRunIds, setStoppingRunIds] = useState<string[]>([])
  const [contextTab, setContextTab] = useState<ContextTab | null>(null)
  const [expandedProjectIds, setExpandedProjectIds] = useState<ID[]>(readExpanded)
  const [creatingProject, setCreatingProject] = useState(false)
  /** The session a just-finished create is waiting to hand the composer to.
   *  Focus cannot be taken at create time: the composer for a brand-new
   *  session has not mounted yet, and for the first session in the app it
   *  does not exist at all. Cleared by the effect that lands the focus. */
  const [focusPendingId, setFocusPendingId] = useState<ID | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  /** The sidebar's live width. Seeded from the stored preference once it
   *  loads, then owned here — App is the single source of truth for it, and
   *  the resizer is a control over this value rather than a second copy. */
  const [sidebarWidth, setSidebarWidth] = useState(() => resolveSidebarWidth(null))
  const [selectedArtifactId, setSelectedArtifactId] = useState<ID | null>(null)
  const [artifactContent, setArtifactContent] = useState<ArtifactContent | null>(null)
  const [dragging, setDragging] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [artifactNotices, setArtifactNotices] = useState<ArtifactNotice[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [modelStatus, setModelStatus] = useState<ResolvedDefaultModel | null>(null)
  const [clearing, setClearing] = useState(false)
  const [unsorted, setUnsorted] = useState<Conversation[]>([])
  const [startupError, setStartupError] = useState<{ message: string; detail?: string | undefined } | null>(null)
  const dragDepth = useRef(0)
  const composerFocusRef = useRef<(() => void) | null>(null)
  /** Sessions whose reasoning tier has already been settled this launch, so
   *  seeding a migrated session can never turn into a write loop. */
  const seededEffortIds = useRef(new Set<ID>())
  /** Runs that currently owe the user an answer to a native prompt.
   *
   *  A ref rather than derived state because it is read from inside the
   *  completion refresh's `finally`, which runs long after that refresh was
   *  started and must see what is true *now*, not what was true when the run
   *  completed — see `refreshAfterRun`. */
  const runsAwaitingInteraction = useRef(new Set<ID>())
  /** A mirror of `runningRunByConversation`, readable from the asynchronous
   *  project load. Pruning per-run state has to know which runs are still
   *  in flight, and that load resolves long after it was started — reading
   *  the state variable there would see whatever was true when the load
   *  began, which for a run started moments earlier is nothing. */
  const runningRunByConversationRef = useRef<Record<string, string>>({})

  runningRunByConversationRef.current = runningRunByConversation
  /** The session on screen, readable from the runtime-event handler, which
   *  is subscribed once and would otherwise see the first render's value. */
  const activeConversationIdRef = useRef<ID | null>(null)
  activeConversationIdRef.current = workspace.activeConversationId

  const projects = useMemo(() => tree.map((group) => group.project), [tree])
  const activeProject = projects.find((project) => project.id === workspace.activeProjectId) ?? null
  const activeGroup = tree.find((group) => group.project.id === workspace.activeProjectId) ?? null
  // No active project is the Unsorted workspace, whose sessions live in
  // their own list rather than under any project group.
  const conversations = workspace.activeProjectId === null ? unsorted : (activeGroup?.conversations ?? [])
  const activeConversation = conversations.find((item) => item.id === workspace.activeConversationId) ?? null
  const activeRunId = activeConversation ? runningRunByConversation[activeConversation.id] ?? null : null

  // Read once per session, and again whenever a turn finishes — a turn is
  // the thing most likely to have changed the working tree, and the chips
  // must not keep offering "Commit changes" after the agent has committed.
  // Deliberately not polled: git is not free, and nothing else here can
  // change the repository behind Orbit's back mid-turn.
  const repositoryConversationId = activeConversation?.id ?? null
  useEffect(() => {
    if (!repositoryConversationId || activeRunId) return
    let cancelled = false
    void requireOrbitApi()
      .repository.state({ conversationId: repositoryConversationId })
      .then((next) => {
        if (!cancelled) setRepository(next)
      })
      .catch(() => {
        // A folder Orbit cannot read git in simply shows no chips.
        if (!cancelled) setRepository(NO_REPOSITORY)
      })
    return () => {
      cancelled = true
    }
  }, [repositoryConversationId, activeRunId])
  // Who is actually working: the session's own model, resolved against the
  // real catalogue. Orbit's Saturn stands for Orbit and is never used here.
  const identity = useMemo(() => agentIdentity(models, activeConversation?.model ?? null), [models, activeConversation?.model])
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

  // A new session lands the user in the composer, ready to type. This waits
  // for the session to actually be the active one, because that is the
  // render that mounts the composer and registers its focus callback (a
  // child effect, so it has already run by the time this one does).
  useEffect(() => {
    if (!focusPendingId) return
    if (workspace.activeConversationId !== focusPendingId) return
    composerFocusRef.current?.()
    setFocusPendingId(null)
  }, [focusPendingId, workspace.activeConversationId])

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

  /** Session settings are launch flags: the turn agy runs is decided by
   *  what is persisted, not by what the composer is showing. Every write
   *  chains onto this, and Send waits on it, so the selected state and the
   *  state the runtime launches with can never disagree. */
  const sessionSettingsRef = useRef<Promise<unknown>>(Promise.resolve())

  // Remember where the user is, so the next launch reopens it. Any session
  // counts — Unsorted ones included — and only the id is sent: the main
  // process reads the session's project from the database, and owns these
  // fields outright so no other preference write can roll them back.
  const markedActiveRef = useRef<ID | null>(null)
  useEffect(() => {
    const conversationId = workspace.activeConversationId
    if (!conversationId || markedActiveRef.current === conversationId) return
    markedActiveRef.current = conversationId
    void getOrbitApi()?.conversations.markActive?.(conversationId).catch(() => undefined)
  }, [workspace.activeConversationId])

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
    setSidebarWidth(resolveSidebarWidth(storedPreferences.sidebarWidth))
    setTree(groups)
    // The catalogue comes from Antigravity itself. If it cannot be read we
    // show no models at all rather than inventing plausible-looking ones.
    void orbit.models
      .list()
      .then(setModels)
      .catch(() => setModels([]))
    // Orbit reopens the session the user was last in. The main process
    // resolves it before anything is drawn — the remembered session if it
    // still exists, else the most recent one, and a new session only when
    // there are none (see startupSession.ts) — so no blank session is ever
    // created and then switched away from. It memoizes that answer for the
    // launch, so asking again after a remount or reload is safe.
    const startup = await orbit.startup.session().catch(() => null)
    if (startup) {
      if (startup.projectId) {
        const projectId = startup.projectId
        setExpandedProjectIds((current) => (current.includes(projectId) ? current : [...current, projectId]))
      }
      await openWorkspace(startup.projectId, startup.conversationId)
      setFocusPendingId(startup.conversationId)
      return
    }
    // The launch session could not be created. Fall back to opening a
    // project, on its own most recent session — never on a restored
    // `lastActive` one.
    const remembered = groups.find((group) => group.project.id === storedPreferences.lastActiveProjectId)?.project
    const target = remembered ?? groups[0]?.project
    if (!target) return
    setExpandedProjectIds((current) => (current.includes(target.id) ? current : [...current, target.id]))
    await openProject(target.id)
  }

  /** Opens a workspace: a project, or — with null — the Unsorted one.
   *  Both come back as the same snapshot shape, so everything downstream
   *  treats "no project" as an ordinary state rather than a missing one. */
  async function openWorkspace(projectId: ID | null, preferredConversationId?: ID | null): Promise<void> {
    const orbit = requireOrbitApi()
    const [snapshot, groups, unsortedSessions] = await Promise.all([
      projectId ? orbit.projects.open(projectId) : orbit.projects.openUnsorted(),
      orbit.projects.tree(),
      orbit.conversations.listUnsorted()
    ])
    setTree(groups)
    setUnsorted(unsortedSessions)
    setWorkspace(
      fromSnapshot(
        snapshot,
        preferredConversationId ?? (projectId ? workspaceConversationFor(groups, projectId, preferredConversationId) : null)
      )
    )
    setSelectedArtifactId((current) => current ?? snapshot.artifacts[0]?.id ?? null)
    // Live per-run state belongs to the project that is open. Anything for
    // a run this project does not contain is another project's — dropping
    // it here is what keeps switching projects from accumulating other
    // runs' activity (and their timers) for the rest of the session. A run
    // that is still going is kept regardless: its snapshot row exists, but
    // the guard is explicit so an in-flight run can never be pruned.
    setActivityByRun((current) => pruneActivity(current, [...snapshot.runs.map((run) => run.id), ...Object.values(runningRunByConversationRef.current)]))
  }

  const openProject = openWorkspace

  async function refreshProject(preferred?: ID | null): Promise<void> {
    // No project id is the Unsorted workspace, which still refreshes.
    await openWorkspace(workspace.activeProjectId, preferred ?? workspace.activeConversationId)
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
  async function refreshAfterRun(projectId: ID | null, conversationId: ID, runId: ID): Promise<void> {
    try {
      await openProject(projectId, conversationId)
    } finally {
      setRunningRunByConversation((current) => {
        if (current[conversationId] !== runId) return current
        // CRITICAL: Antigravity can raise a prompt *after* reporting the turn
        // complete, and this refresh may still have been in flight when it
        // did. That prompt puts the run back in charge of the conversation,
        // and retiring it here — merely because the id still matches the run
        // this refresh was started for — would hide a question the user has
        // to answer and leave the session wedged behind it. A run that owes
        // the user an answer keeps the conversation; the next completion
        // retires it.
        if (runsAwaitingInteraction.current.has(runId)) return current
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
      // The turn is over and the composer is live again; put the cursor
      // back in it so the next message needs no click. Only when this
      // session is the one on screen — focusing a composer the user is not
      // looking at would steal their cursor from wherever they are.
      if (workspace.activeConversationId === conversationId) composerFocusRef.current?.()
    }
  }

  function applyRuntimeEvent(event: RuntimeEvent): void {
    if (event.type === 'interaction.required') {
      if (event.canRespond) {
        runsAwaitingInteraction.current.add(event.runId)
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
      runsAwaitingInteraction.current.delete(event.runId)
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
      // Only media gets a toast, and only for a session the user is not
      // looking at: in the session on screen the output is drawn right under
      // the reply, and announcing it as well would say the same thing twice.
      // The run's own ending, which follows immediately, reloads the
      // workspace — so nothing is refreshed here per artifact.
      const kind = mediaKindFor(event.artifact.name)
      if (kind && event.conversationId !== activeConversationIdRef.current) {
        setArtifactNotices((current) =>
          // Keyed by artifact id, so the same registration can never be
          // announced twice however many times the event is delivered.
          current.some((item) => item.artifactId === event.artifact.id)
            ? current
            : [...current, { artifactId: event.artifact.id, name: event.artifact.name, kind }]
        )
      }
    }
    if (event.type === 'run.notice') setNotice(event.message)
    if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') {
      // The turn is over; anything it was waiting on is stale. A prompt that
      // arrives *after* this re-adds itself above, and the refresh below then
      // leaves the run alone.
      runsAwaitingInteraction.current.delete(event.runId)
      setPendingByRun((current) => {
        const next = { ...current }
        delete next[event.runId]
        return next
      })
      // CRITICAL: the run is over, so nothing it started may still be
      // counting. Any step left mid-flight — which is exactly what a
      // cancelled or crashed turn leaves behind — is closed here, so no
      // activity row can outlive the run that created it.
      setActivityByRun((current) => {
        const activity = current[event.runId]
        if (!activity) return current
        const settled = finalizeActivity(activity)
        return settled === activity ? current : { ...current, [event.runId]: settled }
      })
      setStoppingRunIds((current) => (current.includes(event.runId) ? current.filter((id) => id !== event.runId) : current))
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
      setCreatingProject(false)
      setExpandedProjectIds((current) => (current.includes(project.id) ? current : [...current, project.id]))
      await openProject(project.id)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'That project could not be created.')
    }
  }

  /** One click, one session. Nothing is asked for: the session belongs to
   *  the project whose control was used, inherits that project's folder
   *  (no workingDirectory means exactly that), and is called `New Session`
   *  until its first prompt names it. It is then opened and handed the
   *  composer so the user can just start typing. */
  /** One click, one session. Null means Unsorted — a session that belongs
   *  to no project and can be typed into immediately; a project id puts it
   *  in that project, which is what a project's own + does. */
  async function createSession(projectId: ID | null): Promise<void> {
    const orbit = requireOrbitApi()
    try {
      const conversation = await orbit.conversations.create({ projectId })
      if (projectId) setExpandedProjectIds((current) => (current.includes(projectId) ? current : [...current, projectId]))
      await openWorkspace(projectId, conversation.id)
      setFocusPendingId(conversation.id)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'That session could not be created.')
    }
  }

  /** Settings reads the live catalogue status each time it opens, so a
   *  saved default that has since disappeared is reported the moment the
   *  user looks, not whenever the app happened to start. */
  async function openSettings(): Promise<void> {
    setSettingsOpen(true)
    try {
      setModelStatus(await requireOrbitApi().defaults.modelStatus())
    } catch {
      setModelStatus(null)
    }
  }

  async function saveDefaults(next: OrbitPreferences): Promise<void> {
    savePreferences(next)
    try {
      setModelStatus(await requireOrbitApi().defaults.modelStatus())
    } catch {
      // The panel keeps showing what it had; nothing was lost.
    }
  }

  async function clearAllData(confirmation: string): Promise<void> {
    setClearing(true)
    try {
      // Succeeds by relaunching, so there is deliberately nothing after it.
      await requireOrbitApi().data.clearAll({ confirmation })
    } catch (error) {
      setClearing(false)
      setNotice(error instanceof Error ? error.message : 'Orbit data could not be cleared.')
    }
  }

  /** Files the open Unsorted session into a project. The same session
   *  moves — its transcript, its native conversation id and every setting
   *  come with it — and its working directory is deliberately left alone,
   *  so nothing it has already written is relocated or overwritten. */
  async function assignSessionToProject(projectId: ID): Promise<void> {
    if (!activeConversation) return
    const conversationId = activeConversation.id
    try {
      await requireOrbitApi().conversations.assignProject({ conversationId, projectId })
      await openWorkspace(projectId, conversationId)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'That session could not be added to the project.')
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

  async function selectSession(projectId: ID | null, conversationId: ID): Promise<void> {
    if (projectId === workspace.activeProjectId) {
      setWorkspace((current) => ({ ...current, activeConversationId: conversationId }))
      return
    }
    await openWorkspace(projectId, conversationId)
  }

  /** Sends the composer's contents, or `promptOverride` when one is given.
   *
   *  The override is how a repository quick action submits: it takes the
   *  same path a typed message does — same IPC call, same run bookkeeping,
   *  same permission mode — so a chip is genuinely a shortcut for words and
   *  not a second way to start a turn. A draft already in the composer is
   *  left alone rather than being overwritten or sent alongside it. */
  async function send(promptOverride?: string): Promise<void> {
    // A session is all that is needed. An Unsorted one has no project and
    // must still send: picking a project is a later decision, not a
    // precondition for using Orbit.
    if (!activeConversation) return
    const override = promptOverride?.trim() || null
    if (!override && !composer.trim() && attachments.length === 0) return
    // The composer shows a session's settings the moment they are chosen,
    // but the runtime reads them back from the database when it launches the
    // turn. Between those two points the displayed mode and the mode agy is
    // actually started with can disagree — pick "Bypass permissions" and press
    // Send quickly enough and the turn used to go out under Ask first.
    // Waiting on the writes already in flight closes that window without
    // adding a delay: when nothing is pending this resolves immediately.
    await settledSessionSettings()
    const content = override ?? (composer.trim() || 'See the attached files.')
    const fileIds = attachments.map((attachment) => attachment.fileId)

    // Reflect the outcome each attachment is heading for before the turn
    // starts, so nothing silently changes meaning mid-send.
    setAttachments((current) => current.map((item) => ({ ...item, state: projectedState(item, nativeMediaAvailable) })))
    if (!override) setComposer('')

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
      // Only a typed message is handed back to the composer. Restoring an
      // override would drop a quick action's prompt into a draft the user
      // never wrote.
      if (!override) setComposer(content)
      setNotice(error instanceof Error ? error.message : 'Message could not be sent.')
    }
  }

  /** Applies a change to a session wherever the renderer is holding it.
   *
   *  A session lives in one of two lists: under its project in `tree`, or in
   *  `unsorted` when it belongs to no project. `activeConversation` is read
   *  from whichever applies, so an optimistic update that touched only
   *  `tree` left an Unsorted session showing its old settings — the control
   *  appeared to do nothing even though the write had succeeded. Both lists
   *  are updated here so no caller has to know, or remember, which one a
   *  session is in. */
  function updateConversationLocal(conversationId: ID, patch: Partial<Conversation>): void {
    setTree((current) =>
      current.map((group) => ({
        ...group,
        conversations: group.conversations.map((item) => (item.id === conversationId ? { ...item, ...patch } : item))
      }))
    )
    setUnsorted((current) => current.map((item) => (item.id === conversationId ? { ...item, ...patch } : item)))
  }

  /** Persisted per conversation, so a session keeps the model it was
   *  started with instead of silently drifting to whatever was picked last.
   *
   *  `model` is normalized here as well as in the store, so the optimistic
   *  local update and the persisted row agree on one concrete id rather than
   *  the UI briefly showing a session with no model. */
  async function persistModel(conversationId: ID, model: string | null, reasoningEffort: ReasoningEffort | null): Promise<void> {
    const resolved = resolveModelId(model)
    updateConversationLocal(conversationId, { model: resolved, reasoningEffort })
    try {
      await trackSessionSetting(() => requireOrbitApi().conversations.setModel({ conversationId, model: resolved, reasoningEffort }))
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

  /** Writes preferences through in one place, so every caller updates the
   *  same object rather than racing with a stale copy of it. */
  function trackSessionSetting<T>(write: () => Promise<T>): Promise<T> {
    const next = sessionSettingsRef.current.then(write, write)
    // Swallowed here only so one failed write cannot reject every later
    // wait; the caller still sees its own rejection.
    sessionSettingsRef.current = next.catch(() => undefined)
    return next
  }

  function settledSessionSettings(): Promise<unknown> {
    return sessionSettingsRef.current
  }

  function savePreferences(next: OrbitPreferences): void {
    setPreferences(next)
    void requireOrbitApi()
      .preferences.set(next)
      .catch(() => {
        // A preference that failed to persist still applies to this launch;
        // it simply will not be remembered next time.
      })
  }

  /** Committed once a resize gesture ends, never on every pointer move. */
  function commitSidebarWidth(width: number): void {
    savePreferences({ ...preferences, sidebarWidth: width })
  }

  /** How this session answers permission requests. A real agy launch flag,
   *  so it lands on the conversation and takes effect on its next turn. */
  async function selectPermissionMode(mode: PermissionMode): Promise<void> {
    if (!activeConversation) return
    const conversationId = activeConversation.id
    updateConversationLocal(conversationId, { permissionMode: mode })
    try {
      await trackSessionSetting(() =>
        requireOrbitApi().conversations.setPermissionMode({ conversationId, permissionMode: mode })
      )
      await refreshProject()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'That permission mode could not be applied.')
      await refreshProject()
    }
  }

  /** The project's real folder, chosen through the main process. The
   *  renderer never touches the filesystem: it asks for a folder and
   *  persists whatever the dialog returns. */
  async function chooseProjectFolder(): Promise<void> {
    if (!activeProject) return
    const orbit = requireOrbitApi()
    try {
      const picked = await orbit.dialog.pickFolder({
        title: 'Choose the project folder',
        ...(activeProject.rootPath ? { defaultPath: activeProject.rootPath } : {})
      })
      if (!picked) return
      await orbit.projects.setRoot({ projectId: activeProject.id, rootPath: picked })
      await refreshProject()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'That folder could not be set.')
    }
  }

  /** Drops a session's own folder override so it follows its project again. */
  async function useProjectFolder(): Promise<void> {
    if (!activeConversation) return
    try {
      await requireOrbitApi().conversations.setWorkingDirectory({
        conversationId: activeConversation.id,
        workingDirectory: null
      })
      await refreshProject()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'That session folder could not be cleared.')
    }
  }

  /** Stopping is a normal thing to ask for, and Orbit says so immediately.
   *
   *  The run is marked stopping before the request goes out, so the pause
   *  between pressing Stop and the transport acknowledging it reads as
   *  "Stopping…" rather than as the app having frozen. The real
   *  `run.cancelled` clears the mark and hands the composer back; a
   *  request that could not even be delivered clears it too, so the UI can
   *  never be left claiming to be stopping something it is not. */
  async function cancel(): Promise<void> {
    const runId = activeRunId
    if (!runId) return
    setStoppingRunIds((current) => (current.includes(runId) ? current : [...current, runId]))
    try {
      await requireOrbitApi().runs.cancel({ runId })
    } catch (error) {
      setStoppingRunIds((current) => current.filter((id) => id !== runId))
      setNotice(error instanceof Error ? error.message : 'That run could not be stopped.')
    }
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

  async function pickFiles(category: AttachmentPickerCategory = 'files'): Promise<void> {
    if (!workspace.activeProjectId) return
    const files = await requireOrbitApi().files.attach({ projectId: workspace.activeProjectId, category })
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
        onOpenSettings={() => void openSettings()}
        groups={tree}
        unsorted={unsorted}
        activeProjectId={workspace.activeProjectId}
        activeConversationId={workspace.activeConversationId}
        expandedProjectIds={expandedProjectIds}
        indicatorFor={indicatorFor}
        collapsed={sidebarCollapsed}
        width={sidebarWidth}
        onToggleProject={(projectId) =>
          setExpandedProjectIds((current) =>
            current.includes(projectId) ? current.filter((id) => id !== projectId) : [...current, projectId]
          )
        }
        onSelectSession={(projectId, conversationId) => void selectSession(projectId, conversationId)}
        onNewProject={() => setCreatingProject(true)}
        onNewSession={(projectId) => void createSession(projectId)}
        onRename={(conversationId, title) => void renameSession(conversationId, title)}
        onDelete={(conversationId) => void deleteSession(conversationId)}
        onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
      />

      {/* Only while the sidebar is showing: there is nothing to resize when
          it is collapsed to its fixed rail. */}
      {sidebarCollapsed ? null : (
        <SidebarResizer width={sidebarWidth} onResize={setSidebarWidth} onCommit={commitSidebarWidth} />
      )}

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

        <ArtifactToasts
          notices={artifactNotices}
          onOpen={(artifactId) => {
            setSelectedArtifactId(artifactId)
            setContextTab('artifacts')
            setArtifactNotices((current) => current.filter((item) => item.artifactId !== artifactId))
          }}
          onDismiss={(artifactId) => setArtifactNotices((current) => current.filter((item) => item.artifactId !== artifactId))}
        />

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
              artifacts={workspace.artifacts}
              thumbnails={thumbnails}
              activeRunId={activeRunId}
              streamText={activeRunId ? streamTextByRun[activeRunId] ?? '' : ''}
              activityByRun={activityByRun}
              identity={identity}
              stopping={Boolean(activeRunId && stoppingRunIds.includes(activeRunId))}
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
                project={activeProject}
                conversation={activeConversation}
                permissionMode={activeConversation.permissionMode}
                onSelectPermissionMode={(mode) => void selectPermissionMode(mode)}
                repository={repository}
                repositoryActionsEnabled={preferences.showRepositoryActions ?? true}
                onSendPrompt={(prompt) => void send(prompt)}
                onChooseProjectFolder={() => void chooseProjectFolder()}
                onUseProjectFolder={() => void useProjectFolder()}
                projects={tree.map((group) => group.project)}
                onAssignProject={(projectId) => void assignSessionToProject(projectId)}
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
                onPickFiles={(category) => void pickFiles(category)}
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

      {/* A project is the only thing that still needs configuring before it
          can exist: its name, and the folder Antigravity will run in. */}
      {creatingProject ? (
        <CreateProjectDialog
          onCancel={() => setCreatingProject(false)}
          onCreate={(input) => void createProject(input)}
          pickFolder={() => requireOrbitApi().dialog.pickFolder({ title: 'Choose the project folder' })}
        />
      ) : null}

      {settingsOpen ? (
        <SettingsPanel
          preferences={preferences}
          models={models}
          modelStatus={modelStatus}
          busy={clearing}
          onClose={() => setSettingsOpen(false)}
          onSelectDefaultModel={(modelId) => void saveDefaults({ ...preferences, defaultModelId: modelId })}
          onSelectDefaultPermissionMode={(mode) => void saveDefaults({ ...preferences, defaultPermissionMode: mode })}
          onToggleRepositoryActions={(enabled) => void saveDefaults({ ...preferences, showRepositoryActions: enabled })}
          onClearAllData={(confirmation) => void clearAllData(confirmation)}
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
    // Null is the Unsorted workspace, not a missing project.
    activeProjectId: snapshot.project?.id ?? null,
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
