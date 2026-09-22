// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WorkSession } from '../../src/renderer/app/components/WorkSession'
import { ProviderLogoSprite } from '../../src/renderer/app/components/ProviderLogo'
import { runModelId } from '../../src/renderer/app/lib/agentIdentity'
import type { Conversation, Message, ModelOption, Run } from '../../src/shared/domain'

const MODELS: ModelOption[] = [
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', supportedReasoningEfforts: ['low', 'medium', 'high'] },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' }
]

const CONVERSATION: Conversation = {
  id: 'conversation_1',
  projectId: 'project_1',
  title: 'Fix login',
  providerId: 'antigravity',
  nativeConversationId: null,
  status: 'idle',
  transport: 'structured',
  // The session has since been switched to Claude.
  model: 'claude-opus-4-6',
  permissionMode: 'ask',
  reasoningEffort: null,
  workingDirectory: null,
  createdAt: 'now',
  updatedAt: 'now'
}

function run(id: string, metadata: Record<string, unknown>): Run {
  return {
    id,
    projectId: 'project_1',
    conversationId: 'conversation_1',
    providerId: 'antigravity',
    state: 'completed',
    startedAt: 'now',
    endedAt: 'now',
    cancellationRequestedAt: null,
    nativeRunId: null,
    error: null,
    metadata
  }
}

function message(id: string, role: 'user' | 'assistant', content: string, runId: string | null, sequence: number): Message {
  return {
    id,
    projectId: 'project_1',
    conversationId: 'conversation_1',
    runId,
    role,
    content,
    status: 'completed',
    createdAt: '2026-09-22T10:00:00.000Z',
    updatedAt: '2026-09-22T10:00:00.000Z',
    sequence
  }
}

function renderSession(runs: Run[]) {
  return render(
    <>
      <ProviderLogoSprite />
      <WorkSession
        project={null}
        conversation={CONVERSATION}
        messages={[message('u1', 'user', 'Fix it', null, 1), message('a1', 'assistant', 'Fixed.', 'run_1', 2)]}
        runs={runs}
        projectFiles={[]}
        thumbnails={{}}
        activeRunId={null}
        streamText=""
        activityByRun={{}}
        // What the session is set to NOW.
        identity={{ provider: 'anthropic', name: 'Claude Opus 4.6' }}
        models={MODELS}
        stopping={false}
        pendingInteraction={null}
        unavailableInteraction={null}
        staleInteraction={false}
        respondingInteractionId={null}
        resolvedRecords={[]}
        onRespond={vi.fn()}
      />
    </>
  )
}

describe('the model a past turn is attributed to', () => {
  it('reads the model the run actually recorded', () => {
    expect(runModelId({ model: 'gemini-3.8-flash' })).toBe('gemini-3.8-flash')
  })

  it('reports no model for a run written before Orbit recorded one', () => {
    expect(runModelId({ attachmentFileIds: [] })).toBeNull()
    expect(runModelId(undefined)).toBeNull()
    expect(runModelId({ model: '   ' })).toBeNull()
    expect(runModelId({ model: 42 })).toBeNull()
  })

  it('labels a past turn with the model that answered it, not the session’s current one', () => {
    // THE BUG. The turn ran on Gemini; the session has since been switched
    // to Claude. Every row used to take the session's current selection, so
    // the whole history was silently restamped with a model that never saw
    // it — a false claim about who answered.
    renderSession([run('run_1', { model: 'gemini-3.8-flash' })])

    expect(screen.getByText('3.8 Flash')).toBeInTheDocument()
    expect(screen.queryByText('Claude Opus 4.6')).not.toBeInTheDocument()
  })

  it('falls back to the session’s model for a run that recorded none', () => {
    // A legacy run has nothing better to be labelled with, and the session
    // selection is still the only datum that exists for it.
    renderSession([run('run_1', { attachmentFileIds: [] })])

    expect(screen.getByText('Claude Opus 4.6')).toBeInTheDocument()
  })

  it('keeps the recorded model even when the catalogue no longer lists it', () => {
    // A stale id stays visible as itself rather than reverting to the
    // session's current selection.
    renderSession([run('run_1', { model: 'gemini-2-legacy' })])

    expect(screen.getByText('gemini-2-legacy')).toBeInTheDocument()
  })
})
