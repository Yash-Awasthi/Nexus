// SPDX-License-Identifier: Apache-2.0
/**
 * Cross-instance migration lock.
 *
 * Every API instance runs the migrate step on boot. Without coordination two
 * instances apply the same DDL at once and one fails on an object the other
 * just created. A Postgres advisory lock is per database and vanishes with the
 * session, so a crashed instance releases its claim without leaving a row.
 *
 * Embedded PGlite is a single local writer with no second instance to
 * coordinate with and no advisory-lock function, so it runs unlocked.
 */

import pg from "pg";

import { isEmbeddedUrl } from "./pg-pool.ts";

/** Advisory-lock key for the migration step ("nexu"). */
export const MIGRATION_LOCK_KEY = 0x6e657875;

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_RETRY_MS = 1_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface MigrationLockOptions {
  /** How long a waiting instance retries before giving up (migrations are seconds). */
  timeoutMs?: number;
  /** Delay between lock attempts. */
  retryMs?: number;
}

/**
 * Run `fn` while holding the migration advisory lock. The callback gets the
 * lock-holding client (null for embedded), so a caller can keep its migration
 * connection separate from the lock connection.
 */
export async function withMigrationLock<T>(
  url: string,
  fn: (lock: pg.Client | null) => Promise<T>,
  options: MigrationLockOptions = {},
): Promise<T> {
  if (isEmbeddedUrl(url)) return fn(null);

  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(`could not connect to acquire the migration lock: ${String(error)}`);
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const deadline = Date.now() + timeoutMs;
  let held = false;
  try {
    while (Date.now() < deadline) {
      const { rows } = await client.query<{ ok: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS ok",
        [MIGRATION_LOCK_KEY],
      );
      if (rows[0]?.ok) {
        held = true;
        break;
      }
      await sleep(retryMs);
    }
    if (!held) throw new Error(`timed out after ${timeoutMs}ms waiting for the migration lock`);
    return await fn(client);
  } finally {
    if (held) {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
    }
    await client.end().catch(() => {});
  }
}
