import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrbitDatabase } from '../../src/main/persistence/database'
import { OrbitStore } from '../../src/main/persistence/store'
import { FileStorage } from '../../src/main/files/fileStorage'
import { ArtifactService } from '../../src/main/artifacts/artifactService'
import { OrbitRuntime } from '../../src/main/runtime/orbitRuntime'
import { resolveDefaultModel, resolveDefaultPermissionMode } from '../../src/shared/newSessionDefaults'
import { ORBIT_DEFAULT_MODEL_ID } from '../../src/shared/defaultModel'
import { EMPTY_PREFERENCES } from '../../src/shared/reasoningPolicy'
import { attachmentPickerCategorySchema, preferencesSchema } from '../../src/main/ipc/validation'
import type { AgentProvider, ProviderSendInput } from '../../src/main/runtime/provider'
import type { ModelOption, ProviderStatus } from '../../src/shared/domain'
import type { RuntimeEvent } from '../../src/shared/runtime-events'

const CATALOGUE: ModelOption[] = [
  { id: ORBIT_DEFAULT_MODEL_ID, label: 'Gemini 3.8 Flash', supportedReasoningEfforts: ['low', 'medium', 'high'] },
  { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', supportedReasoningEfforts: ['low', 'high'] }
]

class QuietProvider implements AgentProvider {
  listModels = vi.fn(async () => CATALOGUE)
  cancelRun = vi.fn(async () => undefined)
  respondToInteraction = vi.fn(async () => undefined)
  releaseConversation = vi.fn(async () => undefined)
  shutdown = vi.fn(async () => undefined)
  async getStatus(): Promise<ProviderStatus> {
    return { id: 'antigravity', state: 'ready', sdkAvailable: true, authConfigured: true, message: null, details: {} }
  }
  async sendMessage(_input: ProviderSendInput, _onEvent: (event: RuntimeEvent) => void): Promise<void> {}
}

describe('resolving what a new session starts with', () => {
  it('uses the saved default when the catalogue still lists it', () => {
    const resolved = resolveDefaultModel({ ...EMPTY_PREFERENCES, defaultModelId: 'gemini-3.1-pro' }, CATALOGUE)
    expect(resolved).toEqual({ modelId: 'gemini-3.1-pro', source: 'preference', missingModelId: null })
  })

  it('uses Orbit’s own default when nothing is saved', () => {
    const resolved = resolveDefaultModel(EMPTY_PREFERENCES, CATALOGUE)
    expect(resolved).toEqual({ modelId: ORBIT_DEFAULT_MODEL_ID, source: 'factory', missingModelId: null })
  })

  it('falls back deterministically, and says which model went missing', () => {
    const resolved = resolveDefaultModel({ ...EMPTY_PREFERENCES, defaultModelId: 'gemini-2-retired' }, CATALOGUE)
    expect(resolved).toEqual({ modelId: ORBIT_DEFAULT_MODEL_ID, source: 'fallback', missingModelId: 'gemini-2-retired' })
  })

  it('reports honestly when Orbit’s own default is missing too', () => {
    const thin: ModelOption[] = [{ id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' }]
    const resolved = resolveDefaultModel({ ...EMPTY_PREFERENCES, defaultModelId: 'gone' }, thin)

    expect(resolved.source).toBe('unavailable')
    expect(resolved.missingModelId).toBe('gone')
    // Still concrete: a run never falls back to letting agy choose.
    expect(resolved.modelId).toBe(ORBIT_DEFAULT_MODEL_ID)
  })

  it('does not call a saved model missing on the strength of an unreadable catalogue', () => {
    // Empty means Orbit could not read the catalogue, not that the model is
    // gone — reporting it as missing there would be a guess.
    const resolved = resolveDefaultModel({ ...EMPTY_PREFERENCES, defaultModelId: 'gemini-3.1-pro' }, [])
    expect(resolved).toEqual({ modelId: 'gemini-3.1-pro', source: 'preference', missingModelId: null })
  })

  it('defaults permissions to asking, and honours a saved choice', () => {
    expect(resolveDefaultPermissionMode(EMPTY_PREFERENCES)).toBe('ask')
    expect(resolveDefaultPermissionMode({ ...EMPTY_PREFERENCES, defaultPermissionMode: 'skip' })).toBe('skip')
    // Anything unrecognized fails towards asking.
    expect(resolveDefaultPermissionMode({ ...EMPTY_PREFERENCES, defaultPermissionMode: 'nonsense' as never })).toBe('ask')
  })
})

describe('new sessions against the real runtime', () => {
  let dir: string
  let db: OrbitDatabase
  let store: OrbitStore
  let runtime: OrbitRuntime

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-defaults-'))
    db = new OrbitDatabase({ dataDir: dir })
    await db.init()
    store = new OrbitStore(db)
    runtime = new OrbitRuntime(store, new ArtifactService(store, new FileStorage(dir)), new QuietProvider(), dir, '0.1.0')
    await runtime.listModels()
  })

  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('creates a new session on the saved default model', () => {
    const project = runtime.createProject('Defaults')
    store.writePreferences({ ...store.readPreferences(), defaultModelId: 'gemini-3.1-pro' })

    const session = runtime.createConversation(project.id)

    expect(session.model).toBe('gemini-3.1-pro')
    // The tier is mapped onto the tiers that model really publishes: Pro
    // has no medium, so it is not given one.
    expect(session.reasoningEffort).toBe('low')
  })

  it('leaves existing sessions on the model they already have', () => {
    const project = runtime.createProject('Defaults')
    const before = runtime.openProject(project.id).conversations[0]!
    expect(before.model).toBe(ORBIT_DEFAULT_MODEL_ID)

    store.writePreferences({ ...store.readPreferences(), defaultModelId: 'gemini-3.1-pro' })
    const after = runtime.createConversation(project.id)

    expect(store.requireConversation(before.id).model).toBe(ORBIT_DEFAULT_MODEL_ID)
    expect(after.model).toBe('gemini-3.1-pro')
  })

  it('creates a new session in the saved default permission mode', () => {
    const project = runtime.createProject('Defaults')
    store.writePreferences({ ...store.readPreferences(), defaultPermissionMode: 'skip' })

    expect(runtime.createConversation(project.id).permissionMode).toBe('skip')
  })

  it('leaves an existing session’s permission mode alone when the default changes', () => {
    const project = runtime.createProject('Defaults')
    const before = runtime.openProject(project.id).conversations[0]!
    expect(before.permissionMode).toBe('ask')

    store.writePreferences({ ...store.readPreferences(), defaultPermissionMode: 'skip' })

    expect(store.requireConversation(before.id).permissionMode).toBe('ask')
    expect(runtime.createConversation(project.id).permissionMode).toBe('skip')
  })

  it('still gives every session a concrete model when the saved default is gone', () => {
    const project = runtime.createProject('Defaults')
    store.writePreferences({ ...store.readPreferences(), defaultModelId: 'gemini-retired' })

    const session = runtime.createConversation(project.id)

    expect(session.model).toBe(ORBIT_DEFAULT_MODEL_ID)
    expect(session.model).toBeTruthy()
    expect(runtime.defaultModelStatus()).toMatchObject({ source: 'fallback', missingModelId: 'gemini-retired' })
  })

  it('persists both defaults across a reopen', async () => {
    store.writePreferences({ ...store.readPreferences(), defaultModelId: 'gemini-3.1-pro', defaultPermissionMode: 'skip' })
    db.close()

    db = new OrbitDatabase({ dataDir: dir })
    await db.init()
    store = new OrbitStore(db)

    expect(store.readPreferences().defaultModelId).toBe('gemini-3.1-pro')
    expect(store.readPreferences().defaultPermissionMode).toBe('skip')
  })
})

describe('the preference and picker IPC contracts', () => {
  it('accepts the defaults the settings panel writes', () => {
    const parsed = preferencesSchema.parse({
      ...EMPTY_PREFERENCES,
      defaultModelId: 'gemini-3.1-pro',
      defaultPermissionMode: 'skip'
    })
    expect(parsed.defaultModelId).toBe('gemini-3.1-pro')
    expect(parsed.defaultPermissionMode).toBe('skip')
  })

  it('refuses a permission mode Orbit does not have', () => {
    expect(() => preferencesSchema.parse({ ...EMPTY_PREFERENCES, defaultPermissionMode: 'auto-approve' })).toThrow()
  })

  it('accepts only the three picker categories', () => {
    for (const category of ['image', 'video', 'files']) {
      expect(attachmentPickerCategorySchema.parse(category)).toBe(category)
    }
    // The renderer names an intent; it cannot ask for an arbitrary dialog.
    expect(() => attachmentPickerCategorySchema.parse('directory')).toThrow()
    expect(() => attachmentPickerCategorySchema.parse('*')).toThrow()
    expect(() => attachmentPickerCategorySchema.parse({ properties: ['openDirectory'] })).toThrow()
  })
})
