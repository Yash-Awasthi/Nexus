// SPDX-License-Identifier: Apache-2.0
/**
 * Runs against a real embedded database: the desktop app keeps chat threads in
 * this store, so what matters is that values, TTLs and counters survive SQL.
 */
import { describe, it, expect, afterAll } from "vitest";

import { closePgPools, getPgPool } from "../../src/lib/pg-pool.js";
import { PgKVStore } from "../../src/lib/shared-kv.js";

const kv = new PgKVStore(getPgPool("pglite://:memory:pg-kv-test")!);

afterAll(async () => {
  await closePgPools();
});

describe("PgKVStore", () => {
  it("round-trips JSON values and deletes them", async () => {
    await kv.set("thread:list:u1", ["a", "b"]);
    expect(await kv.get("thread:list:u1")).toEqual(["a", "b"]);
    await kv.set("thread:list:u1", ["c"]);
    expect(await kv.get("thread:list:u1")).toEqual(["c"]);
    await kv.delete("thread:list:u1");
    expect(await kv.get("thread:list:u1")).toBeUndefined();
  });

  it("hides expired keys", async () => {
    await kv.set("short", 1, 1);
    await new Promise((r) => setTimeout(r, 5));
    expect(await kv.has("short")).toBe(false);
  });

  it("matches keys by prefix, treating LIKE wildcards literally", async () => {
    await kv.set("p:1", 1);
    await kv.set("p:2", 2);
    await kv.set("p_x", 3);
    expect((await kv.keys("p:*")).sort()).toEqual(["p:1", "p:2"]);
  });

  it("increments atomically and restarts an expired counter", async () => {
    expect(await kv.incr("c", 60_000)).toBe(1);
    expect(await kv.incr("c", 60_000)).toBe(2);
    await kv.incr("gone", 1);
    await new Promise((r) => setTimeout(r, 5));
    expect(await kv.incr("gone", 1)).toBe(1);
  });
});
