import { FormEvent, useEffect, useMemo, useState } from 'react'
import type { ArtifactContent } from '@shared/contracts'
import type { Artifact, Conversation, ID, Message, Project, ProjectFile, ProjectSnapshot, ProviderStatus, Reference, Run } from '@shared/domain'
import type { InteractionRequiredEvent, RuntimeEvent } from '@shared/runtime-events'
import { StartupError } from './ErrorBoundary'
import { getOrbitApi } from './orbitApi'

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
  const [projectName, setProjectName] = useState('')
  const [conversationTitle, setConversationTitle] = useState('')
  const [composer, setComposer] = useState('')
  const [attachmentFileIds, setAttachmentFileIds] = useState<ID[]>([])
  const [streamTextByRun, setStreamTextByRun] = useState<Record<string, string>>({})
  const [runningRunByConversation, setRunningRunByConversation] = useState<Record<string, string>>({})
  const [pendingInteractionByRun, setPendingInteractionByRun] = useState<Record<string, InteractionRequiredEvent>>({})
  const [respondingInteractionIds, setRespondingInteractionIds] = useState<Set<string>>(new Set())
  const [selectedArtifactId, setSelectedArtifactId] = useState<ID | null>(null)
  const [artifactContent, setArtifactContent] = useState<ArtifactContent | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [startupError, setStartupError] = useState<{ message: string; detail?: string | undefined } | null>(null)

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
    const unsubscribe = orbit.runs.onEvent((event) => {
      applyRuntimeEvent(event)
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    if (!selectedArtifactId) {
      setArtifactContent(null)
      return
    }
    const orbit = getOrbitApi()
    if (!orbit) return
    void orbit.artifacts.getContent(selectedArtifactId).then(setArtifactContent).catch((error: unknown) => {
      setNotice(error instanceof Error ? error.message : 'Unable to load artifact.')
    })
  }, [selectedArtifactId])

  const activeConversation = workspace.conversations.find((conversation) => conversation.id === workspace.activeConversationId) ?? null
  const activeMessages = useMemo(
    () =>
      workspace.messages
        .filter((message) => message.conversationId === workspace.activeConversationId)
        .sort((a, b) => a.sequence - b.sequence),
    [workspace.messages, workspace.activeConversationId]
  )
  const activeRunId = activeConversation ? runningRunByConversation[activeConversation.id] ?? null : null
  const selectedArtifact = workspace.artifacts.find((artifact) => artifact.id === selectedArtifactId) ?? workspace.artifacts[0] ?? null

  if (startupError) return <StartupError message={startupError.message} detail={startupError.detail} />

  async function loadInitial(): Promise<void> {
    const orbit = requireOrbitApi()
    const [projects, status] = await Promise.all([orbit.projects.list(), orbit.providers.status()])
    setProviderStatus(status)
    if (projects.length === 0) {
      setWorkspace((current) => ({ ...current, projects }))
      return
    }
    const firstProject = projects[0]
    if (firstProject) await openProject(firstProject.id, projects)
  }

  async function openProject(projectId: ID, knownProjects = workspace.projects, preferredConversationId?: ID | null): Promise<void> {
    const orbit = requireOrbitApi()
    const snapshot = await orbit.projects.open(projectId)
    setWorkspace(fromSnapshot(snapshot, knownProjects.length ? knownProjects : await orbit.projects.list(), preferredConversationId))
    setSelectedArtifactId(snapshot.artifacts[0]?.id ?? null)
  }

  async function refreshProject(): Promise<void> {
    if (!workspace.activeProject) return
    await openProject(workspace.activeProject.id, workspace.projects, workspace.activeConversationId)
  }

  async function createProject(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!projectName.trim()) return
    const orbit = requireOrbitApi()
    const project = await orbit.projects.create({ name: projectName })
    const projects = await orbit.projects.list()
    setProjectName('')
    await openProject(project.id, projects)
  }

  async function createConversation(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!workspace.activeProject) return
    const conversation = await requireOrbitApi().conversations.create({
      projectId: workspace.activeProject.id,
      title: conversationTitle || 'New conversation'
    })
    setConversationTitle('')
    await refreshProject()
    setWorkspace((current) => ({ ...current, activeConversationId: conversation.id }))
  }

  async function sendMessage(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!workspace.activeProject || !activeConversation || !composer.trim()) return
    const content = composer
    setComposer('')
    const run = await requireOrbitApi().messages.send({
      projectId: workspace.activeProject.id,
      conversationId: activeConversation.id,
      content,
      attachmentFileIds
    })
    setRunningRunByConversation((current) => ({ ...current, [activeConversation.id]: run.id }))
    setAttachmentFileIds([])
    await refreshProject()
  }

  async function cancelActiveRun(): Promise<void> {
    if (!activeRunId) return
    await requireOrbitApi().runs.cancel({ runId: activeRunId })
  }

  async function attachFiles(): Promise<void> {
    if (!workspace.activeProject) return
    const files = await requireOrbitApi().files.attach({ projectId: workspace.activeProject.id })
    if (files.length > 0) await refreshProject()
  }

  async function importArtifacts(): Promise<void> {
    if (!workspace.activeProject) return
    const artifacts = await requireOrbitApi().artifacts.import({
      projectId: workspace.activeProject.id,
      conversationId: activeConversation?.id ?? null
    })
    if (artifacts.length > 0) {
      await refreshProject()
      const firstArtifact = artifacts[0]
      if (firstArtifact) setSelectedArtifactId(firstArtifact.id)
    }
  }

  async function referenceArtifact(destinationConversationId: ID): Promise<void> {
    if (!workspace.activeProject || !selectedArtifact) return
    await requireOrbitApi().references.create({
      projectId: workspace.activeProject.id,
      artifactId: selectedArtifact.id,
      destinationConversationId
    })
    setNotice(`Referenced "${selectedArtifact.name}" in ${workspace.conversations.find((c) => c.id === destinationConversationId)?.title ?? 'conversation'}.`)
    await refreshProject()
  }

  function applyRuntimeEvent(event: RuntimeEvent): void {
    if (event.type === 'text.delta') {
      setStreamTextByRun((current) => ({ ...current, [event.runId]: `${current[event.runId] ?? ''}${event.delta}` }))
    }
    if (event.type === 'interaction.required' && event.canRespond) {
      setPendingInteractionByRun((current) => ({ ...current, [event.runId]: event }))
    }
    if (event.type === 'interaction.resolved') {
      setPendingInteractionByRun((current) => {
        const next = { ...current }
        for (const [runId, interaction] of Object.entries(next)) {
          if (interaction.interactionId === event.interactionId) delete next[runId]
        }
        return next
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
      setPendingInteractionByRun((current) => {
        const next = { ...current }
        delete next[event.runId]
        return next
      })
      void openProject(event.projectId, [], event.conversationId)
    }
  }

  async function respondToInteraction(runId: ID, interaction: InteractionRequiredEvent, optionId: string): Promise<void> {
    if (!workspace.activeProject || !activeConversation) return
    if (respondingInteractionIds.has(interaction.interactionId)) return
    setRespondingInteractionIds((current) => new Set(current).add(interaction.interactionId))
    try {
      await requireOrbitApi().interactions.respond({
        conversationId: activeConversation.id,
        runId,
        interactionId: interaction.interactionId,
        optionId
      })
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Unable to respond to that prompt.')
    } finally {
      setRespondingInteractionIds((current) => {
        const next = new Set(current)
        next.delete(interaction.interactionId)
        return next
      })
    }
  }

  async function enableInteractiveMode(): Promise<void> {
    if (!activeConversation || activeConversation.transport === 'pty') return
    const updated = await requireOrbitApi().conversations.setTransport({ conversationId: activeConversation.id, transport: 'pty' })
    setWorkspace((current) => ({
      ...current,
      conversations: current.conversations.map((conversation) => (conversation.id === updated.id ? updated : conversation))
    }))
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <div className="brand">Orbit</div>
          <div className="tagline">by AgentDock</div>
        </div>
        <form className="project-create" onSubmit={(event) => void createProject(event)}>
          <select value={workspace.activeProject?.id ?? ''} onChange={(event) => void openProject(event.target.value)} aria-label="Project">
            <option value="" disabled>
              {workspace.projects.length ? 'Select project' : 'No projects'}
            </option>
            {workspace.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="New project" />
          <button type="submit">Create</button>
        </form>
      </header>

      <section className="status-strip" data-state={providerStatus?.state ?? 'unknown'}>
        <span>Antigravity</span>
        <strong>{providerStatus?.state ?? 'checking'}</strong>
        {providerStatus?.message ? <span>{providerStatus.message}</span> : <span>Checking the installed Antigravity runtime.</span>}
      </section>

      {notice ? (
        <button className="notice" type="button" onClick={() => setNotice(null)}>
          {notice}
        </button>
      ) : null}

      <section className="workspace">
        <aside className="sidebar">
          <div className="panel-title">Conversations</div>
          <form className="new-conversation" onSubmit={(event) => void createConversation(event)}>
            <input value={conversationTitle} onChange={(event) => setConversationTitle(event.target.value)} placeholder="Conversation name" disabled={!workspace.activeProject} />
            <button type="submit" disabled={!workspace.activeProject}>
              New
            </button>
          </form>
          <div className="conversation-list">
            {workspace.conversations.map((conversation) => (
              <button
                type="button"
                key={conversation.id}
                className={conversation.id === workspace.activeConversationId ? 'active' : ''}
                onClick={() => setWorkspace((current) => ({ ...current, activeConversationId: conversation.id }))}
              >
                <span>{conversation.title}</span>
                <small>{conversation.status}</small>
              </button>
            ))}
          </div>
          <div className="assets">
            <div className="panel-title">Project Assets</div>
            <div className="asset-actions">
              <button type="button" onClick={() => void attachFiles()} disabled={!workspace.activeProject}>
                Attach file
              </button>
              <button type="button" onClick={() => void importArtifacts()} disabled={!workspace.activeProject}>
                Import artifact
              </button>
            </div>
            {workspace.projectFiles.map((file) => (
              <button type="button" className={`asset-row ${attachmentFileIds.includes(file.id) ? 'selected' : ''}`} key={file.id} title={file.originalPath} onClick={() => setAttachmentFileIds((current) => current.includes(file.id) ? current.filter((id) => id !== file.id) : [...current, file.id])}>
                {attachmentFileIds.includes(file.id) ? 'Attached: ' : ''}{file.name}
              </button>
            ))}
          </div>
        </aside>

        <section className="conversation">
          <div className="conversation-header">
            <div>
              <h1>{activeConversation?.title ?? 'Create a project to begin'}</h1>
              <p>{workspace.activeProject ? workspace.activeProject.name : 'Projects contain conversations, files, and artifacts.'}</p>
            </div>
            {activeConversation ? (
              <button
                type="button"
                className="transport-toggle"
                disabled={activeConversation.transport === 'pty'}
                title="Interactive mode keeps a live Antigravity session open so it can ask you questions or request permission. Cannot be turned back off for this conversation."
                onClick={() => void enableInteractiveMode()}
              >
                {activeConversation.transport === 'pty' ? 'Interactive session' : 'Enable interactive mode'}
              </button>
            ) : null}
            {activeRunId ? (
              <button className="cancel" type="button" onClick={() => void cancelActiveRun()}>
                Cancel
              </button>
            ) : null}
          </div>

          <div className="messages" aria-live="polite">
            {activeMessages.map((message) => (
              <article className={`message ${message.role}`} key={message.id}>
                <div className="message-role">{message.role}</div>
                <div className="message-body">{message.content}</div>
              </article>
            ))}
            {activeRunId && streamTextByRun[activeRunId] ? (
              <article className="message assistant streaming">
                <div className="message-role">assistant</div>
                <div className="message-body">{streamTextByRun[activeRunId]}</div>
              </article>
            ) : null}
            {activeRunId && pendingInteractionByRun[activeRunId] ? (
              <InteractionPanel
                interaction={pendingInteractionByRun[activeRunId]!}
                busy={respondingInteractionIds.has(pendingInteractionByRun[activeRunId]!.interactionId)}
                onRespond={(optionId) => void respondToInteraction(activeRunId, pendingInteractionByRun[activeRunId]!, optionId)}
              />
            ) : null}
            {activeConversation?.status === 'running' &&
            !activeRunId &&
            workspace.runs.some((run) => run.conversationId === activeConversation.id && run.state === 'waiting_for_interaction') ? (
              <div className="interaction-panel stale">
                A previous session left this conversation waiting on a native prompt that Orbit can no longer show. Cancel and send a new message to continue.
              </div>
            ) : null}
          </div>

          <form className="composer" onSubmit={(event) => void sendMessage(event)}>
            <textarea
              value={composer}
              onChange={(event) => setComposer(event.target.value)}
              placeholder="Ask Orbit..."
              disabled={!activeConversation || Boolean(activeRunId) || Boolean(activeRunId && pendingInteractionByRun[activeRunId])}
            />
            <button type="submit" disabled={!activeConversation || !composer.trim() || Boolean(activeRunId)}>
              Send
            </button>
          </form>
        </section>

        <aside className="artifact-panel">
          <div className="panel-title">Artifacts</div>
          <div className="artifact-list">
            {workspace.artifacts.map((artifact) => (
              <button type="button" key={artifact.id} className={artifact.id === selectedArtifact?.id ? 'active' : ''} onClick={() => setSelectedArtifactId(artifact.id)}>
                <span>{artifact.name}</span>
                <small>{artifact.type}</small>
              </button>
            ))}
          </div>
          <ArtifactPreview artifact={selectedArtifact} content={artifactContent} />
          {selectedArtifact ? (
            <div className="handoff">
              <div className="panel-title">Reference in conversation</div>
              {workspace.conversations
                .filter((conversation) => conversation.id !== selectedArtifact.creatorConversationId)
                .map((conversation) => (
                  <button type="button" key={conversation.id} onClick={() => void referenceArtifact(conversation.id)}>
                    {conversation.title}
                  </button>
                ))}
            </div>
          ) : null}
        </aside>
      </section>
    </main>
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

function InteractionPanel({
  interaction,
  busy,
  onRespond
}: {
  interaction: InteractionRequiredEvent
  busy: boolean
  onRespond: (optionId: string) => void
}): JSX.Element {
  return (
    <div className="interaction-panel" role="alert">
      <div className="interaction-prompt">{interaction.prompt}</div>
      <div className="interaction-options">
        {interaction.options.map((option) => (
          <button
            type="button"
            key={option.id}
            className={option.destructive ? 'destructive' : ''}
            disabled={busy}
            onClick={() => onRespond(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function ArtifactPreview({ artifact, content }: { artifact: Artifact | null; content: ArtifactContent | null }): JSX.Element {
  if (!artifact) return <div className="empty-artifact">Artifacts created or imported in this project appear here.</div>
  if (!content) return <div className="empty-artifact">Loading artifact...</div>
  if (content.dataUrl && content.previewKind === 'image') return <img className="artifact-image" src={content.dataUrl} alt={artifact.name} />
  if (content.dataUrl && content.previewKind === 'audio') return <audio controls src={content.dataUrl} />
  if (content.dataUrl && content.previewKind === 'video') return <video controls src={content.dataUrl} />
  if (content.text && content.previewKind === 'html') return <iframe title={artifact.name} sandbox="" srcDoc={content.text} />
  if (content.text && content.previewKind === 'svg') return <iframe title={artifact.name} sandbox="" srcDoc={content.text} />
  if (content.text) return <pre className="artifact-text">{content.text}</pre>
  return (
    <div className="artifact-meta">
      <strong>{artifact.name}</strong>
      <span>{artifact.mimeType ?? 'Unknown MIME type'}</span>
      <span>{content.byteSize} bytes</span>
      <span>{artifact.location}</span>
    </div>
  )
}
