// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ModelControls } from '../../src/renderer/app/components/ModelControls'
import { PermissionControl } from '../../src/renderer/app/components/PermissionControl'
import { ProjectControl } from '../../src/renderer/app/components/ProjectControl'
import { MessageActions } from '../../src/renderer/app/components/MessageActions'
import { MessageBlock } from '../../src/renderer/app/components/MessageBlock'
import { isDescriptive, modelDescription, modelPurpose } from '../../src/renderer/app/lib/modelMetadata'
import { canSwitchTo, permissionModeFor } from '../../src/renderer/app/lib/permissionModes'
import { describeModelSelection, resolvedModelFromEvent } from '../../src/renderer/app/lib/resolvedModel'
import { pathLeaf, workingContext } from '../../src/renderer/app/lib/projectContext'
import type { Conversation, Message, ModelOption, Project } from '../../src/shared/domain'
import type { RuntimeEvent } from '../../src/shared/runtime-events'

const MODELS: ModelOption[] = [
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', supportedReasoningEfforts: ['low', 'medium', 'high'] },
  { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', supportedReasoningEfforts: ['low', 'high'] },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
  { id: 'gpt-oss-120b', label: 'GPT-OSS 120B', supportedReasoningEfforts: ['medium'] }
]

const PROJECT: Project = { id: 'p1', name: 'TestingZONE', rootPath: '/home/dev/testing-zone', createdAt: 'now', updatedAt: 'now' }
const OTHER: Project = { id: 'p2', name: 'Orbit', rootPath: '/home/dev/orbit', createdAt: 'now', updatedAt: 'now' }
const MANAGED: Project = { id: 'p3', name: 'Scratch', rootPath: null, createdAt: 'now', updatedAt: 'now' }

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    projectId: 'p1',
    title: 'Main',
    providerId: 'antigravity',
    nativeConversationId: null,
    status: 'idle',
    transport: 'structured',
    model: null,
    reasoningEffort: null,
    workingDirectory: null,
    createdAt: 'now',
    updatedAt: 'now',
    ...overrides
  }
}

// ---------------------------------------------------------------- model

describe('model display', () => {
  it('states the chosen model when the user picked one', () => {
    const display = describeModelSelection('gemini-3.8-flash', MODELS, null)
    expect(display.mode).toBe('explicit')
    expect(display.primary).toBe('3.8 Flash')
    expect(display.unresolved).toBe(false)
  })

  it('shows the id itself when the session carries one the catalogue no longer has', () => {
    const display = describeModelSelection('gemini-9.9-vapour', MODELS, null)
    expect(display.primary).toBe('gemini-9.9-vapour')
    expect(display.model).toBeNull()
  })

  it('says Default and nothing more until the runtime reports a real model', () => {
    const display = describeModelSelection(null, MODELS, null)
    expect(display.primary).toBe('Default')
    expect(display.secondary).toBeNull()
    expect(display.unresolved).toBe(true)
  })

  it('adds the resolved model beside Default once it is known', () => {
    const display = describeModelSelection(null, MODELS, 'gemini-3.8-flash')
    expect(display.primary).toBe('Default')
    expect(display.secondary).toBe('3.8 Flash')
    expect(display.unresolved).toBe(false)
  })

  it('reports a resolved model the catalogue does not list, rather than dropping it', () => {
    const display = describeModelSelection(null, MODELS, 'gemini-4.0-experimental')
    expect(display.secondary).toBe('gemini-4.0-experimental')
    expect(display.unresolved).toBe(false)
  })

  it('takes a reported model only from run events that carry one', () => {
    const base = { projectId: 'p', conversationId: 'c1', runId: 'r', providerId: 'antigravity' as const, createdAt: 'now' }
    expect(resolvedModelFromEvent({ ...base, type: 'run.started' } as RuntimeEvent)).toBeNull()
    expect(resolvedModelFromEvent({ ...base, type: 'text.delta', delta: 'hi' } as RuntimeEvent)).toBeNull()
    expect(resolvedModelFromEvent({ ...base, type: 'run.started', model: '  ' } as RuntimeEvent)).toBeNull()
    expect(resolvedModelFromEvent({ ...base, type: 'run.started', model: 'gemini-3.8-flash' } as RuntimeEvent)).toEqual({
      conversationId: 'c1',
      model: 'gemini-3.8-flash'
    })
  })
})

