// The real `agy models` catalogue, shared by every test that needs one.
//
// Orbit now refuses to run without a catalogue — it resolves its own
// concrete default model from it and names that model explicitly, and a
// catalogue it cannot read is a real failure rather than a licence to let
// Antigravity choose (see src/shared/defaultModel.ts). So a fake provider
// that reports no models is no longer a neutral stand-in, and tests that
// are not *about* that failure use this instead.
import type { ModelOption } from '../../src/shared/domain'
import { normalizeModels, parseModelList } from '../../src/main/runtime/providers/antigravity/modelCatalog'

/** Verbatim `agy models` stdout (agy 1.1.28 — identical in shape to 1.1.27,
 *  re-captured while making Orbit own its default model). */
export const REAL_MODELS_OUTPUT = [
  'Fetching available models...',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'gemini-3.7-flash-high\tGemini 3.7 Flash (High)',
  'gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)',
  'gemini-3.7-flash-low\tGemini 3.7 Flash (Low)',
  'gemini-3.6-flash-high\tGemini 3.6 Flash (High)',
  'gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)',
  'gemini-3.6-flash-low\tGemini 3.6 Flash (Low)',
  'gemini-3.1-pro-high\tGemini 3.1 Pro (High)',
  'gemini-3.1-pro-low\tGemini 3.1 Pro (Low)',
  'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
  'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)'
].join('\n')

/** The raw, combined-id catalogue — what `fetchModels` returns and what
 *  `resolveInvocation` consumes. */
export const RAW_CATALOGUE: ModelOption[] = parseModelList(REAL_MODELS_OUTPUT)

/** The normalized, one-entry-per-base-model catalogue — what
 *  `provider.listModels()` returns, what the picker shows, and what Orbit
 *  resolves its default from. */
export const NORMALIZED_CATALOGUE: ModelOption[] = normalizeModels(RAW_CATALOGUE)

/** The model Orbit resolves to on this catalogue with no configured
 *  override, and the tier a user with no remembered preference gets. Stated
 *  once here so a test asserting "the concrete model Orbit chose" does not
 *  have to re-derive it. */
export const EXPECTED_DEFAULT_MODEL = 'gemini-3.8-flash'
export const EXPECTED_DEFAULT_EFFORT = 'medium'
