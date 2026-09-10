// What each model in Antigravity's catalogue is actually *for*, as the one
// line shown under its name in the chooser.
//
// The rule this file exists to keep: a description says what a model family
// is, in the plainest terms, and never makes a claim Orbit cannot stand
// behind. There are no benchmark numbers, no superlatives Orbit invented,
// and no ranking of one vendor against another — each entry describes its
// own family's stated position within its own vendor's line-up, which is
// the only comparison that is a fact rather than an opinion.
//
// Matching is on the catalogue id, which is the stable half of a model
// entry (labels are display text and get reworded between releases). A
// family Orbit does not recognize is NOT given a made-up description: it
// falls back to what is genuinely known — the vendor, and the real
// catalogue id — so a new model appearing in `agy models` degrades to
// honest text rather than to a wrong one.
//
// To describe a new family, add a rule below. Nothing else needs touching.
import type { ModelOption } from '@shared/domain'
import { PROVIDERS, providerForModel, type ProviderKey } from './providers'

export interface ModelDescription {
  provider: ProviderKey
  /** The parts of the description line, in order. Joined with a separator
   *  by the component that renders it, so the separator lives in one place
   *  and an entry with a single part never renders a dangling one. */
  parts: string[]
}

interface DescriptionRule {
  /** Tested against the lowercased catalogue id. */
  match: RegExp
  parts: readonly [string, string]
}

// Ordered: the first match wins, so a more specific family is listed above
// the broader pattern that would also match it.
const RULES: readonly DescriptionRule[] = [
  // Gemini — Google's line-up, split by the Flash/Pro tiering Google itself
  // publishes across every Gemini generation.
  {
    match: /^gemini.*flash.*lite/,
    parts: ['Google’s lightest Gemini model', 'built for high-volume, low-latency work']
  },
  {
    match: /^gemini.*flash/,
    parts: ['Google’s fast Gemini model', 'quick everyday coding and iteration']
  },
  {
    match: /^gemini.*(pro|ultra)/,
    parts: ['Google’s high-capability Gemini model', 'agentic coding and complex reasoning']
  },
  { match: /^gemini/, parts: ['Google’s Gemini model family', 'general-purpose coding and reasoning'] },

  // Claude — Anthropic's three named tiers.
  { match: /^claude.*opus/, parts: ['Anthropic’s highest-capability model', 'deep coding and long-running tasks'] },
  { match: /^claude.*sonnet/, parts: ['Anthropic’s balanced coding model', 'strong mix of speed and capability'] },
  { match: /^claude.*haiku/, parts: ['Anthropic’s fastest model', 'short, latency-sensitive tasks'] },
  { match: /^claude/, parts: ['Anthropic’s Claude model family', 'general-purpose coding and reasoning'] },

  // OpenAI — Codex is the coding-specialized line; gpt-oss is the
  // open-weight release; everything else falls to the general GPT entry.
  { match: /codex/, parts: ['OpenAI’s coding-focused model', 'software engineering and tool use'] },
  { match: /^gpt-oss/, parts: ['OpenAI’s open-weight model', 'self-hosted reasoning and coding'] },
  { match: /^(gpt|openai)/, parts: ['OpenAI’s general model family', 'coding, reasoning and tool use'] },
  { match: /^o\d/, parts: ['OpenAI’s reasoning model', 'step-by-step problem solving'] }
]

/** The description shown under a model's name.
 *
 *  Never states a reasoning level: which tiers a model publishes is a
 *  separate, adjustable setting with its own control, and spending the
 *  description line on "High · Medium · Low" said nothing about what the
 *  model is. */
export function describeModel(model: ModelOption): ModelDescription {
  const provider = providerForModel(model)
  const rule = RULES.find((candidate) => candidate.match.test(model.id.toLowerCase()))
  if (rule) return { provider, parts: [...rule.parts] }

  // Unrecognized family. Say only what is certain: who publishes it (when
  // the id identifies a vendor at all) and what the catalogue calls it.
  const vendor = PROVIDERS[provider].vendor
  return { provider, parts: vendor ? [`${vendor} model`, model.id] : [model.id] }
}

/** The rendered line, for callers that want the string rather than the
 *  parts. The separator is a middle dot with hair spacing, matching the
 *  shape used elsewhere in the chooser. */
export function modelDescriptionLine(model: ModelOption): string {
  return describeModel(model).parts.join(' • ')
}
