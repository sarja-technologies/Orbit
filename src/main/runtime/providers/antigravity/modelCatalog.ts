// Antigravity's real model catalogue, and the model/effort -> CLI argument
// mapping. Ported from AgentDock Pro's live-tested
// `antigravity-model-normalization.ts` / `antigravity-model-catalog-service.ts`,
// preserving the semantics exactly rather than reinterpreting them.
//
// `agy models` reports one COMBINED id per reasoning tier — confirmed live
// against the installed agy 1.1.27:
//   gemini-3.8-flash-high     Gemini 3.8 Flash (High)
//   gemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)
//   gemini-3.8-flash-low      Gemini 3.8 Flash (Low)
// — three catalogue entries for what a person thinks of as one model at
// three reasoning levels. A Model/Reasoning UI needs those split apart;
// this module is the single place that split happens, in both directions.
//
// Every rule below is grounded in real, live-tested `agy` invocations (the
// AgentDock header documents these against 1.1.18; the catalogue shape is
// unchanged on 1.1.27):
//   - `agy --model gemini-3.7-flash --effort high`  -> succeeds
//   - `agy --model gemini-3.7-flash-low`            -> succeeds (combined id)
//   - `agy --effort high` (no --model)              -> succeeds, agy's default
//   - `agy --model gemini-3.6-flash` (multi-tier base, NO --effort)
//       -> ERROR: "requires --effort (available: low, medium, high)"
//   - `agy --model claude-sonnet-4-6` (no tiers)    -> succeeds
// A multi-tier base genuinely REQUIRES an explicit effort, and there is no
// discoverable "default tier" anywhere in `agy models` output — so one is
// never guessed here.
import { spawn } from 'node:child_process'
import type { ModelOption, ReasoningEffort } from '@shared/domain'
import { pickDefaultModelId } from '@shared/defaultModel'
import { DEFAULT_REASONING_EFFORT, nearestSupportedEffort } from '@shared/reasoningPolicy'

export const REASONING_TIERS: readonly ReasoningEffort[] = ['low', 'medium', 'high'] as const

const VARIANT_SUFFIX = /^(.+)-(low|medium|high)$/
const MODEL_ID_LINE = /^[a-z0-9][a-z0-9.-]*$/
const FETCH_TIMEOUT_MS = 10_000

function capitalize(word: string): string {
  return word.length > 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word
}

function labelize(id: string): string {
  return id
    .split('-')
    .map((part) => capitalize(part))
    .join(' ')
}

/** Splits ONE raw catalogue entry into its base identity + which single tier
 *  it represents — null when the id carries no low/medium/high suffix at all
 *  (a genuinely single-tier model, e.g. "claude-sonnet-4-6"). The base label
 *  is derived from the label agy itself supplied, never guessed. */
function splitVariant(raw: ModelOption): { baseId: string; baseLabel: string; tier: ReasoningEffort } | null {
  const match = VARIANT_SUFFIX.exec(raw.id)
  if (!match) return null
  const baseId = match[1]!
  const tier = match[2] as ReasoningEffort
  const tierMention = new RegExp(`\\s*\\(?${capitalize(tier)}\\)?\\s*$`, 'i')
  const baseLabel = raw.label.replace(tierMention, '').trim()
  return { baseId, baseLabel: baseLabel || baseId, tier }
}

/** Groups the raw combined-id catalogue into one entry per base model, whose
 *  `supportedReasoningEfforts` contains EXACTLY the tiers genuinely present
 *  for that base — never manufacturing one (a base with only low/high never
 *  gains a fabricated medium). An entry with no tier suffix passes through
 *  with no efforts at all, which is how "this model has no reasoning
 *  control" is represented. Order follows each base's first appearance;
 *  duplicate ids/tiers are ignored. */
export function normalizeModels(raw: ModelOption[]): ModelOption[] {
  const order: string[] = []
  const groups = new Map<string, { label: string; efforts: Set<ReasoningEffort> }>()

  for (const model of raw) {
    const split = splitVariant(model)
    const key = split ? split.baseId : model.id
    if (!groups.has(key)) {
      order.push(key)
      groups.set(key, { label: split ? split.baseLabel : model.label, efforts: new Set() })
    }
    if (split) groups.get(key)!.efforts.add(split.tier)
  }

  return order.map((id) => {
    const group = groups.get(id)!
    const efforts = REASONING_TIERS.filter((tier) => group.efforts.has(tier))
    return efforts.length > 0 ? { id, label: group.label, supportedReasoningEfforts: efforts } : { id, label: group.label }
  })
}

