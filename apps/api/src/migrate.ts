// SPDX-License-Identifier: Apache-2.0
/** Bring DATABASE_URL up to the current schema and exit: the deploy-time migrate step. */
import { migrateEmbedded } from "./lib/migrate-embedded.js";
import { closePgPools, getPgPool } from "./lib/pg-pool.js";

const pool = getPgPool();
if (!pool) {
  console.error("[migrate] DATABASE_URL is not set");
  process.exit(1);
}
try {
  const { applied, skipped } = await migrateEmbedded(pool);
  console.log(`[migrate] applied ${applied.length}, skipped ${skipped.join(", ") || "none"}`);
} catch (err) {
  console.error(`[migrate] ${String(err)}`);
  process.exitCode = 1;
} finally {
  await closePgPools();
}
