// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ModelControls } from '../../src/renderer/app/components/ModelControls'
import { ProviderLogoSprite } from '../../src/renderer/app/components/ProviderLogo'
import { describeModel, modelDescriptionLine } from '../../src/renderer/app/lib/modelDescriptions'
import { agentIdentity, agentVendor, RUNTIME_NAME } from '../../src/renderer/app/lib/agentIdentity'
import { PROVIDERS, providerForModelId } from '../../src/renderer/app/lib/providers'
import type { ModelOption } from '../../src/shared/domain'
import { ORBIT_DEFAULT_MODEL_ID } from '../../src/shared/defaultModel'

/** Shaped exactly as `agy models` normalizes: one entry per base model,
 *  carrying only the tiers Antigravity genuinely publishes for it. */
const MODELS: ModelOption[] = [
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', supportedReasoningEfforts: ['low', 'medium', 'high'] },
  { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', supportedReasoningEfforts: ['low', 'high'] },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
  { id: 'gpt-5-codex', label: 'GPT-5 Codex' },
  { id: 'mystery-7b', label: 'Mystery 7B' }
]

function renderControls(selectedModel: string | null) {
  const onSelectModel = vi.fn()
  const onSelectEffort = vi.fn()
  render(
    <>
      <ProviderLogoSprite />
      <ModelControls
        models={MODELS}
        selectedModel={selectedModel}
        selectedEffort={null}
        disabled={false}
        onSelectModel={onSelectModel}
        onSelectEffort={onSelectEffort}
      />
    </>
  )
  return { onSelectModel, onSelectEffort }
}

const openBrowser = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByLabelText('Model and reasoning'))
  await user.click(screen.getByRole('button', { name: /Other models/ }))
  return screen.getByRole('dialog', { name: 'All models' })
}

describe('model descriptions', () => {
  it('says what each family is for, in two real attributes', () => {
    expect(modelDescriptionLine(MODELS[0]!)).toBe('Google’s fast Gemini model • quick everyday coding and iteration')
    expect(modelDescriptionLine(MODELS[1]!)).toBe('Google’s high-capability Gemini model • agentic coding and complex reasoning')
    expect(modelDescriptionLine(MODELS[2]!)).toBe('Anthropic’s highest-capability model • deep coding and long-running tasks')
    expect(modelDescriptionLine(MODELS[3]!)).toBe('Anthropic’s balanced coding model • strong mix of speed and capability')
    expect(modelDescriptionLine(MODELS[4]!)).toBe('OpenAI’s coding-focused model • software engineering and tool use')
  })

  it('never states a reasoning tier as a model’s description', () => {
    for (const model of MODELS) {
      const line = modelDescriptionLine(model)
      expect(line, model.id).not.toMatch(/\b(High|Medium|Low)\b/)
      expect(line, model.id).not.toMatch(/reasoning (only|setting)/i)
    }
  })

  it('degrades to what is known rather than inventing a description', () => {
    // A vendor Orbit can identify, but a family it has never seen.
    expect(describeModel({ id: 'gemini-9-turbo', label: 'Gemini 9 Turbo' }).parts[0]).toContain('Google')
    // No vendor either: only the catalogue's own id is a fact.
    expect(describeModel(MODELS[5]!).parts).toEqual(['mystery-7b'])
  })

  it('carries the provider each description belongs to', () => {
    expect(describeModel(MODELS[0]!).provider).toBe('gemini')
    expect(describeModel(MODELS[2]!).provider).toBe('anthropic')
    expect(describeModel(MODELS[4]!).provider).toBe('openai')
    expect(describeModel(MODELS[5]!).provider).toBe('other')
  })
})