export interface AntigravityInvocation {
  model?: string
  effort?: ReasoningEffort
}

/** The one place a model + effort choice becomes real `--model`/`--effort`
 *  arguments. `rawCatalog` must be the same un-normalized list
 *  normalizeModels() consumes.
 *
 *  PRODUCT RULE: this never produces an invocation without a `--model`
 *  while a catalogue exists. Orbit owns its default model (see
 *  shared/defaultModel.ts) and always names it explicitly; the old
 *  behaviour of omitting `--model` so agy would pick — for a null
 *  selection, and for a multi-tier base whose tier was missing — is gone.
 *  The only model-less result left is an empty catalogue, which callers
 *  must treat as a failure rather than as agy's default (see
 *  AntigravityProvider.sendMessage). */
export function resolveInvocation(
  model: string | null | undefined,
  reasoningEffort: string | null | undefined,
  rawCatalog: ModelOption[]
): AntigravityInvocation {
  const effort = (reasoningEffort || undefined) as ReasoningEffort | undefined

  // No selection: Orbit picks a concrete model from the real catalogue
  // rather than handing the decision to agy.
  const requested = model || pickDefaultModelId(normalizeModels(rawCatalog))
  // The catalogue could not be read at all. There is nothing concrete to
  // name, and naming nothing means agy chooses — which is exactly what this
  // must never do. The caller turns this into an honest error.
  if (!requested) return {}

  // Already a real, self-contained raw id (a combined id, or a genuinely
  // single-tier model). agy accepts this alone; never send a redundant or
  // conflicting --effort alongside an id that already encodes one.
  if (rawCatalog.some((candidate) => candidate.id === requested)) return { model: requested }

  // Otherwise it must be a normalized BASE id — find its real tiers.
  const variantPrefix = `${requested}-`
  const variantTiers = REASONING_TIERS.filter((tier) => rawCatalog.some((candidate) => candidate.id === `${variantPrefix}${tier}`))

  // Unrecognized entirely (stale/future catalogue drift) — pass it through
  // rather than silently dropping the choice, so agy's own "unknown model"
  // error surfaces like any other bad launch configuration.
  if (variantTiers.length === 0) return effort ? { model: requested, effort } : { model: requested }

  if (effort && variantTiers.includes(effort)) return { model: requested, effort }

  // A multi-tier base whose tier is missing or not one this model publishes.
  // agy's CLI requires --effort here. Orbit chooses the tier — the nearest
  // one this model really has to the documented default — instead of
  // dropping the model and letting agy choose the whole thing.
  const resolved =
    nearestSupportedEffort({ id: requested, label: requested, supportedReasoningEfforts: variantTiers }, DEFAULT_REASONING_EFFORT) ??
    variantTiers[0]!
  return { model: requested, effort: resolved }
}

/** Parses `agy models` stdout. Two real shapes are tolerated: `<id>\t<label>`
 *  (current) and a bare `<id>`. Non-model chrome is filtered by
 *  MODEL_ID_LINE; agy's "Fetching available models..." goes to stderr. */
export function parseModelList(stdout: string): ModelOption[] {
  const seen = new Set<string>()
  const models: ModelOption[] = []
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const tabIndex = line.indexOf('\t')
    const id = (tabIndex === -1 ? line : line.slice(0, tabIndex)).trim()
    if (!MODEL_ID_LINE.test(id) || seen.has(id)) continue
    const label = (tabIndex === -1 ? '' : line.slice(tabIndex + 1).trim()) || labelize(id)
    seen.add(id)
    models.push({ id, label })
  }
  return models
}

/** Live `agy models` fetch. Resolves to [] on any failure (spawn error,
 *  timeout, non-zero exit, unparseable output) — callers decide the
 *  fallback rather than this inventing a catalogue. */
export function fetchModels(executable: string): Promise<ModelOption[]> {
  return new Promise((resolve) => {
    let stdout = ''
    let settled = false
    const finish = (models: ModelOption[]): void => {
      if (settled) return
      settled = true
      resolve(models)
    }
    try {
      const child = spawn(executable, ['models'], { stdio: ['ignore', 'pipe', 'pipe'], shell: false })
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        finish([])
      }, FETCH_TIMEOUT_MS)
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      child.on('error', () => {
        clearTimeout(timer)
        finish([])
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        finish(code === 0 ? parseModelList(stdout) : [])
      })
    } catch {
      finish([])
    }
  })
}
