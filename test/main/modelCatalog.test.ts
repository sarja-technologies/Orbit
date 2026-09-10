import { describe, expect, it } from 'vitest'
import { ORBIT_DEFAULT_MODEL_ID } from '../../src/shared/defaultModel'
import { normalizeModels, parseModelList, resolveInvocation } from '../../src/main/runtime/providers/antigravity/modelCatalog'

/** Fixture copied verbatim from a real `agy models` run (agy 1.1.27). The
 *  point of these tests is that Orbit derives reasoning support from what
 *  Antigravity actually publishes — never from a hard-coded assumption that
 *  every model has three tiers. */
const REAL_OUTPUT = [
  'Fetching available models...',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'gemini-3.7-flash-high\tGemini 3.7 Flash (High)',
  'gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)',
  'gemini-3.7-flash-low\tGemini 3.7 Flash (Low)',
  'gemini-3.6-flash-high\tGemini 3.6 Flash (High)',
  'gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)',
  'gemini-3.6-flash-low\tGemini 3.6 Flash (Low)',
  'gemini-3.1-pro-high\tGemini 3.1 Pro (High)',
  'gemini-3.1-pro-low\tGemini 3.1 Pro (Low)',
  'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
  'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)'
].join('\n')

describe('parseModelList', () => {
  it('reads id/label pairs and ignores prose lines', () => {
    const parsed = parseModelList(REAL_OUTPUT)
    expect(parsed).toHaveLength(14)
    expect(parsed[0]).toEqual({ id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' })
    expect(parsed.some((model) => model.label.startsWith('Fetching'))).toBe(false)
  })

  it('returns nothing for output that carries no model ids', () => {
    expect(parseModelList('Error: not logged in.\n')).toEqual([])
  })
})

describe('normalizeModels', () => {
  const models = normalizeModels(parseModelList(REAL_OUTPUT))
  const byId = (id: string) => models.find((model) => model.id === id)

  it('collapses tier variants into their base model', () => {
    expect(models.map((model) => model.id)).not.toContain('gemini-3.8-flash-high')
    expect(byId('gemini-3.8-flash')?.supportedReasoningEfforts).toEqual(['low', 'medium', 'high'])
    expect(byId('gemini-3.8-flash')?.label).toBe('Gemini 3.8 Flash')
  })

  it('preserves uneven tier coverage instead of assuming three levels', () => {
    // Gemini 3.1 Pro really does publish high and low but no medium.
    expect(byId('gemini-3.1-pro')?.supportedReasoningEfforts).toEqual(['low', 'high'])
  })

  it('leaves models with no tier variants without any reasoning efforts', () => {
    // Its label says "(Thinking)", but the id carries no tier suffix, so it
    // must not be presented as offering a reasoning choice.
    expect(byId('claude-sonnet-4-6')?.supportedReasoningEfforts).toBeUndefined()
    expect(byId('claude-opus-4-6-thinking')?.supportedReasoningEfforts).toBeUndefined()
  })

  it('keeps a lone variant as a real selectable model with its single tier', () => {
    const only = byId('gpt-oss-120b')
    expect(only?.supportedReasoningEfforts).toEqual(['medium'])
  })
})

describe('resolveInvocation', () => {
  const raw = parseModelList(REAL_OUTPUT)

  it('sends Orbit’s own default model when the conversation carries a legacy null', () => {
    // The old contract returned {} here, which meant "spawn agy with no
    // --model and let it choose". Orbit owns the default now, so a null
    // resolves to a real id and a real tier from the real catalogue.
    expect(resolveInvocation(null, null, raw)).toEqual({ model: ORBIT_DEFAULT_MODEL_ID, effort: 'medium' })
  })

  it('never returns an invocation without a model, whatever it is given', () => {
    for (const model of [null, undefined, '', '   ']) {
      for (const effort of [null, undefined, 'medium', 'nonsense']) {
        expect(resolveInvocation(model, effort, raw).model).toBeTruthy()
      }
    }
  })

  it('passes a raw catalogue id through without inventing an effort flag', () => {
    expect(resolveInvocation('claude-sonnet-4-6', null, raw)).toEqual({ model: 'claude-sonnet-4-6' })
  })

  it('does not append an effort to a model that has no tiers', () => {
    expect(resolveInvocation('claude-sonnet-4-6', 'high', raw)).toEqual({ model: 'claude-sonnet-4-6' })
  })

  it('combines a normalized base model with a tier it genuinely supports', () => {
    expect(resolveInvocation('gemini-3.8-flash', 'medium', raw)).toEqual({ model: 'gemini-3.8-flash', effort: 'medium' })
  })

  it('keeps a multi-tier model and resolves a tier it genuinely publishes', () => {
    // gemini-3.1-pro has no plain variant, so agy REQUIRES --effort with it.
    // Dropping the model (the old behaviour) is no longer an option, so the
    // tier is taken from the catalogue: low/high only, and a missing choice
    // resolves to the nearest real one rather than an invented medium.
    expect(resolveInvocation('gemini-3.1-pro', null, raw)).toEqual({ model: 'gemini-3.1-pro', effort: 'low' })
  })

  it('resolves an unsupported tier DOWN to a real one rather than escalating', () => {
    // medium is not published for gemini-3.1-pro; low and high are equally
    // distant, and Orbit never escalates a session to a model's peak tier.
    expect(resolveInvocation('gemini-3.1-pro', 'medium', raw)).toEqual({ model: 'gemini-3.1-pro', effort: 'low' })
  })

  it('applies a bare effort to Orbit’s default model instead of agy’s', () => {
    expect(resolveInvocation(null, 'high', raw)).toEqual({ model: ORBIT_DEFAULT_MODEL_ID, effort: 'high' })
  })

  it('sends the default model explicitly even when the catalogue could not be read', () => {
    // An empty catalogue is a failed `agy models`. It must not silently
    // restore "let agy pick": the real id still goes on the command line.
    expect(resolveInvocation(null, null, [])).toEqual({ model: ORBIT_DEFAULT_MODEL_ID })
    expect(resolveInvocation(null, 'high', [])).toEqual({ model: ORBIT_DEFAULT_MODEL_ID, effort: 'high' })
  })

  it('passes an unrecognized model through untouched', () => {
    expect(resolveInvocation('some-future-model', 'low', raw)).toEqual({ model: 'some-future-model', effort: 'low' })
  })
})
