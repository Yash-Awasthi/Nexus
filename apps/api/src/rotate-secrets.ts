// SPDX-License-Identifier: Apache-2.0
/**
 * Re-encrypt every stored provider credential under the current `NEXUS_SECRETS_KEY`, then exit.
 *
 *   NEXUS_SECRETS_KEY=<new> NEXUS_SECRETS_KEY_PREVIOUS=<old> node src/rotate-secrets.ts [--dry-run]
 *
 * The order matters and is documented in docs/runbook.md §11: set both keys, run this, then drop the previous
 * variable on the next deploy. Running it without `NEXUS_SECRETS_KEY_PREVIOUS` after the key has already been
 * swapped reports every row as `skipped (undecryptable)` instead of deleting anything — which is the report an
 * operator needs at that moment, not a half-rotated table.
 */
import { closePgPools, getPgPool } from "./lib/pg-pool.ts";
import { describeRotation, rotateProviderKeys } from "./lib/secret-rotation.ts";

const dryRun = process.argv.includes("--dry-run");
const pool = getPgPool();
if (!pool) {
  console.error("[rotate-secrets] DATABASE_URL is not set");
  process.exit(1);
}

try {
  const report = await rotateProviderKeys(pool, { dryRun });
  console.log(`[rotate-secrets]${dryRun ? " (dry run)" : ""} ${describeRotation(report)}`);
  // A skip is not a failure of this process — it is a row nobody can read, which is exactly what an operator has
  // to look at. Exiting non-zero makes it loud in a deploy log instead of a line somebody scrolls past.
  if (report.skipped.length > 0 || report.failed.length > 0) process.exitCode = 1;
} catch (err) {
  console.error(`[rotate-secrets] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await closePgPools();
}
