// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ModelControls } from '../../src/renderer/app/components/ModelControls'
import { EmptySession, STARTERS } from '../../src/renderer/app/components/EmptySession'
import { compactModelLabel, descendingEfforts, isReasoningAdjustable } from '../../src/renderer/app/lib/modelDisplay'
import { animationTempo, reasoningTheme, tierAtFraction, trackFill } from '../../src/renderer/app/lib/reasoningVisual'
import type { ModelOption, ReasoningEffort } from '../../src/shared/domain'

/** Normalized exactly as Antigravity publishes it: uneven tier coverage, a
 *  single-tier model, and models with no reasoning setting at all. */
const MODELS: ModelOption[] = [
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', supportedReasoningEfforts: ['low', 'medium', 'high'] },
  { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', supportedReasoningEfforts: ['low', 'high'] },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
  { id: 'gpt-oss-120b', label: 'GPT-OSS 120B', supportedReasoningEfforts: ['medium'] }
]

function renderControls(
  selectedModel: string | null,
  selectedEffort: ReasoningEffort | null = null,
  fastMode = false,
  models: ModelOption[] = MODELS
) {
  const onChange = vi.fn()
  const onFastModeChange = vi.fn()
  render(
    <ModelControls
      models={models}
      selectedModel={selectedModel}
      selectedEffort={selectedEffort}
      fastMode={fastMode}
      disabled={false}
      onChange={onChange}
      onFastModeChange={onFastModeChange}
    />
  )
  return { onChange, onFastModeChange }
}

const openPopover = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByLabelText('Model and reasoning'))

describe('compact model label', () => {
  it('drops the vendor word the surrounding UI already implies', () => {
    expect(compactModelLabel('Gemini 3.8 Flash')).toBe('3.8 Flash')
    expect(compactModelLabel('Gemini 3.1 Pro')).toBe('3.1 Pro')
  })

  it('drops a trailing parenthetical note', () => {
    expect(compactModelLabel('Claude Sonnet 4.6 (Thinking)')).toBe('Claude Sonnet 4.6')
  })

  it('leaves a label alone when there is nothing redundant to remove', () => {
    expect(compactModelLabel('GPT-OSS 120B')).toBe('GPT-OSS 120B')
  })

  it('never trims a label down to nothing', () => {
    expect(compactModelLabel('Gemini')).toBe('Gemini')
    expect(compactModelLabel('(Thinking)')).toBe('(Thinking)')
  })
})

describe('closed composer control', () => {
  it('shows the shortened model name, not the catalogue label', () => {
    renderControls('gemini-3.8-flash')
    expect(screen.getByLabelText('Model and reasoning')).toHaveTextContent('3.8 Flash')
    expect(screen.getByLabelText('Model and reasoning')).not.toHaveTextContent('Gemini 3.8 Flash')
  })

  it('carries model, effort and fast mode in one control', () => {
    renderControls('gemini-3.8-flash', 'high', true)
    const trigger = screen.getByLabelText('Model and reasoning')
    expect(trigger).toHaveTextContent('3.8 Flash')
    expect(trigger).toHaveTextContent('High')
    expect(trigger).toHaveTextContent('Fast mode')
  })

  it('spends no space saying fast mode is off', () => {
    renderControls('gemini-3.8-flash', 'high', false)
    expect(screen.getByLabelText('Model and reasoning')).not.toHaveTextContent('Fast')
  })

  it('shows only the model when no effort is chosen', () => {
    renderControls('claude-sonnet-4-6')
    const trigger = screen.getByLabelText('Model and reasoning')
    expect(trigger).toHaveTextContent('Claude Sonnet 4.6')
    expect(trigger).not.toHaveTextContent('High')
    expect(trigger).not.toHaveTextContent('Medium')
  })

  it('is disabled when Antigravity’s catalogue could not be read', () => {
    renderControls(null, null, false, [])
    expect(screen.getByLabelText('Model and reasoning')).toBeDisabled()
  })
})

