import type { ConversationTransport } from '@shared/domain'

/** How Antigravity is allowed to ask for permission in a session.
 *
 *  These are the two states Orbit genuinely has, and they are the two
 *  transports — nothing else in the runtime carries an approval policy. agy
 *  1.1.27 exposes no unrestricted / auto-approve / skip-permissions flag at
 *  all, so Orbit does not offer one: a permission mode the runtime cannot
 *  honour would be a lie told in a very reassuring place.
 *
 *  `tone: 'caution'` exists and is styled, but no real mode uses it today.
 *  It is the slot an unrestricted mode would land in if agy ever ships one,
 *  so that mode arrives with its warning treatment already built rather than
 *  being bolted on next to a green tick. */
export interface PermissionMode {
  id: ConversationTransport
  /** The composer pill. Two words, answering "can it ask me?". */
  label: string
  /** The popover row's own heading. */
  title: string
  /** What actually happens in this mode. */
  description: string
  /** The real internal identifier, shown as a detail line rather than as
   *  the control's own name — the same way a technical flag would be. */
  technical: string
  tone: 'neutral' | 'caution'
}

export const PERMISSION_MODES: Readonly<Record<ConversationTransport, PermissionMode>> = {
  structured: {
    id: 'structured',
    label: 'Can’t ask',
    title: 'Can’t ask',
    description:
      'Antigravity has no way to reach you while a turn is running. Anything that needs your approval is skipped, and Orbit tells you it was.',
    technical: 'transport: structured',
    tone: 'neutral'
  },
  pty: {
    id: 'pty',
    label: 'Ask first',
    title: 'Ask first',
    description: 'Antigravity pauses and asks you here before it runs a command or trusts a folder. You approve or decline in the conversation.',
    technical: 'transport: pty',
    tone: 'neutral'
  }
}

/** Highest-capability last, which is also the order the popover offers them
 *  in: the mode you are moving *to* sits below the one you are on. */
export const PERMISSION_MODE_ORDER: readonly ConversationTransport[] = ['structured', 'pty']

export function permissionModeFor(transport: ConversationTransport): PermissionMode {
  return PERMISSION_MODES[transport]
}

/** Whether the runtime will actually accept this change.
 *
 *  Escalation to `pty` is real and supported. The reverse is refused by
 *  OrbitRuntime.setConversationTransport by design — a live interactive
 *  session cannot be un-started — so the UI must present that as settled
 *  rather than offering a switch that silently does nothing. */
export function canSwitchTo(current: ConversationTransport, target: ConversationTransport): boolean {
  if (current === target) return false
  return !(current === 'pty' && target === 'structured')
}

/** Why a mode cannot be chosen, for the disabled row's own note. Null when
 *  it can be. */
export function switchBlockedReason(current: ConversationTransport, target: ConversationTransport): string | null {
  if (current === target) return null
  if (current === 'pty' && target === 'structured') return 'A session that can ask you stays that way.'
  return null
}
