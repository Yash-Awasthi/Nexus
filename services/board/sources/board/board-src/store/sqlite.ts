import { sqlite as a2Sqlite } from 'experimental-a2/store-sqlite'
import { sqliteDb } from './sqlite-db.ts'
import { sqlTables } from './sql.ts'
import type { BoardStore } from './types.ts'

/**
 * A local board in one SQLite file, its log and board's tables side by side. It
 * creates its tables when it opens, and a serverless function, whose files are
 * read-only, can't open it.
 */
export function sqlite(options: { path: string }): BoardStore {
  const { path } = options
  // A2's store first: it creates the file and switches it to WAL, which the second handle needs.
  const log = a2Sqlite({ path })
  let tables: ReturnType<typeof sqlTables>
  try {
    tables = sqlTables(sqliteDb(path))
  } catch (error) {
    // The log's handle is open already: a store that didn't open holds nothing.
    log.close()
    throw error
  }
  return {
    log,
    tables,
    async close() {
      await tables.close()
      log.close()
    },
  }
}
