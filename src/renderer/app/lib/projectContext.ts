import type { Conversation, Project } from '@shared/domain'

/** Where a session's work actually lands, and who decided that.
 *
 *  `managed` is not a missing value: a project with no folder of its own
 *  really does run in an Orbit-managed workspace directory. The renderer is
 *  never told that location (the main process resolves it), so this reports
 *  the fact rather than inventing the path. */
export interface WorkingContext {
  path: string | null
  source: 'session' | 'project' | 'managed'
}

export function workingContext(project: Project | null, conversation: Conversation | null): WorkingContext {
  if (conversation?.workingDirectory) return { path: conversation.workingDirectory, source: 'session' }
  if (project?.rootPath) return { path: project.rootPath, source: 'project' }
  return { path: null, source: 'managed' }
}

/** The last segment of a path — the part that identifies a folder when
 *  there is not room for all of it. Tolerates either separator and a
 *  trailing one, and gives back the whole path when there is no segment to
 *  take (a bare root). */
export function pathLeaf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  const leaf = index === -1 ? trimmed : trimmed.slice(index + 1)
  return leaf.length > 0 ? leaf : path
}

/** The one-line explanation under the folder in the project popover. */
export function describeWorkingContext(context: WorkingContext): string {
  switch (context.source) {
    case 'session':
      return 'This session overrides the project’s folder.'
    case 'project':
      return 'Every session in this project runs here.'
    case 'managed':
      return 'This project has no folder of its own, so it runs in Orbit’s managed workspace.'
  }
}
