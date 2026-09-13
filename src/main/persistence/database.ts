import fs from 'node:fs'
import path from 'node:path'
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js'
import { SCHEMA_SQL } from './schema'
import { DEFAULT_SESSION_TITLE } from '@shared/sessionTitle'

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
    this.relaxProjectOwnership()
    this.backfillTitleState()
    this.enableForeignKeys()
    this.repairOrphanedRows()
    this.persist()
  }

  /** CRITICAL (real bug): `PRAGMA foreign_keys` is per connection, and
   *  sql.js's `export()` — which `persist()` calls after every write — closes
   *  and reopens the connection, silently turning enforcement back off. The
   *  schema's `ON DELETE CASCADE` / `SET NULL` therefore never ran after the
   *  first write: deleting a session left its messages, runs, run events and
   *  artifact versions behind. It is re-enabled after every reopen. */
  private enableForeignKeys(): void {
    this.requireDb().run('PRAGMA foreign_keys = ON')
  }

  /** Repairs what the foreign-key bug above left behind, exactly as the
   *  schema's own ON DELETE rules would have. Idempotent: a no-op once clean.
   *  Only ever removes rows whose owner row no longer exists. */
  private repairOrphanedRows(): void {
    const statements = [
      'DELETE FROM run_events WHERE run_id NOT IN (SELECT id FROM runs)',
      'DELETE FROM messages WHERE conversation_id NOT IN (SELECT id FROM conversations)',
      'DELETE FROM runs WHERE conversation_id NOT IN (SELECT id FROM conversations)',
      'UPDATE messages SET run_id = NULL WHERE run_id IS NOT NULL AND run_id NOT IN (SELECT id FROM runs)',
      // An Unsorted session's artifacts belong to that session alone.
      'DELETE FROM artifacts WHERE project_id IS NULL AND (creator_conversation_id IS NULL OR creator_conversation_id NOT IN (SELECT id FROM conversations))',
      'DELETE FROM artifacts WHERE project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM projects)',
      'UPDATE artifacts SET creator_conversation_id = NULL WHERE creator_conversation_id IS NOT NULL AND creator_conversation_id NOT IN (SELECT id FROM conversations)',
      'UPDATE artifacts SET creator_run_id = NULL WHERE creator_run_id IS NOT NULL AND creator_run_id NOT IN (SELECT id FROM runs)',
      'DELETE FROM artifact_versions WHERE artifact_id NOT IN (SELECT id FROM artifacts)'
    ]
    for (const statement of statements) this.exec(statement)
  }

  /** Lets a session — and what it produced — belong to no project at all.
   *
   *  SQLite cannot drop a NOT NULL constraint in place, so the tables
   *  that carry a session's ownership are rebuilt with a nullable
   *  `project_id`. Everything is copied across first and the swap happens
   *  inside one transaction, so an interrupted run leaves the old table
   *  intact rather than a half-migrated one.
   *
   *  Idempotent: it checks the constraint before doing anything, so it runs
   *  exactly once and is a no-op on every launch afterwards. Foreign keys
   *  are suspended only for the swap — dropping a referenced table with
   *  them on would cascade the very rows being migrated. */
  private relaxProjectOwnership(): void {
    const tables: Array<{ name: string; columns: string }> = [
      { name: 'conversations', columns: 'project_id TEXT REFERENCES projects(id) ON DELETE CASCADE' },
      { name: 'runs', columns: 'project_id TEXT REFERENCES projects(id) ON DELETE CASCADE' },
      { name: 'messages', columns: 'project_id TEXT REFERENCES projects(id) ON DELETE CASCADE' },
      // Outputs an Unsorted session produced — see the artifacts table.
      { name: 'artifacts', columns: 'project_id TEXT REFERENCES projects(id) ON DELETE CASCADE' }
    ]
    const pending = tables.filter((table) => this.columnIsNotNull(table.name, 'project_id'))
    if (pending.length === 0) return

    this.exec('PRAGMA foreign_keys = OFF')
    try {
      for (const table of pending) {
        const definition = this.get<string | null>(
          'SELECT sql FROM sqlite_master WHERE type = ? AND name = ?',
          ['table', table.name],
          (row) => nullableText(row, 'sql')
        )
        if (!definition) continue
        // Reuse the table's own definition, with just this one column
        // relaxed, so no other column, default or constraint can drift.
        const rebuilt = definition
          .replace(/CREATE TABLE (IF NOT EXISTS )?"?\w+"?/i, `CREATE TABLE "${table.name}__orbit_new"`)
          .replace(/project_id TEXT NOT NULL REFERENCES/i, 'project_id TEXT REFERENCES')
        const columns = this.query<string>(`PRAGMA table_info(${table.name})`, [], (row) => text(row, 'name')).join(', ')
        this.exec('BEGIN')
        this.exec(rebuilt)
        this.exec(`INSERT INTO "${table.name}__orbit_new" (${columns}) SELECT ${columns} FROM ${table.name}`)
        this.exec(`DROP TABLE ${table.name}`)
        this.exec(`ALTER TABLE "${table.name}__orbit_new" RENAME TO ${table.name}`)
        this.exec('COMMIT')
      }
      // The rebuild drops the indexes that lived on the old tables.
      this.exec(SCHEMA_SQL)
    } finally {
      this.exec('PRAGMA foreign_keys = ON')
    }
  }

  private columnIsNotNull(table: string, column: string): boolean {
    const rows = this.query<{ name: string; notnull: number }>(`PRAGMA table_info(${table})`, [], (row) => ({
      name: text(row, 'name'),
      notnull: numberValue(row, 'notnull') ?? 0
    }))
    return rows.some((row) => row.name === column && row.notnull !== 0)
  }

  /** Settles `title_state` for rows that predate the column.
   *
   *  Idempotent, and deliberately conservative: a session the user renamed
   *  is 'manual', one still called `New Session` is 'default', and anything
   *  else was named by Orbit from a real prompt and counts as 'substantive'
   *  — so an existing session can never be silently renamed by the new
   *  auto-title rules. Only rows still at the column default are touched,
   *  so this is a no-op on every run after the first. */
  private backfillTitleState(): void {
    this.run("UPDATE conversations SET title_state = 'manual' WHERE title_state = 'default' AND title_is_custom = 1", [])
    this.run("UPDATE conversations SET title_state = 'substantive' WHERE title_state = 'default' AND title_is_custom = 0 AND title <> ?", [
      DEFAULT_SESSION_TITLE
    ])
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
      "ALTER TABLE conversations ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'ask'",
      // How a session came by its name — see shared/sessionTitle.ts. New
      // rows start at 'default'; the backfill below settles existing ones
      // from what they already carry, so no session Orbit or the user
      // already named becomes a candidate for renaming.
      "ALTER TABLE conversations ADD COLUMN title_state TEXT NOT NULL DEFAULT 'default'"
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
    // export() reopened the connection; see enableForeignKeys.
    this.enableForeignKeys()
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
