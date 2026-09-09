import type { ModelOption } from '@shared/domain'
import { compactModelLabel } from './modelDisplay'
import { isGeminiModel } from './providers'

/** Orbit owns the default model; the user never sees one.
 *
 *  There used to be a selectable "Default model" row that meant "whatever
 *  Antigravity picks". It was the only entry in the picker that could not
 *  answer the question the picker exists to answer — which model am I
 *  talking to — and it left sessions in a state Orbit could not report on.
 *  It is gone as a product concept.
 *
 *  Every session now carries a concrete catalogue id instead. This module is
 *  the single place Orbit decides which one that is when nothing has chosen
 *  yet: a new session, or a legacy session persisted before this rule
 *  existed.
 *
 *  It is deliberately a *stopgap in the renderer*. `fix/orbit-runtime-ux` is
 *  implementing the real Orbit-owned default and the migration of stored
 *  sessions; when that lands, this should defer to whatever the runtime
 *  reports rather than choosing on its own. Until then it never invents a
 *  model — every id it returns came out of the real `agy models` catalogue. */

/** Orbit's choice when nothing has chosen yet.
 *
 *  Gemini first, because Antigravity is a Gemini workflow, and within that
 *  simply the catalogue's own order — a stable, real entry rather than a
 *  ranking Orbit is in no position to invent. Null only when the catalogue
 *  could not be read at all, which is a state the UI reports honestly
 *  instead of papering over. */
export function orbitDefaultModel(models: readonly ModelOption[]): ModelOption | null {
  return models.find(isGeminiModel) ?? models[0] ?? null
}

/** The concrete model a session is on.
 *
 *  A stored id always wins, even one the catalogue no longer lists: that is
 *  real catalogue drift and the session genuinely carries it. Only a session
 *  that names no model at all — a legacy "Default" row — falls through to
 *  Orbit's own choice. */
export function concreteModelFor(selectedModelId: string | null, models: readonly ModelOption[]): ModelOption | null {
  if (selectedModelId === null) return orbitDefaultModel(models)
  return models.find((model) => model.id === selectedModelId) ?? null
}

/** True for a session still carrying the retired "no model chosen" state.
 *
 *  Orbit settles these on sight (see App's seeding effect) rather than
 *  leaving them to be resolved differently on every launch. */
export function needsConcreteModel(selectedModelId: string | null, models: readonly ModelOption[]): boolean {
  return selectedModelId === null && orbitDefaultModel(models) !== null
}

export interface ModelDisplay {
  /** The model's own name, compacted for the composer. */
  label: string
  /** The catalogue entry behind it, for the provider mark. Null when the
   *  session carries an id the catalogue no longer lists. */
  model: ModelOption | null
  /** The stored id, for the tooltip and for drift the label cannot show. */
  id: string | null
  /** No model can be named because the catalogue could not be read. The
   *  control says so and disables itself rather than showing a placeholder
   *  that looks like a choice. */
  unavailable: boolean
}

/** What the composer's model control renders. Always a concrete model, or an
 *  explicit statement that the catalogue is unavailable — never a third
 *  "Orbit decides" state. */
export function describeModel(selectedModelId: string | null, models: readonly ModelOption[]): ModelDisplay {
  const model = concreteModelFor(selectedModelId, models)
  if (model) return { label: compactModelLabel(model.label), model, id: model.id, unavailable: false }
  // A stored id with no catalogue entry: show the id itself, which is the
  // only true thing left to show about it.
  if (selectedModelId) return { label: selectedModelId, model: null, id: selectedModelId, unavailable: false }
  return { label: 'Model unavailable', model: null, id: null, unavailable: true }
}

export function describeModelForAssistiveText(display: ModelDisplay): string {
  if (display.unavailable) return 'Model: Antigravity’s model list could not be read.'
  return `Model: ${display.label}`
}
