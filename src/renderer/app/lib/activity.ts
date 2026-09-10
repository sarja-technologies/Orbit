// Turns the raw stream of `tool.activity` events into something a person
// can actually read: one live line while work happens, then a single
// collapsed summary once the turn settles. Deliberately lossy by design —
// the goal is comprehension, not a telemetry feed.
//
// The events themselves carry facts, not prose (see runtime-events.ts):
// what kind of work it is, the exact command, the exact path. Turning
// those into English is activityCopy.ts's job; this file only tracks
// which work is current.
import type { ActivityKind, ToolActivityEvent } from '@shared/runtime-events'

export interface ActivityItem {
  /** Provider step id when available, else the label — used to update in place. */
  key: string
  label: string
  status: ToolActivityEvent['status']
  startedAt: number
  /** Absent when the provider gave no evidence of what kind of work it is. */
  kind?: ActivityKind
  command?: string
  target?: string
  /** Elapsed seconds as the provider itself reported them. Preferred over
   *  the locally measured clock, which only exists because a *running*
   *  step has no reported duration yet. */
  durationSeconds?: number
}

export interface ActivityState {
  items: ActivityItem[]
}

export function emptyActivity(): ActivityState {
  return { items: [] }
}

/** Updates an existing step in place rather than appending, so a long turn
 *  produces a short ordered list instead of hundreds of rows. */
export function applyActivity(state: ActivityState, event: ToolActivityEvent, now = Date.now()): ActivityState {
  const key = event.providerStepId?.trim() ? `step:${event.providerStepId}` : `label:${event.label}`
  const index = state.items.findIndex((item) => item.key === key)
  const facts = {
    label: event.label,
    status: event.status,
    ...(event.kind ? { kind: event.kind } : {}),
    ...(event.command ? { command: event.command } : {}),
    ...(event.target ? { target: event.target } : {}),
    ...(event.durationSeconds !== undefined ? { durationSeconds: event.durationSeconds } : {})
  }
  if (index === -1) {
    return { items: [...state.items, { key, startedAt: now, ...facts }] }
  }
  const items = [...state.items]
  items[index] = { ...items[index]!, ...facts }
  return { items }
}

/** The single line shown while the turn is still running. */
export function currentActivityLine(state: ActivityState): ActivityItem | null {
  for (let i = state.items.length - 1; i >= 0; i--) {
    if (state.items[i]!.status === 'running') return state.items[i]!
  }
  return state.items.length > 0 ? state.items[state.items.length - 1]! : null
}

const COMMAND_TOOLS = /(bash|shell|command|terminal|run|exec)/i
const EDIT_TOOLS = /(write|edit|create|replace|patch|save)/i
const READ_TOOLS = /(read|view|open|search|grep|glob|list|find)/i
/** Which family a finished step counts as in the summary. Uses the kind the
 *  provider reported; the label patterns remain as the fallback for an
 *  event that carried no kind. */
function summaryFamily(item: ActivityItem): 'command' | 'edit' | 'read' | null {
  switch (item.kind) {
    case 'running':
      return 'command'
    case 'editing':
      return 'edit'
    case 'reading':
    case 'searching':
    case 'listing':
      return 'read'
    case 'thinking':
    case 'waiting':
    case 'working':
      return null
    default:
      break
  }
  if (COMMAND_TOOLS.test(item.label)) return 'command'
  if (EDIT_TOOLS.test(item.label)) return 'edit'
  if (READ_TOOLS.test(item.label)) return 'read'
  return null
}

/** e.g. "Ran 3 commands, edited 2 files". Returns null when there is
 *  nothing worth summarizing, so a plain answer stays uncluttered. */
export function summarizeActivity(state: ActivityState): string | null {
  if (state.items.length === 0) return null
  let commands = 0
  let edits = 0
  let reads = 0
  for (const item of state.items) {
    const family = summaryFamily(item)
    if (family === 'command') commands++
    else if (family === 'edit') edits++
    else if (family === 'read') reads++
  }
  const parts: string[] = []
  if (commands > 0) parts.push(`Ran ${commands} ${commands === 1 ? 'command' : 'commands'}`)
  if (edits > 0) parts.push(`edited ${edits} ${edits === 1 ? 'file' : 'files'}`)
  if (reads > 0) parts.push(`read ${reads} ${reads === 1 ? 'file' : 'files'}`)
  if (parts.length === 0) {
    const total = state.items.length
    return `${total} ${total === 1 ? 'step' : 'steps'}`
  }
  return parts.join(', ')
}

export function hasFailure(state: ActivityState): boolean {
  return state.items.some((item) => item.status === 'failed')
}

/** Only surfaced once a step has been running long enough that silence
 *  would otherwise read as a hang. */
export function elapsedLabel(startedAt: number, now: number): string | null {
  return formatSeconds(Math.floor((now - startedAt) / 1000))
}

/** The duration to show for a step, preferring Antigravity's own
 *  measurement over Orbit's clock. Null means "not worth showing yet". */
export function durationLabel(item: ActivityItem, now: number): string | null {
  if (item.durationSeconds !== undefined) return formatSeconds(Math.round(item.durationSeconds))
  if (item.status !== 'running') return null
  return elapsedLabel(item.startedAt, now)
}

function formatSeconds(seconds: number): string | null {
  if (seconds < 5) return null
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
