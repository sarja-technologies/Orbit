import type { ModelOption } from '@shared/domain'

/** What a model is *for*, in one line.
 *
 *  The row under a model's name used to restate its reasoning tiers — which
 *  the reasoning control right next to it already says, and which tells you
 *  nothing about when to pick this model over the one below it. This module
 *  is the single place that line comes from.
 *
 *  Nothing here claims a capability a model does not have. Every description
 *  is a statement about where the model sits in its own vendor's published
 *  family (Flash below Pro, Haiku below Sonnet below Opus, mini below full)
 *  — the one thing a model's name genuinely encodes. A model whose family
 *  Orbit does not recognize gets no invented description at all: it falls
 *  back to its real catalogue id, which is honest and still useful for
 *  telling two near-identical entries apart. */

/** The four positions a family name can place a model in. Kept as constants
 *  rather than inline strings so the same wording is used everywhere and a
 *  copy change happens once. */
const PURPOSE = {
  light: 'Lightweight choice for fast exploration',
  fast: 'Fast everyday coding and quick edits',
  balanced: 'Balanced for general software work',
  deep: 'Best for difficult implementation and deeper reasoning'
} as const

export type ModelPurpose = keyof typeof PURPOSE

/** Ordered because family words overlap: `gemini-3.8-flash-lite` is a light
 *  model *and* a flash model, and the narrower rule has to win. Matched
 *  against the catalogue id, which is the stable half of an entry — labels
 *  are display text and get reworded between releases. */
const FAMILY_RULES: ReadonlyArray<{ pattern: RegExp; purpose: ModelPurpose }> = [
  { pattern: /(^|[-_])(lite|mini|nano|haiku|small)([-_]|$)/, purpose: 'light' },
  { pattern: /(^|[-_])(opus|ultra|thinking)([-_]|$)/, purpose: 'deep' },
  { pattern: /(^|[-_])(flash|turbo|fast)([-_]|$)/, purpose: 'fast' },
  { pattern: /(^|[-_])pro([-_]|$)/, purpose: 'deep' },
  { pattern: /(^|[-_])sonnet([-_]|$)/, purpose: 'balanced' }
]

/** The family position Orbit can defend for this model, or null when its
 *  name says nothing recognizable. Exported for tests and for anywhere that
 *  needs the classification rather than the sentence. */
export function modelPurpose(model: ModelOption): ModelPurpose | null {
  const id = model.id.toLowerCase()
  return FAMILY_RULES.find((rule) => rule.pattern.test(id))?.purpose ?? null
}

/** The line rendered under a model's name.
 *
 *  Real catalogue metadata always wins: if a future `agy models` ever
 *  publishes a description, `ModelOption.description` carries it and this
 *  returns it untouched. Only when there is none does Orbit fall back to its
 *  own family mapping, and only then to the model's id. */
export function modelDescription(model: ModelOption): string {
  const published = model.description?.trim()
  if (published) return published
  const purpose = modelPurpose(model)
  return purpose ? PURPOSE[purpose] : model.id
}

/** Whether the line above is Orbit's own words rather than the model's real
 *  id — the row uses this to keep an id in the same monospace treatment it
 *  gets everywhere else. */
export function isDescriptive(model: ModelOption): boolean {
  return Boolean(model.description?.trim()) || modelPurpose(model) !== null
}