describe('model list', () => {
  it('lists the real catalogue with its genuine tiers', async () => {
    const user = userEvent.setup()
    renderControls('gemini-3.8-flash')
    await openPopover(user)

    expect(screen.getByRole('menuitemradio', { name: /Gemini 3\.8 Flash/ })).toHaveTextContent('High · Medium · Low reasoning')
    expect(screen.getByRole('menuitemradio', { name: /Gemini 3\.1 Pro/ })).toHaveTextContent('High · Low reasoning')
    expect(screen.getByRole('menuitemradio', { name: /Claude Sonnet/ })).toHaveTextContent('No reasoning setting')
    expect(screen.getByRole('menuitemradio', { name: /GPT-OSS/ })).toHaveTextContent('Medium reasoning only')
  })

  it('keeps the primary list short and reveals the rest on request', async () => {
    const user = userEvent.setup()
    const many: ModelOption[] = Array.from({ length: 8 }, (_, index) => ({ id: `m-${index}`, label: `Model ${index}` }))
    renderControls(null, null, false, many)
    await openPopover(user)

    expect(screen.queryByRole('menuitemradio', { name: 'Model 7' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Other models/ }))
    expect(screen.getByRole('menuitemradio', { name: /Model 7/ })).toBeInTheDocument()
  })

  it('drops an effort the newly chosen model does not offer', async () => {
    const user = userEvent.setup()
    const { onChange } = renderControls('gemini-3.8-flash', 'medium')
    await openPopover(user)
    await user.click(screen.getByRole('menuitemradio', { name: /Gemini 3\.1 Pro/ }))
    expect(onChange).toHaveBeenCalledWith('gemini-3.1-pro', null)
  })
})

describe('reasoning slider', () => {
  it('offers one stop per tier the model publishes, highest first', async () => {
    const user = userEvent.setup()
    renderControls('gemini-3.8-flash')
    await openPopover(user)

    const levels = screen.getAllByRole('button', { pressed: false }).filter((node) => /^(High|Medium|Low)$/.test(node.textContent ?? ''))
    expect(levels.map((node) => node.textContent)).toEqual(['High', 'Medium', 'Low'])
  })

  it('shows only the two real stops for a model with High and Low', async () => {
    const user = userEvent.setup()
    renderControls('gemini-3.1-pro')
    await openPopover(user)

    expect(screen.getByRole('button', { name: 'High' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Low' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Medium' })).not.toBeInTheDocument()
  })

  it('renders no adjustable control for a model with no reasoning setting', async () => {
    const user = userEvent.setup()
    renderControls('claude-sonnet-4-6')
    await openPopover(user)

    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
    expect(screen.getByText(/has no reasoning setting/)).toBeInTheDocument()
  })

  it('states a single-tier model as a fact instead of faking a slider', async () => {
    const user = userEvent.setup()
    renderControls('gpt-oss-120b')
    await openPopover(user)

    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
    expect(screen.getByText(/runs at medium reasoning only/)).toBeInTheDocument()
  })

  it('never pre-selects a tier', async () => {
    const user = userEvent.setup()
    renderControls('gemini-3.8-flash')
    await openPopover(user)

    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', 'Automatic')
    expect(screen.getByText('Auto')).toBeInTheDocument()
  })

  it('selects a tier when its label is clicked', async () => {
    const user = userEvent.setup()
    const { onChange } = renderControls('gemini-3.8-flash')
    await openPopover(user)
    await user.click(screen.getByRole('button', { name: 'Medium' }))
    expect(onChange).toHaveBeenCalledWith('gemini-3.8-flash', 'medium')
  })

  it('returns to automatic when the selected tier is clicked again', async () => {
    const user = userEvent.setup()
    const { onChange } = renderControls('gemini-3.8-flash', 'medium')
    await openPopover(user)
    await user.click(screen.getByRole('button', { name: 'Medium' }))
    expect(onChange).toHaveBeenCalledWith('gemini-3.8-flash', null)
  })

  it('walks only real tiers with the keyboard', async () => {
    const user = userEvent.setup()
    const { onChange } = renderControls('gemini-3.1-pro', 'low')
    await openPopover(user)
    screen.getByRole('slider').focus()
    await user.keyboard('{ArrowUp}')
    // Gemini 3.1 Pro has no medium, so up from low lands on high.
    expect(onChange).toHaveBeenCalledWith('gemini-3.1-pro', 'high')
  })
})

