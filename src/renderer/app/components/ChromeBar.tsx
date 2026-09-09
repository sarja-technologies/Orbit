import type { Project, ProviderStatus } from '@shared/domain'
import { describeProviderProblem } from '../lib/errorCopy'

interface WorkspaceHeaderProps {
  activeProject: Project | null
  sessionTitle: string | null
  /** The folder this session actually runs in — the single most useful
   *  thing to be able to check without opening anything. */
  workingPath: string | null
  live: boolean
}

/** The header belongs to the workspace: where you are, and where that runs.
 *  It carries no permanent provider status — a healthy provider is the
 *  normal case and does not need a line of chrome restating it. Real
 *  problems surface in ProviderBanner instead. */
export function ChromeBar({ activeProject, sessionTitle, workingPath, live }: WorkspaceHeaderProps): JSX.Element {
  return (
    <header className="chrome">
      <div className="chrome-breadcrumb">
        <span className="chrome-project">{activeProject?.name ?? 'No project'}</span>
        {sessionTitle ? (
          <>
            <span className="chrome-sep" aria-hidden="true">
              /
            </span>
            <span className="chrome-session">{sessionTitle}</span>
          </>
        ) : null}
        {live ? (
          <span className="live-badge" title="This session can ask for approval and receive images directly.">
            Live
          </span>
        ) : null}
      </div>

      {workingPath ? (
        // Two elements on purpose: the outer box is RTL so the ellipsis lands
        // at the START of a long path (the leaf identifies it), while the
        // inner span stays LTR so bidi cannot move the leading slash to the
        // far end. One element cannot do both.
        <span className="chrome-path" title={workingPath}>
          <span className="path-text">{workingPath}</span>
        </span>
      ) : null}
    </header>
  )
}

interface ProviderBannerProps {
  providerStatus: ProviderStatus | null
}

/** Only rendered for genuinely actionable problems — never for a healthy
 *  or still-starting provider. */
export function ProviderBanner({ providerStatus }: ProviderBannerProps): JSX.Element | null {
  const problem = providerStatus ? describeProviderProblem(providerStatus.state, providerStatus.message) : null
  if (!problem) return null
  return (
    <div className="provider-banner" role="status">
      <span>{problem.title}</span>
      {providerStatus?.message ? <span className="provider-banner-detail">{providerStatus.message}</span> : null}
    </div>
  )
}
