import { describe, expect, it, vi } from 'vitest'
import { AntigravityProvider } from '../../src/main/runtime/providers/antigravity/AntigravityProvider'
import { permissionArgs } from '../../src/shared/permissionMode'
import { transportForTurn } from '../../src/shared/transportPolicy'
import { describeRuntimeError } from '../../src/renderer/app/lib/errorCopy'
import type { ProviderSendInput } from '../../src/main/runtime/provider'
import type { PermissionMode } from '../../src/shared/permissionMode'
import type { RuntimeEvent } from '../../src/shared/runtime-events'

/** Drives the provider's own stream-json line handler with real agy event
 *  shapes, so classification is tested where it actually happens rather
 *  than through a re-implementation of it. */
function replay(lines: object[], permissionMode: PermissionMode): RuntimeEvent[] {
  const provider = new AntigravityProvider() as unknown as {
    activeRuns: Map<string, unknown>
    handleLine: (active: unknown, line: string) => void
  }
  const events: RuntimeEvent[] = []
  const input = {
    projectId: 'p',
    conversationId: 'c',
    runId: 'r',
    prompt: 'go',
    nativeConversationId: null,
    workspacePath: '/tmp/ws',
    saveDir: '/tmp/ws',
    attachments: [],
    referencedArtifacts: [],
    transport: 'structured' as const,
    model: 'gemini-3.8-flash',
    permissionMode,
    reasoningEffort: null
  } satisfies ProviderSendInput
  const active = {
    child: { kill: vi.fn() },
    input,
    onEvent: (event: RuntimeEvent) => events.push(event),
    text: '',
    nativeConversationId: null,
    cancelled: false,
    settled: false,
    stderr: [],
    headlessDenials: []
  }
  provider.activeRuns.set('r', active)
  for (const line of lines) provider.handleLine(active, JSON.stringify(line))
  return events
}

/** A tool step that failed with an ordinary OS error. Captured live: `ls
 *  /root` really does come back as "Permission denied". */
const toolFailure = {
  event: 'step_update',
  step_update: {
    conversation_id: 'n1',
    step_index: 2,
    state: 'DONE',
    step_type: 'tool',
    tool_name: 'run_command',
    tool_info: {
      parameters: { command: 'ls /root' },
      error: { message: "ls: cannot open directory '/root': Permission denied" }
    }
  }
}

const success = { event: 'result', result: { conversation_id: 'n1', status: 'SUCCESS', response: 'The command failed.' } }

describe('Skip approvals launches agy in always-proceed', () => {
  it('passes the real bypass flag, and nothing at all for Ask first', () => {
    expect(permissionArgs('skip')).toEqual(['--dangerously-skip-permissions'])
    // Asking is agy's own default and needs no flag.
    expect(permissionArgs('ask')).toEqual([])
  })

  it('keeps Skip approvals on the headless path and Ask first on the interactive one', () => {
    expect(transportForTurn({ current: 'structured', permissionMode: 'skip', hasImageAttachment: false })).toBe('structured')
    expect(transportForTurn({ current: 'structured', permissionMode: 'ask', hasImageAttachment: false })).toBe('pty')
  })
})

describe('an ordinary tool failure is not an approval problem', () => {
  it('does not turn "Permission denied" in a tool error into a permission card', () => {
    // The reported bug: a turn that ran its tools fine, on a session
    // showing Skip approvals, reporting that Antigravity "needed permission
    // it could not ask for". The words came from the command's own output.
    const events = replay([toolFailure, success], 'skip')

    expect(events.filter((event) => event.type === 'interaction.required')).toHaveLength(0)
    expect(events.some((event) => event.type === 'run.failed')).toBe(false)
    expect(events.some((event) => event.type === 'run.completed')).toBe(true)
  })

  it('does not do it under Ask first either', () => {
    // Nothing was asked there either — agy asks through its own channel,
    // not by putting the word "permission" in a tool error.
    const events = replay([toolFailure, success], 'ask')

    expect(events.filter((event) => event.type === 'interaction.required')).toHaveLength(0)
    expect(events.some((event) => event.type === 'run.completed')).toBe(true)
  })

  it('still reports the step, with the status agy itself gave it', () => {
    // agy decides whether a step failed; a command that ran and printed an
    // error is DONE to agy (confirmed live with `ls /root`), and the model
    // explains the failure in its own answer. Orbit reports what agy said
    // rather than re-deciding it from the error text.
    const activity = replay([toolFailure, success], 'skip').filter((event) => event.type === 'tool.activity')
    expect(activity.length).toBeGreaterThan(0)
    expect(activity.at(-1)).toMatchObject({ status: 'completed', label: 'Running ls /root' })
  })

  it('reports a step agy really did mark as failed', () => {
    const errored = {
      ...toolFailure,
      step_update: { ...toolFailure.step_update, state: 'ERROR' }
    }
    const activity = replay([errored, success], 'skip').filter((event) => event.type === 'tool.activity')

    expect(activity.at(-1)).toMatchObject({ status: 'failed' })
    // Still not an approval problem.
    expect(replay([errored, success], 'skip').some((event) => event.type === 'interaction.required')).toBe(false)
  })
})

describe('what agy itself refuses', () => {
  const denied = {
    event: 'result',
    result: {
      conversation_id: 'n1',
      status: 'SUCCESS',
      response: '',
      denied_actions: [{ display_name: 'Write /etc/passwd' }]
    }
  }

  it('is reported as a restriction, not a missing prompt, when approvals are skipped', () => {
    const events = replay([denied], 'skip')

    // agy is in always-proceed here: it was never going to ask, so there is
    // no approval Orbit failed to present.
    expect(events.filter((event) => event.type === 'interaction.required')).toHaveLength(0)
    const failure = events.find((event) => event.type === 'run.failed')
    expect(failure).toMatchObject({ error: { code: 'provider.action_restricted' } })
  })

  it('is still an un-askable permission under Ask first on the headless path', () => {
    const events = replay([denied], 'ask')

    const raised = events.find((event) => event.type === 'interaction.required')
    expect(raised).toMatchObject({ canRespond: false, sourceEvidence: 'headless-denial' })
    expect(events.find((event) => event.type === 'run.failed')).toMatchObject({
      error: { code: 'provider.interaction_denied' }
    })
  })

  it('ignores agy’s opaque headless-interaction marker when approvals are skipped', () => {
    const opaque = { event: 'step_update', step_update: { conversation_id: 'n1', step_index: 1, state: 'DONE', step_type: 'unknown' } }

    expect(replay([opaque, success], 'skip').some((event) => event.type === 'run.failed')).toBe(false)
    // Under Ask first the same marker still means what it always meant.
    expect(replay([opaque, success], 'ask').some((event) => event.type === 'run.failed')).toBe(true)
  })
})

describe('the copy each condition gets', () => {
  it('does not blame a missing prompt when approvals are skipped', () => {
    const view = describeRuntimeError({ code: 'provider.action_restricted', message: 'Antigravity denied: Write /etc/passwd.', retryable: false })

    expect(view.title).not.toMatch(/could not ask/i)
    expect(view.title).toBe('Antigravity would not do that')
    expect(view.body).toMatch(/already skipped/i)
  })

  it('keeps the un-askable-permission copy for the case that really is one', () => {
    const view = describeRuntimeError({ code: 'provider.interaction_denied', message: 'denied', retryable: true })
    expect(view.title).toBe('Antigravity needed permission it could not ask for')
  })
})
