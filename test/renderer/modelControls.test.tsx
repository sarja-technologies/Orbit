// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ModelControls } from '../../src/renderer/app/components/ModelControls'
import { EmptySession, STARTERS } from '../../src/renderer/app/components/EmptySession'
import type { ModelOption } from '../../src/shared/domain'

/** Normalized exactly as Antigravity publishes it: uneven tier coverage,
 *  and models that genuinely have no reasoning choice at all. */
const MODELS: ModelOption[] = [
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', supportedReasoningEfforts: ['low', 'medium', 'high'] },
  { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', supportedReasoningEfforts: ['low', 'high'] },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' }
]

function renderControls(selectedModel: string | null, selectedEffort: 'low' | 'medium' | 'high' | null = null) {
  const onChange = vi.fn()
  render(
    <ModelControls models={MODELS} selectedModel={selectedModel} selectedEffort={selectedEffort} disabled={false} onChange={onChange} />
  )
  return onChange
}

describe('ModelControls', () => {
  it('shows the model that is actually selected', () => {
    renderControls('gemini-3.1-pro')
    expect(screen.getByLabelText('Model')).toHaveTextContent('Gemini 3.1 Pro')
  })

  it('offers no reasoning control at all for a model with no tiers', () => {
    renderControls('claude-sonnet-4-6')
    expect(screen.queryByLabelText('Reasoning effort')).not.toBeInTheDocument()
  })

  it('offers no reasoning control while the model is left on the default', () => {
    renderControls(null)
    expect(screen.getByLabelText('Model')).toHaveTextContent('Default model')
    expect(screen.queryByLabelText('Reasoning effort')).not.toBeInTheDocument()
  })

  it('lists only the tiers the selected model genuinely publishes', async () => {
    const user = userEvent.setup()
    renderControls('gemini-3.1-pro')
    await user.click(screen.getByLabelText('Reasoning effort'))
    expect(screen.getByRole('menuitemradio', { name: /Low/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitemradio', { name: /High/ })).toBeInTheDocument()
    // Gemini 3.1 Pro has no medium variant, so Orbit must not show one.
    expect(screen.queryByRole('menuitemradio', { name: /^Medium/ })).not.toBeInTheDocument()
  })

  it('never pre-selects an effort on the user’s behalf', async () => {
    const user = userEvent.setup()
    renderControls('gemini-3.8-flash')
    expect(screen.getByLabelText('Reasoning effort')).toHaveTextContent('Default effort')
    await user.click(screen.getByLabelText('Reasoning effort'))
    expect(screen.getByRole('menuitemradio', { name: /Default effort/ })).toHaveAttribute('aria-checked', 'true')
  })

  it('drops an effort the newly chosen model does not offer', async () => {
    const user = userEvent.setup()
    const onChange = renderControls('gemini-3.8-flash', 'medium')
    await user.click(screen.getByLabelText('Model'))
    await user.click(screen.getByRole('menuitemradio', { name: /Gemini 3.1 Pro/ }))
    expect(onChange).toHaveBeenCalledWith('gemini-3.1-pro', null)
  })

  it('keeps an effort the newly chosen model does offer', async () => {
    const user = userEvent.setup()
    const onChange = renderControls('gemini-3.8-flash', 'high')
    await user.click(screen.getByLabelText('Model'))
    await user.click(screen.getByRole('menuitemradio', { name: /Gemini 3.1 Pro/ }))
    expect(onChange).toHaveBeenCalledWith('gemini-3.1-pro', 'high')
  })

  it('invents no models when Antigravity’s catalogue could not be read', () => {
    render(<ModelControls models={[]} selectedModel={null} selectedEffort={null} disabled={false} onChange={vi.fn()} />)
    expect(screen.getByLabelText('Model')).toBeDisabled()
  })
})

describe('EmptySession', () => {
  it('asks what to work on and offers concrete starting points', () => {
    render(<EmptySession projectName="Renderer Check" onPick={vi.fn()} />)
    expect(screen.getByRole('heading', { name: 'What should we work on?' })).toBeInTheDocument()
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

  it('names only the real project, and says nothing when there is none', () => {
    const { unmount } = render(<EmptySession projectName="Renderer Check" onPick={vi.fn()} />)
    expect(screen.getByText(/Renderer Check/)).toBeInTheDocument()
    unmount()
    render(<EmptySession projectName={null} onPick={vi.fn()} />)
    expect(screen.queryByText(/can read and change files/)).not.toBeInTheDocument()
  })
})
