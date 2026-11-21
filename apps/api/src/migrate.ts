// SPDX-License-Identifier: Apache-2.0
/** Bring DATABASE_URL up to the current schema and exit: the deploy-time migrate step. */
import { migrateEmbedded } from "./lib/migrate-embedded.ts";
import { withMigrationLock } from "./lib/migration-lock.ts";
import { closePgPools, getPgPool } from "./lib/pg-pool.ts";

const url = process.env.DATABASE_URL;
const pool = getPgPool();
if (!pool || !url) {
  console.error("[migrate] DATABASE_URL is not set");
  process.exit(1);
}

try {
  await withMigrationLock(url, async () => {
    const { applied, skipped } = await migrateEmbedded(pool);
    console.log(`[migrate] applied ${applied.length}, skipped ${skipped.join(", ") || "none"}`);
  });
} catch (err) {
  console.error(`[migrate] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await closePgPools();
}
