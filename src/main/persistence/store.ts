import type {
  Artifact,
  ArtifactType,
  ArtifactVersion,
  Conversation,
  ConversationTransport,
  ID,
  Message,
  MessageRole,
  MessageStatus,
  OrbitPreferences,
  Project,
  ProjectFile,
  ProjectGroup,
  ProjectSnapshot,
  ProviderId,
  ReasoningEffort,
  Reference,
  Run,
  RunState,
  RuntimeErrorInfo
} from '@shared/domain'
import type { RuntimeEvent } from '@shared/runtime-events'
import { createId, nowIso } from '@main/util/ids'
import { normalizePreferences } from '@shared/reasoningPolicy'
import { resolveModelId } from '@shared/defaultModel'
import { DEFAULT_PERMISSION_MODE, normalizePermissionMode, type PermissionMode } from '@shared/permissionMode'
import {
  DEFAULT_SESSION_TITLE,
  shouldApplyAutoTitle,
  type DerivedSessionTitle,
  type SessionTitleState
} from '@shared/sessionTitle'
import { jsonParseObject, jsonStringify, nullableText, numberValue, OrbitDatabase, text } from './database'

/** Where cross-session preferences live in the `meta` key/value table. */
const PREFERENCES_KEY = 'preferences'

export class OrbitStore {
  constructor(private readonly db: OrbitDatabase) {}

