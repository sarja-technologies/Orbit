import type { ID, ProjectGroup } from '@shared/domain'
import type { StartupSession } from '@shared/contracts'

/** What the resolver needs from the runtime. Narrow on purpose: the whole
 *  point of this module is that "one session per launch" is decided by
 *  plain data, so it can be tested without a database or an Electron app. */
export interface StartupSessionHost {
  listProjectTree(): ProjectGroup[]
  readLastActiveProjectId(): ID | null
  createConversation(projectId: ID): { id: ID }
}

/** Which project the launch session belongs to.
 *
 *  The user's last project if it is still there, otherwise the most
 *  recently touched one — `listProjectTree` is already ordered by recency,
 *  so the fallback is deterministic rather than arbitrary. Null means there
 *  are genuinely no projects yet, which is first run: Orbit must not invent
 *  a project just because it was launched, so the renderer keeps showing
 *  its create-project state and the project's own first session is made by
 *  the normal create-project path. */
export function startupProjectFor(groups: ProjectGroup[], lastActiveProjectId: ID | null): ID | null {
  const remembered = groups.find((group) => group.project.id === lastActiveProjectId)?.project
  return (remembered ?? groups[0]?.project)?.id ?? null
}

/** Orbit opens on a brand-new session, once per application launch.
 *
 *  The invariant lives here, in the main process, rather than in a renderer
 *  effect: this object is constructed once per launch, and `ensure()`
 *  memoizes the very first call. Every later caller — a React remount, a
 *  dev-server HMR reload, a reconnecting preload bridge, a second window —
 *  gets that same session back instead of creating another one. Quitting
 *  Orbit tears the main process down, so the next launch starts a new
 *  resolver and therefore a genuinely new session.
 *
 *  The session itself is nothing special: it is made by the same
 *  `createConversation` the New Session control uses, so it inherits every
 *  new-session default (title, concrete model, reasoning tier, permission
 *  mode, transport, folder inheritance, empty native id) automatically. */
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
    if (!projectId) return null
    return { projectId, conversationId: this.host.createConversation(projectId).id }
  }
}
