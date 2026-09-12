import type { RepositoryAction, RepositoryState } from '@shared/repositoryActions'
import { availableRepositoryActions } from '@shared/repositoryActions'

interface RepositoryActionsProps {
  state: RepositoryState
  /** The user's setting. Off means nothing is drawn at all. */
  enabled: boolean
  /** Nothing can be sent right now — a turn is running, or the composer is
   *  otherwise unavailable. The chips stay visible and become inert rather
   *  than disappearing, so the row does not reflow mid-turn. */
  disabled: boolean
  /** Submits the action's prompt as an ordinary message. The name is
   *  deliberate: this is the same path typing it by hand would take. */
  onSendPrompt: (prompt: string) => void
}

/** Quick actions for a session running inside a git repository.
 *
 *  Every one of these is a PROMPT SHORTCUT. Clicking a chip submits a
 *  natural-language message to the agent exactly as though the user had
 *  typed it — no chip runs git, and none is allowed to. The agent reads the
 *  repository itself, under this session's own permission mode, and reports
 *  what it did. A button that shelled out to git directly would bypass all
 *  of that and could commit or push without the approval the session was
 *  configured to require.
 *
 *  Only actions that can genuinely apply are shown: a commit chip does not
 *  appear on a clean tree, and none of them appear outside a repository.
 *  The row disappears entirely rather than showing a disabled set — an
 *  empty state here is not worth a line of the composer. */
export function RepositoryActions({ state, enabled, disabled, onSendPrompt }: RepositoryActionsProps): JSX.Element | null {
  const actions = availableRepositoryActions(state, enabled)
  if (actions.length === 0) return null

  return (
    <div className="repo-actions" role="group" aria-label="Repository actions">
      {state.branch ? (
        <span className="repo-branch" title={`On branch ${state.branch}`}>
          <BranchGlyph />
          <span className="repo-branch-name">{state.branch}</span>
        </span>
      ) : null}
      {actions.map((action) => (
        <RepositoryActionChip key={action.id} action={action} disabled={disabled} onSendPrompt={onSendPrompt} />
      ))}
    </div>
  )
}

function RepositoryActionChip({
  action,
  disabled,
  onSendPrompt
}: {
  action: RepositoryAction
  disabled: boolean
  onSendPrompt: (prompt: string) => void
}): JSX.Element {
  return (
    <button
      type="button"
      className="repo-action"
      disabled={disabled}
      data-action={action.id}
      // Says what will actually happen, so the chip is never mistaken for a
      // button that performs the operation itself.
      title={`Ask Antigravity: “${action.prompt}”`}
      onClick={() => onSendPrompt(action.prompt)}
    >
      {action.label}
    </button>
  )
}

function BranchGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" focusable="false">
      <circle cx="4.5" cy="3.8" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4.5" cy="12.2" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="11.5" cy="3.8" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.5 5.4v5.2M11.5 5.4v1.2c0 1.6-1.3 2.9-2.9 2.9H6.1" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}
