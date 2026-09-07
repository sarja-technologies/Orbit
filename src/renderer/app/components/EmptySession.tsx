/** The new-session state: a short invitation and a few concrete starting
 *  points, sitting above the composer rather than competing with it. This
 *  replaces what was previously an empty black area with no indication of
 *  what Orbit can do. Disappears the moment a conversation has content. */
export interface Starter {
  id: string
  label: string
  hint: string
  prompt: string
}

/** Deliberately task-shaped rather than feature-shaped, and phrased as the
 *  user's own words so the filled composer reads naturally and is worth
 *  editing before sending. */
export const STARTERS: readonly Starter[] = [
  {
    id: 'build',
    label: 'Build or change something',
    hint: 'Add a feature or edit existing code',
    prompt: 'I want to change '
  },
  {
    id: 'explore',
    label: 'Explore this project',
    hint: 'Understand how the code fits together',
    prompt: 'Give me an overview of how this project is structured, and point out anything surprising.'
  },
  {
    id: 'fix',
    label: 'Fix an issue',
    hint: 'Track down a bug and repair it',
    prompt: "Something isn't working: "
  },
  {
    id: 'review',
    label: 'Review my work',
    hint: 'Check recent changes before shipping',
    prompt: 'Review my recent changes and tell me what you would fix before I ship this.'
  }
]

export function EmptySession({ projectName, onPick }: { projectName: string | null; onPick: (starter: Starter) => void }): JSX.Element {
  return (
    <div className="empty-session">
      <div className="empty-inner">
        <h2 className="empty-title">What should we work on?</h2>
        {projectName ? <p className="empty-sub">Antigravity can read and change files in {projectName}.</p> : null}
        <div className="starters">
          {STARTERS.map((starter) => (
            <button key={starter.id} type="button" className="starter" onClick={() => onPick(starter)}>
              <span className="starter-label">{starter.label}</span>
              <span className="starter-hint">{starter.hint}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
