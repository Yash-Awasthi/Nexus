// SPDX-License-Identifier: Apache-2.0
/**
 * Atomic rate-limiter tests.
 *
 * Covers the atomic Upstash pipeline path, the in-memory fallback, and the
 * fail-open behavior that prevents cascading downtime when KV is unavailable.
 *
 * Uses vi.mock to intercept the shared KV singleton and vi.stubGlobal("fetch")
 * to simulate Upstash REST responses.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyRequest, FastifyReply } from "fastify";
import { MemoryKVStore } from "@nexus/kv";

// ═══════════════════════════════════════════════════════════════════════════════
// Request / Reply factories
// ═══════════════════════════════════════════════════════════════════════════════

function makeRequest(ip?: string): FastifyRequest {
  return {
    headers: {},
    socket: { remoteAddress: ip ?? "127.0.0.1" },
  } as unknown as FastifyRequest;
}

type MockReply = FastifyReply & {
  _code: number;
  _body: unknown;
  _headers: Record<string, string>;
  _sent: boolean;
};

function makeReply(): MockReply {
  const r: MockReply = {
    _code: 200,
    _body: undefined,
    _headers: {} as Record<string, string>,
    _sent: false,
    code(c: number) {
      r._code = c;
      return r as unknown as FastifyReply;
    },
    header(k: string, v: string) {
      r._headers[k] = v;
      return r as unknown as FastifyReply;
    },
    send(b: unknown) {
      r._body = b;
      r._sent = true;
      return r as unknown as FastifyReply;
    },
    sent: false,
  } as unknown as MockReply;
  Object.defineProperty(r, "sent", { get: () => r._sent });
  return r;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function setUpstashEnv(): void {
  process.env.UPSTASH_REDIS_REST_URL = "https://fake-upstash.example.com";
  process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token-12345";
}

function clearUpstashEnv(): void {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
}

/**
 * Mock fetch to return a successful Upstash pipeline response.
 * The first arg is the INCR result, second is the EXPIRE result.
 */
function mockUpstashPipeline(incrResult: number, expireResult: number = 1): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { result: incrResult },
        { result: expireResult },
      ],
    }),
  );
}

/**
 * Mock fetch to simulate an Upstash error.
 */
