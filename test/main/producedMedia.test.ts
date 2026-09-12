// The artifact output bridge, end to end through the real runtime: an
// agent writes a file during a turn, and Orbit registers it as an artifact
// and announces it.
//
// The provider here writes real files at the point a real provider's tool
// would, so what is under test is the whole path — snapshot, diff,
// registration, event — and not a mocked version of it.
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORBIT_DEFAULT_MODEL_ID } from '../../src/shared/defaultModel'
import { OrbitDatabase } from '../../src/main/persistence/database'
import { OrbitStore } from '../../src/main/persistence/store'
import { FileStorage } from '../../src/main/files/fileStorage'
import { ArtifactService } from '../../src/main/artifacts/artifactService'
import { OrbitRuntime } from '../../src/main/runtime/orbitRuntime'
import type { AgentProvider, ProviderSendInput } from '../../src/main/runtime/provider'
import type { ModelOption, ProviderStatus } from '../../src/shared/domain'
import type { RuntimeEvent } from '../../src/shared/runtime-events'

const CATALOGUE: ModelOption[] = [
  { id: ORBIT_DEFAULT_MODEL_ID, label: 'Gemini 3.8 Flash', supportedReasoningEfforts: ['low', 'medium', 'high'] }
]

/** Writes files into the workspace mid-turn, exactly where a real tool
 *  would, then ends the turn the way the real provider does. */
class WritingProvider extends EventEmitter implements AgentProvider {
  /** Relative paths this turn should write before completing. */
  writes: string[] = []
  /** How the turn ends. A cancelled or failed turn can still have written
   *  a file before it stopped. */
  ending: 'run.completed' | 'run.failed' | 'run.cancelled' = 'run.completed'

  listModels = vi.fn(async () => CATALOGUE)
  cancelRun = vi.fn(async () => undefined)
  respondToInteraction = vi.fn(async () => undefined)
  releaseConversation = vi.fn(async () => undefined)
  shutdown = vi.fn(async () => undefined)

  async getStatus(): Promise<ProviderStatus> {
    return { id: 'antigravity', state: 'ready', sdkAvailable: true, authConfigured: true, message: null, details: {} }
  }

  async sendMessage(input: ProviderSendInput, onEvent: (event: RuntimeEvent) => void): Promise<void> {
    const base = {
      projectId: input.projectId,
      conversationId: input.conversationId,
      runId: input.runId,
      providerId: 'antigravity' as const,
      createdAt: new Date().toISOString()
    }
    onEvent({ ...base, type: 'run.started', nativeConversationId: 'native-1' })

    for (const relative of this.writes) {
      const full = path.join(input.workspacePath, relative)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, `contents of ${relative}`)
    }

    if (this.ending === 'run.completed') onEvent({ ...base, type: 'run.completed', finalText: 'Done', nativeConversationId: 'native-1' })
    else if (this.ending === 'run.failed') onEvent({ ...base, type: 'run.failed', error: { code: 'provider.failed', message: 'no', retryable: false } })
    else onEvent({ ...base, type: 'run.cancelled' })
  }
}

let dir = ''
let db: OrbitDatabase
let store: OrbitStore
let provider: WritingProvider
let runtime: OrbitRuntime
let workspace = ''

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-produced-'))
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-ws-'))
  db = new OrbitDatabase({ dataDir: dir })
  await db.init()
  store = new OrbitStore(db)
  provider = new WritingProvider()
  runtime = new OrbitRuntime(store, new ArtifactService(store, new FileStorage(dir)), provider, dir, '0.1.0')
})

afterEach(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(workspace, { recursive: true, force: true })
})

/** Runs one turn in a project pointed at the temp workspace, and returns
 *  every event the runtime emitted. */
async function runTurn(writes: string[], ending: WritingProvider['ending'] = 'run.completed'): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = []
  runtime.on('event', (event) => events.push(event))
  provider.writes = writes
  provider.ending = ending

  const project = runtime.createProject('Media', workspace)
  const conversation = runtime.openProject(project.id).conversations[0]!
  await runtime.sendMessage({ projectId: project.id, conversationId: conversation.id, content: 'Draw a mountain' })
  await vi.waitFor(() => expect(events.some((event) => event.type === ending)).toBe(true))
  return events
}

