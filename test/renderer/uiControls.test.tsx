// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectControl, shortenPath } from '../../src/renderer/app/components/ProjectControl'
import { PermissionControl } from '../../src/renderer/app/components/PermissionControl'
import { MessageActions } from '../../src/renderer/app/components/MessageActions'
import { SidebarResizer } from '../../src/renderer/app/components/SidebarResizer'
import { SIDEBAR_WIDTH, resolveSidebarWidth } from '../../src/shared/reasoningPolicy'
import { ORBIT_DEFAULT_MODEL_ID } from '../../src/shared/defaultModel'
import type { Conversation, Project } from '../../src/shared/domain'

const PROJECT: Project = {
  id: 'project_1',
  name: 'My Website',
  rootPath: '/Users/dev/Projects/my-website',
  createdAt: 'now',
  updatedAt: 'now'
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conversation_1',
    projectId: 'project_1',
    title: 'Session',
    providerId: 'antigravity',
    nativeConversationId: null,
    status: 'idle',
    transport: 'structured',
    model: ORBIT_DEFAULT_MODEL_ID,
    permissionMode: 'ask',
    reasoningEffort: 'medium',
    workingDirectory: null,
    createdAt: 'now',
    updatedAt: 'now',
    ...overrides
  }
}

describe('project and working-folder control', () => {
  it('names the project on the control, with its real folder beneath', () => {
    render(
      <ProjectControl
        project={PROJECT}
        conversation={conversation()}
        disabled={false}
        onChooseProjectFolder={vi.fn()}
        onUseProjectFolder={vi.fn()} projects={[]} onAssignProject={vi.fn()}
      />
    )
    const trigger = screen.getByLabelText('Project and working folder')
    expect(trigger).toHaveTextContent('My Website')
    // The path is abbreviated on the control but complete in the tooltip,
    // so nothing about where agy runs is hidden.
    expect(trigger).toHaveAttribute('title', '/Users/dev/Projects/my-website')
  })

  it('says a session is using its project’s folder when it has no override', async () => {
    const user = userEvent.setup()
    render(
      <ProjectControl
        project={PROJECT}
        conversation={conversation({ workingDirectory: null })}
        disabled={false}
        onChooseProjectFolder={vi.fn()}
        onUseProjectFolder={vi.fn()} projects={[]} onAssignProject={vi.fn()}
      />
    )
    await user.click(screen.getByLabelText('Project and working folder'))
    expect(screen.getByText('Project folder')).toBeInTheDocument()
    expect(screen.getByText(/uses its project’s folder/)).toBeInTheDocument()
    expect(screen.getByText('/Users/dev/Projects/my-website')).toBeInTheDocument()
  })

  it('reports a session override as the session’s own folder, not the project’s', async () => {
    const user = userEvent.setup()
    render(
      <ProjectControl
        project={PROJECT}
        conversation={conversation({ workingDirectory: '/Users/dev/Projects/other' })}
        disabled={false}
        onChooseProjectFolder={vi.fn()}
        onUseProjectFolder={vi.fn()} projects={[]} onAssignProject={vi.fn()}
      />
    )
    await user.click(screen.getByLabelText('Project and working folder'))
    expect(screen.getByText('Session folder')).toBeInTheDocument()
    // The override wins, which is what agy will actually be launched in.
    expect(screen.getByText('/Users/dev/Projects/other')).toBeInTheDocument()
    expect(screen.queryByText('/Users/dev/Projects/my-website')).not.toBeInTheDocument()
  })

  it('claims no folder at all when none was ever chosen', async () => {
    const user = userEvent.setup()
    render(
      <ProjectControl
        project={{ ...PROJECT, rootPath: null }}
        conversation={conversation()}
        disabled={false}
        onChooseProjectFolder={vi.fn()}
        onUseProjectFolder={vi.fn()} projects={[]} onAssignProject={vi.fn()}
      />
    )
    await user.click(screen.getByLabelText('Project and working folder'))
    expect(screen.getByText(/managed workspace/)).toBeInTheDocument()
  })

  it('routes a folder change through the caller’s API rather than touching the filesystem', async () => {
    const user = userEvent.setup()
    const onChooseProjectFolder = vi.fn()
    render(
      <ProjectControl
        project={PROJECT}
        conversation={conversation()}
        disabled={false}
        onChooseProjectFolder={onChooseProjectFolder}
        onUseProjectFolder={vi.fn()} projects={[]} onAssignProject={vi.fn()}
      />
    )
    await user.click(screen.getByLabelText('Project and working folder'))
    await user.click(screen.getByRole('button', { name: /Change project folder/ }))
    expect(onChooseProjectFolder).toHaveBeenCalledTimes(1)
  })

  it('only offers to fall back to the project folder when there is an override', async () => {
    const user = userEvent.setup()
    const onUseProjectFolder = vi.fn()
    const { rerender } = render(
      <ProjectControl
        project={PROJECT}
        conversation={conversation({ workingDirectory: null })}
        disabled={false}
        onChooseProjectFolder={vi.fn()}
        onUseProjectFolder={onUseProjectFolder} projects={[]} onAssignProject={vi.fn()}
      />
    )
    await user.click(screen.getByLabelText('Project and working folder'))
    expect(screen.queryByRole('button', { name: /Use the project’s folder/ })).not.toBeInTheDocument()

    rerender(
      <ProjectControl
        project={PROJECT}
        conversation={conversation({ workingDirectory: '/Users/dev/elsewhere' })}
        disabled={false}
        onChooseProjectFolder={vi.fn()}
        onUseProjectFolder={onUseProjectFolder} projects={[]} onAssignProject={vi.fn()}
      />
    )
    await user.click(screen.getByRole('button', { name: /Use the project’s folder/ }))
    expect(onUseProjectFolder).toHaveBeenCalledTimes(1)
  })

  it('abbreviates a long path without inventing one', () => {
    expect(shortenPath('/Users/dev/Projects/my-website')).toBe('~/…/Projects/my-website')
    expect(shortenPath('/tmp')).toBe('/tmp')
  })
})