  createProject(name: string, rootPath: string | null = null): Project {
    const now = nowIso()
    const project: Project = {
      id: createId('project'),
      name: name.trim(),
      rootPath: normalizePath(rootPath),
      createdAt: now,
      updatedAt: now
    }
    this.db.run('INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
      project.id,
      project.name,
      project.rootPath,
      project.createdAt,
      project.updatedAt
    ])
    return project
  }

  setProjectRoot(projectId: ID, rootPath: string | null): Project {
    const project = this.getProject(projectId)
    if (!project) throw new Error(`Project not found: ${projectId}`)
    this.db.run('UPDATE projects SET root_path = ?, updated_at = ? WHERE id = ?', [normalizePath(rootPath), nowIso(), projectId])
    return this.getProject(projectId)!
  }

  /** Every project with the sessions that belong to it. Projects keep the
   *  same recency order as listProjects(), so the sidebar and the project
   *  list can never disagree about ordering. */
  listProjectTree(): ProjectGroup[] {
    return this.listProjects().map((project) => ({ project, conversations: this.listConversations(project.id) }))
  }

  readPreferences(): OrbitPreferences {
    const row = this.db.get<string | null>('SELECT value FROM meta WHERE key = ?', [PREFERENCES_KEY], (result) =>
      nullableText(result, 'value')
    )
    if (!row) return normalizePreferences(null)
    try {
      return normalizePreferences(JSON.parse(row))
    } catch {
      // A corrupted preferences blob is not worth failing startup over —
      // the user simply starts from the documented defaults again.
      return normalizePreferences(null)
    }
  }

  writePreferences(preferences: OrbitPreferences): OrbitPreferences {
    const normalized = normalizePreferences(preferences)
    this.db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
      PREFERENCES_KEY,
      JSON.stringify(normalized)
    ])
    return normalized
  }

  listProjects(): Project[] {
    return this.db.query('SELECT * FROM projects ORDER BY updated_at DESC', [], mapProject)
  }

  getProject(projectId: ID): Project | null {
    return this.db.get('SELECT * FROM projects WHERE id = ?', [projectId], mapProject)
  }

  createConversation(
    projectId: ID,
    title: string,
    options: {
      providerId?: ProviderId
      workingDirectory?: string | null
      reasoningEffort?: ReasoningEffort | null
      model?: string | null
      permissionMode?: PermissionMode
    } = {}
  ): Conversation {
    this.assertProject(projectId)
    const now = nowIso()
    const conversation: Conversation = {
      id: createId('conversation'),
      projectId,
      title: title.trim() || DEFAULT_SESSION_TITLE,
      providerId: options.providerId ?? 'antigravity',
      nativeConversationId: null,
      status: 'idle',
      transport: 'structured',
      model: resolveModelId(options.model ?? null),
      permissionMode: options.permissionMode ?? DEFAULT_PERMISSION_MODE,
      reasoningEffort: options.reasoningEffort ?? null,
      workingDirectory: normalizePath(options.workingDirectory ?? null),
      createdAt: now,
      updatedAt: now
    }
    this.db.run(
      `INSERT INTO conversations
       (id, project_id, title, provider_id, native_conversation_id, status, transport, model, reasoning_effort, permission_mode, working_directory, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        conversation.id,
        conversation.projectId,
        conversation.title,
        conversation.providerId,
        conversation.nativeConversationId,
        conversation.status,
        conversation.transport,
        conversation.model,
        conversation.reasoningEffort,
        conversation.permissionMode,
        conversation.workingDirectory,
        conversation.createdAt,
        conversation.updatedAt
      ]
    )
    this.touchProject(projectId)
    return conversation
  }

  setConversationWorkingDirectory(conversationId: ID, workingDirectory: string | null): Conversation {
    const conversation = this.requireConversation(conversationId)
    this.db.run('UPDATE conversations SET working_directory = ?, updated_at = ? WHERE id = ?', [
      normalizePath(workingDirectory),
      nowIso(),
      conversationId
    ])
    this.touchProject(conversation.projectId)
    return this.requireConversation(conversationId)
  }

  /** Removes a conversation and everything scoped to it. Messages, runs and
   *  run_events all declare ON DELETE CASCADE against conversations/runs, so
   *  this single delete is sufficient — see schema.ts. */
  deleteConversation(conversationId: ID): void {
    const conversation = this.requireConversation(conversationId)
    this.db.run('DELETE FROM conversations WHERE id = ?', [conversationId])
    this.touchProject(conversation.projectId)
  }

  /** Persists the model/effort choice for one conversation. Either may be
   *  null, meaning "use Antigravity's own default" — never a guessed value. */
  /** `model` is nullable only so a legacy caller cannot crash: null is
   *  normalized to Orbit's default on the way in, so a row can never be
   *  written back to the old "agy picks" state once it has left it. */
  setConversationModel(conversationId: ID, model: string | null, reasoningEffort: ReasoningEffort | null): Conversation {
    const conversation = this.requireConversation(conversationId)
    this.db.run('UPDATE conversations SET model = ?, reasoning_effort = ?, updated_at = ? WHERE id = ?', [
      resolveModelId(model),
      reasoningEffort,
      nowIso(),
      conversationId
    ])
    this.touchProject(conversation.projectId)
    return this.requireConversation(conversationId)
  }

  /** Persists how this session handles permission requests. A real launch
   *  flag, so the provider treats a change the way it treats a model change:
   *  the live session is retired and the next turn respawns with it. */
  setConversationPermissionMode(conversationId: ID, permissionMode: PermissionMode): Conversation {
    const conversation = this.requireConversation(conversationId)
    this.db.run('UPDATE conversations SET permission_mode = ?, updated_at = ? WHERE id = ?', [
      normalizePermissionMode(permissionMode),
      nowIso(),
      conversationId
    ])
    this.touchProject(conversation.projectId)
    return this.requireConversation(conversationId)
  }

  /** Sticky by design — see ConversationTransport's doc comment. Callers
   *  (OrbitRuntime) are responsible for only ever moving 'structured' ->
   *  'pty', never the reverse. */
  setConversationTransport(conversationId: ID, transport: ConversationTransport): Conversation {
    const conversation = this.requireConversation(conversationId)
    this.db.run('UPDATE conversations SET transport = ?, updated_at = ? WHERE id = ?', [transport, nowIso(), conversationId])
    this.touchProject(conversation.projectId)
    return this.requireConversation(conversationId)
  }

  /** A rename the user asked for. It also marks the title as theirs, which
   *  is what stops first-prompt auto-titling from ever replacing it — see
   *  autoTitleConversation. */
  renameConversation(conversationId: ID, title: string): Conversation {
    const conversation = this.requireConversation(conversationId)
    const updated = { ...conversation, title: title.trim() || conversation.title, updatedAt: nowIso() }
    this.db.run("UPDATE conversations SET title = ?, title_is_custom = 1, title_state = 'manual', updated_at = ? WHERE id = ?", [
      updated.title,
      updated.updatedAt,
      conversationId
    ])
    this.touchProject(updated.projectId)
    return updated
  }

  /** Orbit naming a session after one of its prompts.
   *
   *  What may happen is decided by the session's recorded title state, not
   *  by its text — see shared/sessionTitle.ts. A session the user renamed
   *  is never touched. A session Orbit already named from a real prompt is
   *  settled and stops changing. A session named only provisionally (its
   *  first prompt was "hi") still yields to the first prompt that has a
   *  subject in it, which is what stops a used session from sitting at
   *  `New Session` — or at `Hi` — forever.
   *
   *  Returns null when it declined, which is a normal outcome, not an
   *  error. */
  autoTitleConversation(conversationId: ID, derived: DerivedSessionTitle): Conversation | null {
    const conversation = this.requireConversation(conversationId)
    if (this.isTitleCustom(conversationId)) return null
    if (!shouldApplyAutoTitle(this.titleState(conversationId), derived)) return null
    const next = derived.title.trim()
    if (!next) return null
    const updatedAt = nowIso()
    this.db.run('UPDATE conversations SET title = ?, title_state = ?, updated_at = ? WHERE id = ?', [
      next,
      derived.kind,
      updatedAt,
      conversationId
    ])
    this.touchProject(conversation.projectId)
    return { ...conversation, title: next, updatedAt }
  }

  /** How this session came by its name. Unknown values read as 'default',
   *  which is the direction that lets Orbit name an unnamed session rather
   *  than the one that could overwrite a real title. */
  titleState(conversationId: ID): SessionTitleState {
    const value = this.db.get<string | null>('SELECT title_state FROM conversations WHERE id = ?', [conversationId], (row) =>
      nullableText(row, 'title_state')
    )
    if (value === 'manual' || value === 'provisional' || value === 'substantive') return value
    return 'default'
  }

  /** Whether this session's name was chosen by the user rather than Orbit.
   *  Kept out of the `Conversation` shape on purpose: nothing outside this
   *  store's titling rules has any use for it. */
  private isTitleCustom(conversationId: ID): boolean {
    const value = this.db.get<number>('SELECT title_is_custom FROM conversations WHERE id = ?', [conversationId], (row) =>
      numberValue(row, 'title_is_custom')
    )
    return (value ?? 0) !== 0
  }

  updateConversationNativeId(conversationId: ID, nativeConversationId: string | null): void {
    const conversation = this.requireConversation(conversationId)
    this.db.run('UPDATE conversations SET native_conversation_id = ?, updated_at = ? WHERE id = ?', [
      nativeConversationId,
      nowIso(),
      conversationId
    ])
    this.touchProject(conversation.projectId)
  }

  updateConversationStatus(conversationId: ID, status: Conversation['status']): void {
    const conversation = this.requireConversation(conversationId)
    this.db.run('UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?', [status, nowIso(), conversationId])
    this.touchProject(conversation.projectId)
  }

  listConversations(projectId: ID): Conversation[] {
    return this.db.query('SELECT * FROM conversations WHERE project_id = ? ORDER BY updated_at DESC', [projectId], mapConversation)
  }

  getConversation(conversationId: ID): Conversation | null {
    return this.db.get('SELECT * FROM conversations WHERE id = ?', [conversationId], mapConversation)
  }

  requireConversation(conversationId: ID): Conversation {
    const conversation = this.getConversation(conversationId)
    if (!conversation) throw new Error(`Conversation not found: ${conversationId}`)
    return conversation
  }

  createMessage(input: {
    projectId: ID
    conversationId: ID
    runId: ID | null
    role: MessageRole
    content: string
    status: MessageStatus
  }): Message {
    const sequence = this.nextSequence('messages', 'conversation_id', input.conversationId)
    const now = nowIso()
    const message: Message = {
      id: createId('message'),
      projectId: input.projectId,
      conversationId: input.conversationId,
      runId: input.runId,
      role: input.role,
      content: input.content,
      status: input.status,
      createdAt: now,
      updatedAt: now,
      sequence
    }
    this.db.run(
      `INSERT INTO messages
       (id, project_id, conversation_id, run_id, role, content, status, created_at, updated_at, sequence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        message.id,
        message.projectId,
        message.conversationId,
        message.runId,
        message.role,
        message.content,
        message.status,
        message.createdAt,
        message.updatedAt,
        message.sequence
      ]
    )
    return message
  }

  listMessages(projectId: ID): Message[] {
    return this.db.query('SELECT * FROM messages WHERE project_id = ? ORDER BY conversation_id, sequence ASC', [projectId], mapMessage)
  }

  createRun(input: { projectId: ID; conversationId: ID; providerId?: ProviderId; metadata?: Record<string, unknown> }): Run {
    const now = nowIso()
    const run: Run = {
      id: createId('run'),
      projectId: input.projectId,
      conversationId: input.conversationId,
      providerId: input.providerId ?? 'antigravity',
      state: 'running',
      startedAt: now,
      endedAt: null,
      cancellationRequestedAt: null,
      nativeRunId: null,
      error: null,
      metadata: input.metadata ?? {}
    }
    this.db.run(
      `INSERT INTO runs
       (id, project_id, conversation_id, provider_id, state, started_at, ended_at, cancellation_requested_at, native_run_id, error_json, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run.id,
        run.projectId,
        run.conversationId,
        run.providerId,
        run.state,
        run.startedAt,
        run.endedAt,
        run.cancellationRequestedAt,
        run.nativeRunId,
        null,
        jsonStringify(run.metadata)
      ]
    )
    this.updateConversationStatus(input.conversationId, 'running')
    return run
  }

  updateRunState(runId: ID, state: RunState, error: RuntimeErrorInfo | null = null): Run {
    const run = this.requireRun(runId)
    const endedAt = state === 'completed' || state === 'failed' || state === 'cancelled' ? nowIso() : run.endedAt
    const cancellationRequestedAt = state === 'cancelling' ? nowIso() : run.cancellationRequestedAt
    this.db.run('UPDATE runs SET state = ?, ended_at = ?, cancellation_requested_at = ?, error_json = ? WHERE id = ?', [
      state,
      endedAt,
      cancellationRequestedAt,
      error ? JSON.stringify(error) : null,
      runId
    ])
    if (state === 'completed' || state === 'cancelled') this.updateConversationStatus(run.conversationId, 'idle')
    if (state === 'failed') this.updateConversationStatus(run.conversationId, 'failed')
    return this.requireRun(runId)
  }

  requireRun(runId: ID): Run {
    const run = this.db.get('SELECT * FROM runs WHERE id = ?', [runId], mapRun)
    if (!run) throw new Error(`Run not found: ${runId}`)
    return run
  }

  listRuns(projectId: ID): Run[] {
    return this.db.query('SELECT * FROM runs WHERE project_id = ? ORDER BY started_at ASC', [projectId], mapRun)
  }

  addRunEvent(event: RuntimeEvent): void {
    const sequence = this.nextSequence('run_events', 'run_id', event.runId)
    this.db.run('INSERT INTO run_events (id, run_id, event_type, payload_json, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?)', [
      createId('event'),
      event.runId,
      event.type,
      JSON.stringify(event),
      event.createdAt,
      sequence
    ])
  }

  createArtifact(input: {
    projectId: ID
    creatorConversationId: ID | null
    creatorRunId: ID | null
    type: ArtifactType
    name: string
    source: Artifact['source']
    location: string
    previewKind: Artifact['previewKind']
    mimeType: string | null
    byteSize: number
    contentHash: string
    metadata?: Record<string, unknown>
  }): { artifact: Artifact; version: ArtifactVersion } {
    const now = nowIso()
    const artifactId = createId('artifact')
    const versionId = createId('artifact_version')
    const artifact: Artifact = {
      id: artifactId,
      projectId: input.projectId,
      creatorConversationId: input.creatorConversationId,
      creatorRunId: input.creatorRunId,
      type: input.type,
      name: input.name,
      source: input.source,
      location: input.location,
      previewKind: input.previewKind,
      mimeType: input.mimeType,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
      currentVersionId: versionId
    }
    const version: ArtifactVersion = {
      id: versionId,
      artifactId,
      versionNumber: 1,
      location: input.location,
      previewLocation: input.location,
      mimeType: input.mimeType,
      byteSize: input.byteSize,
      contentHash: input.contentHash,
      metadata: input.metadata ?? {},
      createdAt: now
    }
    this.db.run(
      `INSERT INTO artifacts
       (id, project_id, creator_conversation_id, creator_run_id, type, name, source, location, preview_kind, mime_type, metadata_json, created_at, updated_at, current_version_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        artifact.id,
        artifact.projectId,
        artifact.creatorConversationId,
        artifact.creatorRunId,
        artifact.type,
        artifact.name,
        artifact.source,
        artifact.location,
        artifact.previewKind,
        artifact.mimeType,
        jsonStringify(artifact.metadata),
        artifact.createdAt,
        artifact.updatedAt,
        artifact.currentVersionId
      ]
    )
    this.db.run(
      `INSERT INTO artifact_versions
       (id, artifact_id, version_number, location, preview_location, mime_type, byte_size, content_hash, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        version.id,
        version.artifactId,
        version.versionNumber,
        version.location,
        version.previewLocation,
        version.mimeType,
        version.byteSize,
        version.contentHash,
        jsonStringify(version.metadata),
        version.createdAt
      ]
    )
    return { artifact, version }
  }

  listArtifacts(projectId: ID): Artifact[] {
    return this.db.query('SELECT * FROM artifacts WHERE project_id = ? ORDER BY updated_at DESC', [projectId], mapArtifact)
  }

  getArtifact(artifactId: ID): Artifact | null {
    return this.db.get('SELECT * FROM artifacts WHERE id = ?', [artifactId], mapArtifact)
  }

  listArtifactVersions(projectId: ID): ArtifactVersion[] {
    return this.db.query(
      `SELECT av.* FROM artifact_versions av
       JOIN artifacts a ON a.id = av.artifact_id
       WHERE a.project_id = ?
       ORDER BY av.created_at ASC`,
      [projectId],
      mapArtifactVersion
    )
  }

  createProjectFile(input: {
    projectId: ID
    originalPath: string
    storedPath: string
    name: string
    mimeType: string | null
    byteSize: number
    contentHash: string
  }): ProjectFile {
    const file: ProjectFile = { id: createId('file'), createdAt: nowIso(), ...input }
    this.db.run(
      `INSERT INTO project_files
       (id, project_id, original_path, stored_path, name, mime_type, byte_size, content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        file.id,
        file.projectId,
        file.originalPath,
        file.storedPath,
        file.name,
        file.mimeType,
        file.byteSize,
        file.contentHash,
        file.createdAt
      ]
    )
    return file
  }

  listProjectFiles(projectId: ID): ProjectFile[] {
    return this.db.query('SELECT * FROM project_files WHERE project_id = ? ORDER BY created_at DESC', [projectId], mapProjectFile)
  }

  getProjectFile(fileId: ID): ProjectFile | null {
    return this.db.get('SELECT * FROM project_files WHERE id = ?', [fileId], mapProjectFile)
  }

  createReference(input: { projectId: ID; artifactId: ID; destinationConversationId: ID }): Reference {
    const artifact = this.getArtifact(input.artifactId)
    if (!artifact || artifact.projectId !== input.projectId) throw new Error('Artifact not found in this project.')
    const conversation = this.requireConversation(input.destinationConversationId)
    if (conversation.projectId !== input.projectId) throw new Error('Destination conversation belongs to another project.')
    const ref: Reference = {
      id: createId('reference'),
      projectId: input.projectId,
      sourceType: 'artifact',
      sourceId: input.artifactId,
      targetType: 'conversation',
      targetId: input.destinationConversationId,
      relation: 'referenced-in',
      createdAt: nowIso()
    }
    this.db.run(
      `INSERT INTO references_table
       (id, project_id, source_type, source_id, target_type, target_id, relation, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [ref.id, ref.projectId, ref.sourceType, ref.sourceId, ref.targetType, ref.targetId, ref.relation, ref.createdAt]
    )
    return ref
  }

  listReferences(projectId: ID): Reference[] {
    return this.db.query('SELECT * FROM references_table WHERE project_id = ? ORDER BY created_at ASC', [projectId], mapReference)
  }

  openProjectSnapshot(projectId: ID): ProjectSnapshot {
    const project = this.getProject(projectId)
    if (!project) throw new Error(`Project not found: ${projectId}`)
    return {
      project,
      conversations: this.listConversations(projectId),
      messages: this.listMessages(projectId),
      runs: this.listRuns(projectId),
      artifacts: this.listArtifacts(projectId),
      artifactVersions: this.listArtifactVersions(projectId),
      projectFiles: this.listProjectFiles(projectId),
      references: this.listReferences(projectId)
    }
  }

  private assertProject(projectId: ID): void {
    if (!this.getProject(projectId)) throw new Error(`Project not found: ${projectId}`)
  }

  private touchProject(projectId: ID): void {
    this.db.run('UPDATE projects SET updated_at = ? WHERE id = ?', [nowIso(), projectId])
  }

  private nextSequence(table: string, scopeColumn: string, scopeId: ID): number {
    const row = this.db.get<{ seq: number }>(
      `SELECT COALESCE(MAX(sequence), 0) + 1 as seq FROM ${table} WHERE ${scopeColumn} = ?`,
      [scopeId],
      (result) => ({ seq: numberValue(result, 'seq') })
    )
    return row?.seq ?? 1
  }
}

/** Blank/whitespace-only folder input is the same as "no folder chosen" —
 *  storing "" would read as a real path everywhere downstream. */
function normalizePath(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : null
}

function mapProject(row: Record<string, unknown>): Project {
  return {
    id: text(row, 'id'),
    name: text(row, 'name'),
    rootPath: nullableText(row, 'root_path'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at')
  }
}

function mapConversation(row: Record<string, unknown>): Conversation {
  return {
    id: text(row, 'id'),
    projectId: text(row, 'project_id'),
    title: text(row, 'title'),
    providerId: text(row, 'provider_id') as ProviderId,
    nativeConversationId: nullableText(row, 'native_conversation_id'),
    status: text(row, 'status') as Conversation['status'],
    transport: (nullableText(row, 'transport') ?? 'structured') as ConversationTransport,
    // The one place legacy storage stops being legacy. Rows written before
    // Orbit owned a default hold `model = NULL`, which used to mean "let agy
    // pick something". Every read resolves that to Orbit's concrete default,
    // so the renderer, the runtime and the provider all see one real model
    // without the user reopening or re-selecting anything.
    model: resolveModelId(nullableText(row, 'model')),
    permissionMode: normalizePermissionMode(nullableText(row, 'permission_mode')),
    reasoningEffort: nullableText(row, 'reasoning_effort') as Conversation['reasoningEffort'],
    workingDirectory: nullableText(row, 'working_directory'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at')
  }
}

function mapMessage(row: Record<string, unknown>): Message {
  return {
    id: text(row, 'id'),
    projectId: text(row, 'project_id'),
    conversationId: text(row, 'conversation_id'),
    runId: nullableText(row, 'run_id'),
    role: text(row, 'role') as MessageRole,
    content: text(row, 'content'),
    status: text(row, 'status') as MessageStatus,
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
    sequence: numberValue(row, 'sequence')
  }
}

function mapRun(row: Record<string, unknown>): Run {
  return {
    id: text(row, 'id'),
    projectId: text(row, 'project_id'),
    conversationId: text(row, 'conversation_id'),
    providerId: text(row, 'provider_id') as ProviderId,
    state: text(row, 'state') as RunState,
    startedAt: text(row, 'started_at'),
    endedAt: nullableText(row, 'ended_at'),
    cancellationRequestedAt: nullableText(row, 'cancellation_requested_at'),
    nativeRunId: nullableText(row, 'native_run_id'),
    error: nullableText(row, 'error_json') ? (JSON.parse(nullableText(row, 'error_json') ?? '{}') as RuntimeErrorInfo) : null,
    metadata: jsonParseObject(row.metadata_json)
  }
}

function mapArtifact(row: Record<string, unknown>): Artifact {
  return {
    id: text(row, 'id'),
    projectId: text(row, 'project_id'),
    creatorConversationId: nullableText(row, 'creator_conversation_id'),
    creatorRunId: nullableText(row, 'creator_run_id'),
    type: text(row, 'type') as ArtifactType,
    name: text(row, 'name'),
    source: text(row, 'source') as Artifact['source'],
    location: text(row, 'location'),
    previewKind: text(row, 'preview_kind') as Artifact['previewKind'],
    mimeType: nullableText(row, 'mime_type'),
    metadata: jsonParseObject(row.metadata_json),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
    currentVersionId: nullableText(row, 'current_version_id')
  }
}

function mapArtifactVersion(row: Record<string, unknown>): ArtifactVersion {
  return {
    id: text(row, 'id'),
    artifactId: text(row, 'artifact_id'),
    versionNumber: numberValue(row, 'version_number'),
    location: text(row, 'location'),
    previewLocation: nullableText(row, 'preview_location'),
    mimeType: nullableText(row, 'mime_type'),
    byteSize: numberValue(row, 'byte_size'),
    contentHash: text(row, 'content_hash'),
    metadata: jsonParseObject(row.metadata_json),
    createdAt: text(row, 'created_at')
  }
}

function mapProjectFile(row: Record<string, unknown>): ProjectFile {
  return {
    id: text(row, 'id'),
    projectId: text(row, 'project_id'),
    originalPath: text(row, 'original_path'),
    storedPath: text(row, 'stored_path'),
    name: text(row, 'name'),
    mimeType: nullableText(row, 'mime_type'),
    byteSize: numberValue(row, 'byte_size'),
    contentHash: text(row, 'content_hash'),
    createdAt: text(row, 'created_at')
  }
}

function mapReference(row: Record<string, unknown>): Reference {
  return {
    id: text(row, 'id'),
    projectId: text(row, 'project_id'),
    sourceType: text(row, 'source_type') as Reference['sourceType'],
    sourceId: text(row, 'source_id'),
    targetType: text(row, 'target_type') as Reference['targetType'],
    targetId: text(row, 'target_id'),
    relation: text(row, 'relation') as Reference['relation'],
    createdAt: text(row, 'created_at')
  }
}
