import { useRef } from 'react'
import type { Conversation, ID, Project } from '@shared/domain'
import { describeWorkingContext, workingContext } from '../lib/projectContext'
import { useDismiss } from '../lib/useDismiss'
import { ComposerControlButton, ComposerPopover, FolderGlyph, PopoverTitle, useComposerControl } from './ComposerControl'

interface ProjectControlProps {
  project: Project | null
  conversation: Conversation | null
  projects: readonly Project[]
  disabled: boolean
  onSelectProject: (projectId: ID) => void
  /** Opens the OS folder picker and repoints the project at what comes
   *  back. Owned by App because it is a real backend write, not a menu. */
  onChangeFolder: () => void
}

const CONTROL_ID = 'project'

/** The working project, as a first-class composer control.
 *
 *  Orbit's whole premise is that an agent is operating on a specific folder,
 *  and until now the only place that said so was a truncated path in the
 *  window header. It belongs next to Model and Permissions: the three
 *  things that decide what the next message will actually do.
 *
 *  The name is the control; the absolute path is detail, and stays in the
 *  popover where it can be read in full instead of being ellipsised into
 *  something unidentifiable. */
export function ProjectControl({
  project,
  conversation,
  projects,
  disabled,
  onSelectProject,
  onChangeFolder
}: ProjectControlProps): JSX.Element {
  const { open, setOpen, toggle } = useComposerControl(CONTROL_ID)
  const wrapperRef = useRef<HTMLDivElement>(null)
  useDismiss(wrapperRef, open, () => setOpen(false))

  const context = workingContext(project, conversation)
  const name = project?.name ?? 'No project'
  const others = projects.filter((candidate) => candidate.id !== project?.id)

  return (
    <div className="composer-control" ref={wrapperRef}>
      <ComposerControlButton
        name="Project"
        icon={<FolderGlyph />}
        label={name}
        ariaLabel={`Project: ${name}`}
        title={context.path ?? 'Orbit-managed workspace'}
        open={open}
        disabled={disabled || !project}
        onClick={toggle}
      />

      {open && project ? (
        <ComposerPopover label="Project" width={340}>
          <div className="project-popover">
            <header className="project-popover-head">
              <span className="project-popover-name">{project.name}</span>
              <span className="project-popover-role">Working project</span>
            </header>

            {/* The full path, selectable and unwrapped-but-scrollable: a
                folder you cannot read all of is a folder you cannot
                verify. */}
            <div className="project-popover-path">
              {context.path ? (
                <code className="project-path-value" title={context.path}>
                  {context.path}
                </code>
              ) : (
                <span className="project-path-managed">Orbit-managed workspace</span>
              )}
              <p className="project-path-note">{describeWorkingContext(context)}</p>
            </div>

            <button type="button" className="project-popover-action" onClick={onChangeFolder}>
              <FolderGlyph />
              <span>Change project folder…</span>
            </button>

            {others.length > 0 ? (
              <section className="project-switch">
                <PopoverTitle>Switch project</PopoverTitle>
                <div className="project-switch-list">
                  {others.map((candidate) => (
                    <button
                      key={candidate.id}
                      type="button"
                      className="project-switch-row"
                      onClick={() => {
                        setOpen(false)
                        onSelectProject(candidate.id)
                      }}
                    >
                      <FolderGlyph />
                      <span className="project-switch-name">{candidate.name}</span>
                      {candidate.rootPath ? (
                        <span className="project-switch-path" title={candidate.rootPath}>
                          <span className="path-text">{candidate.rootPath}</span>
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        </ComposerPopover>
      ) : null}
    </div>
  )
}
