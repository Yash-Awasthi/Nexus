import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { ddl, type Db, type Sql } from './sql.ts'

/** `$1` → `?1`: SQLite's numbered parameters, bound in order. */
const numbered = (text: string) => text.replace(/\$(\d+)/g, '?$1')

/** SQLite has no booleans. */
const bind = (value: unknown) => (typeof value === 'boolean' ? (value ? 1 : 0) : (value ?? null))

/**
 * The tables on `node:sqlite`, at `path` (`:memory:` works). Every transaction
 * runs synchronously, from `begin` to `commit`: A2's SQLite store, on another
 * handle to the same file, blocks the thread while it waits for the lock, so
 * a transaction of ours that yielded in between would wait on itself.
 */
export function sqliteDb(path: string): Db {
  // Loaded only when used, so a board that never opens SQLite never loads it.
  const { DatabaseSync: Database } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')
  if (path !== ':memory:') mkdirSync(dirname(resolve(/* turbopackIgnore: true */ path)), { recursive: true })
  const db: DatabaseSync = new Database(path)
  db.exec('pragma busy_timeout = 5000')
  for (const statement of ddl()) db.exec(statement)

  const statements = new Map<string, StatementSync>()
  const run = (query: Sql) => {
    let statement = statements.get(query.text)
    if (!statement) statements.set(query.text, (statement = db.prepare(numbered(query.text))))
    return statement.all(...(query.values.map(bind) as never[])) as Record<string, unknown>[]
  }
  const rollback = () => {
    try {
      db.exec('rollback')
    } catch {
      // Nothing was open.
    }
  }

  return {
    all: async (query) => run(query),
    async read(queries) {
      db.exec('begin')
      try {
        const rows = queries.map(run)
        db.exec('commit')
        return rows
      } catch (error) {
        rollback()
        throw error
      }
    },
    async commit(claim, writes) {
      db.exec('begin immediate')
      try {
        if (run(claim).length === 0) {
          db.exec('rollback')
          return false
        }
        for (const write of writes) run(write)
        db.exec('commit')
        return true
      } catch (error) {
        rollback()
        throw error
      }
    },
    async close() {
      db.close()
    },
  }
}
