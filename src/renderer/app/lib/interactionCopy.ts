// Translates Antigravity's own native prompt text into Orbit product
// language. This is a presentation layer only: it never changes which
// native option a choice maps to, and it never invents meaning it cannot
// verify from the prompt itself. Anything it does not confidently
// recognize falls back to a generic, honest heading plus the untouched
// original prompt behind a disclosure.
import type { InteractionRequiredEvent } from '@shared/runtime-events'

export interface InteractionOptionView {
  /** The native option id — passed back to the provider verbatim. */
  id: string
  /** The native option label, preserved for disclosure/fallback rendering. */
  nativeLabel: string
  label: string
  role: 'approve' | 'deny' | 'remember-session' | 'remember-always' | 'other'
  destructive: boolean
}

export interface InteractionView {
  /** Plain-English question shown as the card heading. */
  title: string
  /** Optional one-line explanation of what is being asked. */
  detail: string | null
  /** A literal command/target, rendered in monospace when present. */
  command: string | null
  /** True when we recognized the prompt shape; false means generic fallback. */
  recognized: boolean
  kind: 'command' | 'trust' | 'headless-denial' | 'generic'
  approve: InteractionOptionView | null
  deny: InteractionOptionView | null
  /** "Also allow future ones like this" style options, offered secondarily. */
  rememberSession: InteractionOptionView | null
  rememberAlways: InteractionOptionView | null
  /** Options we could not classify — always rendered so nothing is lost. */
  other: InteractionOptionView[]
  /** The untouched native prompt, always available behind disclosure. */
  originalPrompt: string
}

// Real captured shape (agy 1.1.27):
//   Requesting permission for:
//      npm run build
//
//   Do you want to proceed?
const REQUEST_LABEL = /^\s*Requesting (?:permission|approval) for:?\s*$/i
const PROCEED_QUESTION = /^\s*Do you want to proceed\?/i
// Real captured workspace-trust shape.
const TRUST_QUESTION = /do you trust (?:the contents of )?(?:this|the) (?:project|folder|directory|workspace)/i

/** Conservative, deliberately narrow: only flags shapes that are
 *  unambiguously destructive. This is a visual caution cue, never a
 *  security boundary — the backend remains the only real gate. */
const DESTRUCTIVE = /\brm\s+-[rf]|\brm\s+-{1,2}recursive|\bgit\s+push\s+.*--force|\bgit\s+reset\s+--hard|\bdrop\s+(?:table|database)\b|\bmkfs\b|\bdd\s+if=/i

export function isDestructiveCommand(command: string | null): boolean {
  return command !== null && DESTRUCTIVE.test(command)
}

/** Pulls the literal command out of a "Requesting permission for:" block —
 *  the lines between that label and the "Do you want to proceed?" question. */
export function extractCommand(prompt: string): string | null {
  const lines = prompt.split('\n')
  const start = lines.findIndex((line) => REQUEST_LABEL.test(line))
  if (start === -1) return null
  const end = lines.findIndex((line, index) => index > start && PROCEED_QUESTION.test(line))
  const body = (end === -1 ? lines.slice(start + 1) : lines.slice(start + 1, end)).map((line) => line.trim()).filter(Boolean)
  return body.length > 0 ? body.join('\n') : null
}

function classifyOption(label: string): InteractionOptionView['role'] {
  const value = label.trim().toLowerCase()
  // Order matters: the "always allow" variants also start with "yes".
  if (/persist|settings\.json|always allow for\b/.test(value)) return 'remember-always'
  if (/always allow/.test(value)) return 'remember-session'
  if (/^y$|^yes\b|^approve\b|^allow\b|^proceed\b|^continue\b|i trust/.test(value)) return 'approve'
  if (/^n$|^no\b|^deny\b|^reject\b|^cancel\b|^exit\b|don't|do not/.test(value)) return 'deny'
  return 'other'
}

function viewFor(option: { id: string; label: string; destructive?: boolean }, command: string | null): InteractionOptionView {
  const role = classifyOption(option.label)
  return {
    id: option.id,
    nativeLabel: option.label,
    label: presentableLabel(option.label, role),
    role,
    // A native destructive hint always wins; otherwise only the deny-side
    // of a destructive command gets any special treatment.
    destructive: option.destructive === true || (role === 'approve' && isDestructiveCommand(command))
  }
}

/** Shortens agy's verbose option wording without changing its meaning. */
function presentableLabel(label: string, role: InteractionOptionView['role']): string {
  switch (role) {
    case 'approve':
      return 'Approve'
    case 'deny':
      return 'Deny'
    case 'remember-session':
      return 'Remember for this session'
    case 'remember-always':
      return 'Always allow (saves to Antigravity settings)'
    default:
      return label.trim()
  }
}

export function describeInteraction(event: InteractionRequiredEvent): InteractionView {
  const originalPrompt = event.prompt
  const options = event.options.map((option) => viewFor(option, extractCommand(originalPrompt)))
  const pick = (role: InteractionOptionView['role']): InteractionOptionView | null => options.find((option) => option.role === role) ?? null

  const base = {
    approve: pick('approve'),
    deny: pick('deny'),
    rememberSession: pick('remember-session'),
    rememberAlways: pick('remember-always'),
    other: options.filter((option) => option.role === 'other'),
    originalPrompt
  }

  // Antigravity already skipped/denied this on its own — there is nothing
  // actionable to present, so say exactly that.
  if (event.sourceEvidence === 'headless-denial' || !event.canRespond) {
    return {
      ...base,
      title: 'Antigravity needed permission it could not ask for',
      detail: 'It skipped an action that required your approval. Send another message to try again — this conversation can now ask you directly.',
      command: null,
      recognized: true,
      kind: 'headless-denial'
    }
  }

  const command = extractCommand(originalPrompt)
  if (command) {
    return { ...base, title: 'Run this command?', detail: null, command, recognized: true, kind: 'command' }
  }

  if (TRUST_QUESTION.test(originalPrompt)) {
    return {
      ...base,
      title: 'Trust this project folder?',
      detail: 'Antigravity needs permission to read, edit, and run files in this project before it can start work.',
      command: null,
      recognized: true,
      kind: 'trust'
    }
  }

  // Unknown shape: never guess. Generic heading, every native option kept
  // exactly as Antigravity supplied it, original prompt available below.
  return {
    ...base,
    title: 'Antigravity needs your approval',
    detail: null,
    command: null,
    recognized: false,
    kind: 'generic',
    // Nothing was confidently classified, so present the native options as-is
    // rather than forcing them into approve/deny slots.
    approve: base.approve,
    deny: base.deny,
    other: options.filter((option) => option.role === 'other')
  }
}

/** One-line record kept in the transcript after an interaction resolves. */
export function describeResolution(outcome: 'approved' | 'denied' | 'answered' | 'cancelled', view: InteractionView): string {
  const subject = view.command ?? (view.kind === 'trust' ? 'this project folder' : null)
  switch (outcome) {
    case 'approved':
      return subject ? `Approved · ${subject}` : 'Approved'
    case 'denied':
      return subject ? `Denied · ${subject}` : 'Denied'
    case 'cancelled':
      return 'Cancelled'
    default:
      return 'Answered'
  }
}
