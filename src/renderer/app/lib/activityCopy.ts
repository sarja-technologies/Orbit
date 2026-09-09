// Turns the facts an activity event carries into the one line a person
// reads while Antigravity works. A presentation layer only — exactly like
// interactionCopy.ts and errorCopy.ts: it never invents an activity, and
// it never replaces a real command with a description of one.
//
// The rule this file exists to enforce: "Antigravity is replying" is not an
// activity. When Antigravity has said what it is doing, that is what the UI
// says. When it genuinely has not, the UI says `Working…` — restrained, and
// honest about knowing nothing more.
import type { ActivityItem } from './activity'

export interface ActivityView {
  /** The line to show. Always non-empty. */
  text: string
  /** A literal shell command, rendered in monospace. Preserved exactly as
   *  Antigravity reported it — never summarized into prose. */
  command: string | null
}

/** The line shown when a turn is in flight and Antigravity has not said
 *  anything about what it is doing. Deliberately vague rather than falsely
 *  specific. */
export const FALLBACK_ACTIVITY = 'Working…'

export function fallbackActivity(): ActivityView {
  return { text: FALLBACK_ACTIVITY, command: null }
}

/** The last path segment, which is what a reader recognizes. The full path
 *  stays available as the element's title. */
export function shortenPath(path: string): string {
  const cleaned = path.replace(/[/\\]+$/, '')
  const segments = cleaned.split(/[/\\]/)
  return segments[segments.length - 1] || cleaned
}

export function describeActivity(item: ActivityItem | null | undefined): ActivityView {
  if (!item) return fallbackActivity()

  // A command is the most specific thing Antigravity can report, so it wins
  // over the step's kind — and it is passed through untouched.
  if (item.command) {
    return { text: item.status === 'failed' ? 'Command failed' : 'Running', command: item.command }
  }

  const target = item.target ? shortenPath(item.target) : null
  switch (item.kind) {
    case 'thinking':
      return { text: 'Thinking', command: null }
    case 'reading':
      return { text: target ? `Reading ${target}` : 'Reading files', command: null }
    case 'listing':
      return { text: target ? `Inspecting ${target}` : 'Inspecting the project', command: null }
    case 'searching':
      return { text: item.target ? `Searching project for “${item.target}”` : 'Searching project', command: null }
    case 'editing':
      return { text: target ? `Editing ${target}` : 'Editing files', command: null }
    case 'running':
      return { text: 'Running a command', command: null }
    case 'browsing':
      return { text: item.target ? `Browsing ${item.target}` : 'Using the browser', command: null }
    case 'waiting':
      return { text: 'Waiting for approval', command: null }
    case 'working':
      // agy's own word for what it is doing right now, e.g. "Verifying
      // Requirements Thoroughly". Shown as it was written.
      return { text: item.label.trim() || FALLBACK_ACTIVITY, command: null }
    case 'tool':
      return { text: target ? `Using ${item.label} on ${target}` : `Using ${item.label}`, command: null }
    default:
      break
  }

  // No kind at all: the provider named a tool and nothing else. Say that
  // much rather than more.
  const label = item.label.trim()
  if (!label) return fallbackActivity()
  return { text: target ? `Using ${label} on ${target}` : `Using ${label}`, command: null }
}
