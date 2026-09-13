// The artifact output bridge, end to end through the real runtime: an
// agent produces a file during a turn — in the workspace, or through the
// provider's own tooling somewhere else — and Orbit registers it against
// that turn, keeps it, and announces it.
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
import type { AgentProvider, GeneratedOutput, GeneratedOutputQuery, ProviderSendInput } from '../../src/main/runtime/provider'
import { bytesFor, pngBytes } from './fixtures/outputFiles'
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
  /** Exact bytes for particular paths, overriding the well-formed default. */
  contents: Record<string, Buffer | string> = {}
  finalText = 'Done'
  /** What the provider's own tooling generated outside the workspace. */
  generated: GeneratedOutput[] = []
  queries: GeneratedOutputQuery[] = []
  findGeneratedOutputs = (query: GeneratedOutputQuery): GeneratedOutput[] => {
    this.queries.push(query)
    return this.generated
  }
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
      fs.writeFileSync(full, this.contents[relative] ?? bytesFor(relative))
    }

    if (this.ending === 'run.completed') onEvent({ ...base, type: 'run.completed', finalText: this.finalText, nativeConversationId: 'native-1' })
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

describe('outputs an agent produces reach Artifacts', () => {
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

  it('registers documents, data and archives, not just media', async () => {
    expect(producedNames(await runTurn(['report.pdf', 'analysis.csv', 'output.zip']))).toEqual(['analysis.csv', 'output.zip', 'report.pdf'])
  })

  it('keeps a name with spaces and non-Latin characters intact', async () => {
    const events = await runTurn(['Mountain view 山.png'])
    const artifact = (events.find((event) => event.type === 'artifact.produced') as Extract<RuntimeEvent, { type: 'artifact.produced' }>).artifact
    expect(artifact.name).toBe('Mountain view 山.png')
    expect(fs.existsSync(artifact.location)).toBe(true)
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

  it('registers only the outputs out of a mixed turn', async () => {
    expect(producedNames(await runTurn(['src/render.ts', 'diagram.svg', 'notes.md']))).toEqual(['diagram.svg'])
  })

  it('registers nothing for a large coding turn across many source files', async () => {
    const sources = Array.from({ length: 40 }, (_, index) => `src/components/Component${index}.tsx`)
    expect(producedNames(await runTurn([...sources, 'src/styles.css', 'tsconfig.json', 'CHANGELOG.md', 'node_modules/pkg/logo.png', 'dist/bundle.zip']))).toEqual([])
  })

  it('registers a new document only when the reply names it', async () => {
    provider.finalText = 'I saved the write-up as summary.md in the project root.'
    expect(producedNames(await runTurn(['summary.md', 'scratch.md']))).toEqual(['summary.md'])
  })

  it('ignores media that was already there before the turn', async () => {
    fs.writeFileSync(path.join(workspace, 'existing.png'), 'old')

    expect(producedNames(await runTurn(['new.png']))).toEqual(['new.png'])
  })
})

describe('a turn that did not complete cleanly', () => {
  it('still registers a finished image written before it failed', async () => {
    expect(producedNames(await runTurn(['partial.png'], 'run.failed'))).toEqual(['partial.png'])
  })

  it('still registers a finished image written before it was cancelled', async () => {
    expect(producedNames(await runTurn(['stopped.png'], 'run.cancelled'))).toEqual(['stopped.png'])
  })

  it('does not claim a half-written file from a cancelled turn', async () => {
    const png = pngBytes(64, 64)
    provider.contents = { 'render.png': png.subarray(0, png.length - 30) }
    expect(producedNames(await runTurn(['render.png', 'export.csv', 'done.pdf'], 'run.cancelled'))).toEqual(['done.pdf'])
  })

  it('does not claim a truncated image even from a completed turn', async () => {
    provider.contents = { 'broken.png': pngBytes(64, 64).subarray(0, 50) }
    expect(producedNames(await runTurn(['broken.png', 'fine.png']))).toEqual(['fine.png'])
  })

  it('still ends the run the way it really ended', async () => {
    const events = await runTurn(['stopped.png'], 'run.cancelled')
    const runId = events.find((event) => event.type === 'run.cancelled')!.runId
    expect(store.requireRun(runId).state).toBe('cancelled')
  })
})

describe('outputs generated outside the workspace', () => {
  let brain = ''

  beforeEach(() => {
    brain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-brain-')))
  })

  afterEach(() => {
    fs.rmSync(brain, { recursive: true, force: true })
  })

  function generated(name: string, displayName = name, bytes: Buffer = bytesFor(name)): GeneratedOutput {
    const filePath = path.join(brain, name)
    fs.writeFileSync(filePath, bytes)
    return { filePath, root: brain, displayName, byteSize: bytes.length, modifiedMs: Date.now(), origin: 'provider-generated' }
  }

  it('registers an image the provider generated, under the name the model chose', async () => {
    provider.generated = [generated('small_mountain_1789304888495.jpg', 'small_mountain.jpg')]
    const events = await runTurn([])
    expect(producedNames(events)).toEqual(['small_mountain.jpg'])
    const artifact = runtime.openProject(events[0]!.projectId!).artifacts[0]!
    expect(artifact.metadata.detectedBy).toBe('provider-output-folder')
    expect(artifact.metadata.sourceRoot).toBe(brain)
  })

  it('tells the provider what it needs to find its own folder', async () => {
    await runTurn([])
    expect(provider.queries).toHaveLength(1)
    expect(provider.queries[0]!.prompt).toBe('Draw a mountain')
    expect(provider.queries[0]!.nativeConversationId).toBe('native-1')
    expect(provider.queries[0]!.startedAtMs).toBeGreaterThan(0)
  })

  it('shows one card when the agent copied the generated image into the project', async () => {
    const bytes = pngBytes(8, 8, 3)
    provider.generated = [generated('mountain_1789304888495.png', 'mountain.png', bytes)]
    provider.contents = { 'assets/mountain.png': bytes }
    const events = await runTurn(['assets/mountain.png'])
    const produced = events.filter((event): event is Extract<RuntimeEvent, { type: 'artifact.produced' }> => event.type === 'artifact.produced')
    expect(produced).toHaveLength(1)
    expect(produced[0]!.artifact.metadata.detectedBy).toBe('workspace-scan')
  })

  it('refuses a provider output that is not inside the folder it claims', async () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-outside-')))
    try {
      fs.writeFileSync(path.join(outside, 'secret.png'), pngBytes())
      provider.generated = [{ filePath: path.join(outside, 'secret.png'), root: brain, displayName: 'secret.png', byteSize: 1, modifiedMs: Date.now(), origin: 'provider-generated' }]
      expect(producedNames(await runTurn([]))).toEqual([])
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('an Unsorted session', () => {
  it('keeps what it produced, attached to the turn, and takes it along into a project', async () => {
    const events: RuntimeEvent[] = []
    runtime.on('event', (event) => events.push(event))
    provider.writes = ['mountain.png']
    const conversation = runtime.createConversation(null)
    const run = await runtime.sendMessage({ conversationId: conversation.id, content: 'Draw a mountain' })
    await vi.waitFor(() => expect(events.some((event) => event.type === 'run.completed')).toBe(true))

    const unsorted = runtime.openUnsorted()
    expect(unsorted.artifacts.map((artifact) => artifact.name)).toEqual(['mountain.png'])
    expect(unsorted.artifacts[0]!.creatorRunId).toBe(run.id)
    expect(unsorted.artifacts[0]!.projectId).toBeNull()
    const reply = unsorted.messages.find((message) => message.role === 'assistant')!
    expect(reply.runId).toBe(run.id)

    const project = runtime.createProject('Filed')
    runtime.assignConversationToProject(conversation.id, project.id)
    expect(runtime.openUnsorted().artifacts).toEqual([])
    expect(runtime.openProject(project.id).artifacts.map((artifact) => artifact.creatorRunId)).toEqual([run.id])
  })

  it('removes its outputs and their stored copies when the session is deleted', async () => {
    const events: RuntimeEvent[] = []
    runtime.on('event', (event) => events.push(event))
    provider.writes = ['doomed.png']
    const conversation = runtime.createConversation(null)
    await runtime.sendMessage({ conversationId: conversation.id, content: 'Draw' })
    await vi.waitFor(() => expect(events.some((event) => event.type === 'run.completed')).toBe(true))
    const artifact = runtime.openUnsorted().artifacts[0]!

    await runtime.deleteConversation(conversation.id)
    expect(runtime.openUnsorted().artifacts).toEqual([])
    expect(fs.existsSync(artifact.location)).toBe(false)
  })
})

describe('the same filename across turns', () => {
  it('gives each turn its own copy, so an earlier card never changes', async () => {
    provider.contents = { 'mountain.png': pngBytes(4, 4, 1) }
    const first = await runTurn(['mountain.png'])
    const firstArtifact = (first.find((event) => event.type === 'artifact.produced') as Extract<RuntimeEvent, { type: 'artifact.produced' }>).artifact

    const second: RuntimeEvent[] = []
    runtime.on('event', (event) => second.push(event))
    provider.contents = { 'mountain.png': pngBytes(16, 16, 2) }
    const project = store.listProjects()[0]!
    const conversation = runtime.openProject(project.id).conversations[0]!
    await runtime.sendMessage({ projectId: project.id, conversationId: conversation.id, content: 'Make it bigger' })
    await vi.waitFor(() => expect(second.some((event) => event.type === 'run.completed')).toBe(true))
    const secondArtifact = (second.find((event) => event.type === 'artifact.produced') as Extract<RuntimeEvent, { type: 'artifact.produced' }>).artifact

    expect(secondArtifact.id).not.toBe(firstArtifact.id)
    expect(secondArtifact.creatorRunId).not.toBe(firstArtifact.creatorRunId)
    expect(fs.readFileSync(firstArtifact.location).equals(pngBytes(4, 4, 1))).toBe(true)
    expect(fs.readFileSync(secondArtifact.location).equals(pngBytes(16, 16, 2))).toBe(true)
  })
})

describe('after a restart', () => {
  it('the artifact is still attached to its turn when the database is reopened', async () => {
    const events = await runTurn(['kept.png'])
    const runId = events.find((event) => event.type === 'run.completed')!.runId
    const projectId = events[0]!.projectId!

    db.close()
    db = new OrbitDatabase({ dataDir: dir })
    await db.init()
    store = new OrbitStore(db)
    const reopened = store.openProjectSnapshot(projectId)

    expect(reopened.artifacts.map((artifact) => [artifact.name, artifact.creatorRunId])).toEqual([['kept.png', runId]])
    expect(reopened.messages.find((message) => message.role === 'assistant')!.runId).toBe(runId)
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