describe('provider marks in the chooser', () => {
  it('marks every vendor with its own logo, never Orbit’s', async () => {
    const user = userEvent.setup()
    renderControls('gemini-3.8-flash')
    const modal = await openBrowser(user)

    const markFor = (name: RegExp): Element | null =>
      within(modal).getByRole('menuitemradio', { name }).querySelector('.model-row-mark [data-provider]')

    expect(markFor(/Gemini 3\.8 Flash/)).toHaveAttribute('data-provider', 'gemini')
    expect(markFor(/Claude Opus 4\.6/)).toHaveAttribute('data-provider', 'anthropic')
    expect(markFor(/GPT-5 Codex/)).toHaveAttribute('data-provider', 'openai')
    // Orbit's own Saturn mark is the app's, and appears nowhere in here.
    expect(modal.querySelector('.orbit-logo')).toBeNull()
  })

  it('shows each model’s description under its name in the full browser', async () => {
    const user = userEvent.setup()
    renderControls('gemini-3.8-flash')
    const modal = await openBrowser(user)

    const row = within(modal).getByRole('menuitemradio', { name: /Claude Opus 4\.6/ })
    expect(row).toHaveTextContent('Anthropic’s highest-capability model')
    expect(row).toHaveTextContent('deep coding and long-running tasks')
  })

  it('gives a vendor Orbit cannot identify a monogram, never a guessed logo', async () => {
    const user = userEvent.setup()
    renderControls('gemini-3.8-flash')
    const modal = await openBrowser(user)

    const row = within(modal).getByRole('menuitemradio', { name: /Mystery 7B/ })
    expect(row.querySelector('.provider-logo-text')).not.toBeNull()
    expect(row.querySelector('[data-provider]')).toBeNull()
  })

  it('marks the closed composer control with the selected model’s vendor', () => {
    renderControls('claude-opus-4-6')
    const trigger = screen.getByLabelText('Model and reasoning')
    expect(trigger.querySelector('[data-provider]')).toHaveAttribute('data-provider', 'anthropic')
  })

  it('draws the default model’s own vendor logo for a legacy null selection', () => {
    // A null selection is Orbit's default model, which Orbit can name — so
    // the trigger shows Gemini's mark, not a neutral "who knows" glyph.
    renderControls(null)
    const trigger = screen.getByLabelText('Model and reasoning')
    expect(trigger.querySelector('[data-provider]')).toHaveAttribute('data-provider', 'gemini')
  })
})

describe('agentIdentity', () => {
  it('resolves the working AI from the session’s real model selection', () => {
    expect(agentIdentity(MODELS, 'gemini-3.8-flash')).toEqual({ provider: 'gemini', name: '3.8 Flash' })
    expect(agentIdentity(MODELS, 'claude-opus-4-6')).toEqual({ provider: 'anthropic', name: 'Claude Opus 4.6' })
    expect(agentIdentity(MODELS, 'gpt-5-codex')).toEqual({ provider: 'openai', name: 'GPT-5 Codex' })
  })

  it('names Orbit’s own default model for a legacy null selection', () => {
    // Orbit picks the default now, so a null session is not anonymous: it
    // is the real default model, with that model's vendor and label.
    expect(agentIdentity(MODELS, null)).toEqual(agentIdentity(MODELS, ORBIT_DEFAULT_MODEL_ID))
    expect(agentIdentity(MODELS, null)).toEqual({ provider: 'gemini', name: '3.8 Flash' })
    expect(agentVendor(agentIdentity(MODELS, null))).toBe('Google')
  })

  it('falls back to the runtime only when the vendor is genuinely unknowable', () => {
    // Still true, and still the reason RUNTIME_NAME exists.
    expect(RUNTIME_NAME).toBe('Antigravity')
    expect(agentIdentity(MODELS, 'mystery-model-1').provider).toBeNull()
  })

  it('keeps a stale selection’s vendor and id rather than silently reverting', () => {
    expect(agentIdentity(MODELS, 'claude-sonnet-9-9')).toEqual({ provider: 'anthropic', name: 'claude-sonnet-9-9' })
  })

  it('gives an unidentifiable vendor no logo but keeps its name', () => {
    expect(agentIdentity(MODELS, 'mystery-7b')).toEqual({ provider: null, name: 'Mystery 7B' })
  })

  it('names the vendor behind an identity when there is one', () => {
    expect(agentVendor(agentIdentity(MODELS, 'gemini-3.8-flash'))).toBe('Google')
    expect(agentVendor(agentIdentity(MODELS, 'claude-opus-4-6'))).toBe('Anthropic')
    expect(agentVendor(agentIdentity(MODELS, 'gpt-5-codex'))).toBe('OpenAI')
  })

  it('identifies a vendor from an id alone, for callers holding no catalogue', () => {
    expect(providerForModelId('gemini-3.8-flash')).toBe('gemini')
    expect(providerForModelId('claude-opus-4-6')).toBe('anthropic')
    expect(providerForModelId('codex-mini')).toBe('openai')
    expect(providerForModelId('o3-mini')).toBe('openai')
    expect(providerForModelId(null)).toBe('other')
    expect(PROVIDERS.other.vendor).toBeNull()
  })
})
