import { describe, expect, it } from 'vitest'
import { ORBIT_PREFERRED_DEFAULT_MODELS, isRunnableSelection, pickDefaultModelId, resolveDefaultSelection } from '../../src/shared/defaultModel'
import { EMPTY_PREFERENCES } from '../../src/shared/reasoningPolicy'
import type { ModelOption, OrbitPreferences } from '../../src/shared/domain'
import { EXPECTED_DEFAULT_EFFORT, EXPECTED_DEFAULT_MODEL, NORMALIZED_CATALOGUE } from '../support/catalogue'

const prefs = (overrides: Partial<OrbitPreferences> = {}): OrbitPreferences => ({ ...EMPTY_PREFERENCES, ...overrides })

describe('pickDefaultModelId', () => {
  it('picks Orbit’s most preferred model that the real catalogue actually has', () => {
    expect(pickDefaultModelId(NORMALIZED_CATALOGUE)).toBe(EXPECTED_DEFAULT_MODEL)
  })

  it('only ever returns an id the catalogue genuinely contains', () => {
    const id = pickDefaultModelId(NORMALIZED_CATALOGUE)
    expect(NORMALIZED_CATALOGUE.some((model) => model.id === id)).toBe(true)
  })

  it('honours a configured default — the hook a setting writes to', () => {
    expect(pickDefaultModelId(NORMALIZED_CATALOGUE, 'claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
  })

  it('ignores a configured default the catalogue no longer lists', () => {
    expect(pickDefaultModelId(NORMALIZED_CATALOGUE, 'gemini-9-imaginary')).toBe(EXPECTED_DEFAULT_MODEL)
  })

  it('falls to the next preference when the first is unavailable', () => {
    const without = NORMALIZED_CATALOGUE.filter((model) => model.id !== 'gemini-3.8-flash')
    expect(pickDefaultModelId(without)).toBe('gemini-3.7-flash')
  })

  it('still resolves concretely on a catalogue containing none of Orbit’s preferences', () => {
    const alien: ModelOption[] = [
      { id: 'something-new-2', label: 'Something New 2' },
      { id: 'something-new-1', label: 'Something New 1' }
    ]
    // Not one of the preferred ids, but still a real, concrete model — the
    // decision never falls through to Antigravity.
    expect(pickDefaultModelId(alien)).toBe('something-new-2')
    expect(ORBIT_PREFERRED_DEFAULT_MODELS).not.toContain('something-new-2')
  })

  it('reports nothing only when there is genuinely no catalogue', () => {
    expect(pickDefaultModelId([])).toBeNull()
  })
})

describe('resolveDefaultSelection', () => {
  it('resolves a concrete model and a tier that model really publishes', () => {
    expect(resolveDefaultSelection(NORMALIZED_CATALOGUE, prefs())).toEqual({
      model: EXPECTED_DEFAULT_MODEL,
      reasoningEffort: EXPECTED_DEFAULT_EFFORT
    })
  })

  it('carries the user’s remembered level onto the default model', () => {
    expect(resolveDefaultSelection(NORMALIZED_CATALOGUE, prefs({ lastReasoningEffort: 'high' }))?.reasoningEffort).toBe('high')
  })

  it('never invents a tier for a configured default that has none', () => {
    expect(resolveDefaultSelection(NORMALIZED_CATALOGUE, prefs({ defaultModel: 'claude-sonnet-4-6', lastReasoningEffort: 'high' }))).toEqual({
      model: 'claude-sonnet-4-6',
      reasoningEffort: null
    })
  })

  it('maps a remembered level onto the nearest tier the model has', () => {
    const selection = resolveDefaultSelection(NORMALIZED_CATALOGUE, prefs({ defaultModel: 'gemini-3.1-pro', lastReasoningEffort: 'medium' }))
    expect(selection).toEqual({ model: 'gemini-3.1-pro', reasoningEffort: 'low' })
  })

  it('resolves to nothing only when the catalogue could not be read', () => {
    expect(resolveDefaultSelection([], prefs())).toBeNull()
  })
})

describe('isRunnableSelection', () => {
  it('accepts a concrete id the catalogue still lists', () => {
    expect(isRunnableSelection(NORMALIZED_CATALOGUE, 'gemini-3.1-pro')).toBe(true)
  })

  it('rejects the legacy "let Antigravity decide" null', () => {
    expect(isRunnableSelection(NORMALIZED_CATALOGUE, null)).toBe(false)
  })

  it('accepts a raw combined id, which agy takes directly', () => {
    // Re-resolving this would silently move the session off a model that
    // works perfectly well.
    expect(isRunnableSelection(NORMALIZED_CATALOGUE, 'gemini-3.8-flash-medium')).toBe(true)
  })

  it('does not accept a combined id whose tier the model never published', () => {
    expect(isRunnableSelection(NORMALIZED_CATALOGUE, 'gemini-3.1-pro-medium')).toBe(false)
  })

  it('rejects an id the catalogue has dropped', () => {
    expect(isRunnableSelection(NORMALIZED_CATALOGUE, 'gemini-9-imaginary')).toBe(false)
  })

  it('rejects everything when there is no catalogue', () => {
    expect(isRunnableSelection([], 'gemini-3.8-flash')).toBe(false)
  })
})