function producedNames(events: RuntimeEvent[]): string[] {
  return events
    .filter((event): event is Extract<RuntimeEvent, { type: 'artifact.produced' }> => event.type === 'artifact.produced')
    .map((event) => event.artifact.name)
    .sort()
}

describe('media an agent produces reaches Artifacts', () => {
  it('registers an image the turn wrote', async () => {
    const events = await runTurn(['mountain.png'])

    expect(producedNames(events)).toEqual(['mountain.png'])
  })

  it('registers a video the turn wrote', async () => {
    expect(producedNames(await runTurn(['clip.mp4']))).toEqual(['clip.mp4'])
  })

  it('stores it as a real artifact on the project', async () => {
    const events = await runTurn(['peak.png'])
    const produced = events.find((event) => event.type === 'artifact.produced')!

    const artifacts = runtime.openProject(produced.projectId!).artifacts
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]!.name).toBe('peak.png')
    expect(artifacts[0]!.type).toBe('image')
    expect(artifacts[0]!.previewKind).toBe('image')
    // Attributed to the turn that made it.
    expect(artifacts[0]!.creatorRunId).toBe(produced.runId)
    expect(artifacts[0]!.source).toBe('provider')
  })

  it('copies the file into Orbit’s own storage, so it survives', async () => {
    const events = await runTurn(['kept.png'])
    const produced = events.find((event) => event.type === 'artifact.produced')!
    const artifact = (produced as Extract<RuntimeEvent, { type: 'artifact.produced' }>).artifact

    expect(fs.existsSync(artifact.location)).toBe(true)
    // Not merely a pointer at the workspace: deleting the original leaves
    // the artifact intact.
    fs.rmSync(path.join(workspace, 'kept.png'))
    expect(fs.existsSync(artifact.location)).toBe(true)
  })

  it('registers media written into a subfolder', async () => {
    expect(producedNames(await runTurn(['output/render.png']))).toEqual(['render.png'])
  })

  it('registers several in one turn', async () => {
    expect(producedNames(await runTurn(['a.png', 'b.webp', 'c.mp4']))).toEqual(['a.png', 'b.webp', 'c.mp4'])
  })
})

describe('ordinary project files are left alone', () => {
  it('registers nothing for a turn that only wrote source files', async () => {
    // The requirement: an agent doing normal work produces no artifacts.
    const events = await runTurn(['src/index.ts', 'src/App.tsx', 'package.json', 'README.md'])

    expect(producedNames(events)).toEqual([])
  })

  it('registers nothing for a turn that wrote nothing', async () => {
    expect(producedNames(await runTurn([]))).toEqual([])
  })

  it('registers only the media out of a mixed turn', async () => {
    expect(producedNames(await runTurn(['src/render.ts', 'diagram.svg', 'notes.md']))).toEqual(['diagram.svg'])
  })

  it('ignores media that was already there before the turn', async () => {
    fs.writeFileSync(path.join(workspace, 'existing.png'), 'old')

    expect(producedNames(await runTurn(['new.png']))).toEqual(['new.png'])
  })
})

describe('a turn that did not complete cleanly', () => {
  it('still registers media written before it failed', async () => {
    expect(producedNames(await runTurn(['partial.png'], 'run.failed'))).toEqual(['partial.png'])
  })

  it('still registers media written before it was cancelled', async () => {
    expect(producedNames(await runTurn(['stopped.png'], 'run.cancelled'))).toEqual(['stopped.png'])
  })
})

describe('nothing is announced twice', () => {
  it('emits exactly one artifact.produced per file', async () => {
    const events = await runTurn(['once.png'])

    expect(events.filter((event) => event.type === 'artifact.produced')).toHaveLength(1)
  })

  it('does not re-register an unchanged file on a later turn', async () => {
    await runTurn(['stable.png'])

    // Second turn in the same workspace, writing nothing new.
    const events: RuntimeEvent[] = []
    runtime.on('event', (event) => events.push(event))
    provider.writes = []
    const project = store.listProjects()[0]!
    const conversation = runtime.openProject(project.id).conversations[0]!
    await runtime.sendMessage({ projectId: project.id, conversationId: conversation.id, content: 'Anything else?' })
    await vi.waitFor(() => expect(events.some((event) => event.type === 'run.completed')).toBe(true))

    expect(producedNames(events)).toEqual([])
    expect(runtime.openProject(project.id).artifacts).toHaveLength(1)
  })
})
