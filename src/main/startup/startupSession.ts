import type { ID, ProjectGroup } from '@shared/domain'
import type { StartupSession } from '@shared/contracts'

/** What the resolver needs from the runtime. Narrow on purpose: the whole
 *  point of this module is that "one session per launch" is decided by
 *  plain data, so it can be tested without a database or an Electron app. */
export interface StartupSessionHost {
  listProjectTree(): ProjectGroup[]
  readLastActiveProjectId(): ID | null
  createConversation(projectId: ID | null): { id: ID }
}

/** Which project the launch session belongs to.
 *
 *  None. Orbit opens on an Unsorted session — one that belongs to no
 *  project at all — so launching it and typing costs nothing: no project to
 *  pick, no folder to choose. Existing projects and their sessions are
 *  untouched and a click away in the sidebar, and this session can be filed
 *  into one later without being recreated.
 *
 *  Kept as a function rather than inlined because "where does a launch
 *  start" is exactly the sort of decision that should be visible and
 *  testable on its own. */
export function startupProjectFor(_groups: ProjectGroup[], _lastActiveProjectId: ID | null): ID | null {
  return null
}

export class StartupSessionResolver {
  private pending: Promise<StartupSession | null> | null = null

  constructor(private readonly host: StartupSessionHost) {}

  /** The session this launch opens on, creating it on the first call only.
   *  Null on first run, when there is no project to put it in. */
  async ensure(): Promise<StartupSession | null> {
    // Memoize the promise, not the result: two calls that arrive before
    // the first has resolved must still share one session.
    this.pending ??= Promise.resolve(this.create())
    return this.pending
  }

  private create(): StartupSession | null {
    const projectId = startupProjectFor(this.host.listProjectTree(), this.host.readLastActiveProjectId())
    // Unsorted needs no project to exist in, so unlike before there is no
    // first-run case where a launch cannot produce a session.
    return { projectId, conversationId: this.host.createConversation(projectId).id }
  }
}
