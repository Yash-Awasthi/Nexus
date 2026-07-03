// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  MemoryGatewayLog,
  KVGatewayLog,
  LoggingLLMProvider,
  GatewayLogError,
  computeStats,
  type IGatewayLog,
  type GatewayLogEntry,
  type LLMRequest,
  type LLMResponse,
  type LLMProvider,
  type KVStoreLike,
} from "../src/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let _time = 1_000_000;
function makeNow() {
  _time = 1_000_000;
  return () => _time;
}
function advanceTime(ms: number) {
  _time += ms;
}

function makeEntry(
  overrides: Partial<Omit<GatewayLogEntry, "id">> = {},
): Omit<GatewayLogEntry, "id"> {
  return {
    timestamp: _time,
    model: "gpt-4o",
    provider: "openai",
    status: "success",
    latencyMs: 200,
    usage: { promptTokens: 50, completionTokens: 100, totalTokens: 150 },
    ...overrides,
  };
}

function makeResponse(overrides: Partial<LLMResponse> = {}): LLMResponse {
  return {
    id: "resp-1",
    model: "gpt-4o",
    content: "Hello!",
    usage: { promptTokens: 40, completionTokens: 60, totalTokens: 100 },
    provider: "openai",
    latencyMs: 150,
    ...overrides,
  };
}

function makeRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model: "gpt-4o",
    messages: [{ role: "user", content: "Hello" }],
    ...overrides,
  };
}

function makeKVStore(): KVStoreLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store = new Map<string, any>();
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return store.get(key) as T | undefined;
    },
    async set<T>(key: string, value: T): Promise<void> {
      store.set(key, value);
    },
    async keys(pattern?: string): Promise<string[]> {
      if (!pattern || pattern === "*") return [...store.keys()];
      const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : undefined;
      return [...store.keys()].filter((k) =>
        prefix !== undefined ? k.startsWith(prefix) : k === pattern,
      );
    },
    async clear(): Promise<void> {
      store.clear();
    },
  };
}

