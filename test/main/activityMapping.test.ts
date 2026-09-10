import { describe, expect, it } from 'vitest'
import { classifyToolName, pickParameter, toolActivityFacts } from '../../src/main/runtime/activityMapping'

// Every tool name and parameter shape below was read off a real
// `agy 1.1.28` run (the `init` event's tool list, plus captured `tool`
// steps — see docs/antigravity-transports.md).
describe('classifyToolName', () => {
  it('classifies the real agy tools by the work they do', () => {
    expect(classifyToolName('run_command')).toBe('running')
    expect(classifyToolName('view_file')).toBe('reading')
    expect(classifyToolName('list_dir')).toBe('listing')
    expect(classifyToolName('grep_search')).toBe('searching')
    expect(classifyToolName('find_by_name')).toBe('searching')
    expect(classifyToolName('write_to_file')).toBe('editing')
    expect(classifyToolName('replace_file_content')).toBe('editing')
    expect(classifyToolName('multi_replace_file_content')).toBe('editing')
    expect(classifyToolName('sed_file')).toBe('editing')
    expect(classifyToolName('ask_permission')).toBe('waiting')
    expect(classifyToolName('browser_click_element')).toBe('browsing')
  })

  it('does not mistake an edit tool for a read one, or vice versa', () => {
    // Both names contain "file"; only one of them writes.
    expect(classifyToolName('write_to_file')).toBe('editing')
    expect(classifyToolName('view_file')).toBe('reading')
  })

  it('places an unlisted sibling in the right family rather than giving up', () => {
    expect(classifyToolName('view_file_outline')).toBe('reading')
    expect(classifyToolName('browser_subagent')).toBe('browsing')
  })

  it("says only 'a tool' for a name it genuinely cannot place", () => {
    expect(classifyToolName('manage_inbox')).toBe('tool')
    expect(classifyToolName('invoke_subagent')).toBe('tool')
    expect(classifyToolName('')).toBe('tool')
  })

  it('is not confused by casing, which agy has changed between versions', () => {
    expect(classifyToolName('RunCommand')).toBe('running')
    expect(classifyToolName('Bash')).toBe('running')
  })
})

describe('pickParameter', () => {
  it('matches the real PascalCase names agy 1.1.28 emits', () => {
    expect(pickParameter({ CommandLine: 'ls -a' }, ['CommandLine'])).toBe('ls -a')
  })

  it('matches regardless of case, so a rename cannot lose a real value', () => {
    expect(pickParameter({ absolutepath: '/ws/a.ts' }, ['AbsolutePath'])).toBe('/ws/a.ts')
    expect(pickParameter({ FILE_PATH: '/ws/a.ts' }, ['file_path'])).toBe('/ws/a.ts')
  })

  it('ignores values that are not usable text rather than reporting them', () => {
    expect(pickParameter({ CommandLine: '   ' }, ['CommandLine'])).toBeNull()
    expect(pickParameter({ CommandLine: 42 }, ['CommandLine'])).toBeNull()
    expect(pickParameter(undefined, ['CommandLine'])).toBeNull()
    expect(pickParameter({ Other: 'x' }, ['CommandLine'])).toBeNull()
  })
})

describe('toolActivityFacts', () => {
  it('reports the exact command, verbatim, for the real run_command shape', () => {
    expect(toolActivityFacts('run_command', { CommandLine: 'npm run build -- --watch' })).toEqual({
      kind: 'running',
      command: 'npm run build -- --watch'
    })
  })

  it('reports the real path for the real read, list and write shapes', () => {
    expect(toolActivityFacts('view_file', { AbsolutePath: '/ws/README.md' })).toEqual({ kind: 'reading', target: '/ws/README.md' })
    expect(toolActivityFacts('list_dir', { DirectoryPath: '/ws/src' })).toEqual({ kind: 'listing', target: '/ws/src' })
    expect(toolActivityFacts('write_to_file', { TargetFile: '/ws/notes.md' })).toEqual({ kind: 'editing', target: '/ws/notes.md' })
  })

  it('reports what a search looked for, not where it looked', () => {
    // Real captured shape carries both; the query is the recognizable half.
    expect(toolActivityFacts('grep_search', { Query: 'hello', SearchPath: '/ws' })).toEqual({ kind: 'searching', target: 'hello' })
  })

  it('falls back to the search path when there is no query to report', () => {
    expect(toolActivityFacts('grep_search', { SearchPath: '/ws' })).toEqual({ kind: 'searching', target: '/ws' })
  })

  it('reports a command even from a tool whose name says nothing', () => {
    expect(toolActivityFacts('unknown_thing', { CommandLine: 'make test' })).toEqual({ kind: 'running', command: 'make test' })
  })

  it('reports the kind alone when agy named no subject', () => {
    expect(toolActivityFacts('view_file', {})).toEqual({ kind: 'reading' })
    expect(toolActivityFacts('manage_inbox', undefined)).toEqual({ kind: 'tool' })
  })
})
