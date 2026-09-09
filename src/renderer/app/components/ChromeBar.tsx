import type { Project, ProviderStatus } from '@shared/domain'
import { describeProviderProblem } from '../lib/errorCopy'

interface WorkspaceHeaderProps {
  activeProject: Project | null
  sessionTitle: string | null
  live: boolean
}

/** The header belongs to the workspace: which session you are reading, and
 *  which project it belongs to.
 *
 *  It no longer carries the working folder. That path is the single most
 *  important fact about a turn, and an ellipsised copy of it in a corner was
 *  the wrong place for it — it now lives on the composer's project control,
 *  next to the model and the permission mode it belongs with, in full.
 *
 *  It carries no permanent provider status either — a healthy provider is
 *  the normal case and does not need a line of chrome restating it. Real
 *  problems surface in ProviderBanner instead. */
export function ChromeBar({ activeProject, sessionTitle, live }: WorkspaceHeaderProps): JSX.Element {
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
