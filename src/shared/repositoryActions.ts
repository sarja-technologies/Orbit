// Repository-aware quick actions.
//
// These are PROMPT SHORTCUTS. Clicking one submits a natural-language
// message to the active session exactly as though the user had typed it —
// nothing here runs git, and nothing here is allowed to. That is the whole
// design: the agent already knows how to read a repository, it already
// operates under the session's permission mode, and it already reports what
// it did. A button that shelled out to git directly would bypass all three
// and would be able to commit or push without the approval the session was
// configured to require.
//
// So the only thing an action carries is words. Availability is the one
// piece of real repository state consulted, and only to avoid offering
// something that cannot apply — never to decide what actually happens.

/** What Orbit knows about the folder a session runs in. Every field is read
 *  from git itself; nothing is inferred from a path or a name. */
export interface RepositoryState {
  /** False for a folder that is not in a work tree at all — no actions. */
  isRepository: boolean
  /** The checked-out branch, or null when HEAD is detached or unreadable. */
  branch: string | null
  /** Uncommitted work: modified, staged, or untracked. */
  hasChanges: boolean
  /** Whether the branch has an upstream configured at all. */
  hasUpstream: boolean
  /** Commits on this branch that the upstream does not have. 0 when there
   *  is no upstream to compare against — "nothing to push" and "nowhere to
   *  push to" are different states and are kept apart. */
  ahead: number
}

export const NO_REPOSITORY: RepositoryState = {
  isRepository: false,
  branch: null,
  hasChanges: false,
  hasUpstream: false,
  ahead: 0
}

export type RepositoryActionId = 'review-diff' | 'commit' | 'push' | 'create-pr'

export interface RepositoryAction {
  id: RepositoryActionId
  /** The chip's text. Short enough to sit in the composer without becoming
   *  a toolbar. */
  label: string
  /** The message actually sent. Written as a person would write it, and
   *  deliberately explicit about what NOT to do — an agent told only
   *  "commit" will often push as well. */
  prompt: string
  /** Whether this action can apply to the repository as it stands right
   *  now. A prominent "Commit changes" on a clean tree is noise. */
  isAvailable: (state: RepositoryState) => boolean
}

export const REPOSITORY_ACTIONS: readonly RepositoryAction[] = [
  {
    id: 'review-diff',
    label: 'Review diff',
    prompt:
      'Review the current state of this git repository. Run git status and git diff (including staged changes), then walk me through what has changed and why, calling out anything that looks unintended, incomplete, or risky. Do not commit, push, or change any files — this is a review only.',
    // Always worth offering inside a repository: reviewing committed work
    // is as legitimate as reviewing uncommitted work.
    isAvailable: (state) => state.isRepository
  },
  {
    id: 'commit',
    label: 'Commit changes',
    prompt:
      'Review the current git status and diff, make sure the changes are coherent, then create an appropriate commit for the current work. Do not push unless I ask.',
    isAvailable: (state) => state.isRepository && state.hasChanges
  },
  {
    id: 'push',
    label: 'Push',
    prompt:
      'Check the current branch and its upstream, then push the commits on this branch. If the branch has no upstream yet, set one up against the default remote as part of pushing. Tell me what you pushed and where. Do not create a pull request unless I ask.',
    // Something to push, or nowhere to push it yet — both are real reasons
    // to offer this. A clean, fully-pushed branch is not.
    isAvailable: (state) => state.isRepository && (state.ahead > 0 || (!state.hasUpstream && state.branch !== null))
  },
  {
    id: 'create-pr',
    label: 'Create PR',
    prompt:
      'Inspect the current branch, its git status and its commits relative to the default branch. If there is uncommitted work, tell me before doing anything else. Push the branch if it needs pushing, then open a pull request with a title and description that describe the actual change. Respect the permission settings for this session — ask before anything you are not certain about.',
    isAvailable: (state) => state.isRepository && state.branch !== null
  }
]

/** The actions to show for a repository, in a stable order.
 *
 *  `enabled` is the user's own setting: off means no chips at all, which is
 *  checked here so no caller can forget it. A folder that is not a
 *  repository yields nothing either way. */
export function availableRepositoryActions(
  state: RepositoryState,
  enabled: boolean
): readonly RepositoryAction[] {
  if (!enabled || !state.isRepository) return []
  return REPOSITORY_ACTIONS.filter((action) => action.isAvailable(state))
}

export function repositoryActionById(id: RepositoryActionId): RepositoryAction | null {
  return REPOSITORY_ACTIONS.find((action) => action.id === id) ?? null
}
