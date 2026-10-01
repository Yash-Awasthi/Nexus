// SPDX-License-Identifier: Apache-2.0
/**
 * The shared pool factory, and the embedded (pglite://) backing that lets the
 * desktop app run the real API without a database server.
 *
 * The embedded case is exercised for real rather than mocked: the whole point
 * of the adapter is that callers cannot tell it from node-postgres, and only a
 * real query proves the result shape matches.
 */
import { describe, it, expect, afterAll } from "vitest";

import { closePgPools, getPgPool, isEmbeddedUrl } from "../../src/lib/pg-pool.js";

const MEM = "pglite://:memory:";

afterAll(async () => {
  await closePgPools();
});

describe("getPgPool", () => {
  it("returns null when no database is configured", () => {
    expect(getPgPool("")).toBeNull();
  });

  it("hands the same pool to every caller of one URL", () => {
    expect(getPgPool(MEM)).toBe(getPgPool(MEM));
    expect(getPgPool(MEM)).not.toBe(getPgPool("pglite://:memory:other"));
  });

  it("recognises the embedded scheme and only that", () => {
    expect(isEmbeddedUrl(MEM)).toBe(true);
    expect(isEmbeddedUrl("postgresql://user@host/db")).toBe(false);
  });
});

describe("embedded pool", () => {
  it("runs real SQL and answers in the pg result shape", async () => {
    const pool = getPgPool("pglite://:memory:sql-test");
    expect(pool).not.toBeNull();

    await pool!.query(`CREATE TABLE IF NOT EXISTS kv (k text PRIMARY KEY, v int)`);
    const written = await pool!.query(`INSERT INTO kv (k, v) VALUES ($1, $2)`, ["a", 1]);
    const read = await pool!.query<{ k: string; v: number }>(`SELECT k, v FROM kv WHERE k = $1`, [
      "a",
    ]);

    expect(written.rowCount).toBe(1);
    expect(read.rows).toEqual([{ k: "a", v: 1 }]);
    expect(read.rowCount).toBe(1);
  }, 60_000);

  it("reports no rows rather than throwing on an empty result", async () => {
    const pool = getPgPool("pglite://:memory:sql-test");

    const empty = await pool!.query(`SELECT k FROM kv WHERE k = $1`, ["missing"]);

    expect(empty.rows).toEqual([]);
    expect(empty.rowCount).toBe(0);
  }, 60_000);
});
