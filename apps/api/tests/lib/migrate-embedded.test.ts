// SPDX-License-Identifier: Apache-2.0
/**
 * Runs against a real embedded database rather than a mock: the claim under
 * test is that the shipped `.sql` files apply to PGlite and leave the tables
 * sign-in needs, which only executing them can show.
 */
import { describe, it, expect, afterAll } from "vitest";

import { migrateEmbedded } from "../../src/lib/migrate-embedded.js";
import { closePgPools, getPgPool } from "../../src/lib/pg-pool.js";

const DB = "pglite://:memory:migrate-test";

afterAll(async () => {
  await closePgPools();
});

async function tableExists(name: string): Promise<boolean> {
  const pool = getPgPool(DB)!;
  const res = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1`,
    [name],
  );
  return res.rows[0]!.n === 1;
}

describe("migrateEmbedded", () => {
  it("applies every migration, pgvector's included, and creates the tables sign-in needs", async () => {
    const { applied, skipped } = await migrateEmbedded(getPgPool(DB)!);

    expect(applied).toContain("0002_auto_schema_tables");
    expect(skipped).toEqual([]);
    const tables = ["users", "refresh_tokens", "provider_models", "api_keys", "memory_entries"];
    const present = [];
    for (const t of tables) {
      if (await tableExists(t)) present.push(t);
    }
    expect(present).toEqual(tables);
  }, 120_000);

  it("accepts a user row, so local sign-in has somewhere to write", async () => {
    const pool = getPgPool(DB)!;

    await pool.query(`INSERT INTO users (email, password_hash) VALUES ($1, $2)`, [
      "local@example.test",
      "argon2-placeholder",
    ]);
    const read = await pool.query<{ email: string }>(`SELECT email FROM users WHERE email = $1`, [
      "local@example.test",
    ]);

    expect(read.rows).toEqual([{ email: "local@example.test" }]);
  }, 60_000);

  it("applies nothing on a second run", async () => {
    const again = await migrateEmbedded(getPgPool(DB)!);

    expect(again.applied).toEqual([]);
  }, 60_000);

  it("runs on a server pool, whose query runs a whole script", async () => {
    const sent: string[] = [];
    const server = {
      query: async (sql: string) => {
        sent.push(sql);
        return { rows: [], rowCount: 0 };
      },
      end: async () => {},
    };

    const { applied } = await migrateEmbedded(server as never);
    expect(applied.length).toBeGreaterThan(0);
    expect(sent.some((sql) => /CREATE TABLE (IF NOT EXISTS )?"?users"? \(/i.test(sql))).toBe(true);
  });
});