function makeProvider(response: LLMResponse, shouldThrow = false): LLMProvider {
  return {
    name: "test-provider",
    models: ["gpt-4o"],
    async complete(_req) {
      if (shouldThrow) throw new Error("Provider failed");
      return response;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// computeStats
// ─────────────────────────────────────────────────────────────────────────────

describe("computeStats", () => {
  it("returns zeros for empty array", () => {
    const s = computeStats([]);
    expect(s.totalRequests).toBe(0);
    expect(s.avgLatencyMs).toBe(0);
    expect(s.totalTokens).toBe(0);
    expect(s.p50LatencyMs).toBe(0);
  });

  it("counts successes, errors, cached", () => {
    const entries: GatewayLogEntry[] = [
      {
        id: "1",
        timestamp: 1,
        model: "m",
        provider: "p",
        status: "success",
        latencyMs: 100,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      },
      { id: "2", timestamp: 2, model: "m", provider: "p", status: "error", latencyMs: 50 },
      {
        id: "3",
        timestamp: 3,
        model: "m",
        provider: "p",
        status: "cached",
        latencyMs: 10,
        usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 },
      },
    ];
    const s = computeStats(entries);
    expect(s.totalRequests).toBe(3);
    expect(s.successRequests).toBe(1);
    expect(s.errorRequests).toBe(1);
    expect(s.cachedRequests).toBe(1);
    expect(s.totalTokens).toBe(45);
  });

  it("computes average latency", () => {
    const entries: GatewayLogEntry[] = [
      { id: "1", timestamp: 1, model: "m", provider: "p", status: "success", latencyMs: 100 },
      { id: "2", timestamp: 2, model: "m", provider: "p", status: "success", latencyMs: 200 },
    ];
    expect(computeStats(entries).avgLatencyMs).toBe(150);
  });

  it("computes tokensByProvider", () => {
    const entries: GatewayLogEntry[] = [
      {
        id: "1",
        timestamp: 1,
        model: "m",
        provider: "openai",
        status: "success",
        latencyMs: 100,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      },
      {
        id: "2",
        timestamp: 2,
        model: "m",
        provider: "openai",
        status: "success",
        latencyMs: 100,
        usage: { promptTokens: 5, completionTokens: 10, totalTokens: 15 },
      },
      {
        id: "3",
        timestamp: 3,
        model: "m",
        provider: "groq",
        status: "success",
        latencyMs: 100,
        usage: { promptTokens: 20, completionTokens: 40, totalTokens: 60 },
      },
    ];
    const s = computeStats(entries);
    expect(s.tokensByProvider["openai"]).toBe(45);
    expect(s.tokensByProvider["groq"]).toBe(60);
  });

  it("computes requestsByModel", () => {
    const entries: GatewayLogEntry[] = [
      { id: "1", timestamp: 1, model: "gpt-4o", provider: "p", status: "success", latencyMs: 100 },
      { id: "2", timestamp: 2, model: "gpt-4o", provider: "p", status: "success", latencyMs: 100 },
      {
        id: "3",
        timestamp: 3,
        model: "claude-3-5",
        provider: "p",
        status: "success",
        latencyMs: 100,
      },
    ];
    const s = computeStats(entries);
    expect(s.requestsByModel["gpt-4o"]).toBe(2);
    expect(s.requestsByModel["claude-3-5"]).toBe(1);
  });

  it("computes p50/p95/p99 latencies", () => {
    const latencies = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const entries: GatewayLogEntry[] = latencies.map((l, i) => ({
      id: String(i),
      timestamp: i,
      model: "m",
      provider: "p",
      status: "success" as const,
      latencyMs: l,
    }));
    const s = computeStats(entries);
    expect(s.p50LatencyMs).toBe(60); // 50th percentile of sorted [10..100]
    expect(s.p95LatencyMs).toBe(100);
    expect(s.p99LatencyMs).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MemoryGatewayLog
// ─────────────────────────────────────────────────────────────────────────────

describe("MemoryGatewayLog", () => {
  let log: MemoryGatewayLog;
  let now: () => number;

  beforeEach(() => {
    now = makeNow();
    log = new MemoryGatewayLog({ now });
  });

  // append
  it("append assigns a UUID and returns the full entry", async () => {
    const entry = await log.append(makeEntry());
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(entry.model).toBe("gpt-4o");
    expect(entry.status).toBe("success");
  });

  it("count increases after each append", async () => {
    expect(await log.count()).toBe(0);
    await log.append(makeEntry());
    await log.append(makeEntry());
    expect(await log.count()).toBe(2);
  });

  // query
  it("query returns all entries when no filter", async () => {
    await log.append(makeEntry({ model: "a" }));
    await log.append(makeEntry({ model: "b" }));
    const result = await log.query();
    expect(result).toHaveLength(2);
  });

  it("query returns entries most recent first", async () => {
    await log.append(makeEntry({ timestamp: 1000 }));
    await log.append(makeEntry({ timestamp: 2000 }));
    const result = await log.query();
    expect(result[0].timestamp).toBe(2000);
    expect(result[1].timestamp).toBe(1000);
  });

  it("query filters by provider", async () => {
    await log.append(makeEntry({ provider: "openai" }));
    await log.append(makeEntry({ provider: "groq" }));
    const result = await log.query({ provider: "openai" });
    expect(result).toHaveLength(1);
    expect(result[0].provider).toBe("openai");
  });

  it("query filters by model", async () => {
    await log.append(makeEntry({ model: "gpt-4o" }));
    await log.append(makeEntry({ model: "llama-3" }));
    const result = await log.query({ model: "llama-3" });
    expect(result).toHaveLength(1);
  });

  it("query filters by status", async () => {
    await log.append(makeEntry({ status: "success" }));
    await log.append(makeEntry({ status: "error" }));
    await log.append(makeEntry({ status: "cached" }));
    expect(await log.query({ status: "error" })).toHaveLength(1);
    expect(await log.query({ status: "cached" })).toHaveLength(1);
  });

  it("query filters by identity", async () => {
    await log.append(makeEntry({ identity: "alice" }));
    await log.append(makeEntry({ identity: "bob" }));
    const result = await log.query({ identity: "alice" });
    expect(result).toHaveLength(1);
    expect(result[0].identity).toBe("alice");
  });

  it("query filters by since", async () => {
    await log.append(makeEntry({ timestamp: 1000 }));
    await log.append(makeEntry({ timestamp: 2000 }));
    await log.append(makeEntry({ timestamp: 3000 }));
    const result = await log.query({ since: 2000 });
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.timestamp >= 2000)).toBe(true);
  });

  it("query filters by before", async () => {
    await log.append(makeEntry({ timestamp: 1000 }));
    await log.append(makeEntry({ timestamp: 2000 }));
    await log.append(makeEntry({ timestamp: 3000 }));
    const result = await log.query({ before: 2000 });
    expect(result).toHaveLength(1);
    expect(result[0].timestamp).toBe(1000);
  });

  it("query respects limit", async () => {
    for (let i = 0; i < 10; i++) await log.append(makeEntry({ timestamp: i * 100 }));
    const result = await log.query({ limit: 3 });
    expect(result).toHaveLength(3);
  });

  // stats
  it("stats returns aggregate metrics", async () => {
    await log.append(
      makeEntry({
        status: "success",
        latencyMs: 100,
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      }),
    );
    await log.append(makeEntry({ status: "error", latencyMs: 50, usage: undefined }));
    const s = await log.stats();
    expect(s.totalRequests).toBe(2);
    expect(s.successRequests).toBe(1);
    expect(s.errorRequests).toBe(1);
    expect(s.totalTokens).toBe(30);
  });

  it("stats can be filtered like query", async () => {
    await log.append(makeEntry({ provider: "openai", status: "success", latencyMs: 100 }));
    await log.append(makeEntry({ provider: "groq", status: "error", latencyMs: 50 }));
    const s = await log.stats({ provider: "openai" });
    expect(s.totalRequests).toBe(1);
    expect(s.successRequests).toBe(1);
  });

  // clear
  it("clear removes all entries", async () => {
    await log.append(makeEntry());
    await log.append(makeEntry());
    await log.clear();
    expect(await log.count()).toBe(0);
  });

  // circular buffer eviction
  it("evicts oldest entry when maxEntries exceeded", async () => {
    const tiny = new MemoryGatewayLog({ maxEntries: 3, now });
    const e1 = await tiny.append(makeEntry({ timestamp: 100 }));
    await tiny.append(makeEntry({ timestamp: 200 }));
    await tiny.append(makeEntry({ timestamp: 300 }));
    // Should evict e1
    await tiny.append(makeEntry({ timestamp: 400 }));
    expect(await tiny.count()).toBe(3);
    const entries = await tiny.query();
    expect(entries.find((e) => e.id === e1.id)).toBeUndefined();
  });

  // IGatewayLog interface
  it("implements IGatewayLog interface", () => {
    const l: IGatewayLog = log;
    expect(typeof l.append).toBe("function");
    expect(typeof l.query).toBe("function");
    expect(typeof l.stats).toBe("function");
    expect(typeof l.clear).toBe("function");
    expect(typeof l.count).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// KVGatewayLog
// ─────────────────────────────────────────────────────────────────────────────

describe("KVGatewayLog", () => {
  let kv: KVStoreLike;
  let log: KVGatewayLog;

  beforeEach(() => {
    kv = makeKVStore();
    log = new KVGatewayLog(kv);
  });

  it("append returns entry with id", async () => {
    const e = await log.append(makeEntry());
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("count returns number of stored entries", async () => {
    expect(await log.count()).toBe(0);
    await log.append(makeEntry());
    await log.append(makeEntry());
    expect(await log.count()).toBe(2);
  });

  it("query returns all entries", async () => {
    await log.append(makeEntry({ model: "a" }));
    await log.append(makeEntry({ model: "b" }));
    const result = await log.query();
    expect(result).toHaveLength(2);
  });

  it("query filters by status", async () => {
    await log.append(makeEntry({ status: "success" }));
    await log.append(makeEntry({ status: "error" }));
    const errors = await log.query({ status: "error" });
    expect(errors).toHaveLength(1);
  });

  it("query respects limit", async () => {
    for (let i = 0; i < 5; i++) await log.append(makeEntry());
    const result = await log.query({ limit: 2 });
    expect(result).toHaveLength(2);
  });

  it("stats aggregates entries", async () => {
    await log.append(
      makeEntry({
        status: "success",
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      }),
    );
    await log.append(makeEntry({ status: "error", usage: undefined }));
    const s = await log.stats();
    expect(s.totalRequests).toBe(2);
    expect(s.totalTokens).toBe(30);
  });

  it("clear removes all entries", async () => {
    await log.append(makeEntry());
    await log.clear();
    expect(await log.count()).toBe(0);
  });

  it("uses custom key prefix", async () => {
    const prefixedLog = new KVGatewayLog(kv, { keyPrefix: "ns" });
    await prefixedLog.append(makeEntry());
    const keys = await kv.keys("ns:gwlog:*");
    expect(keys).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LoggingLLMProvider
// ─────────────────────────────────────────────────────────────────────────────

describe("LoggingLLMProvider", () => {
  let log: MemoryGatewayLog;
  let now: () => number;

  beforeEach(() => {
    now = makeNow();
    log = new MemoryGatewayLog({ now });
  });

  // Name / models
  it("wraps provider name", () => {
    const p = new LoggingLLMProvider(makeProvider(makeResponse()), log, { now });
    expect(p.name).toBe("logging(test-provider)");
  });

  it("exposes inner models", () => {
    const p = new LoggingLLMProvider(makeProvider(makeResponse()), log, { now });
    expect(p.models).toEqual(["gpt-4o"]);
  });

  // Success logging
  it("logs a success entry on successful call", async () => {
    const p = new LoggingLLMProvider(makeProvider(makeResponse()), log, { now });
    await p.complete(makeRequest());
    const entries = await log.query();
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("success");
    expect(entries[0].provider).toBe("openai");
    expect(entries[0].model).toBe("gpt-4o");
    expect(entries[0].usage?.totalTokens).toBe(100);
  });

  // Cached logging
  it("logs status as 'cached' when response.cached is true", async () => {
    const p = new LoggingLLMProvider(makeProvider(makeResponse({ cached: true })), log, { now });
    await p.complete(makeRequest());
    const entries = await log.query();
    expect(entries[0].status).toBe("cached");
  });

  // Error logging
  it("logs an error entry and re-throws", async () => {
    const p = new LoggingLLMProvider(makeProvider(makeResponse(), true), log, { now });
    await expect(p.complete(makeRequest())).rejects.toThrow("Provider failed");
    const entries = await log.query();
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("error");
    expect(entries[0].errorMessage).toBe("Provider failed");
  });

  // Latency
  it("records latency", async () => {
    const inner: LLMProvider = {
      name: "timed",
      models: ["gpt-4o"],
      async complete(_req) {
        advanceTime(300);
        return makeResponse({ provider: "timed" });
      },
    };
    const p = new LoggingLLMProvider(inner, log, { now });
    await p.complete(makeRequest());
    const entries = await log.query();
    expect(entries[0].latencyMs).toBe(300);
  });

  // Identity extraction
  it("logs identity from metadata", async () => {
    const p = new LoggingLLMProvider(makeProvider(makeResponse()), log, { now });
    await p.complete(makeRequest({ metadata: { identity: "user-42" } }));
    const entries = await log.query();
    expect(entries[0].identity).toBe("user-42");
  });

  it("custom identityFn overrides default", async () => {
    const p = new LoggingLLMProvider(makeProvider(makeResponse()), log, {
      now,
      identityFn: () => "fixed-identity",
    });
    await p.complete(makeRequest());
    const entries = await log.query();
    expect(entries[0].identity).toBe("fixed-identity");
  });

  // Tags
  it("custom tagsFn enriches log entries", async () => {
    const p = new LoggingLLMProvider(makeProvider(makeResponse()), log, {
      now,
      tagsFn: (req) => ({ env: "test", model: req.model }),
    });
    await p.complete(makeRequest());
    const entries = await log.query();
    expect(entries[0].tags?.env).toBe("test");
    expect(entries[0].tags?.model).toBe("gpt-4o");
  });

  // gatewayLog accessor
  it("exposes log via gatewayLog accessor", () => {
    const p = new LoggingLLMProvider(makeProvider(makeResponse()), log, { now });
    expect(p.gatewayLog).toBe(log);
  });

  // Multiple calls accumulate
  it("accumulates multiple log entries", async () => {
    const p = new LoggingLLMProvider(makeProvider(makeResponse()), log, { now });
    await p.complete(makeRequest());
    await p.complete(makeRequest());
    await p.complete(makeRequest());
    expect(await log.count()).toBe(3);
  });

  // implements LLMProvider
  it("implements LLMProvider interface", () => {
    const p: LLMProvider = new LoggingLLMProvider(makeProvider(makeResponse()), log, { now });
    expect(typeof p.complete).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GatewayLogError
// ─────────────────────────────────────────────────────────────────────────────

describe("GatewayLogError", () => {
  it("has correct name and code", () => {
    const err = new GatewayLogError("storage failed", "STORAGE_ERROR", { detail: "kv" });
    expect(err.name).toBe("GatewayLogError");
    expect(err.code).toBe("STORAGE_ERROR");
    expect(err.context?.detail).toBe("kv");
    expect(err instanceof Error).toBe(true);
  });
});
