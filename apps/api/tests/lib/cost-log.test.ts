// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import type { KVStore } from "@nexus/kv";
import { MemoryKVStore } from "@nexus/kv";

import { fetchWithTimeout, getSharedKV, withTimeout } from "../../src/lib/shared-kv.js";
import { CostLogStore, type CostEntry } from "../../src/lib/cost-log.js";

function entry(over: Partial<CostEntry> & { ts: string }): CostEntry {
  return { model: "ollama/qwen", inputTokens: 100, outputTokens: 50, costUsd: 0.0005, ...over };
}

// No REDIS_URL / UPSTASH env in tests → getSharedKV() falls back to the
// in-process MemoryKVStore. Clear it before every test so cases are isolated.
beforeEach(async () => {
  await getSharedKV().clear();
});

/**
 * A fresh store instance is a clean "process": it records into its own memory
 * and flushes/loads against the shared KV. That mirrors a restart — the first
 * instance flushes, the second loads what the first persisted.
 */
function freshStore(kv?: KVStore): CostLogStore {
  return new CostLogStore(kv);
}

describe("cost-log write-behind store", () => {
  it("flush then load round-trips recorded entries in order", async () => {
    const a = freshStore();
    a.record(entry({ ts: "2026-09-06T10:00:00.000Z", model: "m1", costUsd: 0.001 }));
    a.record(entry({ ts: "2026-09-06T10:00:01.000Z", model: "m2", costUsd: 0.002 }));
    await a.flush();

    const b = freshStore();
    await b.load();
    expect(b.entries.map((e) => e.ts)).toEqual([
      "2026-09-06T10:00:00.000Z",
      "2026-09-06T10:00:01.000Z",
    ]);
    expect(b.entries[0]?.costUsd).toBe(0.001);
    expect(b.entries[1]?.model).toBe("m2");
  });

  it("an empty flush is a no-op and never duplicates", async () => {
    const a = freshStore();
    a.record(entry({ ts: "2026-09-06T10:00:00.000Z" }));
    await a.flush();
    await a.flush(); // nothing new — second flush must not re-append
    a.record(entry({ ts: "2026-09-06T10:00:02.000Z" }));
    await a.flush();

    const b = freshStore();
    await b.load();
    expect(b.entries).toHaveLength(2);
    expect(b.entries.map((e) => e.ts)).toEqual([
      "2026-09-06T10:00:00.000Z",
      "2026-09-06T10:00:02.000Z",
    ]);
  });

  it("batches across flushes into the same day key", async () => {
    const a = freshStore();
    a.record(entry({ ts: "2026-09-06T09:00:00.000Z" }));
    await a.flush();
    a.record(entry({ ts: "2026-09-06T10:00:00.000Z" }));
    await a.flush();

    const b = freshStore();
    await b.load();
    expect(b.entries).toHaveLength(2);
  });

  it("shards by day and reloads across days chronologically", async () => {
    const a = freshStore();
    a.record(entry({ ts: "2026-09-05T23:59:59.000Z" }));
    a.record(entry({ ts: "2026-09-06T00:00:01.000Z" }));
    await a.flush();

    const b = freshStore();
    await b.load();
    expect(b.entries.map((e) => e.ts.slice(0, 10))).toEqual(["2026-09-05", "2026-09-06"]);

    const dayKeys = (await getSharedKV().keys("*")).filter((k) => k.startsWith("costlog:day:"));
    expect(dayKeys.sort()).toEqual(["costlog:day:2026-09-05", "costlog:day:2026-09-06"]);
  });

  it("keeps the newest MAX entries after a restart (same cap the hot path used)", async () => {
    const a = freshStore();
    const many = 10_005;
    for (let i = 0; i < many; i++) {
      a.record(entry({ ts: new Date(Date.UTC(2026, 8, 6, 0, 0, 0, i)).toISOString() }));
    }
    // In-memory cap trims the oldest as it grows (10000 of 10005 remain: ms 5..10004).
    expect(a.entries).toHaveLength(10_000);
    await a.flush();

    const b = freshStore();
    await b.load();
    expect(b.entries).toHaveLength(10_000);
    expect(b.entries[0]?.ts).toBe(new Date(Date.UTC(2026, 8, 6, 0, 0, 0, 5)).toISOString());
    expect(b.entries.at(-1)?.ts).toBe(
      new Date(Date.UTC(2026, 8, 6, 0, 0, 0, 10_004)).toISOString(),
    );
  });

  it("load on an empty KV is safe", async () => {
    const b = freshStore();
    await b.load();
    expect(b.entries).toHaveLength(0);
  });

  it("load() fails open when the KV never settles (boot must not hang)", async () => {
    // A store whose keys() never resolves (Redis/Upstash unreachable, fetch
    // dropped) — the exact condition that used to hang Fastify plugin
    // registration past its ~10s cap and fatal the server.
    const hanging: KVStore = {
      get: () => new Promise(() => {}),
      set: async () => {},
      delete: async () => {},
      has: async () => false,
      keys: () => new Promise(() => {}),
      clear: async () => {},
      getOrSet: () => new Promise(() => {}),
      incr: async () => 0,
    };
    const store = new CostLogStore(hanging);
    const started = Date.now();
    // Must RESOLVE (degrade to an empty in-memory log), not hang or throw.
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.entries).toHaveLength(0);
    // And it must do so well inside Fastify's ~10s plugin cap.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("withTimeout rejects a never-settling promise within the bound", async () => {
    const started = Date.now();
    await expect(withTimeout(new Promise(() => {}), 100, "probe")).rejects.toThrow(
      "probe timed out after 100ms",
    );
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("withTimeout resolves normally when the promise wins the race", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1_000, "probe")).resolves.toBe("ok");
  });

  it("fetchWithTimeout aborts a fetch that never settles", async () => {
    const origFetch = globalThis.fetch;
    // A fetch that ignores the signal and never settles (dropped connection).
    globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch;
    try {
      const started = Date.now();
      await expect(fetchWithTimeout("http://kv.invalid/pipeline", {}, 150)).rejects.toThrow(
        /timed out after 150ms/,
      );
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("fetchWithTimeout passes a live result through untouched on the happy path", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      void init;
      return new Response(JSON.stringify([{ result: "pong" }]), { status: 200 });
    }) as typeof fetch;
    try {
      const res = await fetchWithTimeout("http://kv.invalid/pipeline", {}, 1_000);
      const json = (await res.json()) as { result: string }[];
      expect(json[0]?.result).toBe("pong");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("load() mutates in place — a pre-bound read view sees the restored entries", async () => {
    // api-bridge binds its `_costLog` to `costLogStore.entries` once at module
    // eval, BEFORE boot load() runs. load() must therefore fill the SAME array
    // object; reassigning it would strand every reader on an empty snapshot.
    const a = freshStore();
    a.record(entry({ ts: "2026-09-06T10:00:00.000Z" }));
    await a.flush();

    const b = freshStore();
    const boundView = b.entries; // bind before load, like the route module does
    await b.load();
    expect(boundView).toHaveLength(1);
    expect(boundView[0]?.ts).toBe("2026-09-06T10:00:00.000Z");
  });

  it("flush tolerates KV failure, keeps entries in memory, and retries later", async () => {
    // Broken KV: writes throw. flush() must resolve, not lose in-memory state.
    const broken = new MemoryKVStore();
    const originalSet = broken.set.bind(broken);
    broken.set = (async () => {
      throw new Error("kv down");
    }) as unknown as typeof broken.set;
    const a = freshStore(broken);
    a.record(entry({ ts: "2026-09-06T10:00:00.000Z" }));
    await expect(a.flush()).resolves.toBeUndefined();
    expect(a.entries).toHaveLength(1); // memory intact — reads still work

    // KV recovers → the watermark never advanced, so the retry persists the
    // entry into the same KV the failed flush targeted.
    broken.set = originalSet;
    await a.flush();
    const b = freshStore(broken);
    await b.load();
    expect(b.entries).toHaveLength(1);
  });

  it("load tolerates a KV that cannot list keys", async () => {
    const broken = new MemoryKVStore();
    broken.keys = async () => {
      throw new Error("kv down");
    };
    const a = freshStore(broken);
    await expect(a.load()).resolves.toBeUndefined();
    expect(a.entries).toHaveLength(0);
  });
});

describe("cost-log flushStats", () => {
  it("tracks pending entries, flush recency, and failure counters", async () => {
    const a = freshStore();
    // Fresh store: nothing dirty, never flushed.
    expect(a.flushStats()).toEqual({
      pendingEntries: 0,
      dirty: false,
      lastFlushAt: null,
      lastFlushAgeMs: null,
      consecutiveFailures: 0,
      totalFlushes: 0,
      totalFailures: 0,
    });

    a.record(entry({ ts: "2026-09-06T10:00:00.000Z" }));
    const dirty = a.flushStats();
    expect(dirty.pendingEntries).toBe(1);
    expect(dirty.dirty).toBe(true);

    await a.flush();
    const clean = a.flushStats();
    expect(clean.pendingEntries).toBe(0);
    expect(clean.dirty).toBe(false);
    expect(clean.totalFlushes).toBe(1);
    expect(clean.consecutiveFailures).toBe(0);
    expect(clean.lastFlushAt).not.toBeNull();
    expect(clean.lastFlushAgeMs).toBeGreaterThanOrEqual(0);
  });

  it("counts consecutive failures after a broken KV flush and resets on success", async () => {
    const broken = new MemoryKVStore();
    const originalSet = broken.set.bind(broken);
    broken.set = (async () => {
      throw new Error("kv down");
    }) as unknown as typeof broken.set;
    const a = freshStore(broken);
    a.record(entry({ ts: "2026-09-06T10:00:00.000Z" }));
    await a.flush();
    expect(a.flushStats().consecutiveFailures).toBe(1);
    await a.flush(); // second failure — watermark never advanced, still dirty
    expect(a.flushStats().consecutiveFailures).toBe(2);
    expect(a.flushStats().totalFailures).toBe(2);

    broken.set = originalSet;
    await a.flush(); // KV back → succeeds, resets the streak
    const s = a.flushStats();
    expect(s.consecutiveFailures).toBe(0);
    expect(s.totalFlushes).toBe(1);
    expect(s.totalFailures).toBe(2); // total is cumulative — never reset
  });
});

describe("cost-log graceful-shutdown close()", () => {
  it("flushes the pending tail so a clean close loses ~zero", async () => {
    const a = freshStore();
    a.record(entry({ ts: "2026-09-06T10:00:00.000Z" }));
    a.record(entry({ ts: "2026-09-06T10:00:01.000Z" }));
    // No debounce wait — close() must flush synchronously with the tail.
    await a.close();

    const b = freshStore();
    await b.load();
    expect(b.entries).toHaveLength(2);
  });

  it("is a no-op when nothing is dirty", async () => {
    const a = freshStore();
    await a.close();
    const s = a.flushStats();
    expect(s.dirty).toBe(false);
    expect(s.totalFlushes).toBe(0);
  });

  it("is bounded — a hanging KV cannot stall process exit", async () => {
    const hung = new MemoryKVStore();
    // A set that never settles simulates a dead Redis connection.
    hung.set = (() => new Promise<void>(() => {})) as unknown as typeof hung.set;
    const a = freshStore(hung);
    a.record(entry({ ts: "2026-09-06T10:00:00.000Z" }));
    const started = Date.now();
    await a.close(50); // 50 ms bound
    expect(Date.now() - started).toBeLessThan(2_000);
    // Not persisted — the tail is still pending and memory is intact for reads.
    expect(a.entries).toHaveLength(1);
    expect(a.flushStats().pendingEntries).toBe(1);
  });

  it("serializes with an in-flight flush — no concurrent day-key writes", async () => {
    const kv = new MemoryKVStore();
    const a = freshStore(kv);
    a.record(entry({ ts: "2026-09-06T10:00:00.000Z" }));
    // Start a debounced flush, then close() while it is in flight: close must
    // wait for the first flush to finish (which advances the watermark), so
    // the second is a no-op — the day key holds exactly one copy of the entry.
    const p1 = a.flush();
    const p2 = a.close();
    await Promise.all([p1, p2]);
    const dayKeys = (await kv.keys("*")).filter((k) => k.startsWith("costlog:day:"));
    const stored = (await kv.get<CostEntry[]>(dayKeys[0] ?? "")) ?? [];
    expect(stored).toHaveLength(1);
  });
});
