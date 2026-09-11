import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearAllData, CLEAR_DATA_CONFIRMATION } from '../../src/main/data/clearAllData'

describe('clearing all Orbit data', () => {
  let dataDir: string
  let external: string

  beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-clear-'))
    dataDir = path.join(root, 'orbit', 'userData')
    external = path.join(root, 'Documents', 'MyProject')
    fs.mkdirSync(path.join(dataDir, 'projects', 'project_1', 'workspace'), { recursive: true })
    fs.mkdirSync(path.join(dataDir, 'projects', 'project_1', 'files'), { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'orbit.sqlite'), 'database')
    fs.writeFileSync(path.join(dataDir, 'projects', 'project_1', 'workspace', 'scratch.txt'), 'managed')
    fs.writeFileSync(path.join(dataDir, 'projects', 'project_1', 'files', 'copied.png'), 'attachment')

    // The user's own project, which a project row merely points at.
    fs.mkdirSync(path.join(external, 'src'), { recursive: true })
    fs.writeFileSync(path.join(external, 'README.md'), '# My project')
    fs.writeFileSync(path.join(external, 'src', 'index.ts'), 'export const x = 1')
  })

  afterEach(() => {
    fs.rmSync(path.resolve(dataDir, '..', '..'), { recursive: true, force: true })
  })

  it('removes everything Orbit owns', async () => {
    await clearAllData({ dataDir, shutdown: async () => undefined })

    expect(fs.existsSync(path.join(dataDir, 'orbit.sqlite'))).toBe(false)
    expect(fs.existsSync(path.join(dataDir, 'projects'))).toBe(false)
    // The directory itself survives, so the next launch has somewhere to go.
    expect(fs.existsSync(dataDir)).toBe(true)
    expect(fs.readdirSync(dataDir)).toEqual([])
  })

  it('removes Orbit-managed workspaces and copied attachments', async () => {
    await clearAllData({ dataDir, shutdown: async () => undefined })

    expect(fs.existsSync(path.join(dataDir, 'projects', 'project_1', 'workspace', 'scratch.txt'))).toBe(false)
    expect(fs.existsSync(path.join(dataDir, 'projects', 'project_1', 'files', 'copied.png'))).toBe(false)
  })

  it('NEVER deletes the user’s own project folder or anything in it', async () => {
    await clearAllData({ dataDir, shutdown: async () => undefined })

    // The whole point: a project row pointing here loses Orbit's reference,
    // and the real work on disk is untouched.
    expect(fs.existsSync(external)).toBe(true)
    expect(fs.readFileSync(path.join(external, 'README.md'), 'utf8')).toBe('# My project')
    expect(fs.readFileSync(path.join(external, 'src', 'index.ts'), 'utf8')).toBe('export const x = 1')
  })

  it('leaves an external folder alone even when it sits beside the data directory', async () => {
    const sibling = path.join(path.dirname(dataDir), 'NotOrbit')
    fs.mkdirSync(sibling, { recursive: true })
    fs.writeFileSync(path.join(sibling, 'keep.txt'), 'keep me')

    await clearAllData({ dataDir, shutdown: async () => undefined })

    expect(fs.readFileSync(path.join(sibling, 'keep.txt'), 'utf8')).toBe('keep me')
  })

  it('stops everything holding the data open before deleting anything', async () => {
    const order: string[] = []
    await clearAllData({
      dataDir,
      shutdown: async () => {
        // A live agy process or an open sqlite handle would otherwise
        // outlive the clear and rewrite part of what was removed.
        order.push('shutdown')
        expect(fs.existsSync(path.join(dataDir, 'orbit.sqlite'))).toBe(true)
      }
    })
    order.push('cleared')

    expect(order).toEqual(['shutdown', 'cleared'])
  })

  it('does not delete anything when shutdown fails', async () => {
    const failing = vi.fn(async () => {
      throw new Error('agy would not stop')
    })

    await expect(clearAllData({ dataDir, shutdown: failing })).rejects.toThrow('agy would not stop')
    expect(fs.existsSync(path.join(dataDir, 'orbit.sqlite'))).toBe(true)
  })

  it('refuses a path that could not be an application data directory', async () => {
    const shutdown = vi.fn(async () => undefined)

    await expect(clearAllData({ dataDir: path.parse(process.cwd()).root, shutdown })).rejects.toThrow(/filesystem root/i)
    await expect(clearAllData({ dataDir: path.join(path.parse(process.cwd()).root, 'home'), shutdown })).rejects.toThrow(/shallow/i)
    // Refused before anything was even stopped, let alone deleted.
    expect(shutdown).not.toHaveBeenCalled()
  })

  it('is a no-op on a data directory that does not exist yet', async () => {
    const missing = path.join(dataDir, 'nope', 'gone')
    await expect(clearAllData({ dataDir: missing, shutdown: async () => undefined })).resolves.toEqual({ removed: [] })
  })

  it('names the confirmation word in one place', () => {
    expect(CLEAR_DATA_CONFIRMATION).toBe('CLEAR')
  })
})