describe('reasoning visuals', () => {
  const flash = MODELS[0]!
  const pro = MODELS[1]!

  it('uses the calm theme below a model’s maximum', () => {
    expect(reasoningTheme(flash, 'medium')).toBe('calm')
    expect(reasoningTheme(flash, 'low')).toBe('calm')
  })

  it('switches to the purple peak theme at a model’s highest tier', () => {
    expect(reasoningTheme(flash, 'high')).toBe('peak')
    // "Peak" is relative to the model: Pro's maximum is also high, but a
    // model whose top tier were medium would peak at medium.
    expect(reasoningTheme(pro, 'high')).toBe('peak')
    expect(reasoningTheme(pro, 'low')).toBe('calm')
  })

  it('stays inert until a tier is actually chosen', () => {
    expect(reasoningTheme(flash, null)).toBe('auto')
    expect(trackFill(flash, null)).toBe(0)
  })

  it('fills the track by position among the real tiers', () => {
    expect(trackFill(flash, 'high')).toBe(1)
    expect(trackFill(flash, 'medium')).toBeCloseTo(0.5)
    expect(trackFill(flash, 'low')).toBe(0)
    expect(trackFill(pro, 'high')).toBe(1)
    expect(trackFill(pro, 'low')).toBe(0)
  })

  it('runs quicker only when fast mode is on', () => {
    expect(animationTempo(true)).toBe('quick')
    expect(animationTempo(false)).toBe('steady')
  })

  it('snaps a drag to the nearest real tier and never between them', () => {
    const three = descendingEfforts(flash)
    expect(tierAtFraction(three, 0)).toBe('high')
    expect(tierAtFraction(three, 0.4)).toBe('medium')
    expect(tierAtFraction(three, 0.99)).toBe('low')
    const two = descendingEfforts(pro)
    expect(tierAtFraction(two, 0.3)).toBe('high')
    expect(tierAtFraction(two, 0.7)).toBe('low')
    expect(tierAtFraction([], 0.5)).toBeNull()
  })

  it('knows which models have a reasoning choice at all', () => {
    expect(isReasoningAdjustable(flash)).toBe(true)
    expect(isReasoningAdjustable(pro)).toBe(true)
    expect(isReasoningAdjustable(MODELS[2]!)).toBe(false)
    expect(isReasoningAdjustable(MODELS[3]!)).toBe(false)
  })
})

describe('fast mode', () => {
  it('is a plain row, not a switch', async () => {
    const user = userEvent.setup()
    renderControls('gemini-3.8-flash')
    await openPopover(user)
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Fast mode/ })).toBeInTheDocument()
  })

  it('toggles its own state without touching the model or effort', async () => {
    const user = userEvent.setup()
    const { onChange, onFastModeChange } = renderControls('gemini-3.8-flash', 'medium')
    await openPopover(user)
    await user.click(screen.getByRole('button', { name: /Fast mode/ }))
    expect(onFastModeChange).toHaveBeenCalledWith(true)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('speeds the track up without changing its colour theme', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <ModelControls
        models={MODELS}
        selectedModel="gemini-3.8-flash"
        selectedEffort="medium"
        fastMode={false}
        disabled={false}
        onChange={vi.fn()}
        onFastModeChange={vi.fn()}
      />
    )
    await openPopover(user)
    const slider = () => screen.getByRole('slider').closest('.reasoning-slider') as HTMLElement
    expect(slider().className).toContain('tempo-steady')
    expect(slider().className).toContain('theme-calm')

    rerender(
      <ModelControls
        models={MODELS}
        selectedModel="gemini-3.8-flash"
        selectedEffort="medium"
        fastMode
        disabled={false}
        onChange={vi.fn()}
        onFastModeChange={vi.fn()}
      />
    )
    expect(slider().className).toContain('tempo-quick')
    expect(slider().className).toContain('theme-calm')
  })

  it('says plainly that it does not reach Antigravity yet', async () => {
    const user = userEvent.setup()
    renderControls('gemini-3.8-flash')
    await openPopover(user)
    expect(screen.getByText(/Antigravity has no fast-mode setting yet/i)).toBeInTheDocument()
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
