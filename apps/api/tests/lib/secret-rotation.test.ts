// SPDX-License-Identifier: Apache-2.0
/**
 * A key rotation is the one maintenance operation where a bug is silent: every row it fails to rewrite still
 * works, until the deploy that drops the old key and the whole table goes unreadable at once.
 *
 * So the properties tested here are the ones that make the pass safe to run twice, and safe to run wrong:
 *  - a row on the previous key is re-encrypted and marked `2`;
 *  - a row already on the current key is left alone (byte-identical), so a second run is a no-op;
 *  - a row nobody can decrypt is *reported*, not deleted and not overwritten;
 *  - a dry run writes nothing;
 *  - a row that fails to write keeps its old ciphertext — losing a key silently is worse than a failed rotation.
 */
import { randomBytes } from "node:crypto";

import { beforeEach, describe, expect, it } from "vite-plus/test";

import { describeRotation, rotateProviderKeys } from "../../src/lib/secret-rotation.ts";
import {
  SECRET_ENVELOPE,
  decryptSecret,
  decryptWithKey,
  encryptSecret,
  encryptWithKey,
  isCurrentEnvelope,
} from "../../src/lib/secret-crypto.ts";

const CURRENT = randomBytes(32).toString("hex");
const PREVIOUS = randomBytes(32).toString("hex");

/** A tiny stand-in for the credential table, with the same column names the SQL uses. */
function fakeTable(
  rows: { id: string; encrypted_key: string | null; key_material_version: number }[],
) {
  const writes: { id: string; value: string; version: number }[] = [];
  const pool = {
    async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
      if (/^\s*SELECT/i.test(sql)) return { rows: rows as unknown as T[] };
      if (/^\s*UPDATE/i.test(sql)) {
        const [id, value, version] = params as [string, string, number];
        const row = rows.find((candidate) => candidate.id === id);
        if (row) {
          row.encrypted_key = value;
          row.key_material_version = version;
        }
        writes.push({ id, value, version });
        return { rows: [] as T[] };
      }
      throw new Error(`unexpected SQL: ${sql.slice(0, 40)}`);
    },
  };
  return { pool, rows, writes };
}

beforeEach(() => {
  process.env.NEXUS_SECRETS_KEY = CURRENT;
  process.env.NEXUS_SECRETS_KEY_PREVIOUS = PREVIOUS;
});

