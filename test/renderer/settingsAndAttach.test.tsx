// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SettingsPanel } from '../../src/renderer/app/components/SettingsPanel'
import { AttachMenu } from '../../src/renderer/app/components/AttachMenu'
import { ORBIT_DEFAULT_MODEL_ID } from '../../src/shared/defaultModel'
import { EMPTY_PREFERENCES } from '../../src/shared/reasoningPolicy'
import { CLEAR_DATA_CONFIRMATION } from '../../src/shared/clearData'
import type { ModelOption } from '../../src/shared/domain'
import type { ResolvedDefaultModel } from '../../src/shared/newSessionDefaults'
import { STARTERS } from '../../src/renderer/app/components/EmptySession'

const MODELS: ModelOption[] = [
  { id: ORBIT_DEFAULT_MODEL_ID, label: 'Gemini 3.8 Flash', supportedReasoningEfforts: ['low', 'medium', 'high'] },
  { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', supportedReasoningEfforts: ['low', 'high'] }
]

const FACTORY: ResolvedDefaultModel = { modelId: ORBIT_DEFAULT_MODEL_ID, source: 'factory', missingModelId: null }

function panel(overrides: Partial<Parameters<typeof SettingsPanel>[0]> = {}) {
  const props = {
    preferences: { ...EMPTY_PREFERENCES },
    models: MODELS,
    modelStatus: FACTORY,
    busy: false,
    onClose: vi.fn(),
    onSelectDefaultModel: vi.fn(),
    onSelectDefaultPermissionMode: vi.fn(),
    onClearAllData: vi.fn(),
    ...overrides
  }
  return { props, ...render(<SettingsPanel {...props} />) }
}

describe('Orbit settings', () => {
  it('opens as a dismissible dialog with the two general settings', () => {
    panel()
    const dialog = screen.getByRole('dialog', { name: 'Settings' })

    expect(within(dialog).getByText('General')).toBeInTheDocument()
    expect(screen.getByLabelText(/Default model/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Default permissions/)).toBeInTheDocument()
    expect(within(dialog).getByText('Data')).toBeInTheDocument()
  })

  it('takes keyboard focus and closes on Escape', async () => {
    const user = userEvent.setup()
    const { props } = panel()

    expect(screen.getByRole('button', { name: 'Close settings' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('closes from its own control', async () => {
    const user = userEvent.setup()
    const { props } = panel()

    await user.click(screen.getByRole('button', { name: 'Close settings' }))
    expect(props.onClose).toHaveBeenCalled()
  })

  it('offers only models the real catalogue lists', () => {
    panel()
    const select = screen.getByLabelText(/Default model/) as HTMLSelectElement

    expect([...select.options].map((option) => option.value)).toEqual([ORBIT_DEFAULT_MODEL_ID, 'gemini-3.1-pro'])
    expect([...select.options].map((option) => option.textContent)).toEqual(['Gemini 3.8 Flash', 'Gemini 3.1 Pro'])
  })

  it('saves a chosen default model', async () => {
    const user = userEvent.setup()
    const { props } = panel()

    await user.selectOptions(screen.getByLabelText(/Default model/), 'gemini-3.1-pro')
    expect(props.onSelectDefaultModel).toHaveBeenCalledWith('gemini-3.1-pro')
  })

  it('shows the saved default, not merely Orbit’s own', () => {
    panel({
      preferences: { ...EMPTY_PREFERENCES, defaultModelId: 'gemini-3.1-pro' },
      modelStatus: { modelId: 'gemini-3.1-pro', source: 'preference', missingModelId: null }
    })
    expect((screen.getByLabelText(/Default model/) as HTMLSelectElement).value).toBe('gemini-3.1-pro')
  })

  it('says so when a saved default model has gone from the catalogue', () => {
    panel({ modelStatus: { modelId: ORBIT_DEFAULT_MODEL_ID, source: 'fallback', missingModelId: 'gemini-2-retired' } })

    const note = screen.getByRole('status')
    expect(note).toHaveTextContent('gemini-2-retired')
    expect(note).toHaveTextContent(/no longer available/i)
  })

  it('asks for a choice when neither the saved nor the factory model exists', () => {
    panel({ modelStatus: { modelId: ORBIT_DEFAULT_MODEL_ID, source: 'unavailable', missingModelId: 'gone' } })

    expect(screen.getByRole('status')).toHaveTextContent(/Choose one from the list/i)
  })

  it('offers exactly the two real permission modes', () => {
    panel()
    const select = screen.getByLabelText(/Default permissions/) as HTMLSelectElement

    expect([...select.options].map((option) => option.textContent)).toEqual(['Ask first', 'Skip approvals'])
    expect(select.value).toBe('ask')
  })

  it('saves a chosen default permission mode', async () => {
    const user = userEvent.setup()
    const { props } = panel()

    await user.selectOptions(screen.getByLabelText(/Default permissions/), 'skip')
    expect(props.onSelectDefaultPermissionMode).toHaveBeenCalledWith('skip')
  })

  it('says both general settings are about new sessions only', () => {
    panel()
    // The distinction the whole feature rests on.
    expect(screen.getAllByText(/Used by new sessions/i).length).toBe(2)
    expect(screen.getByText(/keep the model they have/i)).toBeInTheDocument()
  })
})

describe('clearing all Orbit data', () => {
  it('does not clear anything on the first click', async () => {
    const user = userEvent.setup()
    const { props } = panel()

    await user.click(screen.getByRole('button', { name: 'Clear data' }))
    expect(props.onClearAllData).not.toHaveBeenCalled()
  })

  it('spells out what goes, and what explicitly does not', async () => {
    const user = userEvent.setup()
    panel()
    await user.click(screen.getByRole('button', { name: 'Clear data' }))

    const group = screen.getByRole('group', { name: /Confirm clearing all Orbit data/i })
    const items = within(group)
      .getAllByRole('listitem')
      .map((item) => item.textContent ?? '')
      .join('\n')
    for (const item of [/Projects/i, /Sessions/i, /Messages and run history/i, /preferences/i, /attached/i, /Artifacts/i, /Workspaces/i]) {
      expect(items).toMatch(item)
    }
    // The promise that matters most.
    expect(within(group).getByText(/Your own project folders are/i)).toBeInTheDocument()
    expect(within(group).getByText(/stay exactly where they are/i)).toBeInTheDocument()
  })

  it('stays disabled until the confirmation word is typed exactly', async () => {
    const user = userEvent.setup()
    const { props } = panel()
    await user.click(screen.getByRole('button', { name: 'Clear data' }))

    const confirm = screen.getByRole('button', { name: 'Clear all data' })
    expect(confirm).toBeDisabled()

    await user.type(screen.getByLabelText(new RegExp(`Type ${CLEAR_DATA_CONFIRMATION}`, 'i')), 'clear')
    expect(confirm).toBeDisabled() // case matters
    expect(props.onClearAllData).not.toHaveBeenCalled()
  })

  it('clears once the word matches', async () => {
    const user = userEvent.setup()
    const { props } = panel()
    await user.click(screen.getByRole('button', { name: 'Clear data' }))
    await user.type(screen.getByLabelText(new RegExp(`Type ${CLEAR_DATA_CONFIRMATION}`, 'i')), CLEAR_DATA_CONFIRMATION)

    const confirm = screen.getByRole('button', { name: 'Clear all data' })
    await waitFor(() => expect(confirm).toBeEnabled())
    await user.click(confirm)

    expect(props.onClearAllData).toHaveBeenCalledWith(CLEAR_DATA_CONFIRMATION)
  })

  it('can be backed out of', async () => {
    const user = userEvent.setup()
    const { props } = panel()
    await user.click(screen.getByRole('button', { name: 'Clear data' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('group', { name: /Confirm clearing/i })).not.toBeInTheDocument()
    expect(props.onClearAllData).not.toHaveBeenCalled()
  })
})

describe('the + attachment menu', () => {
  it('asks which kind before opening any native picker', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    render(<AttachMenu disabled={false} onPick={onPick} />)

    await user.click(screen.getByRole('button', { name: 'Add files' }))

    const menu = screen.getByRole('menu', { name: 'Add files' })
    expect(within(menu).getByRole('menuitem', { name: 'Image' })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: 'Video' })).toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: 'Files' })).toBeInTheDocument()
    // Nothing opened yet: choosing the category is the first step now.
    expect(onPick).not.toHaveBeenCalled()
  })

  it('opens the picker for the category chosen', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    render(<AttachMenu disabled={false} onPick={onPick} />)

    await user.click(screen.getByRole('button', { name: 'Add files' }))
    await user.click(screen.getByRole('menuitem', { name: 'Image' }))

    expect(onPick).toHaveBeenCalledWith('image')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('opens the video and files pickers too', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    const view = render(<AttachMenu disabled={false} onPick={onPick} />)

    await user.click(screen.getByRole('button', { name: 'Add files' }))
    await user.click(screen.getByRole('menuitem', { name: 'Video' }))
    expect(onPick).toHaveBeenLastCalledWith('video')

    await user.click(screen.getByRole('button', { name: 'Add files' }))
    await user.click(screen.getByRole('menuitem', { name: 'Files' }))
    expect(onPick).toHaveBeenLastCalledWith('files')
    view.unmount()
  })

  it('closes on Escape without picking anything', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    render(<AttachMenu disabled={false} onPick={onPick} />)

    await user.click(screen.getByRole('button', { name: 'Add files' }))
    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(onPick).not.toHaveBeenCalled()
  })

  it('is navigable by keyboard', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    render(<AttachMenu disabled={false} onPick={onPick} />)

    await user.click(screen.getByRole('button', { name: 'Add files' }))
    // Focus lands in the menu, so it can be driven without a pointer.
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Image' })).toHaveFocus())
    await user.keyboard('{Enter}')

    expect(onPick).toHaveBeenCalledWith('image')
  })
})

