// SPDX-License-Identifier: Apache-2.0
/**
 * The shared memory store on the embedded database: pgvector search, and the
 * one-time move of entries that older desktop builds kept in nexus_kv.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const DB = "pglite://:memory:memory-store-embedded";

function vec(hot: number): number[] {
  return Array.from({ length: 768 }, (_, i) => (i === hot ? 1 : 0));
}

let getMemoryStore: typeof import("../../src/lib/memory-store.js").getMemoryStore;
let getPgPool: typeof import("../../src/lib/pg-pool.js").getPgPool;
let closePgPools: typeof import("../../src/lib/pg-pool.js").closePgPools;

beforeAll(async () => {
  process.env.DATABASE_URL = DB;
  ({ getPgPool, closePgPools } = await import("../../src/lib/pg-pool.js"));
  const pool = getPgPool(DB)!;
  await pool.query(`CREATE TABLE IF NOT EXISTS nexus_kv (
    collection TEXT NOT NULL, id TEXT NOT NULL, data JSONB NOT NULL, PRIMARY KEY (collection, id))`);
  const legacy = { id: "old", text: "kept from kv", embedding: vec(1), metadata: {}, createdAt: 1 };
  await pool.query(
    `INSERT INTO nexus_kv (collection, id, data) VALUES ('memory_entries', $1, $2)`,
    ["old", JSON.stringify(legacy)],
  );
  ({ getMemoryStore } = await import("../../src/lib/memory-store.js"));
}, 120_000);

afterAll(async () => {
  await closePgPools();
  delete process.env.DATABASE_URL;
});

describe("memory store on the embedded database", () => {
  it("ranks by cosine similarity in pgvector", async () => {
    const store = getMemoryStore();
    await store.save({ id: "a", text: "alpha", embedding: vec(2), metadata: {}, createdAt: 2 });
    await store.save({ id: "b", text: "beta", embedding: vec(3), metadata: {}, createdAt: 3 });

    const hits = await store.search(vec(3), 1);

    expect(hits.map((h) => h.entry.id)).toEqual(["b"]);
    const rows = await getPgPool(DB)!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM memory_entries`,
    );
    expect(rows.rows[0]!.n).toBe(3);
  }, 120_000);

  it("moves entries from nexus_kv into memory_entries once", async () => {
    const hits = await getMemoryStore().search(vec(1), 1);
    expect(hits.map((h) => h.entry.text)).toEqual(["kept from kv"]);

    const left = await getPgPool(DB)!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM nexus_kv WHERE collection = 'memory_entries'`,
    );
    expect(left.rows[0]!.n).toBe(0);
  }, 60_000);
});
