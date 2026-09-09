import type { RuntimeEvent, ToolActivityEvent } from '@shared/runtime-events'

export interface RuntimeEventBatch {
  textDeltas: Record<string, string>
  toolActivities: ToolActivityEvent[]
}

type Schedule = (callback: () => void) => number
type Cancel = (handle: number) => void

const emptyBatch = (): RuntimeEventBatch => ({ textDeltas: {}, toolActivities: [] })

export class RuntimeEventBatcher {
  private pending = emptyBatch()
  private scheduled: number | null = null

  constructor(
    private readonly flushBatch: (batch: RuntimeEventBatch) => void,
    private readonly applyImmediate: (event: RuntimeEvent) => void,
    private readonly schedule: Schedule = defaultSchedule,
    private readonly cancel: Cancel = defaultCancel
  ) {}

  push(event: RuntimeEvent): void {
    if (event.type === 'text.delta') {
      this.pending.textDeltas[event.runId] = `${this.pending.textDeltas[event.runId] ?? ''}${event.delta}`
      this.scheduleFlush()
      return
    }

    if (event.type === 'tool.activity') {
      this.pending.toolActivities.push(event)
      this.scheduleFlush()
      return
    }

    this.flush()
    this.applyImmediate(event)
  }

  flush(): void {
    if (this.scheduled !== null) {
      this.cancel(this.scheduled)
      this.scheduled = null
    }
    if (Object.keys(this.pending.textDeltas).length === 0 && this.pending.toolActivities.length === 0) return
    const batch = this.pending
    this.pending = emptyBatch()
    this.flushBatch(batch)
  }

  dispose(): void {
    if (this.scheduled !== null) this.cancel(this.scheduled)
    this.scheduled = null
    this.pending = emptyBatch()
  }

  private scheduleFlush(): void {
    if (this.scheduled !== null) return
    this.scheduled = this.schedule(() => {
      this.scheduled = null
      this.flush()
    })
  }
}

function defaultSchedule(callback: () => void): number {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    return window.requestAnimationFrame(callback)
  }
  return window.setTimeout(callback, 16)
}

function defaultCancel(handle: number): void {
  if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(handle)
    return
  }
  window.clearTimeout(handle)
}
