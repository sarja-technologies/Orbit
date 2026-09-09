// Orbit owns its default model.
//
// Product rule, deliberately absolute: Orbit never asks Antigravity to pick a
// model. There is no "Default" selection that hands the decision to `agy` and
// then waits to discover what it chose. Every run names a concrete model id
// from the real, live `agy models` catalogue, and the id Orbit stores and
// shows is the same id it passed on the command line.
//
// This module is the single place that decision is made, so it can become a
// user-facing setting by giving `OrbitPreferences.defaultModel` a control —
// nothing else needs to change.
import type { ModelOption, OrbitPreferences, ReasoningEffort } from './domain'
import { effortForModel } from './reasoningPolicy'

/** Orbit's own preference order, by normalized base id, most preferred
 *  first.
 *
 *  These are real ids from the installed catalogue (verified against agy
 *  1.1.28 — see docs/antigravity-transports.md), but the list is a
 *  *preference*, not a requirement: an id that is not in the live catalogue
 *  is skipped, and a catalogue containing none of them still resolves, to
 *  its own first entry. So a future catalogue that renames everything keeps
 *  working, and still never defers the choice to agy.
 *
 *  The order is Orbit's editorial judgement: the newest general-purpose
 *  Flash model first (fast, and it publishes all three reasoning tiers),
 *  then its predecessors, then the non-Gemini models. */
export const ORBIT_PREFERRED_DEFAULT_MODELS: readonly string[] = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.1-pro',
  'claude-sonnet-4-6'
] as const

/** The concrete model id Orbit defaults to, given the catalogue it can
 *  actually see.
 *
 *  Precedence:
 *   1. the configured default (`OrbitPreferences.defaultModel`), when the
 *      catalogue still contains it — the future setting's hook;
 *   2. the first of Orbit's preferred ids the catalogue contains;
 *   3. the catalogue's own first entry.
 *
 *  Returns null ONLY when the catalogue is empty, which means `agy models`
 *  could not be read. That is a real failure and callers must treat it as
 *  one: there is deliberately no "fall back to agy's default" branch here,
 *  because using it is exactly the behaviour this module exists to remove.
 *
 *  `models` is the NORMALIZED catalogue (one entry per base model, carrying
 *  the tiers it genuinely publishes) — the same view the picker shows, so
 *  the default can never be an id the user could not also have chosen. */
export function pickDefaultModelId(models: readonly ModelOption[], configured: string | null = null): string | null {
  if (models.length === 0) return null
  if (configured && models.some((model) => model.id === configured)) return configured
  const preferred = ORBIT_PREFERRED_DEFAULT_MODELS.find((id) => models.some((model) => model.id === id))
  return preferred ?? models[0]!.id
}

export interface ModelSelection {
  model: string
  /** null only for a model that publishes no reasoning tiers at all. */
  reasoningEffort: ReasoningEffort | null
}

/** Orbit's default model *and* the tier it should run at, resolved together
 *  so a session is never left half-decided. The tier comes from the same
 *  policy an explicit model choice uses (reasoningPolicy.effortForModel), so
 *  the default is not a special case with rules of its own. */
export function resolveDefaultSelection(
  models: readonly ModelOption[],
  preferences: OrbitPreferences
): ModelSelection | null {
  const id = pickDefaultModelId(models, preferences.defaultModel)
  if (!id) return null
  const model = models.find((candidate) => candidate.id === id) ?? null
  return { model: id, reasoningEffort: effortForModel(model, preferences) }
}

/** Whether a stored selection is one Orbit can run as-is.
 *
 *  A concrete id the catalogue still lists is kept exactly as it is — the
 *  user chose it, and a catalogue refresh is not a reason to move them. A
 *  null model is the legacy "let agy decide" state and is not runnable;
 *  neither is an id the catalogue no longer has.
 *
 *  A raw COMBINED id (`gemini-3.8-flash-medium`) counts as runnable even
 *  though the normalized catalogue lists only its base: agy accepts it
 *  directly (see modelCatalog.resolveInvocation), so re-resolving it would
 *  silently move a session off a model that works. */
export function isRunnableSelection(models: readonly ModelOption[], model: string | null): model is string {
  if (model === null) return false
  if (models.some((candidate) => candidate.id === model)) return true
  return models.some(
    (candidate) =>
      model.startsWith(`${candidate.id}-`) &&
      (candidate.supportedReasoningEfforts ?? []).some((tier) => model === `${candidate.id}-${tier}`)
  )
}
