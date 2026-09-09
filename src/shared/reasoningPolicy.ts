// The single source of truth for "which reasoning tier should this model be
// on?". Every rule here is deterministic and never invents a tier the
// catalogue does not publish for the model in question.
//
// The inputs are all real: a model's `supportedReasoningEfforts` comes
// straight from Antigravity's own catalogue (see modelCatalog.ts), and the
// remembered preferences are the user's own explicit past choices.
import type { ModelOption, OrbitPreferences, ReasoningEffort } from './domain'

/** Ascending intensity. Used for distance when a remembered tier has to be
 *  mapped onto a model that does not publish it. */
export const EFFORT_RANK: Record<ReasoningEffort, number> = { low: 0, medium: 1, high: 2 }

/** What a user who has never touched the control gets, on any model that
 *  actually publishes medium. Models without medium fall through to
 *  nearestSupportedEffort rather than gaining a fabricated one. */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'medium'

export const EMPTY_PREFERENCES: OrbitPreferences = { defaultModel: null, lastReasoningEffort: null, modelReasoningEfforts: {} }

/** The key an unresolved selection's remembered tier is filed under.
 *
 *  A session should never be here — Orbit resolves a concrete model before
 *  any run (see shared/defaultModel.ts) — but a tier chosen in the moment
 *  before that resolution lands still has to go somewhere, and it must not
 *  be filed under a real model's id. Deliberately namespaced so it can never
 *  collide with a catalogue id.
 *
 *  This replaces the old `antigravity:default` sentinel, which was not just
 *  a key: it was a *selectable option* meaning "let Antigravity choose",
 *  which Orbit no longer offers. */
export const UNRESOLVED_MODEL_KEY = 'orbit:unresolved'

/** The model option a selection refers to, or null when the catalogue does
 *  not contain it. A stale or unresolved selection resolves to null rather
 *  than to some stand-in's tier set — it must not inherit tiers it was never
 *  shown to have. */
export function modelForSelection(models: readonly ModelOption[], selectedModelId: string | null): ModelOption | null {
  if (selectedModelId === null) return null
  return models.find((model) => model.id === selectedModelId) ?? null
}

/** The preference key an explicit tier choice is remembered under. */
export function preferenceKeyFor(selectedModelId: string | null): string {
  return selectedModelId ?? UNRESOLVED_MODEL_KEY
}

/** Tiers a model genuinely publishes, ascending. Empty when the model has no
 *  reasoning control at all. */
export function supportedEfforts(model: ModelOption | null): ReasoningEffort[] {
  const efforts = model?.supportedReasoningEfforts
  if (!efforts || efforts.length === 0) return []
  return [...efforts].sort((a, b) => EFFORT_RANK[a] - EFFORT_RANK[b])
}

/** Closest tier the model really has to the one the user wants.
 *
 *  Ties (medium wanted, only low/high offered) resolve DOWNWARD on purpose:
 *  a model's highest tier is its most expensive one, and Orbit never
 *  escalates a session to peak reasoning on the strength of a preference
 *  the model cannot honour. Returns null only when the model has no tiers. */
export function nearestSupportedEffort(model: ModelOption | null, desired: ReasoningEffort): ReasoningEffort | null {
  const available = supportedEfforts(model)
  if (available.length === 0) return null
  if (available.includes(desired)) return desired
  const target = EFFORT_RANK[desired]
  let best = available[0]!
  let bestDistance = Math.abs(EFFORT_RANK[best] - target)
  for (const candidate of available.slice(1)) {
    const distance = Math.abs(EFFORT_RANK[candidate] - target)
    // Strictly-less-than keeps the lower tier on a tie, because `available`
    // is ascending and the lower candidate is seen first.
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

/** The tier a model should land on when it is selected, given what the user
 *  has chosen before. In precedence order:
 *
 *   1. A model with no tiers at all -> null (nothing to choose).
 *   2. A model with exactly one tier -> that tier (a fact, not a choice).
 *   3. An explicit past choice for THIS model, if it is still valid.
 *   4. The last tier the user explicitly chose anywhere, mapped to the
 *      nearest tier this model actually has.
 *   5. Medium for a user who has never chosen, likewise mapped. */
export function effortForModel(model: ModelOption | null, preferences: OrbitPreferences): ReasoningEffort | null {
  const available = supportedEfforts(model)
  if (available.length === 0) return null
  if (available.length === 1) return available[0]!

  const remembered = model ? preferences.modelReasoningEfforts[model.id] : undefined
  if (remembered && available.includes(remembered)) return remembered

  const desired = preferences.lastReasoningEffort ?? DEFAULT_REASONING_EFFORT
  return nearestSupportedEffort(model, desired)
}

/** The tier a brand-new session starts on before its model has been
 *  resolved against the live catalogue.
 *
 *  A provisional value only: `OrbitRuntime` resolves the session's real
 *  model and re-derives the tier from what that model genuinely publishes
 *  (see shared/defaultModel.ts), so a model without this tier never keeps
 *  it. It exists so a session is never persisted with no tier at all. */
export function effortForNewSession(preferences: OrbitPreferences): ReasoningEffort {
  return preferences.lastReasoningEffort ?? DEFAULT_REASONING_EFFORT
}

/** Folds an explicit user choice into the stored preferences. Clearing a
 *  tier (back to Antigravity's own default) deliberately does NOT erase
 *  `lastReasoningEffort` — "I want auto on this model" is not evidence that
 *  the user's general preference changed. */
export function rememberEffort(
  preferences: OrbitPreferences,
  modelId: string | null,
  effort: ReasoningEffort | null
): OrbitPreferences {
  const modelReasoningEfforts = { ...preferences.modelReasoningEfforts }
  if (modelId) {
    if (effort) modelReasoningEfforts[modelId] = effort
    else delete modelReasoningEfforts[modelId]
  }
  return {
    defaultModel: preferences.defaultModel,
    lastReasoningEffort: effort ?? preferences.lastReasoningEffort,
    modelReasoningEfforts
  }
}

/** Parses whatever was persisted back into a usable preferences object,
 *  discarding anything that is not a real tier. */
export function normalizePreferences(value: unknown): OrbitPreferences {
  if (!value || typeof value !== 'object') return EMPTY_PREFERENCES
  const raw = value as Record<string, unknown>
  const last = isEffort(raw.lastReasoningEffort) ? raw.lastReasoningEffort : null
  const defaultModel = typeof raw.defaultModel === 'string' && raw.defaultModel.trim() ? raw.defaultModel.trim() : null
  const efforts: Record<string, ReasoningEffort> = {}
  const map = raw.modelReasoningEfforts
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    for (const [modelId, effort] of Object.entries(map as Record<string, unknown>)) {
      if (modelId && isEffort(effort)) efforts[modelId] = effort
    }
  }
  return { defaultModel, lastReasoningEffort: last, modelReasoningEfforts: efforts }
}

function isEffort(value: unknown): value is ReasoningEffort {
  return value === 'low' || value === 'medium' || value === 'high'
}
