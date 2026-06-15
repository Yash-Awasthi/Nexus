// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  CloudflareKVStore,
  registerCFContext,
  getSharedKVFromCF,
  _resetCFContext,
  isCFRuntime,
  buildCFCacheKey,
  type CFKVNamespaceLike,
} from "../../src/lib/cf-adapter.js";

// ── Minimal in-memory CF KV Namespace mock ─────────────────────────────────────

function makeMockNamespace(): CFKVNamespaceLike & { _store: Map<string, string> } {
  const _store = new Map<string, string>();
  return {
    _store,
    async get(key: string) {
      return _store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      _store.set(key, value);
    },
    async delete(key: string) {
      _store.delete(key);
    },
    async list(opts?: { prefix?: string; limit?: number }) {
      const prefix = opts?.prefix ?? "";
      const keys = [..._store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys };
    },
  };
}

describe("CloudflareKVStore", () => {
  let ns: ReturnType<typeof makeMockNamespace>;
  let store: CloudflareKVStore;

  beforeEach(() => {
    ns = makeMockNamespace();
    store = new CloudflareKVStore(ns);
  });

  it("set and get round-trips JSON", async () => {
    await store.set("key1", { foo: "bar" });
    const val = await store.get<{ foo: string }>("key1");
    expect(val).toEqual({ foo: "bar" });
  });

  it("get returns undefined for missing key", async () => {
    expect(await store.get("nope")).toBeUndefined();
  });

  it("delete removes key", async () => {
    await store.set("del-me", 42);
    await store.delete("del-me");
    expect(await store.get("del-me")).toBeUndefined();
  });

  it("has returns true for existing key", async () => {
    await store.set("exists", true);
    expect(await store.has("exists")).toBe(true);
  });

  it("has returns false for missing key", async () => {
    expect(await store.has("ghost")).toBe(false);
  });

  it("keys with prefix filter", async () => {
    await store.set("a:1", 1);
    await store.set("a:2", 2);
    await store.set("b:1", 3);
    const keys = await store.keys("a:*");
    expect(keys).toContain("a:1");
    expect(keys).toContain("a:2");
    expect(keys).not.toContain("b:1");
  });

  it("clear removes all keys", async () => {
    await store.set("x", 1);
    await store.set("y", 2);
    await store.clear();
    expect(await store.keys("*")).toHaveLength(0);
  });

  it("getOrSet caches factory result", async () => {
    let calls = 0;
    const factory = async () => {
      calls++;
      return "computed";
    };
    const v1 = await store.getOrSet("ck", factory);
    const v2 = await store.getOrSet("ck", factory);
    expect(v1).toBe("computed");
    expect(v2).toBe("computed");
    expect(calls).toBe(1); // factory only called once
  });

  it("applies keyPrefix to stored keys", async () => {
    const prefixed = new CloudflareKVStore(ns, { keyPrefix: "myapp" });
    await prefixed.set("item", "val");
    // raw namespace should have "myapp:item"
    expect(ns._store.has("myapp:item")).toBe(true);
  });

  it("strips keyPrefix from keys() results", async () => {
    const prefixed = new CloudflareKVStore(ns, { keyPrefix: "app" });
    await prefixed.set("foo", 1);
    const keys = await prefixed.keys("*");
    expect(keys).toContain("foo");
    expect(keys).not.toContain("app:foo");
  });

  it("set with ttlMs rounds up to 60s minimum", async () => {
    const putCalls: [string, string, unknown][] = [];
    const trackingNs: CFKVNamespaceLike = {
      ...ns,
      put: async (k, v, opts) => {
        putCalls.push([k, v, opts]);
        ns._store.set(k, v);
      },
    };
    const s = new CloudflareKVStore(trackingNs);
    await s.set("t", "v", 1000); // 1 s < 60 s → rounds to 60
    const opts = putCalls[0]?.[2] as { expirationTtl?: number };
    expect(opts?.expirationTtl).toBe(60);
  });
});

describe("registerCFContext / getSharedKVFromCF", () => {
  beforeEach(() => {
    _resetCFContext();
  });

  it("returns undefined before registration", () => {
    expect(getSharedKVFromCF()).toBeUndefined();
  });

  it("returns store after registerCFContext", () => {
    registerCFContext(makeMockNamespace());
    expect(getSharedKVFromCF()).toBeDefined();
  });

  it("returned store is functional", async () => {
    registerCFContext(makeMockNamespace());
    const kv = getSharedKVFromCF()!;
    await kv.set("hello", "world");
    expect(await kv.get("hello")).toBe("world");
  });

  it("_resetCFContext clears registration", () => {
    registerCFContext(makeMockNamespace());
    _resetCFContext();
    expect(getSharedKVFromCF()).toBeUndefined();
  });
});

describe("helpers", () => {
  it("isCFRuntime returns false in Node.js test environment", () => {
    expect(isCFRuntime()).toBe(false);
  });

  it("buildCFCacheKey returns a Request object", () => {
    const req = buildCFCacheKey("https://example.com/api/v1/gateway/models");
    expect(req).toBeInstanceOf(Request);
    expect(req.url).toBe("https://example.com/api/v1/gateway/models");
    expect(req.method).toBe("GET");
  });
});
