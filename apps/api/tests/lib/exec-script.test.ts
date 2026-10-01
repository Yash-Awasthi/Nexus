// SPDX-License-Identifier: Apache-2.0
/**
 * Runs against a real embedded database: the claim is that a DDL script with
 * several statements applies to PGlite, which only executing it can show.
 */
import { describe, it, expect, afterAll } from "vitest";

import { closePgPools, execScript, getPgPool } from "../../src/lib/pg-pool.js";

const DB = "pglite://:memory:exec-script-test";

afterAll(async () => {
  await closePgPools();
});

describe("execScript", () => {
  it("applies a multi-statement DDL script on the embedded database", async () => {
    const pool = getPgPool(DB)!;

    await expect(
      pool.query(`
        CREATE TABLE IF NOT EXISTS es_probe (id text PRIMARY KEY);
        CREATE INDEX IF NOT EXISTS es_probe_id_idx ON es_probe (id);
      `),
    ).rejects.toThrow(/multiple commands/);

    await execScript(
      pool,
      `
        CREATE TABLE IF NOT EXISTS es_probe (id text PRIMARY KEY);
        CREATE INDEX IF NOT EXISTS es_probe_id_idx ON es_probe (id);
      `,
    );

    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'es_probe_id_idx'`,
    );
    expect(rows[0]?.n).toBe(1);
  });

  it("falls back to query when the pool has no exec (server database)", async () => {
    const seen: string[] = [];
    const fake = {
      query: async (text: string) => {
        seen.push(text);
        return { rows: [], rowCount: 0 };
      },
      end: async () => {},
    };

    await execScript(fake, "SELECT 1; SELECT 2;");
    expect(seen).toEqual(["SELECT 1; SELECT 2;"]);
  });
});
