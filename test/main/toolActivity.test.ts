import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { describeToolActivity } from '../../src/main/runtime/providers/antigravity/toolActivity'

const WORKSPACE = path.resolve('/tmp/orbit-workspace')

describe('describeToolActivity', () => {
  // Captured verbatim from a live `agy 1.1.27 --print --output-format
  // stream-json` session. agy names its parameters in PascalCase, which is
  // exactly what a plausible-looking snake_case guess gets wrong — and got
  // wrong here until these shapes were captured: every label silently fell
  // back to "Running a command" with the real command thrown away.
  it('reads the real parameter shapes agy actually emits', () => {
    expect(describeToolActivity('run_command', { CommandLine: 'npm run build' })).toEqual({
      label: 'Running npm run build',
      kind: 'command',
      detail: 'npm run build'
    })
    expect(describeToolActivity('view_file', { AbsolutePath: '/tmp/ws/src/App.tsx' }, '/tmp/ws')).toEqual({
      label: 'Reading src/App.tsx',
      kind: 'read',
      detail: 'src/App.tsx'
    })
    expect(describeToolActivity('write_to_file', { TargetFile: 'summary.txt' })).toEqual({
      label: 'Editing summary.txt',
      kind: 'edit',
      detail: 'summary.txt'
    })
    expect(describeToolActivity('replace_file_content', { TargetFile: 'styles.css' })).toEqual({
      label: 'Editing styles.css',
      kind: 'edit',
      detail: 'styles.css'
    })
    expect(describeToolActivity('list_dir', { DirectoryPath: '/tmp/ws/src' }, '/tmp/ws')).toEqual({
      label: 'Listing src',
      kind: 'list',
      detail: 'src'
    })
    expect(describeToolActivity('find_by_name', { Pattern: 'notes.txt', SearchDirectory: '/tmp/ws' })).toEqual({
      label: 'Searching for notes.txt',
      kind: 'search',
      detail: 'notes.txt'
    })
  })

  it('keeps working if agy renames its parameters to the conventional spellings', () => {
    expect(describeToolActivity('command', { command: 'pytest -q' }).label).toBe('Running pytest -q')
    expect(describeToolActivity('write_file', { path: 'styles.css' }).label).toBe('Editing styles.css')
    expect(describeToolActivity('read_file', { path: 'App.tsx' }).label).toBe('Reading App.tsx')
    expect(describeToolActivity('view_file', { file_path: 'main.ts' }).label).toBe('Reading main.ts')
  })

  it('classifies each step so the UI never has to read the label', () => {
    expect(describeToolActivity('run_command', { command: 'ls' }).kind).toBe('command')
    expect(describeToolActivity('write_file', { path: 'a.ts' }).kind).toBe('edit')
    expect(describeToolActivity('read_file', { path: 'a.ts' }).kind).toBe('read')
    expect(describeToolActivity('grep_search', { query: 'useEffect' }).kind).toBe('search')
    expect(describeToolActivity('list_dir', { path: 'src' }).kind).toBe('list')
  })

  it('shortens a path inside the workspace, and never hides one outside it', () => {
    expect(describeToolActivity('read_file', { path: path.join(WORKSPACE, 'src/App.tsx') }, WORKSPACE).detail).toBe(
      path.join('src', 'App.tsx')
    )
    // Where the agent is working outside the project is exactly the detail
    // a reader must not have hidden from them.
    const outside = path.resolve('/etc/hosts')
    expect(describeToolActivity('read_file', { path: outside }, WORKSPACE).detail).toBe(outside)
  })

  it('keeps a multi-line command on one line without dropping any of it', () => {
    const described = describeToolActivity('run_command', { CommandLine: 'npm run build \\\n  --silent' })
    expect(described.detail).toBe('npm run build \\ --silent')
  })

  it('truncates a very long command rather than wrapping the activity row', () => {
    const long = `echo ${'x'.repeat(400)}`
    const described = describeToolActivity('run_command', { CommandLine: long })
    expect(described.detail!.length).toBeLessThanOrEqual(120)
    expect(described.detail!.endsWith('…')).toBe(true)
  })

  it('says only what the runtime reported when it reported no parameters', () => {
    // No invented file name, no invented command — just the fact that a
    // command is running.
    expect(describeToolActivity('run_command', undefined)).toEqual({ label: 'Running a command', kind: 'command' })
    expect(describeToolActivity('write_file', {})).toEqual({ label: 'Editing a file', kind: 'edit' })
  })

  it('keeps an unrecognized tool’s own name rather than inventing a category', () => {
    expect(describeToolActivity('summon_kraken', undefined)).toEqual({ label: 'summon_kraken', kind: 'tool' })
    expect(describeToolActivity('summon_kraken', { path: 'sea.txt' })).toEqual({
      label: 'summon_kraken sea.txt',
      kind: 'tool',
      detail: 'sea.txt'
    })
  })

  it('falls back to a neutral label when agy named no tool at all', () => {
    expect(describeToolActivity(undefined, undefined)).toEqual({ label: 'Antigravity tool', kind: 'tool' })
  })

  it('ignores a parameter that is not a usable string', () => {
    expect(describeToolActivity('run_command', { CommandLine: 42, cmd: 'true' }).detail).toBe('true')
    expect(describeToolActivity('run_command', { CommandLine: '   ' })).toEqual({ label: 'Running a command', kind: 'command' })
  })

  it('leaves a real agy tool it has no category for as its own name', () => {
    // Captured live: manage_task { Action, TaskId } — neither a command nor
    // a file, and forcing it into one would misreport what happened.
    expect(describeToolActivity('manage_task', { Action: 'status', TaskId: 'task-12' })).toEqual({
      label: 'manage_task',
      kind: 'tool'
    })
  })
})