describe("provider key rotation", () => {
  it("re-encrypts a row written under the previous key and marks it current", async () => {
    const legacyEnvelope =
      SECRET_ENVELOPE + encryptWithKey(Buffer.from(PREVIOUS, "hex"), "gsk_old_key");
    const table = fakeTable([{ id: "a", encrypted_key: legacyEnvelope, key_material_version: 1 }]);

    const report = await rotateProviderKeys(table.pool);

    expect(report.rotated).toBe(1);
    expect(table.rows[0]!.key_material_version).toBe(2);
    expect(decryptSecret(table.rows[0]!.encrypted_key!)).toBe("gsk_old_key");
    expect(table.rows[0]!.encrypted_key).not.toBe(legacyEnvelope);
  });

  it("rewrites a legacy bare-base64 row as well, because rotation is about the form too", async () => {
    const bare = encryptWithKey(Buffer.from(CURRENT, "hex"), "sk-live");
    expect(isCurrentEnvelope(bare)).toBe(false);
    const table = fakeTable([{ id: "b", encrypted_key: bare, key_material_version: 1 }]);

    const report = await rotateProviderKeys(table.pool);

    expect(report.rotated).toBe(1);
    expect(isCurrentEnvelope(table.rows[0]!.encrypted_key!)).toBe(true);
    expect(decryptSecret(table.rows[0]!.encrypted_key!)).toBe("sk-live");
  });

  it("is idempotent: a second run touches no row", async () => {
    const table = fakeTable([
      { id: "c", encrypted_key: encryptSecret("already"), key_material_version: 2 },
    ]);
    const before = table.rows[0]!.encrypted_key;

    const report = await rotateProviderKeys(table.pool);

    expect(report.rotated).toBe(0);
    expect(report.current).toBe(1);
    expect(table.writes).toEqual([]);
    expect(table.rows[0]!.encrypted_key).toBe(before);
  });

  it("reports a row nobody can decrypt instead of deleting or overwriting it", async () => {
    const garbage = SECRET_ENVELOPE + randomBytes(48).toString("base64");
    const table = fakeTable([{ id: "d", encrypted_key: garbage, key_material_version: 1 }]);

    const report = await rotateProviderKeys(table.pool);

    expect(report.skipped.map((row) => row.id)).toEqual(["d"]);
    expect(report.rotated).toBe(0);
    expect(table.writes).toEqual([]);
    expect(table.rows[0]!.encrypted_key).toBe(garbage);
    expect(describeRotation(report)).toContain("skipped");
  });

  it("writes nothing on a dry run, but still counts what would change", async () => {
    const table = fakeTable([
      {
        id: "e",
        encrypted_key: encryptWithKey(Buffer.from(PREVIOUS, "hex"), "old"),
        key_material_version: 1,
      },
      { id: "f", encrypted_key: encryptSecret("fresh"), key_material_version: 2 },
    ]);

    const report = await rotateProviderKeys(table.pool, { dryRun: true });

    expect(report.rotated).toBe(1);
    expect(report.current).toBe(1);
    expect(table.writes).toEqual([]);
  });

  it("keeps the old ciphertext when the write fails, and says so", async () => {
    const legacy = SECRET_ENVELOPE + encryptWithKey(Buffer.from(PREVIOUS, "hex"), "keep me");
    const rows = [{ id: "g", encrypted_key: legacy, key_material_version: 1 }];
    const pool = {
      async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
        if (/^\s*SELECT/i.test(sql)) return { rows: rows as unknown as T[] };
        void params;
        throw new Error("connection reset");
      },
    };

    const report = await rotateProviderKeys(pool);

    expect(report.failed.map((row) => row.id)).toEqual(["g"]);
    expect(report.rotated).toBe(0);
    expect(rows[0]!.encrypted_key).toBe(legacy);
  });

  it("skips rows with no key material, which local providers legitimately have", async () => {
    const table = fakeTable([{ id: "h", encrypted_key: null, key_material_version: 1 }]);
    const report = await rotateProviderKeys(table.pool);
    expect(report).toMatchObject({ total: 1, rotated: 0, current: 0 });
    expect(report.skipped).toEqual([]);
    expect(table.writes).toEqual([]);
  });

  it("refuses to call a rotation successful when every row is unreadable", async () => {
    const table = fakeTable([
      {
        id: "i",
        encrypted_key: SECRET_ENVELOPE + randomBytes(48).toString("base64"),
        key_material_version: 1,
      },
      {
        id: "j",
        encrypted_key: SECRET_ENVELOPE + randomBytes(48).toString("base64"),
        key_material_version: 1,
      },
    ]);
    const report = await rotateProviderKeys(table.pool);
    expect(report.skipped).toHaveLength(2);
    expect(describeRotation(report)).toMatch(/2 skipped/);
  });

  it("says which key it used when both are available", async () => {
    const { decryptSecretAnyKey } = await import("../../src/lib/secret-crypto.ts");
    const fromPrevious = SECRET_ENVELOPE + encryptWithKey(Buffer.from(PREVIOUS, "hex"), "x");
    const fromCurrent = encryptSecret("y");
    expect(decryptSecretAnyKey(fromPrevious)).toEqual({ plaintext: "x", key: "previous" });
    expect(decryptSecretAnyKey(fromCurrent)).toEqual({ plaintext: "y", key: "current" });
    // A caller that skips the fallback (the request path) still reads only the current key.
    expect(() => decryptSecret(fromPrevious)).toThrow();
    expect(SECRET_ENVELOPE).toBe("v1:");
  });
});
