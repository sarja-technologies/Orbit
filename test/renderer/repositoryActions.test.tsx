// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { RepositoryActions } from '../../src/renderer/app/components/RepositoryActions'
import { NO_REPOSITORY, repositoryActionById, type RepositoryState } from '../../src/shared/repositoryActions'

function state(overrides: Partial<RepositoryState> = {}): RepositoryState {
  return { isRepository: true, branch: 'main', hasChanges: false, hasUpstream: true, ahead: 0, ...overrides }
}

function renderActions(overrides: Partial<RepositoryState> = {}, enabled = true, disabled = false) {
  const onSendPrompt = vi.fn()
  const view = render(
    <RepositoryActions state={state(overrides)} enabled={enabled} disabled={disabled} onSendPrompt={onSendPrompt} />
  )
  return { ...view, onSendPrompt }
}

describe('a git repository shows quick actions', () => {
  it('shows the actions that apply', () => {
    renderActions({ hasChanges: true, ahead: 1 })

    expect(screen.getByRole('button', { name: 'Review diff' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Commit changes' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Push' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create PR' })).toBeInTheDocument()
  })

  it('names the branch it is acting on', () => {
    renderActions({ branch: 'feature/thing' })
    expect(screen.getByText('feature/thing')).toBeInTheDocument()
  })

  it('hides a commit action on a clean tree', () => {
    renderActions({ hasChanges: false })
    expect(screen.queryByRole('button', { name: 'Commit changes' })).toBeNull()
  })

  it('goes inert rather than vanishing while a turn runs', () => {
    // Disappearing would reflow the composer the moment a message is sent.
    renderActions({ hasChanges: true }, true, true)
    expect(screen.getByRole('button', { name: 'Commit changes' })).toBeDisabled()
  })
})

describe('a non-git folder shows nothing', () => {
  it('renders nothing at all outside a repository', () => {
    const { container } = render(
      <RepositoryActions state={NO_REPOSITORY} enabled disabled={false} onSendPrompt={vi.fn()} />
    )
    expect(container).toBeEmptyDOMElement()
  })
})

describe('the setting hides them', () => {
  it('renders nothing when repository actions are disabled', () => {
    const { container } = renderActions({ hasChanges: true, ahead: 2 }, false)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('a quick action sends a prompt, never a git command', () => {
  it('submits the action’s prompt text', async () => {
    const user = userEvent.setup()
    const { onSendPrompt } = renderActions({ hasChanges: true })

    await user.click(screen.getByRole('button', { name: 'Commit changes' }))

    // Exactly the shared prompt — the component composes nothing of its own.
    expect(onSendPrompt).toHaveBeenCalledTimes(1)
    expect(onSendPrompt).toHaveBeenCalledWith(repositoryActionById('commit')!.prompt)
  })

  it('sends natural language rather than anything executable', async () => {
    const user = userEvent.setup()
    const { onSendPrompt } = renderActions({ hasChanges: true })

    await user.click(screen.getByRole('button', { name: 'Commit changes' }))

    const sent = onSendPrompt.mock.calls[0]![0] as string
    expect(sent).toMatch(/review the current git status and diff/i)
    // Not a command line. The agent decides what to run, under the
    // session's own permission mode.
    expect(sent).not.toMatch(/^git /)
  })

  it('sends each action’s own prompt', async () => {
    const user = userEvent.setup()
    const { onSendPrompt } = renderActions({ hasChanges: true, ahead: 1 })

    for (const [label, id] of [
      ['Review diff', 'review-diff'],
      ['Push', 'push'],
      ['Create PR', 'create-pr']
    ] as const) {
      onSendPrompt.mockClear()
      await user.click(screen.getByRole('button', { name: label }))
      expect(onSendPrompt).toHaveBeenCalledWith(repositoryActionById(id)!.prompt)
    }
  })

  it('says in its tooltip that it asks Antigravity', async () => {
    renderActions({ hasChanges: true })
    // So a chip is never mistaken for a button that performs the operation.
    expect(screen.getByRole('button', { name: 'Commit changes' }).getAttribute('title')).toMatch(/^Ask Antigravity:/)
  })
})
