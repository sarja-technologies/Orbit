import { describe, expect, it } from 'vitest'
import {
  UNRESOLVED_MODEL_KEY,
  DEFAULT_REASONING_EFFORT,
  EMPTY_PREFERENCES,
  effortForModel,
  effortForNewSession,
  modelForSelection,
  nearestSupportedEffort,
  normalizePreferences,
  preferenceKeyFor,
  rememberEffort,
  supportedEfforts
} from '../../src/shared/reasoningPolicy'
import type { ModelOption, OrbitPreferences } from '../../src/shared/domain'

/** Exactly the shapes agy 1.1.27 publishes: three-tier, two-tier with no
 *  medium, single fixed tier, and no reasoning control at all. */
const FLASH: ModelOption = { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', supportedReasoningEfforts: ['low', 'medium', 'high'] }
const PRO: ModelOption = { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', supportedReasoningEfforts: ['low', 'high'] }
const OSS: ModelOption = { id: 'gpt-oss-120b', label: 'GPT-OSS 120B', supportedReasoningEfforts: ['medium'] }
const SONNET: ModelOption = { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' }

const prefs = (overrides: Partial<OrbitPreferences> = {}): OrbitPreferences => ({ ...EMPTY_PREFERENCES, ...overrides })

describe('supported tiers', () => {
  it('reports the catalogue tiers ascending, and nothing for a model without them', () => {
    expect(supportedEfforts(FLASH)).toEqual(['low', 'medium', 'high'])
    expect(supportedEfforts(PRO)).toEqual(['low', 'high'])
    expect(supportedEfforts(SONNET)).toEqual([])
    expect(supportedEfforts(null)).toEqual([])
  })
})

describe('mapping a wanted tier onto a model that lacks it', () => {
  it('keeps the tier when the model really has it', () => {
    expect(nearestSupportedEffort(FLASH, 'medium')).toBe('medium')
    expect(nearestSupportedEffort(PRO, 'high')).toBe('high')
  })

  it('never fabricates medium for a high/low-only model', () => {
    // The tie resolves downward: Orbit does not escalate a session to a
    // model's most expensive tier on the strength of a preference the model
    // cannot honour.
    expect(nearestSupportedEffort(PRO, 'medium')).toBe('low')
  })

  it('walks to the nearest real tier in both directions', () => {
    expect(nearestSupportedEffort(OSS, 'high')).toBe('medium')
    expect(nearestSupportedEffort(OSS, 'low')).toBe('medium')
  })

  it('has nothing to map onto for a model with no reasoning control', () => {
    expect(nearestSupportedEffort(SONNET, 'high')).toBeNull()
  })
})

describe('choosing a tier for a newly selected model', () => {
  it('defaults a first-time user to medium', () => {
    expect(effortForModel(FLASH, prefs())).toBe(DEFAULT_REASONING_EFFORT)
    expect(effortForModel(FLASH, prefs())).toBe('medium')
  })

  it('carries the level the user last chose anywhere', () => {
    expect(effortForModel(FLASH, prefs({ lastReasoningEffort: 'high' }))).toBe('high')
  })

  it('maps a remembered level the new model cannot offer', () => {
    expect(effortForModel(PRO, prefs({ lastReasoningEffort: 'medium' }))).toBe('low')
    expect(effortForModel(OSS, prefs({ lastReasoningEffort: 'high' }))).toBe('medium')
  })

  it('prefers this model’s own remembered choice over the global one', () => {
    const remembered = prefs({ lastReasoningEffort: 'high', modelReasoningEfforts: { [FLASH.id]: 'low' } })
    expect(effortForModel(FLASH, remembered)).toBe('low')
    // …and other models still follow the global preference.
    expect(effortForModel(PRO, remembered)).toBe('high')
  })

  it('ignores a remembered choice the model no longer publishes', () => {
    const stale = prefs({ lastReasoningEffort: 'low', modelReasoningEfforts: { [PRO.id]: 'medium' } })
    expect(effortForModel(PRO, stale)).toBe('low')
  })

  it('states a single-tier model’s only level rather than asking', () => {
    expect(effortForModel(OSS, prefs({ lastReasoningEffort: 'high' }))).toBe('medium')
  })

  it('chooses nothing for a model with no reasoning control', () => {
    expect(effortForModel(SONNET, prefs({ lastReasoningEffort: 'high' }))).toBeNull()
    expect(effortForModel(null, prefs({ lastReasoningEffort: 'high' }))).toBeNull()
  })
})

describe('an unresolved selection', () => {
  // Orbit no longer offers "let Antigravity choose". A null model is a
  // session whose concrete model has not been resolved yet, not a standing
  // choice — see shared/defaultModel.ts.
  it('resolves to no model at all, rather than to a stand-in with tiers', () => {
    expect(modelForSelection([FLASH], null)).toBeNull()
    expect(modelForSelection([FLASH], FLASH.id)).toBe(FLASH)
  })

  it('does not lend tiers to a selection the catalogue has dropped', () => {
    expect(modelForSelection([FLASH], 'gemini-9-imaginary')).toBeNull()
  })

  it('files a tier chosen before resolution under a key no model can own', () => {
    expect(preferenceKeyFor(null)).toBe(UNRESOLVED_MODEL_KEY)
    expect(UNRESOLVED_MODEL_KEY).not.toBe(FLASH.id)
    expect(preferenceKeyFor(FLASH.id)).toBe(FLASH.id)
  })

  it('starts a new session on the remembered level, medium until there is one', () => {
    expect(effortForNewSession(prefs())).toBe('medium')
    expect(effortForNewSession(prefs({ lastReasoningEffort: 'low' }))).toBe('low')
  })
})

describe('remembering an explicit choice', () => {
  it('records the level globally and against the model', () => {
    const next = rememberEffort(EMPTY_PREFERENCES, FLASH.id, 'high')
    expect(next.lastReasoningEffort).toBe('high')
    expect(next.modelReasoningEfforts[FLASH.id]).toBe('high')
  })

  it('keeps per-model choices independent', () => {
    const first = rememberEffort(EMPTY_PREFERENCES, FLASH.id, 'high')
    const second = rememberEffort(first, PRO.id, 'low')
    expect(second.modelReasoningEfforts).toEqual({ [FLASH.id]: 'high', [PRO.id]: 'low' })
    // Switching away and back returns the tier each model was left on.
    expect(effortForModel(FLASH, second)).toBe('high')
    expect(effortForModel(PRO, second)).toBe('low')
  })

  it('does not treat clearing one model’s tier as changing the general preference', () => {
    const chosen = rememberEffort(EMPTY_PREFERENCES, FLASH.id, 'high')
    const cleared = rememberEffort(chosen, FLASH.id, null)
    expect(cleared.modelReasoningEfforts[FLASH.id]).toBeUndefined()
    expect(cleared.lastReasoningEffort).toBe('high')
  })
})

describe('reading persisted preferences back', () => {
  it('survives a full round trip', () => {
    const stored = rememberEffort(EMPTY_PREFERENCES, FLASH.id, 'low')
    expect(normalizePreferences(JSON.parse(JSON.stringify(stored)))).toEqual(stored)
  })

  it('discards anything that is not a real tier', () => {
    const parsed = normalizePreferences({
      lastReasoningEffort: 'extreme',
      modelReasoningEfforts: { [FLASH.id]: 'high', broken: 'turbo' }
    })
    expect(parsed.lastReasoningEffort).toBeNull()
    expect(parsed.modelReasoningEfforts).toEqual({ [FLASH.id]: 'high' })
  })

  it('falls back to empty preferences for junk', () => {
    expect(normalizePreferences(null)).toEqual(EMPTY_PREFERENCES)
    expect(normalizePreferences('nope')).toEqual(EMPTY_PREFERENCES)
    expect(normalizePreferences({ modelReasoningEfforts: [] })).toEqual(EMPTY_PREFERENCES)
  })
})
