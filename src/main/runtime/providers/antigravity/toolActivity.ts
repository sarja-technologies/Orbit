// Turns one `step_update` of `step_type: 'tool'` into the line Orbit shows
// while that step runs.
//
// Everything here is a projection of data agy actually sent: the tool's own
// name and the parameters it reported in `tool_info.parameters`. Nothing is
// inferred about what the model is thinking, and nothing is filled in when
// agy reported nothing — a tool with no usable parameter degrades to its
// own name rather than to an invented sentence.
//
// The tool names and parameter keys below were captured from a live
// `agy 1.1.27 --print --output-format stream-json` session (raw capture and
// method in docs/antigravity-transports.md). agy names its parameters in
// PascalCase, which is the whole reason this mapping cannot be guessed:
//
//   run_command           { CommandLine }
//   view_file             { AbsolutePath }
//   list_dir              { DirectoryPath }
//   find_by_name          { Pattern, SearchDirectory }
//   write_to_file         { TargetFile }
//   replace_file_content  { TargetFile }
//   manage_task           { Action, TaskId }
//
// Matching is by substring on the reported name so a versioned or renamed
// variant of the same tool still lands in the right bucket, and the
// conventional snake_case aliases are kept alongside the real keys so a
// future agy that renames them does not silently go blank. Anything
// unrecognized keeps its own name verbatim rather than being forced into a
// category it may not belong to.
import { isAbsolute, relative } from 'node:path'
import type { ToolActivityKind } from '@shared/runtime-events'

export interface ToolActivityDescription {
  label: string
  kind: ToolActivityKind
  /** The command line / path / query itself, when one was reported. */
  detail?: string
}

/** Parameter keys, in priority order, that carry the thing a step is acting
 *  on. Each list is the union of the spellings actually seen from agy plus
 *  the conventional aliases of the same field; a key that is not present
 *  simply does not match. */
const COMMAND_KEYS = ['CommandLine', 'command', 'cmd', 'command_line', 'script']
const PATH_KEYS = [
  'AbsolutePath',
  'TargetFile',
  'DirectoryPath',
  'SearchDirectory',
  'path',
  'file_path',
  'filename',
  'file',
  'absolute_path',
  'target_file',
  'directory',
  'dir'
]
const QUERY_KEYS = ['Pattern', 'Query', 'query', 'pattern', 'search', 'regex', 'q']

/** Longest reasonable single line. A command longer than this is truncated
 *  rather than wrapped, because the activity row is one line by design. */
const MAX_DETAIL_CHARS = 120

interface ToolRule {
  match: RegExp
  kind: ToolActivityKind
  keys: readonly string[]
  /** Builds the label from a detail that was genuinely reported. */
  withDetail: (detail: string) => string
  /** Builds the label when agy named the tool but reported no usable
   *  parameter for it. Still says only what is known. */
  bare: string
}

// Ordered: the first rule whose pattern appears in the tool name wins, so
// more specific names are listed before the words they contain.
const RULES: readonly ToolRule[] = [
  {
    // Real: run_command.
    match: /(run_command|run_terminal|execute_command|shell|bash|terminal|^command$|_command)/,
    kind: 'command',
    keys: COMMAND_KEYS,
    withDetail: (detail) => `Running ${detail}`,
    bare: 'Running a command'
  },
  {
    // Real: write_to_file, replace_file_content.
    match: /(write_to_file|write_file|create_file|edit_file|replace_file|str_replace|apply_patch|apply_diff|^write$|^edit$|^patch$)/,
    kind: 'edit',
    keys: PATH_KEYS,
    withDetail: (detail) => `Editing ${detail}`,
    bare: 'Editing a file'
  },
  {
    // Real: list_dir.
    match: /(list_dir|list_directory|list_files|^ls$)/,
    kind: 'list',
    keys: PATH_KEYS,
    withDetail: (detail) => `Listing ${detail}`,
    bare: 'Listing files'
  },
  {
    // Real: find_by_name.
    match: /(find_by_name|grep|glob|search|find_|codebase_search|^find$)/,
    kind: 'search',
    keys: [...QUERY_KEYS, ...PATH_KEYS],
    withDetail: (detail) => `Searching for ${detail}`,
    bare: 'Searching'
  },
  {
    // Real: view_file.
    match: /(read_file|view_file|open_file|view_code|^read$|^view$|^open$|^cat$)/,
    kind: 'read',
    keys: PATH_KEYS,
    withDetail: (detail) => `Reading ${detail}`,
    bare: 'Reading a file'
  }
]

/** The label, kind and detail for one reported tool step.
 *
 *  `workspacePath` only ever shortens a path that is genuinely inside the
 *  workspace — an absolute path elsewhere is shown in full, because where
 *  the agent is working outside the project is exactly the detail a reader
 *  should not have hidden from them. */
export function describeToolActivity(
  toolName: string | undefined,
  parameters: Record<string, unknown> | undefined,
  workspacePath?: string
): ToolActivityDescription {
  const name = (toolName ?? '').trim()
  const normalized = name.toLowerCase()
  const rule = normalized ? RULES.find((candidate) => candidate.match.test(normalized)) : undefined

  if (!rule) {
    // Unrecognized tool: agy's own name for it is the most honest label
    // available, and a reported path/command is still worth showing.
    const detail = firstDetail(parameters, [...COMMAND_KEYS, ...PATH_KEYS, ...QUERY_KEYS], workspacePath)
    const label = name || 'Antigravity tool'
    return detail ? { label: `${label} ${detail}`, kind: 'tool', detail } : { label, kind: 'tool' }
  }

  const detail = firstDetail(parameters, rule.keys, workspacePath)
  if (!detail) return { label: rule.bare, kind: rule.kind }
  return { label: rule.withDetail(detail), kind: rule.kind, detail }
}

/** The first key in `keys` whose value is a usable non-empty string. */
function firstDetail(
  parameters: Record<string, unknown> | undefined,
  keys: readonly string[],
  workspacePath: string | undefined
): string | undefined {
  if (!parameters) return undefined
  for (const key of keys) {
    const value = parameters[key]
    if (typeof value !== 'string') continue
    const cleaned = condense(value)
    if (!cleaned) continue
    return truncate(shortenPath(cleaned, workspacePath))
  }
  return undefined
}

/** A command may genuinely be multi-line; the activity row is one line, so
 *  newlines become spaces rather than being dropped with their content. */
function condense(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** Relative to the workspace when it is genuinely inside it. `relative`
 *  answering with a `..` prefix means it is not, and the full path stands. */
function shortenPath(value: string, workspacePath: string | undefined): string {
  if (!workspacePath || !isAbsolute(value)) return value
  const rel = relative(workspacePath, value)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return value
  return rel
}

function truncate(value: string): string {
  return value.length <= MAX_DETAIL_CHARS ? value : `${value.slice(0, MAX_DETAIL_CHARS - 1)}…`
}
