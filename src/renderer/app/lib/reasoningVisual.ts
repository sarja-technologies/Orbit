import type { ModelOption, ReasoningEffort } from '@shared/domain'
import { descendingEfforts } from './modelDisplay'

/** What the reasoning track is currently expressing.
 *  - `auto`  — no tier chosen; Antigravity decides. Deliberately inert.
 *  - `calm`  — a tier below this model's maximum: restrained teal-green.
 *  - `peak`  — this model's highest available tier: purple, with sparks.
 *  "peak" is relative to the selected model, never to a fixed idea of
 *  "high" — a model whose top tier is medium peaks at medium. */
export type ReasoningTheme = 'auto' | 'calm' | 'peak'

export function reasoningTheme(model: ModelOption | null, effort: ReasoningEffort | null): ReasoningTheme {
  if (!effort) return 'auto'
  const [highest] = descendingEfforts(model)
  if (!highest) return 'auto'
  return effort === highest ? 'peak' : 'calm'
}

/** Fast mode is the only thing that changes the animation's tempo — it is
 *  not a reasoning tier and must never be read as one. */
export function animationTempo(fastMode: boolean): 'quick' | 'steady' {
  return fastMode ? 'quick' : 'steady'
}

/** How full the track reads for a given tier: purely positional, derived
 *  from where the tier sits among the ones this model actually offers. */
export function trackFill(model: ModelOption | null, effort: ReasoningEffort | null): number {
  const efforts = descendingEfforts(model)
  if (!effort || efforts.length === 0) return 0
  const index = efforts.indexOf(effort)
  if (index < 0) return 0
  if (efforts.length === 1) return 1
  // Top of the list is the highest tier, so invert the index.
  return (efforts.length - 1 - index) / (efforts.length - 1)
}

/** Nearest valid tier for a pointer position inside the track, where 0 is
 *  the top edge. Snapping is to real tiers only — there are no positions
 *  between them to land on. */
export function tierAtFraction(efforts: readonly ReasoningEffort[], fractionFromTop: number): ReasoningEffort | null {
  if (efforts.length === 0) return null
  if (efforts.length === 1) return efforts[0] ?? null
  const clamped = Math.min(1, Math.max(0, fractionFromTop))
  const index = Math.round(clamped * (efforts.length - 1))
  return efforts[index] ?? null
}
