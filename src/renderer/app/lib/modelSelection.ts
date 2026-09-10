import type { ModelOption } from '@shared/domain'
import { compactModelLabel } from './modelDisplay'

/** How the composer's model control *reads*. Not how a model is *chosen*.
 *
 *  That distinction is the whole point of this file. `shared/defaultModel.ts`
 *  is the single authority on which model Orbit runs — it is shared with the
 *  main process, so the id the runtime passes to `agy --model` and the id the
 *  composer shows are the same decision, made once. Nothing here picks a
 *  model, falls back to one, or invents one; a second opinion living in the
 *  renderer is exactly how a UI and its runtime start disagreeing about what
 *  the user is talking to.
 *
 *  So this module only turns a selection that has *already* been made into
 *  the two or three strings the control draws. */

export interface ModelDisplay {
  /** The model's own name, compacted for the composer. */
  label: string
  /** The catalogue entry behind it, for the provider mark. Null when the
   *  session carries an id the normalized catalogue does not list. */
  model: ModelOption | null
  /** The stored id, for the tooltip and for drift the label cannot show. */
  id: string | null
  /** Nothing is selected yet. A brief state, not a standing one: App
   *  resolves a concrete model as soon as the catalogue is known, and there
   *  is no user-selectable "let Antigravity choose" to sit in. */
  resolving: boolean
  /** The catalogue could not be read at all, so no model can be named. */
  unavailable: boolean
}

/** What the composer's model control renders. Always a concrete model, or an
 *  explicit statement that Orbit is still resolving one / cannot read the
 *  catalogue — never a third "Orbit decides" state. */
export function describeModel(selectedModelId: string | null, models: readonly ModelOption[]): ModelDisplay {
  const model = selectedModelId ? (models.find((candidate) => candidate.id === selectedModelId) ?? null) : null
  if (model) return { label: compactModelLabel(model.label), model, id: model.id, resolving: false, unavailable: false }

  // A stored id the normalized catalogue does not list. Either real drift,
  // which App migrates on sight, or a raw combined id like
  // `gemini-3.8-flash-medium` that agy accepts directly and that
  // isRunnableSelection deliberately leaves alone. Showing the id itself is
  // the only true thing left to show, and beats claiming to be resolving
  // something that is already settled.
  if (selectedModelId) return { label: selectedModelId, model: null, id: selectedModelId, resolving: false, unavailable: false }

  if (models.length === 0) return { label: 'Model unavailable', model: null, id: null, resolving: false, unavailable: true }
  return { label: 'Resolving…', model: null, id: null, resolving: true, unavailable: false }
}

export function describeModelForAssistiveText(display: ModelDisplay): string {
  if (display.unavailable) return 'Model: Antigravity’s model list could not be read.'
  if (display.resolving) return 'Model: Orbit is resolving this session’s model.'
  return `Model: ${display.label}`
}
