// SPDX-License-Identifier: Apache-2.0
/**
 * Rewriting stored provider credentials under a new encryption key (M6.2.4).
 *
 * A key rotation is not a config change: after `NEXUS_SECRETS_KEY` is swapped, every row written under the old key
 * is still on the old key. The two-step is `NEXUS_SECRETS_KEY_PREVIOUS` plus this pass, and then dropping the
 * previous variable — which is why the report distinguishes four outcomes instead of two:
 *
 *   rotated   — read with the previous key or the legacy envelope, re-written under the current key
 *   current   — already on the current key and envelope, nothing to do
 *   skipped   — could not be decrypted at all; listed with its id and left untouched rather than deleted
 *   failed    — the write itself failed; the row keeps its old value, because losing a key silently is worse
 *
 * The module takes a narrow SQL surface so it runs against the pool in production and a fake in a test, and it is
 * safe to run twice: the second run reports every row as `current`.
 */

import { decryptSecretAnyKey, encryptSecret, isCurrentEnvelope } from "@nexus/db/secret-crypto";

/** The slice of a `pg` pool this pass needs. */
export interface RotationPool {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface RotationReport {
  total: number;
  rotated: number;
  current: number;
  skipped: { id: string; reason: string }[];
  failed: { id: string; reason: string }[];
}

/** Where a row sits relative to the current key material. */
export const CURRENT_KEY_MATERIAL_VERSION = 2;

/**
 * Re-encrypt every stored provider credential.
 *
 * `dryRun` reports what would change without writing, so an operator can see the shape of a rotation before it
 * touches rows. Deleted rows (`deleted_at`) are included on purpose: a rotation that only rewrites live rows
 * leaves the old key's ciphertext in the table, which is the thing being rotated away from.
 */
export async function rotateProviderKeys(
  pool: RotationPool,
  options: { dryRun?: boolean } = {},
): Promise<RotationReport> {
  const { rows } = await pool.query<{
    id: string;
    encrypted_key: string | null;
    key_material_version: number;
  }>(
    `SELECT id, encrypted_key, key_material_version
       FROM user_provider_credentials
      WHERE encrypted_key IS NOT NULL
      ORDER BY id`,
  );

  const report: RotationReport = {
    total: rows.length,
    rotated: 0,
    current: 0,
    skipped: [],
    failed: [],
  };

  for (const row of rows) {
    const stored = row.encrypted_key;
    if (stored === null) continue;

    let plaintext: string;
    let usedKey: "current" | "previous";
    try {
      ({ plaintext, key: usedKey } = decryptSecretAnyKey(stored));
    } catch (error) {
      report.skipped.push({ id: row.id, reason: (error as Error).message });
      continue;
    }

    // Current key *and* current envelope: nothing to rewrite.
    if (usedKey === "current" && isCurrentEnvelope(stored)) {
      report.current += 1;
      continue;
    }

    if (options.dryRun) {
      report.rotated += 1;
      continue;
    }

    try {
      const next = encryptSecret(plaintext);
      await pool.query(
        `UPDATE user_provider_credentials
            SET encrypted_key = $2, key_material_version = $3, updated_at = now()
          WHERE id = $1`,
        [row.id, next, CURRENT_KEY_MATERIAL_VERSION],
      );
      report.rotated += 1;
    } catch (error) {
      report.failed.push({ id: row.id, reason: (error as Error).message });
    }
  }

  return report;
}

/** One line a cron job or a human can read: what changed, what was left. */
export function describeRotation(report: RotationReport): string {
  const parts = [
    `${report.total} credential(s) scanned`,
    `${report.rotated} rotated`,
    `${report.current} already current`,
  ];
  if (report.skipped.length > 0)
    parts.push(
      `${report.skipped.length} skipped (undecryptable: ${report.skipped.map((r) => r.id).join(", ")})`,
    );
  if (report.failed.length > 0) parts.push(`${report.failed.length} failed to write`);
  return parts.join(", ");
}
