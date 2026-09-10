// Turns Antigravity's own account of what it is doing into the structured
// activity Orbit's runtime carries. Everything here is derived from real
// captured `agy` output — nothing is inferred from the prompt, the elapsed
// time, or what a turn is "probably" doing.
//
// Two independent sources feed this file, and both are Antigravity's own
// words:
//
//  1. structured `stream-json`: a `step_update` of `step_type: "tool"`
//     carries `tool_name` plus `tool_info.parameters`. Captured live
//     against agy 1.1.28 (see docs/antigravity-transports.md):
//
//       run_command      { "CommandLine": "ls -a" }
//       view_file        { "AbsolutePath": "/ws/README.md" }
//       list_dir         { "DirectoryPath": "/ws" }
//       grep_search      { "Query": "hello", "SearchPath": "/ws" }
//       write_to_file    { "TargetFile": "/ws/notes.md" }
//
//  2. the interactive PTY screen, where agy draws the same work as
//     `● Bash(npm run build) (ctrl+o to expand)` — see
//     TerminalInteractionDetector.readScreenActivity.
//
// Parameter names are matched case-insensitively and by several real
// spellings: agy 1.1.27 and 1.1.28 do not agree on them (1.1.28 uses
// PascalCase), and Orbit must not lose a file path to a casing change.
import type { ActivityKind } from '@shared/runtime-events'

/** Real `agy` tool names, grouped by the kind of work they represent.
 *  Matched as whole tool names first, then as substrings, so an unlisted
 *  sibling (`view_file_outline`, `browser_click_element`) still lands in
 *  the right family instead of falling all the way through to 'tool'. */
const TOOL_KINDS: ReadonlyArray<{ kind: ActivityKind; pattern: RegExp }> = [
  // Ordered: the first match wins, and the more specific families come
  // first. `run_command` must be tested before the generic `command_*`
  // family, and the write/edit family before the read family (several edit
  // tools contain "file", which the read family also matches).
  { kind: 'running', pattern: /^(run_command|send_command_input|command_status|notebook_execution)$/ },
  { kind: 'editing', pattern: /^(write_to_file|replace_file_content|multi_replace_file_content|sed_file|notebook_edit|generate_image)$/ },
  { kind: 'searching', pattern: /^(grep_search|find_by_name|search_web|read_url_content)$/ },
  { kind: 'listing', pattern: /^(list_dir|list_resources|list_permissions)$/ },
  { kind: 'reading', pattern: /^(view_file|read_resource|read_browser_page)$/ },
  { kind: 'waiting', pattern: /^(ask_permission|ask_custom_permission|ask_question)$/ },
  { kind: 'browsing', pattern: /^browser_|^open_browser|^capture_browser|^click_browser|^execute_browser|^list_browser/ },
  { kind: 'editing', pattern: /(write|edit|replace|create|patch|save)/ },
  { kind: 'searching', pattern: /(search|grep|find|glob)/ },
  { kind: 'listing', pattern: /(list|dir)/ },
  { kind: 'reading', pattern: /(read|view|open|inspect)/ },
  { kind: 'running', pattern: /(command|shell|bash|terminal|exec)/ },
  { kind: 'waiting', pattern: /(permission|approval|ask)/ }
]

/** What kind of work an Antigravity tool name represents. Falls back to
 *  'tool' — "Antigravity used a tool", which is true and says nothing it
 *  cannot see — rather than guessing a family. */
export function classifyToolName(toolName: string): ActivityKind {
  const name = toolName.trim().toLowerCase()
  if (!name) return 'tool'
  for (const { kind, pattern } of TOOL_KINDS) {
    if (pattern.test(name)) return kind
  }
  return 'tool'
}

/** Case- and spelling-tolerant parameter lookup. agy has changed these
 *  names between versions (`file_path` -> `AbsolutePath`), and a rename
 *  must degrade to "no target" rather than to a wrong one. */
export function pickParameter(parameters: Record<string, unknown> | undefined, names: readonly string[]): string | null {
  if (!parameters) return null
  const wanted = new Set(names.map((name) => name.toLowerCase()))
  for (const [key, value] of Object.entries(parameters)) {
    if (!wanted.has(key.toLowerCase())) continue
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/** Every real spelling of "the shell command this step runs". */
export const COMMAND_PARAMS = ['CommandLine', 'command_line', 'command', 'cmd'] as const
/** Every real spelling of "the path this step acts on". Covers both the
 *  1.1.28 PascalCase names and the older snake_case ones. */
export const PATH_PARAMS = [
  'AbsolutePath',
  'TargetFile',
  'DirectoryPath',
  'SearchPath',
  'NotebookPath',
  'absolute_path',
  'target_file',
  'directory_path',
  'file_path',
  'path',
  'filename',
  'file'
] as const
/** Every real spelling of "what this step is looking for". */
export const QUERY_PARAMS = ['Query', 'SearchTerm', 'Pattern', 'query', 'search_term', 'pattern'] as const

export interface ToolActivityFacts {
  kind: ActivityKind
  /** The exact command, when the step named one. Never summarized. */
  command?: string
  /** The exact file, directory or query, when the step named one. */
  target?: string
}

/** Everything Orbit can honestly say about a structured `tool` step.
 *
 *  A search reports its query as the target rather than the directory it
 *  searched: "what was looked for" is the part a reader recognizes, and the
 *  path is usually just the workspace they are already in. */
export function toolActivityFacts(toolName: string, parameters: Record<string, unknown> | undefined): ToolActivityFacts {
  const kind = classifyToolName(toolName)
  const command = pickParameter(parameters, COMMAND_PARAMS)
  if (command) return { kind: kind === 'tool' ? 'running' : kind, command }
  const query = kind === 'searching' ? pickParameter(parameters, QUERY_PARAMS) : null
  const target = query ?? pickParameter(parameters, PATH_PARAMS)
  return target ? { kind, target } : { kind }
}
