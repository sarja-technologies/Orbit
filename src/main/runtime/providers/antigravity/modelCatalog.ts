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
//     (a real CLI fact, but NOT one Orbit uses any more: Orbit owns its
//      default model and always sends --model — see defaultModel.ts)
//   - `agy --model gemini-3.6-flash` (multi-tier base, NO --effort)
//       -> ERROR: "requires --effort (available: low, medium, high)"
//   - `agy --model claude-sonnet-4-6` (no tiers)    -> succeeds
// A multi-tier base genuinely REQUIRES an explicit effort, and there is no
// discoverable "default tier" anywhere in `agy models` output — so one is
// never guessed here.
import { spawn } from 'node:child_process'
import type { ModelOption, ReasoningEffort } from '@shared/domain'
import { resolveModelId } from '@shared/defaultModel'
import { nearestSupportedEffort } from '@shared/reasoningPolicy'

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
 *  INVARIANT: every invocation carries an explicit `--model`. There is no
 *  longer a path that omits it and lets agy choose in secret — a legacy
 *  null resolves to Orbit's own default before anything else happens, so
 *  both transports spawn against a model Orbit can name. */
export function resolveInvocation(
  model: string | null | undefined,
  reasoningEffort: string | null | undefined,
  rawCatalog: ModelOption[]
): AntigravityInvocation {
  const effort = (reasoningEffort || undefined) as ReasoningEffort | undefined
  // A legacy `null` is Orbit's default, not agy's. Resolved here as well as
  // at the store boundary so a caller holding an older object in memory
  // still cannot produce a model-less launch.
  const selected = resolveModelId(model)

  // Already a real, self-contained raw id (a combined id, or a genuinely
  // single-tier model). agy accepts this alone; never send a redundant or
  // conflicting --effort alongside an id that already encodes one.
  if (rawCatalog.some((candidate) => candidate.id === selected)) return { model: selected }

  // Otherwise it must be a normalized BASE id — find its real tiers.
  const variantPrefix = `${selected}-`
  const variantIds = new Set(rawCatalog.filter((candidate) => candidate.id.startsWith(variantPrefix)).map((candidate) => candidate.id))

  // Unrecognized entirely — a stale selection, a future catalogue, or a
  // catalogue that could not be read at all. Pass the choice through rather
  // than silently dropping it, so agy's own "unknown model" error surfaces
  // like any other bad launch configuration. Critically this still sends
  // `--model`: a failed catalogue must not quietly restore the old "agy
  // picks whatever it wants" behaviour.
  if (variantIds.size === 0) return effort ? { model: selected, effort } : { model: selected }

  if (effort && variantIds.has(`${selected}-${effort}`)) return { model: selected, effort }

  // A multi-tier base whose selected effort is missing or not one this model
  // publishes. agy's CLI REQUIRES --effort here, so omitting it would be a
  // launch known to fail — and omitting the model instead is the hidden
  // default this design removed. The honest resolution is the nearest tier
  // the model genuinely lists, taken from the catalogue by the same policy
  // the UI uses. Nothing is fabricated: every candidate is a real variant.
  const published = REASONING_TIERS.filter((tier) => variantIds.has(`${selected}-${tier}`))
  const resolved = nearestSupportedEffort(
    { id: selected, label: selected, supportedReasoningEfforts: published },
    effort ?? 'medium'
  )
  return resolved ? { model: selected, effort: resolved } : { model: selected }
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
