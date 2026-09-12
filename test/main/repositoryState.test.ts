// Exercised against real git repositories created in a temp directory —
// this is the one place Orbit shells out to git, and mocking it would test
// nothing about whether the commands and their output are right.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { readRepositoryState } from '../../src/main/git/repositoryState'

const created: string[] = []

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  created.push(dir)
  return dir
}

/** A repository with one commit on a known branch and no remote. */
function repository(): string {
  const dir = tempDir('orbit-repo-')
  git(dir, 'init', '--initial-branch=main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Orbit Test')
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'initial')
  return dir
}

afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true })
})

describe('a folder that is not a repository', () => {
  it('reports no repository for a plain directory', async () => {
    expect(await readRepositoryState(tempDir('orbit-plain-'))).toEqual({
      isRepository: false,
      branch: null,
      hasChanges: false,
      hasUpstream: false,
      ahead: 0
    })
  })

  it('reports no repository for a null workspace', async () => {
    expect((await readRepositoryState(null)).isRepository).toBe(false)
  })

  it('reports no repository for a path that does not exist', async () => {
    expect((await readRepositoryState('/orbit/definitely/not/here')).isRepository).toBe(false)
  })
})

describe('a real repository', () => {
  it('reports the branch and a clean tree', async () => {
    const state = await readRepositoryState(repository())

    expect(state.isRepository).toBe(true)
    expect(state.branch).toBe('main')
    expect(state.hasChanges).toBe(false)
  })

  it('sees a modified tracked file as uncommitted work', async () => {
    const dir = repository()
    fs.writeFileSync(path.join(dir, 'README.md'), '# changed\n')

    expect((await readRepositoryState(dir)).hasChanges).toBe(true)
  })

  it('sees a brand-new untracked file as uncommitted work', async () => {
    // The case that matters most here: a file the agent just wrote.
    const dir = repository()
    fs.writeFileSync(path.join(dir, 'generated.txt'), 'new\n')

    expect((await readRepositoryState(dir)).hasChanges).toBe(true)
  })

  it('reports no upstream for a branch that has none', async () => {
    const state = await readRepositoryState(repository())

    expect(state.hasUpstream).toBe(false)
    // Never counts every commit on the branch as "ahead" — without an
    // upstream there is nothing to be ahead of.
    expect(state.ahead).toBe(0)
  })

  it('reports a detached HEAD as having no branch', async () => {
    const dir = repository()
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
    git(dir, 'checkout', '--detach', head)

    const state = await readRepositoryState(dir)
    expect(state.isRepository).toBe(true)
    expect(state.branch).toBeNull()
  })

  it('counts commits ahead of a real upstream', async () => {
    const origin = tempDir('orbit-origin-')
    git(origin, 'init', '--bare', '--initial-branch=main')

    const dir = repository()
    git(dir, 'remote', 'add', 'origin', origin)
    git(dir, 'push', '-u', 'origin', 'main')

    const level = await readRepositoryState(dir)
    expect(level.hasUpstream).toBe(true)
    expect(level.ahead).toBe(0)

    fs.writeFileSync(path.join(dir, 'second.txt'), 'x\n')
    git(dir, 'add', '.')
    git(dir, 'commit', '-m', 'second')

    const ahead = await readRepositoryState(dir)
    expect(ahead.ahead).toBe(1)
    expect(ahead.hasChanges).toBe(false)
  })

  it('reports a subdirectory of a repository as being in one', async () => {
    const dir = repository()
    const nested = path.join(dir, 'src', 'deep')
    fs.mkdirSync(nested, { recursive: true })

    expect((await readRepositoryState(nested)).isRepository).toBe(true)
  })
})
