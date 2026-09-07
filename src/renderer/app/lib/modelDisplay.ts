import type { ModelOption, ReasoningEffort } from '@shared/domain'

/** Vendors whose name is already implied by the surrounding UI (the whole
 *  catalogue is Antigravity's). Dropping the prefix in the composer's
 *  compact control buys real horizontal space without losing identity —
 *  "3.8 Flash" is unambiguous where "Gemini 3.8 Flash" is just longer. */
const IMPLIED_VENDOR = /^Gemini\s+/i
const TRAILING_NOTE = /\s*\([^)]*\)\s*$/

/** The label used inside the closed composer control. Never invents a name:
 *  it only ever removes text from the catalogue's own display name, and
 *  falls back to the full label if trimming would leave nothing useful. */
export function compactModelLabel(label: string): string {
  const withoutNote = label.replace(TRAILING_NOTE, '').trim()
  const base = withoutNote.length > 0 ? withoutNote : label.trim()
  const shortened = base.replace(IMPLIED_VENDOR, '').trim()
  return shortened.length > 0 ? shortened : base
}

export const EFFORT_LABEL: Record<ReasoningEffort, string> = { low: 'Low', medium: 'Medium', high: 'High' }

/** Highest first, so the slider can render top-down without re-sorting at
 *  the call site. Only ever contains tiers the model genuinely publishes. */
export function descendingEfforts(model: ModelOption | null): ReasoningEffort[] {
  const efforts = model?.supportedReasoningEfforts
  if (!efforts || efforts.length === 0) return []
  return [...efforts].reverse()
}

/** A model whose reasoning cannot be changed — either it has no tiers at
 *  all, or it publishes exactly one, which is a fact to state rather than a
 *  control to offer. */
export function isReasoningAdjustable(model: ModelOption | null): boolean {
  return descendingEfforts(model).length > 1
}
