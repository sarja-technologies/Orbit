/** The new-session state: an invitation, the workspace it applies to, and a
 *  few lightweight starting points that read as suggestions rather than
 *  product features. Disappears the moment the session has content. */
export interface Starter {
  id: string
  label: string
  prompt: string
}

/** Task-shaped rather than feature-shaped, and phrased as the user's own
 *  words so the filled composer reads naturally and is worth editing. */
export const STARTERS: readonly Starter[] = [
  { id: 'explore', label: 'Explore this project', prompt: 'Give me an overview of how this project is structured, and point out anything surprising.' },
  { id: 'build', label: 'Build or change something', prompt: 'I want to change ' },
  { id: 'fix', label: 'Fix an issue', prompt: "Something isn't working: " },
  { id: 'review', label: 'Review my work', prompt: 'Review my recent changes and tell me what you would fix before I ship this.' }
]

export function EmptySession({ projectName, onPick }: { projectName: string | null; onPick: (starter: Starter) => void }): JSX.Element {
  return (
    <div className="empty-session">
      <div className="empty-inner">
        <h2 className="empty-title">What should we work on?</h2>
        {projectName ? (
          <p className="empty-sub">
            Working in <span className="empty-project">{projectName}</span>
          </p>
        ) : null}
        <div className="starters">
          {STARTERS.map((starter) => (
            <button key={starter.id} type="button" className={`starter starter-${starter.id}`} onClick={() => onPick(starter)}>
              <StarterGlyph id={starter.id} />
              <span>{starter.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Sits under the composer in a new session only. Every line is a shortcut
 *  Orbit genuinely implements, so the empty state teaches the app instead of
 *  decorating it — and the pair of blocks reads as one composed unit rather
 *  than a lone box in a large canvas. */
export function ComposerHints(): JSX.Element {
  return (
    <p className="composer-hints">
      <span>
        <kbd>Enter</kbd> to send
      </span>
      <span>
        <kbd>Shift</kbd>
        <kbd>Enter</kbd> for a new line
      </span>
      <span>Drop files anywhere to attach</span>
    </p>
  )
}

/** Small, literal icons — a magnifier for exploring, a pencil for building.
 *  They aid recognition at a glance; nothing decorative. */
function StarterGlyph({ id }: { id: string }): JSX.Element {
  const common = { viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': true, focusable: 'false' as const }
  if (id === 'explore') {
    return (
      <svg {...common}>
        <circle cx="7" cy="7" r="4.2" stroke="currentColor" strokeWidth="1.4" fill="none" />
        <path d="M10.2 10.2L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    )
  }
  if (id === 'build') {
    return (
      <svg {...common}>
        <path d="M10.5 2.5l3 3L6 13H3v-3z" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinejoin="round" />
      </svg>
    )
  }
  if (id === 'fix') {
    return (
      <svg {...common}>
        <path d="M8 2.2v3M8 10.8v3M2.2 8h3M10.8 8h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <circle cx="8" cy="8" r="2.4" stroke="currentColor" strokeWidth="1.3" fill="none" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <path d="M2.5 8.5l3.2 3.2L13.5 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
