import type { ModelOption } from '@shared/domain'

/** Providers Orbit can name and mark. 'other' is the honest bucket for a
 *  catalogue entry whose vendor cannot be identified from its id — it gets a
 *  neutral monogram rather than a guessed logo. */
export type ProviderKey = 'gemini' | 'anthropic' | 'openai' | 'other'

export interface ProviderIdentity {
  key: ProviderKey
  /** Section heading in the full model browser — the product family. */
  label: string
  /** The company behind it, used where a description names the maker
   *  ("Google's fastest Gemini model"). Never guessed for 'other'. */
  vendor: string | null
  /** Drawn when no official asset could be sourced for this provider. */
  monogram: string
}

export const PROVIDERS: Record<ProviderKey, ProviderIdentity> = {
  gemini: { key: 'gemini', label: 'Gemini', vendor: 'Google', monogram: 'G' },
  anthropic: { key: 'anthropic', label: 'Claude', vendor: 'Anthropic', monogram: 'A' },
  openai: { key: 'openai', label: 'OpenAI', vendor: 'OpenAI', monogram: 'O' },
  other: { key: 'other', label: 'Other models', vendor: null, monogram: '·' }
}

/** Order the browser groups providers in: Antigravity is a Gemini workflow
 *  first, so Gemini leads and unknown vendors trail. */
export const PROVIDER_ORDER: readonly ProviderKey[] = ['gemini', 'anthropic', 'openai', 'other']

/** Matched against the catalogue id, which is the stable half of a model
 *  entry — labels are display text and change wording between releases. */
export function providerForModel(model: ModelOption | null): ProviderKey {
  if (!model) return 'other'
  return providerForModelId(model.id)
}

/** The provider a catalogue id belongs to. Kept separate from
 *  `providerForModel` so anything holding only an id — a stored
 *  conversation's `model`, say — can ask the same question. */
export function providerForModelId(modelId: string | null): ProviderKey {
  if (!modelId) return 'other'
  const id = modelId.toLowerCase()
  if (id.startsWith('gemini')) return 'gemini'
  if (id.startsWith('claude')) return 'anthropic'
  if (id.startsWith('gpt') || id.startsWith('openai') || id.startsWith('codex') || /^o\d/.test(id)) return 'openai'
  return 'other'
}

export function isGeminiModel(model: ModelOption): boolean {
  return providerForModel(model) === 'gemini'
}

export interface ProviderGroup {
  provider: ProviderIdentity
  models: ModelOption[]
}

/** Groups the real catalogue by provider in PROVIDER_ORDER, dropping any
 *  provider the catalogue has no models for. */
export function groupByProvider(models: ModelOption[]): ProviderGroup[] {
  const groups = new Map<ProviderKey, ModelOption[]>()
  for (const model of models) {
    const key = providerForModel(model)
    const bucket = groups.get(key)
    if (bucket) bucket.push(model)
    else groups.set(key, [model])
  }
  return PROVIDER_ORDER.filter((key) => groups.has(key)).map((key) => ({
    provider: PROVIDERS[key],
    models: groups.get(key)!
  }))
}

/** Substring match over the things a person would actually type: the model's
 *  display name, its catalogue id, and the provider's name. */
export function matchesQuery(model: ModelOption, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  const provider = PROVIDERS[providerForModel(model)]
  return (
    model.label.toLowerCase().includes(needle) ||
    model.id.toLowerCase().includes(needle) ||
    provider.label.toLowerCase().includes(needle)
  )
}
