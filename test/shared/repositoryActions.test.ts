import { describe, expect, it } from 'vitest'
import {
  NO_REPOSITORY,
  REPOSITORY_ACTIONS,
  availableRepositoryActions,
  repositoryActionById,
  type RepositoryState
} from '../../src/shared/repositoryActions'

function state(overrides: Partial<RepositoryState> = {}): RepositoryState {
  return { isRepository: true, branch: 'main', hasChanges: false, hasUpstream: true, ahead: 0, ...overrides }
}

const ids = (actions: readonly { id: string }[]): string[] => actions.map((action) => action.id)

describe('repository actions are prompts, never git', () => {
  it('carries words and nothing executable', () => {
    for (const action of REPOSITORY_ACTIONS) {
      expect(action.prompt.length).toBeGreaterThan(40)
      // Nothing here may look like a command to run. The agent is the only
      // thing that touches the repository, under the session's own
      // permission mode.
      expect(action).not.toHaveProperty('command')
      expect(action).not.toHaveProperty('args')
      expect(action).not.toHaveProperty('run')
    }
  })

  it('tells the agent to commit without pushing', () => {
    // An agent told only "commit" will often push as well.
    const commit = repositoryActionById('commit')!
    expect(commit.prompt).toMatch(/do not push unless I ask/i)
  })

  it('tells the review action to change nothing', () => {
    expect(repositoryActionById('review-diff')!.prompt).toMatch(/do not commit, push, or change any files/i)
  })

  it('has the PR action inspect state, push if needed, and respect permissions', () => {
    const prompt = repositoryActionById('create-pr')!.prompt
    expect(prompt).toMatch(/branch/i)
    expect(prompt).toMatch(/push/i)
    expect(prompt).toMatch(/permission/i)
  })

  it('has the push action handle a branch with no upstream', () => {
    expect(repositoryActionById('push')!.prompt).toMatch(/no upstream/i)
  })
})

describe('only actions that can apply are offered', () => {
  it('shows nothing outside a repository', () => {
    expect(availableRepositoryActions(NO_REPOSITORY, true)).toEqual([])
  })

  it('does not offer a commit on a clean tree', () => {
    expect(ids(availableRepositoryActions(state({ hasChanges: false }), true))).not.toContain('commit')
  })

  it('offers a commit once there is uncommitted work', () => {
    expect(ids(availableRepositoryActions(state({ hasChanges: true }), true))).toContain('commit')
  })

  it('does not offer a push when the branch is level with its upstream', () => {
    expect(ids(availableRepositoryActions(state({ ahead: 0, hasUpstream: true }), true))).not.toContain('push')
  })

  it('offers a push when there are commits to push', () => {
    expect(ids(availableRepositoryActions(state({ ahead: 2 }), true))).toContain('push')
  })

  it('offers a push for a branch that has no upstream yet', () => {
    expect(ids(availableRepositoryActions(state({ hasUpstream: false, ahead: 0 }), true))).toContain('push')
  })

  it('does not offer push or PR on a detached HEAD', () => {
    const offered = ids(availableRepositoryActions(state({ branch: null, hasUpstream: false }), true))
    expect(offered).not.toContain('push')
    expect(offered).not.toContain('create-pr')
  })

  it('always offers a review inside a repository', () => {
    expect(ids(availableRepositoryActions(state(), true))).toContain('review-diff')
  })

  it('keeps a stable order', () => {
    const offered = ids(availableRepositoryActions(state({ hasChanges: true, ahead: 1 }), true))
    expect(offered).toEqual(['review-diff', 'commit', 'push', 'create-pr'])
  })
})

describe('the user setting wins over everything', () => {
  it('shows nothing at all when the setting is off', () => {
    expect(availableRepositoryActions(state({ hasChanges: true, ahead: 3 }), false)).toEqual([])
  })

  it('shows nothing when off even outside a repository', () => {
    expect(availableRepositoryActions(NO_REPOSITORY, false)).toEqual([])
  })
})
