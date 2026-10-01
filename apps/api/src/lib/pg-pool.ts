// SPDX-License-Identifier: Apache-2.0
/**
 * Single owner of the process's Postgres connections.
 *
 * Eleven modules each built their own `new Pool({ connectionString:
 * DATABASE_URL })`, so one API process opened a dozen independent pools
 * against the same database and each site picked its own `max` by feel. They
 * all call `query()` and nothing else, so one pool per connection string
 * serves all of them.
 *
 * It is also where `pglite://` is understood — the embedded Postgres that lets
 * the desktop app run the real API with a real database and no server to
 * install (spec milestone M2). The instance belongs to `@nexus/db`, which
 * hands the same one to the Drizzle client; here it is wrapped so its results
 * are pg-shaped (`rows`, `rowCount`) and callers cannot tell the two backings
 * apart — the point of routing every site through here rather than teaching
 * each one about both.
 *
 *   DATABASE_URL=postgresql://…        → node-postgres, as before
 *   DATABASE_URL=pglite:///path/to/dir → embedded Postgres in that directory
 *   DATABASE_URL=pglite://:memory:     → embedded, discarded on exit
 *   (unset)                            → null; callers fall back to their
 *                                        file or in-memory store
 *
 * Loading the WASM build is deferred to the first embedded query, so a
 * deployment on a server database never pays for it.
 */

import { type EmbeddedDb, isEmbeddedUrl } from "@nexus/db/embedded";
import { Pool } from "pg";

// Re-exported because callers ask this module, not `@nexus/db`, which backing
// a URL names — the two answers must never diverge.
export { isEmbeddedUrl };

/** The slice of `pg.Pool` this codebase actually uses. */
export interface PgLike {
  // The type parameter appears once by design: it names the row shape the
  // caller expects back, exactly as node-postgres' own `query<R>` does.
  query<R = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
  end(): Promise<void>;
  /**
   * Run a script of several statements. Present only on the embedded pool:
   * `query` speaks the extended protocol, which carries one statement per
   * message, so a migration file needs the simple protocol instead. A server
   * database gets its migrations from `drizzle-kit`, which does not go
   * through this interface.
   */
  exec?(sql: string): Promise<void>;
}

/**
 * pg.Pool over the embedded database. PGlite serialises its own queries, so
 * one instance is the pool; `max` has no meaning and is ignored rather than
 * faked. The instance itself belongs to `@nexus/db`, which also hands it to
 * the Drizzle client — one writer per data directory, or the files corrupt.
 */
class EmbeddedPool implements PgLike {
  private db: Promise<EmbeddedDb> | null = null;

  constructor(private readonly url: string) {}

  private open(): NonNullable<typeof this.db> {
    this.db ??= import("@nexus/db/embedded").then(({ getEmbeddedDb }) => getEmbeddedDb(this.url));
    return this.db;
  }

  async query<R = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }> {
    const db = await this.open();
    const res = await db.query(text, values);
    return {
      rows: res.rows as R[],
      rowCount: res.rowCount ?? res.affectedRows ?? res.rows.length,
    };
  }

  async exec(sql: string): Promise<void> {
    const db = await this.open();
    await db.exec(sql);
  }

  async end(): Promise<void> {
    if (!this.db) return;
    this.db = null;
    const { closeEmbeddedDb } = await import("@nexus/db/embedded");
    await closeEmbeddedDb(this.url);
  }
}

/**
 * Run a multi-statement DDL script on either backing.
 *
 * `query` speaks the extended protocol on the embedded database, which rejects
 * a script with "cannot insert multiple commands into a prepared statement";
 * node-postgres falls back to the simple protocol when there are no values, so
 * the same text works there. Schema setup goes through here instead.
 */
export function execScript(pool: PgLike, sql: string): Promise<unknown> {
  return pool.exec ? pool.exec(sql) : pool.query(sql);
}

/**
 * A URL the `@neondatabase/serverless` driver will accept.
 *
 * Several stores (`PgVectorStore`, `DrizzleSyncStore`, …) call `neon()` on
 * `DATABASE_URL` directly instead of going through this module, and `neon()`
 * *throws* on anything that is not `postgres(ql)://`. Those constructions sit
 * at module load, so an embedded (`pglite://`) URL takes the whole process
 * down at boot rather than falling back the way every other store does.
 * Call sites gate on this instead of on `DATABASE_URL` being merely set.
 */
export function isNeonCompatibleUrl(url: string | undefined): url is string {
  return !!url && /^postgres(ql)?:\/\//.test(url);
}

const pools = new Map<string, PgLike>();

/**
 * The shared pool for `url` (default: `DATABASE_URL`), or `null` when no
 * database is configured — the signal every caller already treats as "use the
 * file or in-memory store instead".
 */
export function getPgPool(url = process.env.DATABASE_URL): PgLike | null {
  if (!url) return null;
  let pool = pools.get(url);
  if (!pool) {
    pool = isEmbeddedUrl(url) ? new EmbeddedPool(url) : new Pool({ connectionString: url });
    pools.set(url, pool);
  }
  return pool;
}

/** Close every pool this process opened. For shutdown and for tests. */
export async function closePgPools(): Promise<void> {
  const open = [...pools.values()];
  pools.clear();
  await Promise.allSettled(open.map((p) => p.end()));
}