describe('model control rendering', () => {
  const renderModel = (selectedModel: string | null, resolvedModelId: string | null = null) =>
    render(
      <ModelControls
        models={MODELS}
        selectedModel={selectedModel}
        selectedEffort={null}
        resolvedModelId={resolvedModelId}
        disabled={false}
        onSelectModel={vi.fn()}
        onSelectEffort={vi.fn()}
      />
    )

  it('says Default is unresolved quietly, without naming a model nobody reported', () => {
    renderModel(null)
    const trigger = screen.getByLabelText('Model and reasoning')
    expect(trigger).toHaveTextContent('Default')
    expect(trigger).toHaveTextContent('not reported')
    for (const model of MODELS) expect(trigger).not.toHaveTextContent(model.label)
  })

  it('shows Default and the resolved model together once it is known', () => {
    renderModel(null, 'gemini-3.1-pro')
    const trigger = screen.getByLabelText('Model and reasoning')
    expect(trigger).toHaveTextContent('Default')
    expect(trigger).toHaveTextContent('3.1 Pro')
    expect(trigger).not.toHaveTextContent('not reported')
  })

  it('updates in place when the model becomes known mid-session', () => {
    const { rerender } = renderModel(null)
    expect(screen.getByLabelText('Model and reasoning')).toHaveTextContent('not reported')
    rerender(
      <ModelControls
        models={MODELS}
        selectedModel={null}
        selectedEffort={null}
        resolvedModelId="gemini-3.8-flash"
        disabled={false}
        onSelectModel={vi.fn()}
        onSelectEffort={vi.fn()}
      />
    )
    expect(screen.getByLabelText('Model and reasoning')).toHaveTextContent('3.8 Flash')
  })

  it('carries the whole truth in the accessible description, not just the two words', () => {
    renderModel(null)
    expect(screen.getByLabelText('Model and reasoning')).toHaveAttribute(
      'title',
      expect.stringContaining('has not reported which model it used yet')
    )
  })

  it('names the resolved model on the Default row too, so the open menu agrees with the trigger', async () => {
    const user = userEvent.setup()
    renderModel(null, 'gemini-3.8-flash')
    await user.click(screen.getByLabelText('Model and reasoning'))
    expect(screen.getByRole('menuitemradio', { name: /Default model/ })).toHaveTextContent('Antigravity’s own choice · 3.8 Flash')
  })
})

// --------------------------------------------------------- descriptions

