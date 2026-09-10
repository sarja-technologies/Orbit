import fs from 'node:fs'
import path from 'node:path'
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js'
import { SCHEMA_SQL } from './schema'

export interface DatabaseOptions {
  dataDir: string
}

type SqlParams = Array<string | number | null>

export class OrbitDatabase {
  private SQL: SqlJsStatic | null = null
  private db: Database | null = null
  readonly dbPath: string

  constructor(private readonly opts: DatabaseOptions) {
    this.dbPath = path.join(opts.dataDir, 'orbit.sqlite')
  }

  async init(): Promise<void> {
    fs.mkdirSync(this.opts.dataDir, { recursive: true })
    this.SQL = await initSqlJs()
    if (fs.existsSync(this.dbPath)) {
      this.db = new this.SQL.Database(fs.readFileSync(this.dbPath))
    } else {
      this.db = new this.SQL.Database()
    }
    this.exec(SCHEMA_SQL)
    this.runMigrations()
    this.persist()
  }

  /** Orbit has no formal migration framework yet — each entry here is a
   *  single idempotent `ALTER TABLE`, safe to re-run on every startup
   *  (SQLite has no `ADD COLUMN IF NOT EXISTS`, so a "duplicate column"
   *  failure is expected and ignored on every run after the first). */
  private runMigrations(): void {
    const migrations = [
      "ALTER TABLE conversations ADD COLUMN transport TEXT NOT NULL DEFAULT 'structured'",
      'ALTER TABLE conversations ADD COLUMN model TEXT',
      'ALTER TABLE conversations ADD COLUMN reasoning_effort TEXT',
      // Project/session working folders. Existing rows keep NULL, which
      // means "the Orbit-managed workspace" — the same folder they have
      // always run in — so no session loses its history or its location.
      'ALTER TABLE projects ADD COLUMN root_path TEXT',
      'ALTER TABLE conversations ADD COLUMN working_directory TEXT',
      // Marks a title the user chose themselves, so first-prompt
      // auto-titling can never overwrite one. Existing rows default to 0:
      // they were all named before auto-titling existed and none of them
      // carries the default title, so none is a candidate anyway.
      'ALTER TABLE conversations ADD COLUMN title_is_custom INTEGER NOT NULL DEFAULT 0',
      // Permission handling per session. Defaults to 'ask', which is agy's
      // own behaviour, so every existing session keeps behaving exactly as
      // it did before the control existed.
      "ALTER TABLE conversations ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'ask'"
    ]
    for (const migration of migrations) {
      try {
        this.exec(migration)
      } catch (error) {
        if (!messageOf(error).includes('duplicate column')) throw error
      }
    }
  }

  close(): void {
    this.persist()
    this.db?.close()
    this.db = null
  }

  exec(sql: string): void {
    this.requireDb().run(sql)
  }

  run(sql: string, params: SqlParams = []): void {
    this.requireDb().run(sql, params)
    this.persist()
  }

  query<T>(sql: string, params: SqlParams = [], mapper: (row: Record<string, unknown>) => T): T[] {
    const stmt = this.requireDb().prepare(sql, params)
    const rows: T[] = []
    try {
      while (stmt.step()) rows.push(mapper(stmt.getAsObject()))
    } finally {
      stmt.free()
    }
    return rows
  }

  get<T>(sql: string, params: SqlParams = [], mapper: (row: Record<string, unknown>) => T): T | null {
    return this.query(sql, params, mapper)[0] ?? null
  }

  persist(): void {
    if (!this.db) return
    const bytes = this.db.export()
    fs.writeFileSync(this.dbPath, Buffer.from(bytes))
  }

  private requireDb(): Database {
    if (!this.db) throw new Error('Orbit database has not been initialized.')
    return this.db
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function jsonStringify(value: unknown): string {
  return JSON.stringify(value ?? {})
}

export function jsonParseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.length === 0) return {}
  const parsed = JSON.parse(value) as unknown
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
}

export function text(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new Error(`Expected ${key} to be text.`)
  return value
}

export function nullableText(row: Record<string, unknown>, key: string): string | null {
  const value = row[key]
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error(`Expected ${key} to be nullable text.`)
  return value
}

export function numberValue(row: Record<string, unknown>, key: string): number {
  const value = row[key]
  if (typeof value !== 'number') throw new Error(`Expected ${key} to be number.`)
  return value
}
