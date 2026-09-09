import type { ContextTab } from './ContextPanel'

interface WorkspaceRailProps {
  tab: ContextTab | null
  fileCount: number
  artifactCount: number
  onSelect: (tab: ContextTab) => void
}

/** The drawer's controls live on the edge the drawer comes out of. Putting
 *  them in the bottom-left — where they used to be — made the user aim at
 *  one side of the window to open something on the other. Clicking the
 *  active one closes the drawer again. */
export function WorkspaceRail({ tab, fileCount, artifactCount, onSelect }: WorkspaceRailProps): JSX.Element {
  return (
    <div className="workspace-rail" role="tablist" aria-orientation="vertical" aria-label="Workspace panels">
      <RailButton
        label="Files"
        count={fileCount}
        active={tab === 'files'}
        onClick={() => onSelect('files')}
        glyph={<FileGlyph />}
      />
      <RailButton
        label="Artifacts"
        count={artifactCount}
        active={tab === 'artifacts'}
        onClick={() => onSelect('artifacts')}
        glyph={<ArtifactGlyph />}
      />
    </div>
  )
}

function RailButton({
  label,
  count,
  active,
  onClick,
  glyph
}: {
  label: string
  count: number
  active: boolean
  onClick: () => void
  glyph: JSX.Element
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-label={label}
      title={active ? `Close ${label}` : label}
      className={active ? 'rail-button active' : 'rail-button'}
      onClick={onClick}
    >
      {glyph}
      {/* The label runs down the rail rather than being an icon-only mystery,
          and the count only appears when there is something to count. */}
      <span className="rail-label">{label}</span>
      {count > 0 ? <span className="rail-count">{count}</span> : null}
    </button>
  )
}

function FileGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M4 2.5h4l3 3v8H4z" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinejoin="round" />
      <path d="M8 2.5v3h3" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinejoin="round" />
    </svg>
  )
}

function ArtifactGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <rect x="2.2" y="2.2" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.3" fill="none" />
      <rect x="8.8" y="2.2" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.3" fill="none" />
      <rect x="2.2" y="8.8" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.3" fill="none" />
      <rect x="8.8" y="8.8" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.3" fill="none" />
    </svg>
  )
}
