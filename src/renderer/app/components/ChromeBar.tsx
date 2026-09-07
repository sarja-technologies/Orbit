import type { ID, Project, ProviderStatus } from '@shared/domain'
import { describeProviderProblem } from '../lib/errorCopy'

interface ChromeBarProps {
  projects: Project[]
  activeProject: Project | null
  providerStatus: ProviderStatus | null
  onSelectProject: (projectId: ID) => void
  onCreateProject: () => void
}

/** One compact bar: identity, active project, provider health. A healthy
 *  provider is a dot and a word — never a permanent banner. */
export function ChromeBar({ projects, activeProject, providerStatus, onSelectProject, onCreateProject }: ChromeBarProps): JSX.Element {
  const problem = providerStatus ? describeProviderProblem(providerStatus.state, providerStatus.message) : null
  const state = providerStatus?.state ?? 'idle'

  return (
    <header className="chrome">
      <div className="chrome-brand">Orbit</div>

      <div className="chrome-project">
        {projects.length > 0 ? (
          <select
            className="project-select"
            aria-label="Active project"
            value={activeProject?.id ?? ''}
            onChange={(event) => onSelectProject(event.target.value)}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        ) : null}
        <button type="button" className="ghost" onClick={onCreateProject}>
          New project
        </button>
      </div>

      <div className="chrome-status" title={providerStatus?.message ?? undefined}>
        <span className={`status-dot status-dot-${state}`} aria-hidden="true" />
        <span className="status-label">Antigravity</span>
        <span className="visually-hidden">{problem ? problem.title : 'Antigravity is ready'}</span>
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