describe('semantic colour for symbols', () => {
  const STYLES = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/styles.css'), 'utf8')

  it('names the four kinds as tokens rather than scattering hex codes', () => {
    for (const token of ['--kind-explore', '--kind-build', '--kind-fix', '--kind-review']) {
      expect(STYLES).toMatch(new RegExp(`${token}:\\s*#[0-9a-f]{6}`, 'i'))
    }
  })

  it('gives each starter its own accent', () => {
    for (const [starter, token] of [
      ['explore', '--kind-explore'],
      ['build', '--kind-build'],
      ['fix', '--kind-fix'],
      ['review', '--kind-review']
    ]) {
      expect(STYLES).toMatch(new RegExp(`\\.starter-${starter}\\s*\\{[^}]*--starter-accent:\\s*var\\(${token}\\)`))
    }
  })

  it('colours the symbol, not the whole chip', () => {
    // The surfaces stay calm: colour is there to tell the four apart.
    expect(STYLES).toMatch(/\.starter svg \{\s*color: var\(--starter-accent/)
    expect(STYLES).not.toMatch(/\.starter-\w+\s*\{[^}]*background:\s*var\(--kind-/)
  })

  it('puts each starter’s accent on its own chip class in the markup', () => {
    for (const starter of STARTERS) {
      expect(STYLES).toContain(`.starter-${starter.id}`)
    }
  })
})
