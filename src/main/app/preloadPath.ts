import { existsSync } from 'node:fs'
import { join } from 'node:path'

export function resolvePreloadPath(baseDir: string): string {
  const cjsPreload = join(baseDir, '../preload/index.cjs')
  const candidates = [cjsPreload, join(baseDir, '../preload/index.js'), join(baseDir, '../preload/index.mjs')]
  return candidates.find((candidate) => existsSync(candidate)) ?? cjsPreload
}
