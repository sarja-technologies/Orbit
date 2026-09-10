// The live activity feed: what the agent is doing right now, and how long
// it has been doing it.
//
// Everything here is a projection of `tool.activity` events the runtime
// actually emitted. Steps are classified by the `kind` the provider read
// off the runtime's own event data — never by matching words in a display
// label, which made a reworded label silently change what a turn was
// reported to have done.
import type { ToolActivityEvent, ToolActivityKind } from '@shared/runtime-events'

export interface ActivityItem {
  /** Provider step id when available, else the label — used to update in place. */
  key: string
  label: string
  status: ToolActivityEvent['status']
  kind: ToolActivityKind
  startedAt: number
  /** When the step stopped running. Null while it is still going. A step
   *  with an `endedAt` never counts up again, whatever later arrives. */
  endedAt: number | null
}

export interface ActivityState {
  items: ActivityItem[]
}

export function emptyActivity(): ActivityState {
  return { items: [] }
}

export function isRunning(item: ActivityItem): boolean {
  return item.status === 'running' && item.endedAt === null
}

/** Updates an existing step in place rather than appending, so a long turn
 *  produces a short ordered list instead of hundreds of rows. */
export function applyActivity(state: ActivityState, event: ToolActivityEvent, now = Date.now()): ActivityState {
  const key = event.providerStepId?.trim() ? `step:${event.providerStepId}` : `label:${event.label}`
  const kind: ToolActivityKind = event.kind ?? 'tool'
  const index = state.items.findIndex((item) => item.key === key)
  if (index === -1) {
    const item: ActivityItem = {
      key,
      label: event.label,
      status: event.status,
      kind,
      startedAt: now,
      endedAt: event.status === 'running' ? null : now
    }
    return { items: [...state.items, item] }
  }
  const items = [...state.items]
  const existing = items[index]!
  items[index] = {
    ...existing,
    label: event.label,
    status: event.status,
    kind,
    // A step that stops running is stamped once. Re-running an already
    // finished step would restart its clock, so the first ending wins.
    endedAt: event.status === 'running' ? existing.endedAt : (existing.endedAt ?? now)
  }
  return { items }
}

/** Closes every step still marked running.
 *
 *  Called when a run reaches any ending — completed, cancelled, failed, or
 *  the transport going away. Without it, the last step of an interrupted
 *  turn stays "running" forever: its timer keeps counting in the summary
 *  and the row claims work is still happening after the run is over. */
export function finalizeActivity(state: ActivityState, now = Date.now()): ActivityState {
  if (!state.items.some(isRunning)) return state
  return {
    items: state.items.map((item) =>
      isRunning(item) ? { ...item, status: 'completed' as const, endedAt: now } : item
    )
  }
}

/** Whether any step is genuinely still in flight. This — not "the run has
 *  an activity state" and not "a label mentions a tool" — is what makes a
 *  turn "working" rather than "replying". */
export function hasRunningStep(state: ActivityState): boolean {
  return state.items.some(isRunning)
}

/** The single line shown while the turn is still running. */
export function currentActivityLine(state: ActivityState): ActivityItem | null {
  for (let i = state.items.length - 1; i >= 0; i--) {
    if (isRunning(state.items[i]!)) return state.items[i]!
  }
  return state.items.length > 0 ? state.items[state.items.length - 1]! : null
}

/** How each kind is counted in the collapsed summary. Kinds with no entry
 *  fall into the generic step count rather than being force-fitted into a
 *  category they do not belong to. */
const SUMMARY_NOUNS: Partial<Record<ToolActivityKind, { one: string; many: string; verb: string }>> = {
  command: { one: 'command', many: 'commands', verb: 'Ran' },
  edit: { one: 'file', many: 'files', verb: 'edited' },
  read: { one: 'file', many: 'files', verb: 'read' },
  search: { one: 'search', many: 'searches', verb: 'searched' },
  list: { one: 'listing', many: 'listings', verb: 'listed' }
}

/** Order the summary reads in, so "Ran 3 commands, edited 2 files" always
 *  comes out the same way round. */
const SUMMARY_ORDER: readonly ToolActivityKind[] = ['command', 'edit', 'read', 'search', 'list']

/** e.g. "Ran 3 commands, edited 2 files". Returns null when there is
 *  nothing worth summarizing, so a plain answer stays uncluttered. */
export function summarizeActivity(state: ActivityState): string | null {
  if (state.items.length === 0) return null
  const counts = new Map<ToolActivityKind, number>()
  for (const item of state.items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1)

  const parts: string[] = []
  for (const kind of SUMMARY_ORDER) {
    const count = counts.get(kind)
    const noun = SUMMARY_NOUNS[kind]
    if (!count || !noun) continue
    const phrase = `${noun.verb} ${count} ${count === 1 ? noun.one : noun.many}`
    // Only the leading clause is capitalized; the rest read as one sentence.
    parts.push(parts.length === 0 ? capitalize(phrase) : lowerFirst(phrase))
  }
  if (parts.length === 0) {
    const total = state.items.length
    return `${total} ${total === 1 ? 'step' : 'steps'}`
  }
  return parts.join(', ')
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1)
}

export function hasFailure(state: ActivityState): boolean {
  return state.items.some((item) => item.status === 'failed')
}

/** How long a step has been running, or ran for.
 *
 *  Shown from the first whole second: a long command that looks frozen is
 *  exactly the case this exists for, and a timer that only appears after
 *  five seconds of silence is five seconds of the app looking stuck. */
export function elapsedLabel(startedAt: number, now: number): string | null {
  const seconds = Math.floor((now - startedAt) / 1000)
  if (seconds < 1) return null
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/** The elapsed label for one item: live against `now` while it runs, frozen
 *  at its own duration once it has ended. A finished step can therefore
 *  never keep counting, however long the row stays on screen. */
export function itemElapsedLabel(item: ActivityItem, now: number): string | null {
  return elapsedLabel(item.startedAt, item.endedAt ?? now)
}

/** Drops activity for runs that are no longer part of what is on screen.
 *
 *  Called after a project loads with that project's own run ids, so
 *  switching sessions or projects cannot leave another run's steps — or its
 *  timers — behind in memory. */
export function pruneActivity(
  byRun: Record<string, ActivityState>,
  keepRunIds: Iterable<string>
): Record<string, ActivityState> {
  const keep = new Set(keepRunIds)
  const kept = Object.keys(byRun).filter((runId) => keep.has(runId))
  if (kept.length === Object.keys(byRun).length) return byRun
  const next: Record<string, ActivityState> = {}
  for (const runId of kept) next[runId] = byRun[runId]!
  return next
}
