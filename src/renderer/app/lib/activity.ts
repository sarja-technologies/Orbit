// Turns the raw stream of `tool.activity` events into something a person
// can actually read: one live line while work happens, then a single
// collapsed summary once the turn settles. Deliberately lossy by design —
// the goal is comprehension, not a telemetry feed.
import type { ToolActivityEvent } from '@shared/runtime-events'

export interface ActivityItem {
  /** Provider step id when available, else the label — used to update in place. */
  key: string
  label: string
  status: ToolActivityEvent['status']
  startedAt: number
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
  if (index === -1) {
    return { items: [...state.items, { key, label: event.label, status: event.status, startedAt: now }] }
  }
  const items = [...state.items]
  const existing = items[index]!
  items[index] = { ...existing, label: event.label, status: event.status }
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

/** e.g. "Ran 3 commands, edited 2 files". Returns null when there is
 *  nothing worth summarizing, so a plain answer stays uncluttered. */
export function summarizeActivity(state: ActivityState): string | null {
  if (state.items.length === 0) return null
  let commands = 0
  let edits = 0
  let reads = 0
  for (const item of state.items) {
    if (COMMAND_TOOLS.test(item.label)) commands++
    else if (EDIT_TOOLS.test(item.label)) edits++
    else if (READ_TOOLS.test(item.label)) reads++
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
  const seconds = Math.floor((now - startedAt) / 1000)
  if (seconds < 5) return null
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
