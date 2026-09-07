import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrbitDatabase } from '../../src/main/persistence/database'
import { OrbitStore } from '../../src/main/persistence/store'

let dir = ''
let db: OrbitDatabase
let store: OrbitStore

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-store-'))
  db = new OrbitDatabase({ dataDir: dir })
  await db.init()
  store = new OrbitStore(db)
})

afterEach(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('OrbitStore', () => {
  it('persists a model and reasoning effort per conversation', () => {
    const project = store.createProject('Launch')
    const conversation = store.createConversation(project.id, 'Website')

    // A brand-new conversation carries no selection at all — Orbit must not
    // start one on a model the user never picked.
    expect(conversation.model).toBeNull()
    expect(conversation.reasoningEffort).toBeNull()

    store.setConversationModel(conversation.id, 'gemini-3.8-flash', 'medium')
    const saved = store.getConversation(conversation.id)
    expect(saved?.model).toBe('gemini-3.8-flash')
    expect(saved?.reasoningEffort).toBe('medium')

    // Selecting a model with no reasoning tiers must clear a stale effort
    // rather than leaving one behind that the model cannot honour.
    store.setConversationModel(conversation.id, 'claude-sonnet-4-6', null)
    const cleared = store.getConversation(conversation.id)
    expect(cleared?.model).toBe('claude-sonnet-4-6')
    expect(cleared?.reasoningEffort).toBeNull()

    // And returning to the default is a real, persisted state.
    store.setConversationModel(conversation.id, null, null)
    const reset = store.getConversation(conversation.id)
    expect(reset?.model).toBeNull()
  })

  it('round trips projects, conversations, messages, runs, and artifacts', () => {
    const project = store.createProject('Launch')
    const conversation = store.createConversation(project.id, 'Website')
    const run = store.createRun({ projectId: project.id, conversationId: conversation.id })
    store.createMessage({
      projectId: project.id,
      conversationId: conversation.id,
      runId: run.id,
      role: 'user',
      content: 'Build a page',
      status: 'completed'
    })
    const artifact = store.createArtifact({
      projectId: project.id,
      creatorConversationId: conversation.id,
      creatorRunId: run.id,
      type: 'html',
      name: 'index.html',
      source: 'provider',
      location: '/tmp/index.html',
      previewKind: 'html',
      mimeType: 'text/html',
      byteSize: 12,
      contentHash: 'hash'
    })
    const snapshot = store.openProjectSnapshot(project.id)
    expect(snapshot.project.name).toBe('Launch')
    expect(snapshot.conversations).toHaveLength(1)
    expect(snapshot.messages[0]?.content).toBe('Build a page')
    expect(snapshot.runs[0]?.id).toBe(run.id)
    expect(snapshot.artifacts[0]?.id).toBe(artifact.artifact.id)
    expect(snapshot.artifactVersions[0]?.artifactId).toBe(artifact.artifact.id)
  })

  it('persists to disk across database instances', async () => {
    const project = store.createProject('Persistent')
    db.close()
    db = new OrbitDatabase({ dataDir: dir })
    await db.init()
    store = new OrbitStore(db)
    expect(store.getProject(project.id)?.name).toBe('Persistent')
  })
})
