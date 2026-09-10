// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ModelControls } from '../../src/renderer/app/components/ModelControls'
import { EmptySession, STARTERS } from '../../src/renderer/app/components/EmptySession'
import { compactModelLabel, descendingEfforts, isReasoningAdjustable } from '../../src/renderer/app/lib/modelDisplay'
import { describeModel, modelDescriptionLine } from '../../src/renderer/app/lib/modelDescriptions'
import { reasoningTheme, stopOffset, tierAtFraction, trackFill } from '../../src/renderer/app/lib/reasoningVisual'
import { groupByProvider, matchesQuery, providerForModel } from '../../src/renderer/app/lib/providers'
import type { ModelOption, ReasoningEffort } from '../../src/shared/domain'
import { ORBIT_DEFAULT_MODEL_ID } from '../../src/shared/defaultModel'

/** Normalized exactly as Antigravity publishes it: uneven tier coverage, a
 *  single-tier model, and models with no reasoning setting at all. */
const MODELS: ModelOption[] = [
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', supportedReasoningEfforts: ['low', 'medium', 'high'] },
  { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', supportedReasoningEfforts: ['low', 'high'] },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
  { id: 'gpt-oss-120b', label: 'GPT-OSS 120B', supportedReasoningEfforts: ['medium'] }
]

function renderControls(selectedModel: string | null, selectedEffort: ReasoningEffort | null = null, models: ModelOption[] = MODELS) {
  const onSelectModel = vi.fn()
  const onSelectEffort = vi.fn()
  render(
    <ModelControls
      models={models}
      selectedModel={selectedModel}
      selectedEffort={selectedEffort}
      disabled={false}
      onSelectModel={onSelectModel}
      onSelectEffort={onSelectEffort}
    />
  )
  return { onSelectModel, onSelectEffort }
}

const openPopover = async (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByLabelText('Model and reasoning'))

const openBrowser = async (user: ReturnType<typeof userEvent.setup>) => {
  await openPopover(user)
  await user.click(screen.getByRole('button', { name: /Other models/ }))
}

describe('compact model label', () => {
  it('drops the vendor word the surrounding UI already implies', () => {
    expect(compactModelLabel('Gemini 3.8 Flash')).toBe('3.8 Flash')
    expect(compactModelLabel('Gemini 3.1 Pro')).toBe('3.1 Pro')
  })

  it('drops a trailing parenthetical note', () => {
    expect(compactModelLabel('Claude Sonnet 4.6 (Thinking)')).toBe('Claude Sonnet 4.6')
  })

  it('never trims a label down to nothing', () => {
    expect(compactModelLabel('Gemini')).toBe('Gemini')
    expect(compactModelLabel('(Thinking)')).toBe('(Thinking)')
  })
})

describe('providers', () => {
  it('identifies a provider from the stable half of a catalogue entry', () => {
    expect(providerForModel(MODELS[0]!)).toBe('gemini')
    expect(providerForModel(MODELS[2]!)).toBe('anthropic')
    expect(providerForModel(MODELS[3]!)).toBe('openai')
    expect(providerForModel({ id: 'mystery-7b', label: 'Mystery 7B' })).toBe('other')
  })

  it('groups the catalogue Gemini-first and drops providers with no models', () => {
    const groups = groupByProvider(MODELS)
    expect(groups.map((group) => group.provider.label)).toEqual(['Gemini', 'Claude', 'OpenAI'])
    expect(groups[0]!.models).toHaveLength(2)
  })

  it('searches by name, id and provider', () => {
    expect(matchesQuery(MODELS[0]!, 'flash')).toBe(true)
    expect(matchesQuery(MODELS[0]!, 'gemini-3.8')).toBe(true)
    expect(matchesQuery(MODELS[2]!, 'claude')).toBe(true)
    expect(matchesQuery(MODELS[2]!, 'flash')).toBe(false)
    expect(matchesQuery(MODELS[2]!, '   ')).toBe(true)
  })
})

describe('closed composer control', () => {
  it('shows the shortened model name, not the catalogue label', () => {
    renderControls('gemini-3.8-flash')
    expect(screen.getByLabelText('Model and reasoning')).toHaveTextContent('3.8 Flash')
    expect(screen.getByLabelText('Model and reasoning')).not.toHaveTextContent('Gemini 3.8 Flash')
  })

  it('carries the selected reasoning tier in the peak treatment at a model’s maximum', () => {
    renderControls('gemini-3.8-flash', 'high')
    const chip = screen.getByText('High')
    expect(chip).toHaveAttribute('data-theme', 'peak')
  })

  it('drops to a restrained treatment below the maximum, and updates immediately', () => {
    const { rerender } = render(
      <ModelControls
        models={MODELS}
        selectedModel="gemini-3.8-flash"
        selectedEffort="medium"
        disabled={false}
        onSelectModel={vi.fn()}
        onSelectEffort={vi.fn()}
      />
    )
    expect(screen.getByText('Medium')).toHaveAttribute('data-theme', 'mid')

    rerender(
      <ModelControls
        models={MODELS}
        selectedModel="gemini-3.8-flash"
        selectedEffort="low"
        disabled={false}
        onSelectModel={vi.fn()}
        onSelectEffort={vi.fn()}
      />
    )
    expect(screen.queryByText('Medium')).not.toBeInTheDocument()
    expect(screen.getByText('Low')).toHaveAttribute('data-theme', 'base')
  })

  it('shows only the model when the model has no reasoning setting', () => {
    renderControls('claude-sonnet-4-6')
    const trigger = screen.getByLabelText('Model and reasoning')
    expect(trigger).toHaveTextContent('Claude Sonnet 4.6')
    expect(trigger).not.toHaveTextContent('High')
    expect(trigger).not.toHaveTextContent('Medium')
  })

  it('is disabled when Antigravity’s catalogue could not be read', () => {
    renderControls(null, null, [])
    expect(screen.getByLabelText('Model and reasoning')).toBeDisabled()
  })
})

describe('compact model menu', () => {
  it('names the real default model on the closed control, never “Default model”', () => {
    // A legacy null session. The user must see which model will answer.
    renderControls(null)
    const trigger = screen.getByLabelText('Model and reasoning')
    expect(trigger).toHaveTextContent('3.8 Flash')
    expect(trigger).not.toHaveTextContent('Default model')
  })

  it('selects the genuine catalogue id when the default row is chosen', async () => {
    const user = userEvent.setup()
    const { onSelectModel } = renderControls(null)
    await openPopover(user)
    await user.click(screen.getByRole('menuitemradio', { name: /Gemini 3\.8 Flash/ }))
    // Not a sentinel, not null — the real id agy will receive.
    expect(onSelectModel).toHaveBeenCalledWith(ORBIT_DEFAULT_MODEL_ID)
  })

  it('badges Orbit’s default on its own real row', async () => {
    const user = userEvent.setup()
    renderControls('gemini-3.1-pro')
    await openPopover(user)
    const defaultRow = screen.getByRole('menuitemradio', { name: /Gemini 3\.8 Flash/ })
    expect(defaultRow.querySelector('.model-row-default')).not.toBeNull()
    const otherRow = screen.getByRole('menuitemradio', { name: /Gemini 3\.1 Pro/ })
    expect(otherRow.querySelector('.model-row-default')).toBeNull()
  })

  it('shows Gemini only, because Antigravity is a Gemini workflow', async () => {
    const user = userEvent.setup()
    renderControls('gemini-3.8-flash')
    await openPopover(user)

    // There is no synthetic "Default model" row any more: Orbit's default is
    // one of these real rows, badged as such.
    expect(screen.queryByRole('menuitemradio', { name: /^Default model/ })).not.toBeInTheDocument()
    expect(screen.getByRole('menuitemradio', { name: /Gemini 3\.8 Flash/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitemradio', { name: /Gemini 3\.1 Pro/ })).toBeInTheDocument()
    expect(screen.queryByRole('menuitemradio', { name: /Claude Sonnet/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitemradio', { name: /GPT-OSS/ })).not.toBeInTheDocument()
  })

  it('describes what each model is for, under its name', async () => {
    const user = userEvent.setup()
    renderControls('gemini-3.8-flash')
    await openPopover(user)

    const row = screen.getByRole('menuitemradio', { name: /Gemini 3\.8 Flash/ })
    expect(row).toHaveTextContent('Google’s fast Gemini model')
    expect(row).toHaveTextContent('quick everyday coding and iteration')
  })

  it('never spends the description line on the reasoning tiers', async () => {
    const user = userEvent.setup()
    renderControls('gemini-3.8-flash')
    await openPopover(user)

    // The tiers are a live setting with their own control; restating them
    // under every model's name said nothing about what the model is. The
    // tier LABELS are what must be gone — a description is still free to
    // use "reasoning" as an ordinary word ("complex reasoning").
    for (const name of [/Gemini 3\.8 Flash/, /Gemini 3\.1 Pro/]) {
      const hint = screen.getByRole('menuitemradio', { name }).querySelector('.model-row-hint')
      expect(hint).not.toBeNull()
      expect(hint!.textContent, `${name} subtitle`).not.toMatch(/\b(High|Medium|Low)\b/)
      expect(hint!.textContent).not.toMatch(/reasoning (only|setting)/i)
    }
  })

  it('reports the chosen model without deciding its tier', async () => {
    const user = userEvent.setup()
    const { onSelectModel, onSelectEffort } = renderControls('gemini-3.8-flash', 'medium')
    await openPopover(user)
    await user.click(screen.getByRole('menuitemradio', { name: /Gemini 3\.1 Pro/ }))
    expect(onSelectModel).toHaveBeenCalledWith('gemini-3.1-pro')
    expect(onSelectEffort).not.toHaveBeenCalled()
  })

  it('closes on Escape', async () => {
    const user = userEvent.setup()
    renderControls('gemini-3.8-flash')
    await openPopover(user)
    expect(screen.getByRole('dialog', { name: 'Model and reasoning' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Model and reasoning' })).not.toBeInTheDocument()
  })
})

describe('full model browser', () => {
  it('opens as a modal over the app and groups every provider the catalogue returned', async () => {
    const user = userEvent.setup()
    renderControls('gemini-3.8-flash')
    await openBrowser(user)

    const modal = screen.getByRole('dialog', { name: 'All models' })
    expect(modal).toHaveAttribute('aria-modal', 'true')
    expect(within(modal).getByText('Gemini')).toBeInTheDocument()
    expect(within(modal).getByText('Claude')).toBeInTheDocument()
    expect(within(modal).getByText('OpenAI')).toBeInTheDocument()
    expect(within(modal).getByRole('menuitemradio', { name: /Claude Sonnet 4\.6/ })).toBeInTheDocument()
    expect(within(modal).getByRole('menuitemradio', { name: /GPT-OSS 120B/ })).toBeInTheDocument()
  })

  it('selects a model from a provider the compact menu never showed', async () => {
    const user = userEvent.setup()
    const { onSelectModel } = renderControls('gemini-3.8-flash')
    await openBrowser(user)
    await user.click(screen.getByRole('menuitemradio', { name: /Claude Sonnet 4\.6/ }))
    expect(onSelectModel).toHaveBeenCalledWith('claude-sonnet-4-6')
    expect(screen.queryByRole('dialog', { name: 'All models' })).not.toBeInTheDocument()
  })

  it('closes on Escape', async () => {
    const user = userEvent.setup()
    renderControls('gemini-3.8-flash')
    await openBrowser(user)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'All models' })).not.toBeInTheDocument()
  })

  it('closes on a click outside the panel', async () => {
    const user = userEvent.setup()
    renderControls('gemini-3.8-flash')
    await openBrowser(user)
    const backdrop = document.querySelector('.modal-backdrop')
    expect(backdrop).not.toBeNull()
    await user.click(backdrop as Element)
    expect(screen.queryByRole('dialog', { name: 'All models' })).not.toBeInTheDocument()
  })

  it('stays open when a click starts inside the panel', async () => {
    const user = userEvent.setup()
    renderControls('gemini-3.8-flash')
    await openBrowser(user)
    await user.click(screen.getByRole('heading', { name: 'All models' }))
    expect(screen.getByRole('dialog', { name: 'All models' })).toBeInTheDocument()
  })

  it('spends no space on a search field for a catalogue this small', async () => {
    const user = userEvent.setup()
    renderControls('gemini-3.8-flash')
    await openBrowser(user)
    expect(screen.queryByLabelText('Search models')).not.toBeInTheDocument()
  })

  it('offers search once the catalogue is large enough to justify it', async () => {
    const user = userEvent.setup()
    const many: ModelOption[] = [
      ...MODELS,
      ...Array.from({ length: 8 }, (_, index) => ({ id: `gemini-extra-${index}`, label: `Gemini Extra ${index}` }))
    ]
    renderControls(null, null, many)
    await openBrowser(user)

    await user.type(screen.getByLabelText('Search models'), 'sonnet')
    // Scoped to the modal: the compact popover stays mounted behind the
    // backdrop on purpose, so dismissing the browser returns you to it.
    const modal = screen.getByRole('dialog', { name: 'All models' })
    expect(within(modal).getByRole('menuitemradio', { name: /Claude Sonnet 4\.6/ })).toBeInTheDocument()
    expect(within(modal).queryByRole('menuitemradio', { name: /Gemini Extra 0/ })).not.toBeInTheDocument()
  })

  it('says so honestly when Antigravity’s catalogue could not be read', async () => {
    const user = userEvent.setup()
    renderControls(null, null, [])
    // The trigger is disabled with no catalogue, so the browser is reached
    // through the component's own empty state rather than a fabricated list.
    expect(screen.getByLabelText('Model and reasoning')).toBeDisabled()
    await user.click(screen.getByLabelText('Model and reasoning'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('reasoning control', () => {
  it('offers one stop per tier the model publishes, highest first', async () => {
    const user = userEvent.setup()
    renderControls('gemini-3.8-flash')
    await openPopover(user)

    const stops = screen.getAllByRole('button').filter((node) => node.classList.contains('reasoning-stop'))
    expect(stops.map((node) => node.textContent)).toEqual(['High', 'Medium', 'Low'])
  })

  it('is physically shorter for a two-tier model, with no gap where medium would be', async () => {
    const user = userEvent.setup()
    renderControls('gemini-3.1-pro')
    await openPopover(user)

    const scale = document.querySelector('.reasoning-scale') as HTMLElement
    expect(scale.style.getPropertyValue('--stops')).toBe('2')
    expect(screen.getByRole('button', { name: 'High' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Low' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Medium' })).not.toBeInTheDocument()
  })

  it('sizes itself to three stops for a three-tier model', async () => {
    const user = userEvent.setup()
    renderControls('gemini-3.8-flash')
    await openPopover(user)
    expect((document.querySelector('.reasoning-scale') as HTMLElement).style.getPropertyValue('--stops')).toBe('3')
  })

  it('states a single fixed tier instead of drawing a slider that cannot move', async () => {
    const user = userEvent.setup()
    renderControls('gpt-oss-120b')
    await openPopover(user)

    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
    expect(screen.getByText('Medium')).toBeInTheDocument()
    expect(screen.getByText('Fixed by this model')).toBeInTheDocument()
  })

  it('says who owns the decision when there is no reasoning control at all', async () => {
    const user = userEvent.setup()
    renderControls('claude-sonnet-4-6')
    await openPopover(user)

    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
    expect(screen.getByText('Reasoning is controlled by the model.')).toBeInTheDocument()
  })

  it('gives Antigravity’s own default model a real three-tier control', async () => {
    const user = userEvent.setup()
    renderControls(null, 'medium')
    await openPopover(user)
    expect((document.querySelector('.reasoning-scale') as HTMLElement).style.getPropertyValue('--stops')).toBe('3')
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', 'Medium')
  })

  it('selects a tier when its label is clicked', async () => {
    const user = userEvent.setup()
    const { onSelectEffort, onSelectModel } = renderControls('gemini-3.8-flash', 'high')
    await openPopover(user)
    await user.click(screen.getByRole('button', { name: 'Medium' }))
    expect(onSelectEffort).toHaveBeenCalledWith('medium')
    expect(onSelectModel).not.toHaveBeenCalled()
  })

  it('walks only real tiers with the keyboard', async () => {
    const user = userEvent.setup()
    const { onSelectEffort } = renderControls('gemini-3.1-pro', 'low')
    await openPopover(user)
    screen.getByRole('slider').focus()
    await user.keyboard('{ArrowUp}')
    // Gemini 3.1 Pro has no medium, so up from low lands on high.
    expect(onSelectEffort).toHaveBeenCalledWith('high')
  })

  it('animates with particles rather than stripes or a moving gradient', async () => {
    const user = userEvent.setup()
    renderControls('gemini-3.8-flash', 'high')
    await openPopover(user)
    expect(document.querySelectorAll('.reasoning-particle').length).toBeGreaterThan(1)
  })
})

describe('reasoning geometry', () => {
  const flash = MODELS[0]!
  const pro = MODELS[1]!
  const oss = MODELS[3]!

  it('places every stop at its own row’s centre', () => {
    expect(stopOffset(3, 0)).toBeCloseTo(1 / 6)
    expect(stopOffset(3, 1)).toBeCloseTo(0.5)
    expect(stopOffset(3, 2)).toBeCloseTo(5 / 6)
    expect(stopOffset(2, 0)).toBeCloseTo(0.25)
    expect(stopOffset(2, 1)).toBeCloseTo(0.75)
  })

  it('fills the track from the bottom up to the handle, never past it', () => {
    expect(trackFill(flash, 'high')).toBeCloseTo(5 / 6)
    expect(trackFill(flash, 'medium')).toBeCloseTo(0.5)
    // The lowest tier still has a real active section, so the control never
    // looks dead — it is just the shortest one.
    expect(trackFill(flash, 'low')).toBeCloseTo(1 / 6)
    expect(trackFill(flash, null)).toBe(0)
  })

  it('snaps a drag to the row it is over, and never between rows', () => {
    const three = descendingEfforts(flash)
    expect(tierAtFraction(three, 0)).toBe('high')
    expect(tierAtFraction(three, 0.5)).toBe('medium')
    expect(tierAtFraction(three, 1)).toBe('low')
    const two = descendingEfforts(pro)
    expect(tierAtFraction(two, 0.3)).toBe('high')
    expect(tierAtFraction(two, 0.7)).toBe('low')
    expect(tierAtFraction([], 0.5)).toBeNull()
  })

  it('reserves purple for a model’s own maximum', () => {
    expect(reasoningTheme(flash, 'high')).toBe('peak')
    expect(reasoningTheme(flash, 'medium')).toBe('mid')
    expect(reasoningTheme(flash, 'low')).toBe('base')
    expect(reasoningTheme(pro, 'high')).toBe('peak')
    expect(reasoningTheme(pro, 'low')).toBe('base')
    // A fixed tier is a fact about the model, not the top of a scale.
    expect(reasoningTheme(oss, 'medium')).toBe('mid')
    expect(reasoningTheme(flash, null)).toBe('auto')
  })

  it('knows which models have a reasoning choice at all', () => {
    expect(isReasoningAdjustable(flash)).toBe(true)
    expect(isReasoningAdjustable(pro)).toBe(true)
    expect(isReasoningAdjustable(MODELS[2]!)).toBe(false)
    expect(isReasoningAdjustable(oss)).toBe(false)
  })
})

describe('fast mode', () => {
  it('stays visible but inert, because agy 1.1.27 exposes no fast-mode setting', async () => {
    const user = userEvent.setup()
    renderControls('gemini-3.8-flash')
    await openPopover(user)

    expect(screen.queryByRole('button', { name: /Fast mode/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    const row = screen.getByText('Fast mode').closest('.fast-mode')
    expect(row).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText('Not available in Antigravity yet')).toBeInTheDocument()
  })
})

describe('EmptySession', () => {
  it('asks what to work on and names the real workspace', () => {
    render(<EmptySession projectName="Renderer Check" onPick={vi.fn()} />)
    expect(screen.getByRole('heading', { name: 'What should we work on?' })).toBeInTheDocument()
    expect(screen.getByText('Renderer Check')).toBeInTheDocument()
  })

  it('offers every starter as a lightweight action', () => {
    render(<EmptySession projectName={null} onPick={vi.fn()} />)
    for (const starter of STARTERS) {
      expect(screen.getByRole('button', { name: new RegExp(starter.label) })).toBeInTheDocument()
    }
  })

  it('hands back the full starter so the composer can be populated', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    render(<EmptySession projectName="Renderer Check" onPick={onPick} />)
    await user.click(screen.getByRole('button', { name: /Explore this project/ }))
    expect(onPick).toHaveBeenCalledWith(STARTERS.find((starter) => starter.id === 'explore'))
  })

  it('says nothing about a workspace when there is none', () => {
    render(<EmptySession projectName={null} onPick={vi.fn()} />)
    expect(screen.queryByText(/Working in/)).not.toBeInTheDocument()
  })
})

describe('popover structure', () => {
  it('keeps models and reasoning in one popover', async () => {
    const user = userEvent.setup()
    renderControls('gemini-3.8-flash')
    await openPopover(user)
    const popover = screen.getByRole('dialog', { name: 'Model and reasoning' })
    expect(within(popover).getByText('AI Model')).toBeInTheDocument()
    expect(within(popover).getByText('Reasoning effort')).toBeInTheDocument()
  })
})
