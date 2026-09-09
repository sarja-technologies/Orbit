import type { ModelOption, ReasoningEffort } from '@shared/domain'
import { descendingEfforts } from './modelDisplay'

/** What the reasoning track is currently expressing.
 *  - `auto` — no tier chosen; Antigravity decides. Deliberately inert.
 *  - `base` — this model's lowest tier: the quietest treatment.
 *  - `mid`  — a tier between the two, or a model with a single fixed tier
 *             (a fixed tier is a fact about the model, not the top of a
 *             scale, so it never earns the peak treatment).
 *  - `peak` — this model's highest available tier: purple, and the only
 *             place purple appears.
 *  "peak" is relative to the selected model, never to a fixed idea of
 *  "high" — a model whose top tier is medium peaks at medium. */
export type ReasoningTheme = 'auto' | 'base' | 'mid' | 'peak'

export function reasoningTheme(model: ModelOption | null, effort: ReasoningEffort | null): ReasoningTheme {
  if (!effort) return 'auto'
  const efforts = descendingEfforts(model)
  if (efforts.length === 0) return 'auto'
  if (efforts.length === 1) return 'mid'
  if (effort === efforts[0]) return 'peak'
  if (effort === efforts[efforts.length - 1]) return 'base'
  return 'mid'
}

/** Where a tier's stop sits, as a fraction from the top of the track.
 *
 *  The control is a stack of `count` equal rows and every stop sits at its
 *  own row's centre, so the label, the tick and the handle are the same
 *  geometry by construction rather than by two numbers that happen to
 *  agree. A track therefore has real length at every tier, including the
 *  lowest, and shortens honestly when a model publishes fewer tiers. */
export function stopOffset(count: number, index: number): number {
  if (count <= 0) return 0.5
  return (index + 0.5) / count
}

/** How much of the track reads as active for the chosen tier: everything
 *  below the handle. Derived from stopOffset so the fill can never disagree
 *  with where the handle is drawn. */
export function trackFill(model: ModelOption | null, effort: ReasoningEffort | null): number {
  const efforts = descendingEfforts(model)
  if (!effort || efforts.length === 0) return 0
  const index = efforts.indexOf(effort)
  if (index < 0) return 0
  return 1 - stopOffset(efforts.length, index)
}

/** Which tier a pointer position inside the track belongs to, where 0 is the
 *  top edge. Rows partition the track completely, so every position lands on
 *  exactly one real tier and never between them. */
export function tierAtFraction(efforts: readonly ReasoningEffort[], fractionFromTop: number): ReasoningEffort | null {
  if (efforts.length === 0) return null
  const clamped = Math.min(0.999999, Math.max(0, fractionFromTop))
  return efforts[Math.floor(clamped * efforts.length)] ?? null
}
