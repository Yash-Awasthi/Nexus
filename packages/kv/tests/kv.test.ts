// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  KVError,
  MemoryKVStore,
  RedisKVStore,
  MemoryPubSub,
  MemoryDistributedLock,
  RedisDistributedLock,
  type KVStore,
  type PubSubHandler,
  type RedisClientLike,
} from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

let _time = 1_000_000;
const mockNow = () => _time;
const advanceMs = (ms: number) => {
  _time += ms;
};
const resetClock = () => {
  _time = 1_000_000;
};

function makeRedisClient(): RedisClientLike & {
  _store: Map<string, { value: string; expiresAt?: number }>;
} {
  const store = new Map<string, { value: string; expiresAt?: number }>();
  const now = () => Date.now();
  return {
    _store: store,
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== undefined && now() >= entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, opts) {
      if (opts?.NX && store.has(key)) {
        const entry = store.get(key)!;
        if (entry.expiresAt === undefined || now() < entry.expiresAt) return null;
      }
      store.set(key, { value, expiresAt: opts?.PX ? now() + opts.PX : undefined });
      return "OK";
    },
    async del(key) {
      const keys = Array.isArray(key) ? key : [key];
      let count = 0;
      for (const k of keys) {
        if (store.delete(k)) count++;
      }
      return count;
    },
    async exists(key) {
      return store.has(key) ? 1 : 0;
    },
    async keys(pattern) {
      const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : undefined;
      const result: string[] = [];
      for (const k of store.keys()) {
        if (prefix !== undefined ? k.startsWith(prefix) : k === pattern) result.push(k);
      }
      return result;
    },
    async flushAll() {
      store.clear();
      return "OK";
    },
    async eval(_script, { keys, arguments: args }) {
      // Simulate compare-and-delete Lua script
      const val = store.get(keys[0]!);
      if (val?.value === args[0]) {
        store.delete(keys[0]!);
        return 1;
      }
      return 0;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// KVError
// ─────────────────────────────────────────────────────────────────────────────

describe("KVError", () => {
  it("is an Error with name KVError", () => {
    const e = new KVError("msg", "CODE");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("KVError");
  });

  it("exposes code and context", () => {
    const e = new KVError("msg", "MY_CODE", { key: "x" });
    expect(e.code).toBe("MY_CODE");
    expect(e.context).toEqual({ key: "x" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MemoryKVStore
// ─────────────────────────────────────────────────────────────────────────────

describe("MemoryKVStore", () => {
  let kv: MemoryKVStore;

  beforeEach(() => {
    resetClock();
    kv = new MemoryKVStore({ now: mockNow });
  });

  // ── get / set ──────────────────────────────────────────────────────────────

  it("returns undefined for unknown key", async () => {
    expect(await kv.get("missing")).toBeUndefined();
  });

  it("stores and retrieves a string", async () => {
    await kv.set("k", "hello");
    expect(await kv.get("k")).toBe("hello");
  });

  it("stores and retrieves an object", async () => {
    await kv.set("obj", { a: 1, b: [2, 3] });
    expect(await kv.get("obj")).toEqual({ a: 1, b: [2, 3] });
  });

  it("stores and retrieves a number", async () => {
    await kv.set("n", 42);
    expect(await kv.get<number>("n")).toBe(42);
  });

  it("overwrites on same key", async () => {
    await kv.set("k", "first");
    await kv.set("k", "second");
    expect(await kv.get("k")).toBe("second");
  });

  // ── TTL ───────────────────────────────────────────────────────────────────

  it("returns value before TTL expires", async () => {
    await kv.set("k", "val", 1000);
    advanceMs(999);
    expect(await kv.get("k")).toBe("val");
  });

  it("returns undefined after TTL expires", async () => {
    await kv.set("k", "val", 1000);
    advanceMs(1000);
    expect(await kv.get("k")).toBeUndefined();
  });

  it("zero ttlMs stores without expiry", async () => {
    await kv.set("k", "val", 0);
    advanceMs(999_999);
    expect(await kv.get("k")).toBe("val");
  });

  // ── delete / has ──────────────────────────────────────────────────────────

  it("delete removes a key", async () => {
    await kv.set("k", "v");
    await kv.delete("k");
    expect(await kv.get("k")).toBeUndefined();
  });

  it("delete is a no-op for unknown key", async () => {
    await expect(kv.delete("missing")).resolves.toBeUndefined();
  });

  it("has returns true for existing key", async () => {
    await kv.set("k", "v");
    expect(await kv.has("k")).toBe(true);
  });

  it("has returns false for missing key", async () => {
    expect(await kv.has("missing")).toBe(false);
  });

  it("has returns false for expired key", async () => {
    await kv.set("k", "v", 100);
    advanceMs(200);
    expect(await kv.has("k")).toBe(false);
  });

  // ── keys ──────────────────────────────────────────────────────────────────

  it("keys() returns all keys", async () => {
    await kv.set("a", 1);
    await kv.set("b", 2);
    const k = await kv.keys();
    expect(k.sort()).toEqual(["a", "b"]);
  });

  it("keys('*') returns all keys", async () => {
    await kv.set("x", 1);
    await kv.set("y", 2);
    const k = await kv.keys("*");
    expect(k.sort()).toEqual(["x", "y"]);
  });

  it("keys with prefix pattern filters by prefix", async () => {
    await kv.set("user:1", 1);
    await kv.set("user:2", 2);
    await kv.set("session:1", 3);
    const k = await kv.keys("user:*");
    expect(k.sort()).toEqual(["user:1", "user:2"]);
  });

  it("keys excludes expired entries", async () => {
    await kv.set("fresh", 1);
    await kv.set("stale", 2, 100);
    advanceMs(200);
    const k = await kv.keys();
    expect(k).toEqual(["fresh"]);
  });

  // ── clear ─────────────────────────────────────────────────────────────────

  it("clear removes all entries", async () => {
    await kv.set("a", 1);
    await kv.set("b", 2);
    await kv.clear();
    expect(await kv.keys()).toHaveLength(0);
    expect(kv.size).toBe(0);
  });

  // ── getOrSet ──────────────────────────────────────────────────────────────

  it("getOrSet returns existing value without calling factory", async () => {
    await kv.set("k", "cached");
    const factory = vi.fn().mockResolvedValue("fresh");
    const result = await kv.getOrSet("k", factory);
    expect(result).toBe("cached");
    expect(factory).not.toHaveBeenCalled();
  });

  it("getOrSet calls factory on cache miss and stores result", async () => {
    const factory = vi.fn().mockResolvedValue("computed");
    const result = await kv.getOrSet("k", factory);
    expect(result).toBe("computed");
    expect(factory).toHaveBeenCalledTimes(1);
    expect(await kv.get("k")).toBe("computed");
  });

  it("getOrSet respects TTL on stored value", async () => {
    await kv.getOrSet("k", async () => "v", 500);
    advanceMs(600);
    const factory2 = vi.fn().mockResolvedValue("refreshed");
    const result = await kv.getOrSet("k", factory2);
    expect(result).toBe("refreshed");
    expect(factory2).toHaveBeenCalledTimes(1);
  });

  // ── size ──────────────────────────────────────────────────────────────────

  it("size reflects live (non-expired) entry count", async () => {
    await kv.set("a", 1);
    await kv.set("b", 2, 100);
    expect(kv.size).toBe(2);
    advanceMs(200);
    expect(kv.size).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RedisKVStore
// ─────────────────────────────────────────────────────────────────────────────

describe("RedisKVStore", () => {
  let client: ReturnType<typeof makeRedisClient>;
  let kv: RedisKVStore;

  beforeEach(() => {
    client = makeRedisClient();
    kv = new RedisKVStore(client);
  });

  it("returns undefined for missing key", async () => {
    expect(await kv.get("x")).toBeUndefined();
  });

  it("serialises and retrieves objects", async () => {
    await kv.set("obj", { foo: "bar" });
    expect(await kv.get("obj")).toEqual({ foo: "bar" });
  });

  it("has returns true for existing key", async () => {
    await kv.set("k", 1);
    expect(await kv.has("k")).toBe(true);
  });

  it("has returns false for missing key", async () => {
    expect(await kv.has("missing")).toBe(false);
  });

  it("delete removes key", async () => {
    await kv.set("k", 1);
    await kv.delete("k");
    expect(await kv.get("k")).toBeUndefined();
  });

  it("keys() returns stored keys", async () => {
    await kv.set("a", 1);
    await kv.set("b", 2);
    const k = await kv.keys("*");
    expect(k.sort()).toEqual(["a", "b"]);
  });

  it("clear flushes all", async () => {
    await kv.set("a", 1);
    await kv.clear();
    expect(await kv.keys()).toHaveLength(0);
  });

  it("keyPrefix is prepended to all keys", async () => {
    const prefixed = new RedisKVStore(client, { keyPrefix: "ns" });
    await prefixed.set("k", "v");
    // Internal redis key should include prefix
    expect(client._store.has("ns:k")).toBe(true);
  });

  it("keys() strips prefix when returning keys", async () => {
    const prefixed = new RedisKVStore(client, { keyPrefix: "ns" });
    await prefixed.set("k", "v");
    const k = await prefixed.keys("k*");
    expect(k).toEqual(["k"]);
  });

  it("getOrSet stores result on miss", async () => {
    const factory = vi.fn().mockResolvedValue(99);
    const result = await kv.getOrSet("n", factory);
    expect(result).toBe(99);
    expect(await kv.get("n")).toBe(99);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("getOrSet skips factory on hit", async () => {
    await kv.set("n", 99);
    const factory = vi.fn().mockResolvedValue(0);
    const result = await kv.getOrSet("n", factory);
    expect(result).toBe(99);
    expect(factory).not.toHaveBeenCalled();
  });

  it("passes TTL to redis set", async () => {
    const spy = vi.spyOn(client, "set");
    await kv.set("k", "v", 5000);
    expect(spy).toHaveBeenCalledWith("k", '"v"', { PX: 5000 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MemoryPubSub
// ─────────────────────────────────────────────────────────────────────────────

describe("MemoryPubSub", () => {
  let pub: MemoryPubSub;

  beforeEach(() => {
    pub = new MemoryPubSub();
  });

  it("publish with no subscribers is a no-op", async () => {
    await expect(pub.publish("ch", "data")).resolves.toBeUndefined();
  });

  it("subscriber receives published data", async () => {
    const handler = vi.fn();
    pub.subscribe("ch", handler);
    await pub.publish("ch", { x: 1 });
    expect(handler).toHaveBeenCalledWith({ x: 1 }, "ch");
  });

  it("multiple subscribers all receive the message", async () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    pub.subscribe("ch", h1);
    pub.subscribe("ch", h2);
    await pub.publish("ch", "hello");
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe stops handler from receiving messages", async () => {
    const handler = vi.fn();
    const unsub = pub.subscribe("ch", handler);
    unsub();
    await pub.publish("ch", "data");
    expect(handler).not.toHaveBeenCalled();
  });

  it("unsubscribing one handler does not affect others", async () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    const unsub1 = pub.subscribe("ch", h1);
    pub.subscribe("ch", h2);
    unsub1();
    await pub.publish("ch", "data");
    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it("separate channels do not cross-pollinate", async () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    pub.subscribe("ch-a", h1);
    pub.subscribe("ch-b", h2);
    await pub.publish("ch-a", "msg");
    expect(h1).toHaveBeenCalled();
    expect(h2).not.toHaveBeenCalled();
  });

  it("subscriberCount reflects live subscriptions", () => {
    const unsub = pub.subscribe("ch", vi.fn());
    pub.subscribe("ch", vi.fn());
    pub.subscribe("other", vi.fn());
    expect(pub.subscriberCount).toBe(3);
    unsub();
    expect(pub.subscriberCount).toBe(2);
  });

  it("handler receives channel name as second argument", async () => {
    const handler = vi.fn();
    pub.subscribe("my-channel", handler);
    await pub.publish("my-channel", null);
    expect(handler).toHaveBeenCalledWith(null, "my-channel");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MemoryDistributedLock
// ─────────────────────────────────────────────────────────────────────────────

describe("MemoryDistributedLock", () => {
  let lock: MemoryDistributedLock;

  beforeEach(() => {
    resetClock();
    lock = new MemoryDistributedLock({ now: mockNow });
  });

  it("acquire returns a token on first call", async () => {
    const result = await lock.acquire("res", 1000);
    expect(result).toBeDefined();
    expect(result!.token).toBeTruthy();
  });

  it("acquire returns undefined when lock is held", async () => {
    await lock.acquire("res", 1000);
    const second = await lock.acquire("res", 1000);
    expect(second).toBeUndefined();
  });

  it("acquire succeeds after TTL expires", async () => {
    await lock.acquire("res", 500);
    advanceMs(600);
    const result = await lock.acquire("res", 500);
    expect(result).toBeDefined();
  });

  it("release with correct token returns true", async () => {
    const r = await lock.acquire("res", 1000);
    const released = await lock.release("res", r!.token);
    expect(released).toBe(true);
  });

  it("release with wrong token returns false", async () => {
    await lock.acquire("res", 1000);
    expect(await lock.release("res", "wrong-token")).toBe(false);
  });

  it("lock can be re-acquired after release", async () => {
    const r = await lock.acquire("res", 1000);
    await lock.release("res", r!.token);
    const r2 = await lock.acquire("res", 1000);
    expect(r2).toBeDefined();
  });

  it("withLock runs fn and releases lock", async () => {
    const fn = vi.fn().mockResolvedValue("done");
    const result = await lock.withLock("res", 1000, fn);
    expect(result).toBe("done");
    expect(fn).toHaveBeenCalledTimes(1);
    // Lock should be released
    const r = await lock.acquire("res", 100);
    expect(r).toBeDefined();
  });

  it("withLock returns undefined when lock is contended", async () => {
    await lock.acquire("res", 5000);
    const fn = vi.fn();
    const result = await lock.withLock("res", 1000, fn);
    expect(result).toBeUndefined();
    expect(fn).not.toHaveBeenCalled();
  });

  it("withLock releases lock even when fn throws", async () => {
    await lock
      .withLock("res", 1000, async () => {
        throw new Error("oops");
      })
      .catch(() => null);
    const r = await lock.acquire("res", 100);
    expect(r).toBeDefined();
  });

  it("separate keys do not conflict", async () => {
    await lock.acquire("res-a", 1000);
    const r = await lock.acquire("res-b", 1000);
    expect(r).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RedisDistributedLock
// ─────────────────────────────────────────────────────────────────────────────

describe("RedisDistributedLock", () => {
  it("acquire returns token when NX set succeeds", async () => {
    const client = makeRedisClient();
    const lock = new RedisDistributedLock(client);
    const result = await lock.acquire("res", 1000);
    expect(result?.token).toBeTruthy();
  });

  it("acquire returns undefined when key already set", async () => {
    const client = makeRedisClient();
    const lock = new RedisDistributedLock(client);
    // Manually set the lock key so NX fails
    await client.set("lock:res", "existing-token", { PX: 5000 });
    const result = await lock.acquire("res", 1000);
    expect(result).toBeUndefined();
  });

  it("release with matching token returns true", async () => {
    const client = makeRedisClient();
    const lock = new RedisDistributedLock(client);
    const r = await lock.acquire("res", 1000);
    expect(await lock.release("res", r!.token)).toBe(true);
  });

  it("release with wrong token returns false", async () => {
    const client = makeRedisClient();
    const lock = new RedisDistributedLock(client);
    await lock.acquire("res", 1000);
    expect(await lock.release("res", "wrong")).toBe(false);
  });

  it("keyPrefix is applied to lock keys", async () => {
    const client = makeRedisClient();
    const lock = new RedisDistributedLock(client, { keyPrefix: "app" });
    await lock.acquire("res", 1000);
    expect(client._store.has("app:lock:res")).toBe(true);
  });

  it("withLock runs fn and releases", async () => {
    const client = makeRedisClient();
    const lock = new RedisDistributedLock(client);
    const fn = vi.fn().mockResolvedValue(42);
    const result = await lock.withLock("res", 1000, fn);
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
