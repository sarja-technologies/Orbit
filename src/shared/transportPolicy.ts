import type { ConversationTransport } from './domain'
import type { PermissionMode } from './permissionMode'

export interface TurnTransportInput {
  /** The transport the conversation is on now. */
  current: ConversationTransport
  permissionMode: PermissionMode
  /** Images have to be pasted into a live session; the headless path has no
   *  native attachment mechanism. */
  hasImageAttachment: boolean
}

/** Which transport a turn must run on, decided *before* it is launched.
 *
 *  The one rule that matters: "Ask first" means Orbit can actually ask. The
 *  structured path is headless — agy has no channel there to present an
 *  approval on, so a tool needing permission is refused and reported after
 *  the fact. Discovering that mid-turn is too late: the turn is already
 *  under way, and re-running it could repeat tool side effects that already
 *  happened. So an `ask` session runs on the PTY from the start, where agy
 *  draws its real prompt and Orbit can answer it.
 *
 *  `skip` launches with --dangerously-skip-permissions and is never asked
 *  anything, so it keeps the cheaper structured path.
 *
 *  PTY ownership is deliberately sticky: a conversation that has a live
 *  session stays on it, which is why `current === 'pty'` always wins. */
export function transportForTurn({ current, permissionMode, hasImageAttachment }: TurnTransportInput): ConversationTransport {
  if (current === 'pty') return 'pty'
  if (hasImageAttachment) return 'pty'
  return permissionMode === 'ask' ? 'pty' : 'structured'
}