describe('model descriptions', () => {
  it('says what a model is for instead of restating its reasoning tiers', async () => {
    const user = userEvent.setup()
    render(
      <ModelControls
        models={MODELS}
        selectedModel="gemini-3.8-flash"
        selectedEffort="high"
        resolvedModelId={null}
        disabled={false}
        onSelectModel={vi.fn()}
        onSelectEffort={vi.fn()}
      />
    )
    await user.click(screen.getByLabelText('Model and reasoning'))

    const flash = screen.getByRole('menuitemradio', { name: /Gemini 3\.8 Flash/ })
    expect(flash).toHaveTextContent('Fast everyday coding and quick edits')
    // The tier list is the reasoning control's job, one pane to the right.
    expect(flash).not.toHaveTextContent('High · Medium · Low reasoning')
    expect(screen.getByRole('menuitemradio', { name: /Gemini 3\.1 Pro/ })).toHaveTextContent(
      'Best for difficult implementation and deeper reasoning'
    )
  })

  it('places a model from the family word its own vendor published', () => {
    expect(modelPurpose({ id: 'gemini-3.8-flash', label: '' })).toBe('fast')
    expect(modelPurpose({ id: 'gemini-3.1-pro', label: '' })).toBe('deep')
    expect(modelPurpose({ id: 'claude-sonnet-4-6', label: '' })).toBe('balanced')
    expect(modelPurpose({ id: 'claude-opus-4-6-thinking', label: '' })).toBe('deep')
    expect(modelPurpose({ id: 'claude-haiku-4-5', label: '' })).toBe('light')
  })

  it('lets the narrower family word win over the broader one', () => {
    // A flash-lite is a light model first and a flash model second.
    expect(modelPurpose({ id: 'gemini-3.8-flash-lite', label: '' })).toBe('light')
  })

  it('falls back to the real catalogue id rather than inventing a description', () => {
    const unknown: ModelOption = { id: 'gpt-oss-120b', label: 'GPT-OSS 120B' }
    expect(modelPurpose(unknown)).toBeNull()
    expect(modelDescription(unknown)).toBe('gpt-oss-120b')
    expect(isDescriptive(unknown)).toBe(false)
  })

  it('prefers real catalogue metadata over Orbit’s own mapping', () => {
    const published: ModelOption = { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', description: 'Tuned for this workspace' }
    expect(modelDescription(published)).toBe('Tuned for this workspace')
    expect(isDescriptive(published)).toBe(true)
  })
})

// ------------------------------------------------------------- project

describe('working context', () => {
  it('prefers a session override, then the project folder, then says neither exists', () => {
    expect(workingContext(PROJECT, conversation())).toEqual({ path: '/home/dev/testing-zone', source: 'project' })
    expect(workingContext(PROJECT, conversation({ workingDirectory: '/tmp/one-off' }))).toEqual({
      path: '/tmp/one-off',
      source: 'session'
    })
    expect(workingContext(MANAGED, conversation())).toEqual({ path: null, source: 'managed' })
  })

  it('takes the identifying leaf off a path either separator can build', () => {
    expect(pathLeaf('/home/dev/testing-zone')).toBe('testing-zone')
    expect(pathLeaf('/home/dev/testing-zone/')).toBe('testing-zone')
    expect(pathLeaf('C:\\Users\\dev\\Orbit')).toBe('Orbit')
    expect(pathLeaf('/')).toBe('/')
  })
})

describe('ProjectControl', () => {
  const renderProject = (project: Project | null, conv = conversation(), projects: Project[] = [PROJECT, OTHER]) => {
    const onSelectProject = vi.fn()
    const onChangeFolder = vi.fn()
    render(
      <ProjectControl
        project={project}
        conversation={conv}
        projects={projects}
        disabled={false}
        onSelectProject={onSelectProject}
        onChangeFolder={onChangeFolder}
      />
    )
    return { onSelectProject, onChangeFolder }
  }

  it('makes the working project the control, and the path its detail', () => {
    renderProject(PROJECT)
    const trigger = screen.getByLabelText('Project: TestingZONE')
    expect(trigger).toHaveTextContent('TestingZONE')
    // The absolute path stays out of the composer row itself.
    expect(trigger).not.toHaveTextContent('/home/dev/testing-zone')
    expect(trigger).toHaveAttribute('title', '/home/dev/testing-zone')
  })

  it('shows the full folder and who decided it once opened', async () => {
    const user = userEvent.setup()
    renderProject(PROJECT)
    await user.click(screen.getByLabelText('Project: TestingZONE'))
    const popover = screen.getByRole('dialog', { name: 'Project' })
    expect(within(popover).getByText('/home/dev/testing-zone')).toBeInTheDocument()
    expect(within(popover).getByText('Every session in this project runs here.')).toBeInTheDocument()
  })

  it('says a session override is one, rather than passing it off as the project’s folder', async () => {
    const user = userEvent.setup()
    renderProject(PROJECT, conversation({ workingDirectory: '/tmp/one-off' }))
    await user.click(screen.getByLabelText('Project: TestingZONE'))
    const popover = screen.getByRole('dialog', { name: 'Project' })
    expect(within(popover).getByText('/tmp/one-off')).toBeInTheDocument()
    expect(within(popover).getByText('This session overrides the project’s folder.')).toBeInTheDocument()
  })

  it('never invents a path for a project that has none', async () => {
    const user = userEvent.setup()
    renderProject(MANAGED)
    await user.click(screen.getByLabelText('Project: Scratch'))
    const popover = screen.getByRole('dialog', { name: 'Project' })
    expect(within(popover).getByText('Orbit-managed workspace')).toBeInTheDocument()
    // Scoped to this project's own folder block: the switcher below it
    // legitimately shows other projects' real paths.
    const folder = popover.querySelector('.project-popover-path') as HTMLElement
    expect(within(folder).queryByText(/^\//)).not.toBeInTheDocument()
    expect(within(folder).getByText(/no folder of its own/)).toBeInTheDocument()
  })

  it('switches to another project from the same control', async () => {
    const user = userEvent.setup()
    const { onSelectProject } = renderProject(PROJECT)
    await user.click(screen.getByLabelText('Project: TestingZONE'))
    await user.click(screen.getByRole('button', { name: /Orbit/ }))
    expect(onSelectProject).toHaveBeenCalledWith('p2')
    expect(screen.queryByRole('dialog', { name: 'Project' })).not.toBeInTheDocument()
  })

  it('does not offer the project you are already in as somewhere to switch to', async () => {
    const user = userEvent.setup()
    renderProject(PROJECT)
    await user.click(screen.getByLabelText('Project: TestingZONE'))
    const popover = screen.getByRole('dialog', { name: 'Project' })
    expect(within(popover).queryByRole('button', { name: /TestingZONE/ })).not.toBeInTheDocument()
  })

  it('hands the folder change to the app rather than pretending to do it', async () => {
    const user = userEvent.setup()
    const { onChangeFolder } = renderProject(PROJECT)
    await user.click(screen.getByLabelText('Project: TestingZONE'))
    await user.click(screen.getByRole('button', { name: /Change project folder/ }))
    expect(onChangeFolder).toHaveBeenCalled()
  })

  it('closes on Escape', async () => {
    const user = userEvent.setup()
    renderProject(PROJECT)
    await user.click(screen.getByLabelText('Project: TestingZONE'))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Project' })).not.toBeInTheDocument()
  })
})

// --------------------------------------------------------- permissions

describe('permission modes', () => {
  it('maps each real transport onto a mode, and invents no third one', () => {
    expect(permissionModeFor('structured').label).toBe('Can’t ask')
    expect(permissionModeFor('pty').label).toBe('Ask first')
  })

  it('allows only the escalation the runtime actually honours', () => {
    expect(canSwitchTo('structured', 'pty')).toBe(true)
    // OrbitRuntime refuses pty -> structured; the UI must not offer it.
    expect(canSwitchTo('pty', 'structured')).toBe(false)
    expect(canSwitchTo('pty', 'pty')).toBe(false)
  })
})

describe('PermissionControl', () => {
  const renderPermissions = (transport: Conversation['transport']) => {
    const onSelect = vi.fn()
    render(<PermissionControl transport={transport} disabled={false} onSelect={onSelect} />)
    return { onSelect }
  }

  it('states the session’s real approval state beside the model', () => {
    renderPermissions('structured')
    expect(screen.getByLabelText('Permissions: Can’t ask')).toHaveTextContent('Can’t ask')
  })

  it('states the interactive state once the session has one', () => {
    renderPermissions('pty')
    expect(screen.getByLabelText('Permissions: Ask first')).toHaveTextContent('Ask first')
  })

  it('offers exactly the two modes Orbit has, with no auto-approve among them', async () => {
    const user = userEvent.setup()
    renderPermissions('structured')
    await user.click(screen.getByLabelText('Permissions: Can’t ask'))
    const popover = screen.getByRole('dialog', { name: 'Permissions' })
    const rows = within(popover).getAllByRole('menuitemradio')
    expect(rows).toHaveLength(2)
    expect(within(popover).queryByText(/auto.?approve/i)).not.toBeInTheDocument()
    expect(within(popover).queryByText(/skip permissions/i)).not.toBeInTheDocument()
  })

  it('keeps the technical identifier as a detail line, not as the control’s name', async () => {
    const user = userEvent.setup()
    renderPermissions('structured')
    await user.click(screen.getByLabelText('Permissions: Can’t ask'))
    const popover = screen.getByRole('dialog', { name: 'Permissions' })
    expect(within(popover).getByText('transport: structured')).toBeInTheDocument()
    expect(within(popover).getByText('transport: pty')).toBeInTheDocument()
  })

  it('escalates a session so Antigravity can ask', async () => {
    const user = userEvent.setup()
    const { onSelect } = renderPermissions('structured')
    await user.click(screen.getByLabelText('Permissions: Can’t ask'))
    await user.click(screen.getByRole('menuitemradio', { name: /Ask first/ }))
    expect(onSelect).toHaveBeenCalledWith('pty')
  })

  it('presents the one-way escalation as settled rather than as a switch that does nothing', async () => {
    const user = userEvent.setup()
    const { onSelect } = renderPermissions('pty')
    await user.click(screen.getByLabelText('Permissions: Ask first'))
    const cannotAsk = screen.getByRole('menuitemradio', { name: /Can’t ask/ })
    expect(cannotAsk).toBeDisabled()
    expect(cannotAsk).toHaveTextContent('A session that can ask you stays that way.')
    await user.click(cannotAsk)
    expect(onSelect).not.toHaveBeenCalled()
  })
})

// ------------------------------------------------------- message actions

describe('message actions', () => {
  const message = (overrides: Partial<Message> = {}): Message => ({
    id: 'm1',
    projectId: 'p1',
    conversationId: 'c1',
    runId: null,
    role: 'user',
    content: 'Refactor the composer, please.',
    status: 'completed',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sequence: 1,
    ...overrides
  })

  it('copies a user message in one click, with no menu in the way', async () => {
    const user = userEvent.setup()
    render(<MessageBlock message={message()} showRole attachments={[]} thumbnails={{}} />)

    expect(screen.queryByRole('button', { name: /More|Options/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Copy your message' }))
    expect(await navigator.clipboard.readText()).toBe('Refactor the composer, please.')
  })

  it('copies an assistant reply from the reply itself', async () => {
    const user = userEvent.setup()
    render(
      <MessageBlock
        message={message({ id: 'm2', role: 'assistant', content: 'Here is the plan.' })}
        showRole
        attachments={[]}
        thumbnails={{}}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Copy Antigravity’s reply' }))
    expect(await navigator.clipboard.readText()).toBe('Here is the plan.')
  })

  it('confirms the copy, and only after it really happened', async () => {
    const user = userEvent.setup()
    render(<MessageActions text="hello" label="your message" />)
    const button = screen.getByRole('button', { name: 'Copy your message' })
    expect(button).toHaveTextContent('Copy')

    await user.click(button)
    expect(screen.getByRole('button', { name: /Copy your message/ })).toHaveTextContent('Copied')
    expect(screen.getByRole('status')).toHaveTextContent('Copied to clipboard')
  })

  it('claims nothing when the clipboard is unavailable', async () => {
    const user = userEvent.setup()
    const clipboard = navigator.clipboard
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
    try {
      render(<MessageActions text="hello" label="your message" />)
      await user.click(screen.getByRole('button', { name: 'Copy your message' }))
      expect(screen.getByRole('button', { name: 'Copy your message' })).toHaveTextContent('Copy')
      expect(screen.getByRole('status')).toBeEmptyDOMElement()
    } finally {
      Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true })
    }
  })

  it('is reachable by keyboard, and its label is always in the DOM', async () => {
    const user = userEvent.setup()
    render(<MessageActions text="hello" label="your message" />)
    await user.tab()
    expect(screen.getByRole('button', { name: 'Copy your message' })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(await navigator.clipboard.readText()).toBe('hello')
  })
})
