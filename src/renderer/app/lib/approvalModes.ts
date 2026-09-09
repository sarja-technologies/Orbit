import type { ConversationTransport } from '@shared/domain'

/** Whether Antigravity can stop and ask you before it acts.
 *
 *  Deliberately called *approvals*, not permissions. Orbit has no
 *  permission-policy system — no allow-list, no per-tool rules, nothing that
 *  grants or withholds a capability. What it actually has is two transports,
 *  one of which can present an approval prompt mid-turn and one of which
 *  cannot. Calling that "permissions" promised a policy engine that does not
 *  exist; calling it approvals describes what the user will actually
 *  experience.
 *
 *  There is no auto-approve, no skip-permissions, and no
 *  `--dangerously-skip-permissions` equivalent anywhere in agy 1.1.27, so
 *  Orbit offers none. `tone: 'caution'` exists and is styled but no real mode
 *  uses it — it is the slot an unrestricted mode would land in if one ever
 *  ships, so that mode arrives already marked rather than looking like every
 *  other setting. */
export interface ApprovalMode {
  id: ConversationTransport
  /** The composer pill. */
  label: string
  /** The popover row's own heading. */
  title: string
  /** What actually happens in this mode. */
  description: string
  /** The real internal identifier. Secondary detail inside the popover —
   *  never the control's own name. */
  technical: string
  tone: 'neutral' | 'caution'
}

export const APPROVAL_MODES: Readonly<Record<ConversationTransport, ApprovalMode>> = {
  structured: {
    id: 'structured',
    label: 'No approval prompts',
    title: 'No approval prompts',
    description:
      'Antigravity has no way to reach you while a turn is running. Anything that would need your approval is skipped, and Orbit tells you it was.',
    technical: 'transport: structured',
    tone: 'neutral'
  },
  pty: {
    id: 'pty',
    label: 'Ask when needed',
    title: 'Ask when needed',
    description: 'Antigravity pauses and asks you here before it runs a command or trusts a folder. You approve or decline in the conversation.',
    technical: 'transport: pty',
    tone: 'neutral'
  }
}

/** The order the popover offers them in: the mode you can move *to* sits
 *  below the one you are on. */
export const APPROVAL_MODE_ORDER: readonly ConversationTransport[] = ['structured', 'pty']

export function approvalModeFor(transport: ConversationTransport): ApprovalMode {
  return APPROVAL_MODES[transport]
}

/** Whether the runtime will actually accept this change.
 *
 *  Escalation to `pty` is real and supported. The reverse is refused by
 *  OrbitRuntime.setConversationTransport by design — a live interactive
 *  session cannot be un-started — so the UI presents that as settled rather
 *  than offering a switch that would silently do nothing. */
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