function mockUpstashError(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal error",
    }),
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe("Atomic INCR path (Upstash pipeline)", () => {
  beforeEach(() => {
    vi.resetModules();
    setUpstashEnv();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearUpstashEnv();
  });

  it("uses atomic INCR to count calls correctly", async () => {
    // First request: count = 1
    mockUpstashPipeline(1);
    const { makeRateLimitPreHandler } = await import("../../src/lib/rate-limiter.js");
    const handler = makeRateLimitPreHandler({ limit: 3, windowMs: 60_000, keyPrefix: "atomic" });

    const r1 = makeReply();
    await handler(makeRequest("10.0.0.1"), r1);
    expect(r1._sent).toBe(false);
    expect(r1._headers["X-RateLimit-Limit"]).toBe(3);
    expect(r1._headers["X-RateLimit-Remaining"]).toBe(2);

    // Second request: count = 2
    mockUpstashPipeline(2);
    const r2 = makeReply();
    await handler(makeRequest("10.0.0.1"), r2);
    expect(r2._sent).toBe(false);
    expect(r2._headers["X-RateLimit-Remaining"]).toBe(1);

    // Third request: count = 3
    mockUpstashPipeline(3);
    const r3 = makeReply();
    await handler(makeRequest("10.0.0.1"), r3);
    expect(r3._sent).toBe(false);
    expect(r3._headers["X-RateLimit-Remaining"]).toBe(0);
  });

  it("returns 429 when INCR exceeds limit", async () => {
    // Already at limit + 1
    mockUpstashPipeline(4); // limit is 3, so 4 → over limit
    const { makeRateLimitPreHandler } = await import("../../src/lib/rate-limiter.js");
    const handler = makeRateLimitPreHandler({ limit: 3, windowMs: 60_000, keyPrefix: "over" });

    const reply = makeReply();
    await handler(makeRequest("10.0.0.2"), reply);

    expect(reply._code).toBe(429);
    expect(reply._sent).toBe(true);
    expect(reply._headers["Retry-After"]).toBeDefined();
    expect(reply._headers["X-RateLimit-Remaining"]).toBe(0);
  });

  it("different IPs have independent atomic counters", async () => {
    // IP A: count = 1 → pass
    mockUpstashPipeline(1);
    const { makeRateLimitPreHandler } = await import("../../src/lib/rate-limiter.js");
    const handler = makeRateLimitPreHandler({ limit: 1, windowMs: 60_000, keyPrefix: "iso-at" });

    await handler(makeRequest("10.0.0.1"), makeReply());

    // IP B: count = 1 → pass (different key → new counter)
    mockUpstashPipeline(1);
    const rB = makeReply();
    await handler(makeRequest("10.0.0.2"), rB);
    expect(rB._sent).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// In-memory fallback
// ═══════════════════════════════════════════════════════════════════════════════

describe("In-memory fallback (no Upstash env)", () => {
  beforeEach(() => {
    vi.resetModules();
    clearUpstashEnv();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses in-memory KV when Upstash is not configured", async () => {
    // No Upstash env → shared KV falls back to MemoryKVStore
    const { makeRateLimitPreHandler } = await import("../../src/lib/rate-limiter.js");
    const handler = makeRateLimitPreHandler({ limit: 2, windowMs: 60_000, keyPrefix: "memfall" });

    // First request
    const r1 = makeReply();
    await handler(makeRequest("192.168.1.1"), r1);
    expect(r1._sent).toBe(false);
    expect(r1._headers["X-RateLimit-Remaining"]).toBe(1);

    // Second request
    const r2 = makeReply();
    await handler(makeRequest("192.168.1.1"), r2);
    expect(r2._sent).toBe(false);
    expect(r2._headers["X-RateLimit-Remaining"]).toBe(0);

    // Third request → 429
    const r3 = makeReply();
    await handler(makeRequest("192.168.1.1"), r3);
    expect(r3._code).toBe(429);
  });

  it("in-memory counters are independent across keyPrefix values", async () => {
    const { makeRateLimitPreHandler } = await import("../../src/lib/rate-limiter.js");
    const hA = makeRateLimitPreHandler({ limit: 1, windowMs: 60_000, keyPrefix: "indep-a" });
    const hB = makeRateLimitPreHandler({ limit: 1, windowMs: 60_000, keyPrefix: "indep-b" });

    await hA(makeRequest("10.0.0.1"), makeReply());
    const rB = makeReply();
    await hB(makeRequest("10.0.0.1"), rB);
    // Different prefix → different counter → should pass
    expect(rB._sent).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Fail-open behavior
// ═══════════════════════════════════════════════════════════════════════════════

describe("Fail-open when KV is unavailable", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearUpstashEnv();
  });

  it("passes through (no 429) when Upstash fetch throws", async () => {
    setUpstashEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    );

    const { makeRateLimitPreHandler } = await import("../../src/lib/rate-limiter.js");
    const handler = makeRateLimitPreHandler({ limit: 1, windowMs: 60_000, keyPrefix: "fo1" });

    // Even after many calls, all should pass because fetch throws
    for (let i = 0; i < 10; i++) {
      const reply = makeReply();
      await handler(makeRequest("10.0.0.99"), reply);
      expect(reply._code).toBe(200);
      expect(reply._sent).toBe(false);
    }
  });

  it("passes through when Upstash returns non-ok status", async () => {
    setUpstashEnv();
    mockUpstashError();

    const { makeRateLimitPreHandler } = await import("../../src/lib/rate-limiter.js");
    const handler = makeRateLimitPreHandler({ limit: 1, windowMs: 60_000, keyPrefix: "fo2" });

    for (let i = 0; i < 5; i++) {
      const reply = makeReply();
      await handler(makeRequest("10.0.0.88"), reply);
      expect(reply._code).toBe(200);
      expect(reply._sent).toBe(false);
    }
  });

  it("passes through when Upstash pipeline returns an error in results", async () => {
    setUpstashEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ error: "MOVED 1234" }, { result: "OK" }],
      }),
    );

    // The shared-kv singleton may be cached from a previous test group.
    // Force it to use Upstash by resetting the singleton through a fresh import.
    const kv = new MemoryKVStore();
    vi.doMock("../../src/lib/shared-kv.js", () => ({
      getSharedKV: () => kv,
    }));

    const { makeRateLimitPreHandler } = await import("../../src/lib/rate-limiter.js");
    const handler = makeRateLimitPreHandler({ limit: 1, windowMs: 60_000, keyPrefix: "fo3" });

    const reply = makeReply();
    await handler(makeRequest("10.0.0.77"), reply);
    // Atomic pipeline returned error → falls back to in-memory kv → passes
    expect(reply._sent).toBe(false);
    // Headers are set from in-memory fallback
    expect(reply._headers["X-RateLimit-Remaining"]).toBeDefined();
  });

  it("passes through when in-memory KV get throws", async () => {
    // No Upstash → falls back to in-memory. But we mock shared-kv to be broken.
    clearUpstashEnv();

    const brokenKV = new MemoryKVStore();
    // Override get to throw
    brokenKV.get = async () => {
      throw new Error("KV down");
    };

    vi.doMock("../../src/lib/shared-kv.js", () => ({
      getSharedKV: () => brokenKV,
    }));

    const { makeRateLimitPreHandler } = await import("../../src/lib/rate-limiter.js");
    const handler = makeRateLimitPreHandler({ limit: 1, windowMs: 60_000, keyPrefix: "fo4" });

    // Should not throw; should silently pass through
    const reply = makeReply();
    await handler(makeRequest("10.0.0.66"), reply);
    expect(reply._code).toBe(200);
    expect(reply._sent).toBe(false);
  });

  it("does not set rate-limit headers when KV is fully broken", async () => {
    clearUpstashEnv();

    const brokenKV = new MemoryKVStore();
    brokenKV.get = async () => {
      throw new Error("KV down");
    };

    vi.doMock("../../src/lib/shared-kv.js", () => ({
      getSharedKV: () => brokenKV,
    }));

    const { makeRateLimitPreHandler } = await import("../../src/lib/rate-limiter.js");
    const handler = makeRateLimitPreHandler({ limit: 5, windowMs: 60_000, keyPrefix: "fo5" });

    const reply = makeReply();
    await handler(makeRequest("10.0.0.55"), reply);
    // No headers set because catch block is silent
    expect(reply._headers["X-RateLimit-Limit"]).toBeUndefined();
    expect(reply._headers["X-RateLimit-Remaining"]).toBeUndefined();
  });
});
