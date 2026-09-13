import type { Conversation, ID } from '@shared/domain'
import type { StartupSession } from '@shared/contracts'

/** What the resolver needs from the runtime. Narrow on purpose: which
 *  session a launch opens on is decided by plain data, so it can be tested
 *  without a database or an Electron app. */
export interface StartupSessionHost {
  /** The conversation the user was last in, as recorded when they selected
   *  it. May name one that has since been deleted. */
  readLastActiveConversationId(): ID | null
  getConversation(conversationId: ID): Conversation | null
  /** The most recently used conversation of any project, or none. */
  mostRecentConversation(): Conversation | null
  createConversation(projectId: ID | null): { id: ID; projectId?: ID | null }
}

export type StartupSource = 'remembered' | 'most-recent' | 'created'

/** Orbit reopens where the user left off, like any desktop workspace.
 *
 *  1. The conversation they were last in, if it still exists. Its project is
 *     read from the conversation row as it is NOW — a session filed into a
 *     project after it was remembered opens in that project, and a stored
 *     project id is never trusted over the database.
 *  2. Otherwise the most recently used conversation that does exist.
 *  3. Only when there is no conversation at all, a new Unsorted one.
 *
 *  A restart alone never creates a session: that is the user's decision. */
export function resolveStartupSession(host: StartupSessionHost): StartupSession & { source: StartupSource } {
  const rememberedId = host.readLastActiveConversationId()
  const remembered = rememberedId ? host.getConversation(rememberedId) : null
  if (remembered) return { projectId: remembered.projectId, conversationId: remembered.id, source: 'remembered' }

  const recent = host.mostRecentConversation()
  if (recent) return { projectId: recent.projectId, conversationId: recent.id, source: 'most-recent' }

  const created = host.createConversation(null)
  return { projectId: created.projectId ?? null, conversationId: created.id, source: 'created' }
}

export class StartupSessionResolver {
  private pending: Promise<StartupSession | null> | null = null

  constructor(private readonly host: StartupSessionHost) {}

  /** The session this launch opens on. Resolved once per launch and handed
   *  back to every later caller — a renderer remount, an HMR reload or a
   *  reconnecting bridge is not a new launch, and must not re-resolve (which
   *  could otherwise create a session twice on an empty database). */
  async ensure(): Promise<StartupSession | null> {
    // Memoize the promise, not the result: two calls that arrive before the
    // first has resolved must still share one answer.
    this.pending ??= Promise.resolve().then(() => {
      const { projectId, conversationId } = resolveStartupSession(this.host)
      return { projectId, conversationId }
    })
    return this.pending
  }
}
