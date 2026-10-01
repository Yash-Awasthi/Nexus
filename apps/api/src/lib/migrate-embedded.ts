// SPDX-License-Identifier: Apache-2.0
/**
 * Applies `@nexus/db`'s migrations to the embedded (`pglite://`) database, or to a server
 * one through `src/migrate.ts` (docker compose's migrate step).
 *
 * A server database gets its schema from `drizzle-kit migrate` at deploy time.
 * The desktop app has no deploy step and no `drizzle-kit` at runtime, so
 * without this the embedded database held only the tables that stores create
 * for themselves — the Drizzle-schema tables (users, refresh_tokens,
 * provider_models) were absent and local sign-in could not work.
 *
 * The ledger is `nexus_drizzle_migrations`, the same table and the same
 * "sha256 of the file" hash `drizzle-kit` writes, so the two agree about what
 * has already run on a database either of them touched.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { execScript, type PgLike } from "./pg-pool.js";

interface Journal {
  entries: { idx: number; tag: string }[];
}

/** Where `@nexus/db` keeps its `.sql` files, resolved through the package. */
function migrationsDir(): string {
  const pkg = createRequire(import.meta.url).resolve("@nexus/db/package.json");
  return join(dirname(pkg), "migrations");
}

/**
 * PGlite ships without pgvector, so `0002_auto_schema_tables` cannot run there
 * and memory lives in lib/kv-memory-store.ts locally instead. Every other
 * migration is independent of it, so the run continues past this one error and
 * says so. Any other failure is a real schema problem and throws.
 */
function isMissingExtension(err: unknown): boolean {
  return /extension "[^"]+" is not available/.test((err as Error).message ?? "");
}

interface MigrateResult {
  applied: string[];
  skipped: string[];
}

/**
 * Bring `pool` up to the current schema. Idempotent: a migration whose hash is
 * already in the ledger is not run again.
 */
export async function migrateEmbedded(pool: PgLike, dir = migrationsDir()): Promise<MigrateResult> {
  const journal = JSON.parse(await readFile(join(dir, "meta", "_journal.json"), "utf8")) as Journal;
  const ordered = [...journal.entries].sort((a, b) => a.idx - b.idx);

  // The ledger itself is created by 0000, so the first run has no table to
  // read; an empty set is the honest answer to "what has run here".
  await execScript(
    pool,
    `CREATE TABLE IF NOT EXISTS "nexus_drizzle_migrations" (
       id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
  );
  const done = await pool.query<{ hash: string }>(`SELECT hash FROM nexus_drizzle_migrations`);
  const seen = new Set(done.rows.map((r) => r.hash));

  const result: MigrateResult = { applied: [], skipped: [] };
  for (const { tag } of ordered) {
    const sql = await readFile(join(dir, `${tag}.sql`), "utf8");
    const hash = createHash("sha256").update(sql).digest("hex");
    if (seen.has(hash)) continue;

    try {
      await execScript(pool, sql);
    } catch (err) {
      if (!isMissingExtension(err)) throw new Error(`migration ${tag} failed: ${String(err)}`);
      result.skipped.push(tag);
      continue;
    }
    await pool.query(`INSERT INTO nexus_drizzle_migrations (hash, created_at) VALUES ($1, $2)`, [
      hash,
      Date.now(),
    ]);
    result.applied.push(tag);
  }
  return result;
}
