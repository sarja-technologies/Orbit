import { describe, expect, it } from 'vitest'
import { describeInteraction, describeResolution, extractCommand, isDestructiveCommand } from '../../src/renderer/app/lib/interactionCopy'
import type { InteractionRequiredEvent } from '../../src/shared/runtime-events'

function event(overrides: Partial<InteractionRequiredEvent> = {}): InteractionRequiredEvent {
  return {
    type: 'interaction.required',
    projectId: 'p',
    conversationId: 'c',
    runId: 'r',
    providerId: 'antigravity',
    createdAt: new Date().toISOString(),
    interactionId: 'i-1',
    kind: 'permission',
    prompt: 'Requesting permission for:\n   npm run build\n\nDo you want to proceed?',
    options: [
      { id: '1', label: 'Yes' },
      { id: '4', label: 'No' }
    ],
    transport: 'pty',
    canRespond: true,
    sourceEvidence: 'native-prompt',
    ...overrides
  }
}

describe('extractCommand', () => {
  it('pulls the command out of a real captured permission prompt', () => {
    expect(extractCommand('Requesting permission for:\n   npm run build\n\nDo you want to proceed?')).toBe('npm run build')
  })

  it('returns null when the prompt is not a command request', () => {
    expect(extractCommand('Do you trust the contents of this project?')).toBeNull()
  })
})

describe('describeInteraction', () => {
  it('translates a real captured command prompt into product language', () => {
    const view = describeInteraction(event())
    expect(view.title).toBe('Run this command?')
    expect(view.command).toBe('npm run build')
    expect(view.recognized).toBe(true)
    // The raw prompt is never discarded.
    expect(view.originalPrompt).toContain('Requesting permission for:')
  })

  it('translates the workspace-trust prompt', () => {
    const view = describeInteraction(
      event({
        prompt: 'Do you trust the contents of this project?\n\nAntigravity CLI requires permission to read, edit, and execute files here.',
        options: [
          { id: 'arrow:0', label: 'Yes, I trust this folder' },
          { id: 'arrow:1', label: 'No, exit' }
        ]
      })
    )
    expect(view.kind).toBe('trust')
    expect(view.title).toBe('Trust this project folder?')
    expect(view.approve?.id).toBe('arrow:0')
    expect(view.deny?.id).toBe('arrow:1')
  })

  it('maps the real four-option agy menu without losing or substituting any option', () => {
    const view = describeInteraction(
      event({
        options: [
          { id: '1', label: 'Yes' },
          { id: '2', label: "Yes, and always allow in this conversation for commands that start with 'npm'" },
          { id: '3', label: "Yes, and always allow for commands that start with 'npm' (Persist to settings.json)" },
          { id: '4', label: 'No' }
        ]
      })
    )
    // Each native option keeps its own id — presentation changes, semantics do not.
    expect(view.approve?.id).toBe('1')
    expect(view.rememberSession?.id).toBe('2')
    expect(view.rememberAlways?.id).toBe('3')
    expect(view.deny?.id).toBe('4')
    expect(view.other).toHaveLength(0)
  })

  it('falls back safely for an unrecognized prompt shape and keeps every option', () => {
    const view = describeInteraction(
      event({
        prompt: 'Some entirely new question Orbit has never seen before',
        options: [
          { id: 'a', label: 'Option A' },
          { id: 'b', label: 'Option B' }
        ]
      })
    )
    expect(view.recognized).toBe(false)
    expect(view.title).toBe('Antigravity needs your approval')
    expect(view.command).toBeNull()
    // Nothing was confidently classified, so the native labels survive.
    expect(view.other.map((option) => option.nativeLabel)).toEqual(['Option A', 'Option B'])
    expect(view.originalPrompt).toBe('Some entirely new question Orbit has never seen before')
  })

  it('reports a headless denial as non-actionable rather than inventing buttons', () => {
    const view = describeInteraction(event({ canRespond: false, sourceEvidence: 'headless-denial', options: [] }))
    expect(view.kind).toBe('headless-denial')
    expect(view.title).toContain('could not ask for')
  })

  it('flags a destructive command for cautious presentation only', () => {
    const view = describeInteraction(
      event({ prompt: 'Requesting permission for:\n   rm -rf dist\n\nDo you want to proceed?' })
    )
    expect(view.command).toBe('rm -rf dist')
    expect(view.approve?.destructive).toBe(true)
    // Deny is never marked destructive — it is the safe direction.
    expect(view.deny?.destructive).toBe(false)
  })
})

describe('isDestructiveCommand', () => {
  it('recognizes clearly destructive shapes', () => {
    expect(isDestructiveCommand('rm -rf build')).toBe(true)
    expect(isDestructiveCommand('git push --force origin main')).toBe(true)
    expect(isDestructiveCommand('git reset --hard HEAD~3')).toBe(true)
  })

  it('does not flag ordinary commands', () => {
    expect(isDestructiveCommand('npm run build')).toBe(false)
    expect(isDestructiveCommand('ls -la')).toBe(false)
    expect(isDestructiveCommand(null)).toBe(false)
  })
})

describe('describeResolution', () => {
  it('records what was actually decided, including the command', () => {
    const view = describeInteraction(event())
    expect(describeResolution('approved', view)).toBe('Approved · npm run build')
    expect(describeResolution('denied', view)).toBe('Denied · npm run build')
    expect(describeResolution('cancelled', view)).toBe('Cancelled')
  })
})
