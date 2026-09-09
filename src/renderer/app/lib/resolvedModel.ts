import type { ModelOption } from '@shared/domain'
import type { RuntimeEvent } from '@shared/runtime-events'
import { compactModelLabel } from './modelDisplay'

/** What the composer's model control actually states.
 *
 *  Two facts, not one. The *mode* is what the user chose and is always
 *  known: a specific model, or Antigravity's own default. The *resolution*
 *  is which model that turned out to be, and is only known once the runtime
 *  reports it. Collapsing them loses the difference between "I picked Flash"
 *  and "Antigravity picked Flash", which is exactly what the old single
 *  "Default model" line could not say. */
export interface ModelDisplay {
  mode: 'default' | 'explicit'
  /** The primary line: "Default", or the chosen model's compact name. */
  primary: string
  /** The resolved model beneath it, when it is genuinely known. Null in the
   *  default mode until the runtime reports one — never a guess. */
  secondary: string | null
  /** True only in the default mode with nothing reported yet. The control
   *  states this quietly rather than showing a plausible-looking model. */
  unresolved: boolean
  /** The catalogue entry to draw a provider mark from, when there is one. */
  model: ModelOption | null
}

/** Resolved models, keyed by conversation. Lives in one place in App and is
 *  fed from exactly one function (`resolvedModelFromEvent`) so there is a
 *  single seam for the runtime to widen. */
export type ResolvedModels = Record<string, string>

/** The model id a runtime event reports for its conversation, or null.
 *
 *  Today no provider populates `model` on these events (agy 1.1.27 does not
 *  report it), so this always returns null and the composer honestly says
 *  the model is not reported. It is the one place to look when that changes
 *  — no component reads run events for this. */
export function resolvedModelFromEvent(event: RuntimeEvent): { conversationId: string; model: string } | null {
  if (event.type !== 'run.started' && event.type !== 'run.completed') return null
  const model = event.model?.trim()
  if (!model || !event.conversationId) return null
  return { conversationId: event.conversationId, model }
}

/** Turns a selection plus whatever the runtime has reported into the two
 *  lines the control renders. */
export function describeModelSelection(
  selectedModel: string | null,
  models: readonly ModelOption[],
  resolvedModelId: string | null
): ModelDisplay {
  if (selectedModel) {
    const chosen = models.find((model) => model.id === selectedModel) ?? null
    return {
      mode: 'explicit',
      // An id with no catalogue entry is real catalogue drift, not a
      // mystery to paper over: show the id the session actually carries.
      primary: chosen ? compactModelLabel(chosen.label) : selectedModel,
      secondary: null,
      unresolved: false,
      model: chosen
    }
  }

  const resolved = resolvedModelId ? (models.find((model) => model.id === resolvedModelId) ?? null) : null
  if (resolvedModelId) {
    return {
      mode: 'default',
      primary: 'Default',
      secondary: resolved ? compactModelLabel(resolved.label) : resolvedModelId,
      unresolved: false,
      model: resolved
    }
  }

  return { mode: 'default', primary: 'Default', secondary: null, unresolved: true, model: null }
}

/** The full sentence a screen reader and the tooltip get. The visible
 *  control stays two short words; this is where the whole truth lives. */
export function describeModelForAssistiveText(display: ModelDisplay): string {
  if (display.mode === 'explicit') return `Model: ${display.primary}`
  if (display.secondary) return `Model: Antigravity's default, currently ${display.secondary}`
  return 'Model: Antigravity’s default. It has not reported which model it used yet.'
}