describe('permission control', () => {
  it('offers exactly the modes agy really supports', async () => {
    const user = userEvent.setup()
    render(<PermissionControl mode="ask" disabled={false} onSelect={vi.fn()} />)
    await user.click(screen.getByLabelText('Permissions'))
    const rows = screen.getAllByRole('menuitemradio')
    expect(rows.map((row) => row.textContent)).toHaveLength(2)
    expect(screen.getByRole('menuitemradio', { name: /Ask first/ })).toBeInTheDocument()
    expect(screen.getByRole('menuitemradio', { name: /Skip approvals/ })).toBeInTheDocument()
  })

  it('does not present agy’s execution modes as permission choices', async () => {
    const user = userEvent.setup()
    render(<PermissionControl mode="ask" disabled={false} onSelect={vi.fn()} />)
    await user.click(screen.getByLabelText('Permissions'))
    // These exist as agy flags but do not change permission_mode, so a
    // control offering them would be a switch that changes nothing.
    expect(screen.queryByRole('menuitemradio', { name: /accept.edits/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitemradio', { name: /plan/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitemradio', { name: /auto.approve/i })).not.toBeInTheDocument()
  })

  it('shows the active mode on the closed control and marks it in the list', async () => {
    const user = userEvent.setup()
    render(<PermissionControl mode="skip" disabled={false} onSelect={vi.fn()} />)
    const trigger = screen.getByLabelText('Permissions')
    expect(trigger).toHaveTextContent('Skip approvals')
    await user.click(trigger)
    expect(screen.getByRole('menuitemradio', { name: /Skip approvals/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('menuitemradio', { name: /Ask first/ })).toHaveAttribute('aria-checked', 'false')
  })

  it('says when the change takes effect, because it is a launch flag', async () => {
    const user = userEvent.setup()
    render(<PermissionControl mode="ask" disabled={false} onSelect={vi.fn()} />)
    await user.click(screen.getByLabelText('Permissions'))
    expect(screen.getByText(/next message/)).toBeInTheDocument()
  })

  it('reports the chosen mode to its owner', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<PermissionControl mode="ask" disabled={false} onSelect={onSelect} />)
    await user.click(screen.getByLabelText('Permissions'))
    await user.click(screen.getByRole('menuitemradio', { name: /Skip approvals/ }))
    expect(onSelect).toHaveBeenCalledWith('skip')
  })
})

describe('message copy actions', () => {
  const writeText = vi.fn(async () => true)

  beforeEach(() => {
    writeText.mockClear()
    writeText.mockResolvedValue(true)
    ;(window as unknown as { orbit: unknown }).orbit = { clipboard: { writeText } }
  })

  afterEach(() => {
    delete (window as unknown as { orbit?: unknown }).orbit
  })

  it('copies a user message’s own text', async () => {
    const user = userEvent.setup()
    render(<MessageActions text="Ship the release notes" label="your message" />)
    await user.click(screen.getByRole('button', { name: /Copy your message/ }))
    expect(writeText).toHaveBeenCalledWith('Ship the release notes')
  })

  it('copies an assistant reply’s markdown source, not its rendered HTML', async () => {
    const user = userEvent.setup()
    const source = '## Heading\n\n- one\n- two\n'
    render(<MessageActions text={source} label="reply" />)
    await user.click(screen.getByRole('button', { name: /Copy reply/ }))
    expect(writeText).toHaveBeenCalledWith(source)
  })

  it('goes through Orbit’s clipboard bridge, never navigator.clipboard', async () => {
    // A packaged Orbit runs on file://, where navigator.clipboard does not
    // exist — a copy that only worked in dev would be worse than none.
    const user = userEvent.setup()
    render(<MessageActions text="x" label="reply" />)
    await user.click(screen.getByRole('button', { name: /Copy reply/ }))
    expect(writeText).toHaveBeenCalledTimes(1)
  })

  it('confirms a copy that happened', async () => {
    const user = userEvent.setup()
    render(<MessageActions text="x" label="reply" />)
    await user.click(screen.getByRole('button', { name: /Copy reply/ }))
    expect(await screen.findByText('Copied')).toBeInTheDocument()
  })

  it('says so when the copy did not happen, rather than failing silently', async () => {
    const user = userEvent.setup()
    writeText.mockResolvedValue(false)
    render(<MessageActions text="x" label="reply" />)
    await user.click(screen.getByRole('button', { name: /Copy reply/ }))
    expect(await screen.findByText('Failed')).toBeInTheDocument()
  })

  it('says so when the bridge itself throws', async () => {
    const user = userEvent.setup()
    writeText.mockRejectedValue(new Error('no clipboard'))
    render(<MessageActions text="x" label="reply" />)
    await user.click(screen.getByRole('button', { name: /Copy reply/ }))
    expect(await screen.findByText('Failed')).toBeInTheDocument()
  })

  it('is a real focusable control, so it is reachable without a pointer', async () => {
    const user = userEvent.setup()
    render(<MessageActions text="x" label="reply" />)
    const button = screen.getByRole('button', { name: /Copy reply/ })
    await user.tab()
    expect(button).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(writeText).toHaveBeenCalledTimes(1)
  })
})

describe('sidebar resizer', () => {
  it('reports the sidebar’s width as a real separator control', () => {
    render(<SidebarResizer width={300} onResize={vi.fn()} onCommit={vi.fn()} />)
    const handle = screen.getByRole('separator', { name: 'Resize sidebar' })
    expect(handle).toHaveAttribute('aria-valuenow', '300')
    expect(handle).toHaveAttribute('aria-valuemin', String(SIDEBAR_WIDTH.min))
    expect(handle).toHaveAttribute('aria-valuemax', String(SIDEBAR_WIDTH.max))
  })

  it('resizes as the pointer moves, and commits once the gesture ends', async () => {
    const onResize = vi.fn()
    const onCommit = vi.fn()
    render(<SidebarResizer width={300} onResize={onResize} onCommit={onCommit} />)
    const handle = screen.getByRole('separator', { name: 'Resize sidebar' })
    // jsdom has no pointer capture; the component only needs it to exist.
    Object.assign(handle, {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
      hasPointerCapture: () => true
    })

    handle.dispatchEvent(pointerEvent('pointerdown', { clientX: 300, button: 0 }))
    handle.dispatchEvent(pointerEvent('pointermove', { clientX: 380 }))
    expect(onResize).toHaveBeenLastCalledWith(380)
    // Dragging must not persist on every pointer event.
    expect(onCommit).not.toHaveBeenCalled()

    handle.dispatchEvent(pointerEvent('pointerup', { clientX: 380 }))
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1))
  })

  it('clamps a drag to a width the layout can actually use', () => {
    const onResize = vi.fn()
    render(<SidebarResizer width={300} onResize={onResize} onCommit={vi.fn()} />)
    const handle = screen.getByRole('separator', { name: 'Resize sidebar' })
    Object.assign(handle, {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
      hasPointerCapture: () => true
    })

    handle.dispatchEvent(pointerEvent('pointerdown', { clientX: 300, button: 0 }))
    handle.dispatchEvent(pointerEvent('pointermove', { clientX: 20 }))
    expect(onResize).toHaveBeenLastCalledWith(SIDEBAR_WIDTH.min)
    handle.dispatchEvent(pointerEvent('pointermove', { clientX: 4000 }))
    expect(onResize).toHaveBeenLastCalledWith(SIDEBAR_WIDTH.max)
  })

  it('suppresses text selection while a drag is live, then restores it', () => {
    render(<SidebarResizer width={300} onResize={vi.fn()} onCommit={vi.fn()} />)
    const handle = screen.getByRole('separator', { name: 'Resize sidebar' })
    Object.assign(handle, {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
      hasPointerCapture: () => true
    })

    handle.dispatchEvent(pointerEvent('pointerdown', { clientX: 300, button: 0 }))
    expect(document.body.classList.contains('is-resizing')).toBe(true)
    handle.dispatchEvent(pointerEvent('pointerup', { clientX: 300 }))
    expect(document.body.classList.contains('is-resizing')).toBe(false)
  })

  it('resizes from the keyboard, committing each adjustment', async () => {
    const user = userEvent.setup()
    const onResize = vi.fn()
    const onCommit = vi.fn()
    render(<SidebarResizer width={300} onResize={onResize} onCommit={onCommit} />)
    screen.getByRole('separator', { name: 'Resize sidebar' }).focus()
    await user.keyboard('{ArrowRight}')
    expect(onResize).toHaveBeenLastCalledWith(316)
    expect(onCommit).toHaveBeenLastCalledWith(316)
    await user.keyboard('{ArrowLeft}')
    expect(onResize).toHaveBeenLastCalledWith(284)
  })

  it('ignores a non-primary button, so a right-click never starts a drag', () => {
    const onResize = vi.fn()
    render(<SidebarResizer width={300} onResize={onResize} onCommit={vi.fn()} />)
    const handle = screen.getByRole('separator', { name: 'Resize sidebar' })
    handle.dispatchEvent(pointerEvent('pointerdown', { clientX: 300, button: 2 }))
    handle.dispatchEvent(pointerEvent('pointermove', { clientX: 400 }))
    expect(onResize).not.toHaveBeenCalled()
  })
})

describe('stored sidebar width', () => {
  it('opens wider than the cramped default it replaced', () => {
    expect(resolveSidebarWidth(null)).toBe(SIDEBAR_WIDTH.default)
    expect(SIDEBAR_WIDTH.default).toBeGreaterThan(262)
  })

  it('restores a width the user actually dragged to', () => {
    expect(resolveSidebarWidth(342)).toBe(342)
  })

  it('never restores a width that would break the layout', () => {
    expect(resolveSidebarWidth(10)).toBe(SIDEBAR_WIDTH.min)
    expect(resolveSidebarWidth(9000)).toBe(SIDEBAR_WIDTH.max)
    expect(resolveSidebarWidth(Number.NaN)).toBe(SIDEBAR_WIDTH.default)
    expect(resolveSidebarWidth(undefined)).toBe(SIDEBAR_WIDTH.default)
  })
})

/** jsdom does not implement PointerEvent, so the resizer's own listeners are
 *  driven with a MouseEvent carrying the fields it reads. */
function pointerEvent(type: string, init: { clientX: number; button?: number }): Event {
  const event = new MouseEvent(type, { bubbles: true, clientX: init.clientX, button: init.button ?? 0 })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  return event
}
