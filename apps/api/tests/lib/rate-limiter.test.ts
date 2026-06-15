// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FastifyRequest, FastifyReply } from "fastify";
import { MemoryKVStore } from "@nexus/kv";

// We need to control which KV the rate limiter uses.
// Patch shared-kv before importing the module under test.
const _mockKV = new MemoryKVStore();

vi.mock("../../src/lib/shared-kv.js", () => ({
  getSharedKV: () => _mockKV,
}));

// Import AFTER mock is registered
const { makeRateLimitPreHandler } = await import("../../src/lib/rate-limiter.js");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(ip?: string, auth?: string): FastifyRequest {
  return {
    headers: { authorization: auth },
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
    _headers: {},
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("makeRateLimitPreHandler", () => {
  beforeEach(async () => {
    await _mockKV.clear();
  });

  it("passes through under the limit", async () => {
    const handler = makeRateLimitPreHandler({ limit: 3, windowMs: 60_000, keyPrefix: "test" });
    const req = makeRequest("1.2.3.4");
    const reply = makeReply();
    await handler(req, reply);
    expect(reply._sent).toBe(false);
    expect(reply._code).toBe(200); // untouched
  });

  it("sets X-RateLimit-Limit and X-RateLimit-Remaining headers", async () => {
    const handler = makeRateLimitPreHandler({ limit: 5, windowMs: 60_000, keyPrefix: "hdr" });
    const req = makeRequest("1.2.3.5");
    const reply = makeReply();
    await handler(req, reply);
    expect(reply._headers["X-RateLimit-Limit"]).toBe(5);
    expect(reply._headers["X-RateLimit-Remaining"]).toBe(4);
  });

  it("remaining decrements with each call", async () => {
    const handler = makeRateLimitPreHandler({ limit: 3, windowMs: 60_000, keyPrefix: "dec" });
    for (let i = 3; i >= 1; i--) {
      const req = makeRequest("10.0.0.1");
      const reply = makeReply();
      await handler(req, reply);
      expect(reply._headers["X-RateLimit-Remaining"]).toBe(i - 1);
    }
  });

  it("returns 429 when limit exceeded", async () => {
    const handler = makeRateLimitPreHandler({ limit: 2, windowMs: 60_000, keyPrefix: "lim" });
    const ip = "9.9.9.9";
    // Use up the limit
    for (let i = 0; i < 2; i++) {
      await handler(makeRequest(ip), makeReply());
    }
    const req = makeRequest(ip);
    const reply = makeReply();
    await handler(req, reply);
    expect(reply._code).toBe(429);
    expect(reply._sent).toBe(true);
    expect(reply._headers["Retry-After"]).toBeDefined();
  });

  it("different IPs have independent counters", async () => {
    const handler = makeRateLimitPreHandler({ limit: 1, windowMs: 60_000, keyPrefix: "iso" });
    // Exhaust limit for ip A
    await handler(makeRequest("11.0.0.1"), makeReply());
    // ip B should still pass
    const replyB = makeReply();
    await handler(makeRequest("11.0.0.2"), replyB);
    expect(replyB._sent).toBe(false);
  });

  it("keyBy override uses custom key", async () => {
    const handler = makeRateLimitPreHandler({
      limit: 1,
      windowMs: 60_000,
      keyPrefix: "kb",
      keyBy: () => "shared-key",
    });
    // First request passes
    await handler(makeRequest("1.1.1.1"), makeReply());
    // Second request (different IP but same keyBy) should 429
    const r2 = makeReply();
    await handler(makeRequest("2.2.2.2"), r2);
    expect(r2._code).toBe(429);
  });

  it("fails open when KV is unavailable", async () => {
    const brokenKV = new MemoryKVStore();
    // Override get to throw
    brokenKV.get = async () => {
      throw new Error("KV down");
    };

    vi.doMock("../../src/lib/shared-kv.js", () => ({ getSharedKV: () => brokenKV }));

    // Even with broken KV, handler should not throw or block request
    const handler = makeRateLimitPreHandler({ limit: 1, windowMs: 60_000, keyPrefix: "broken" });
    const reply = makeReply();
    await handler(makeRequest("5.5.5.5"), reply);
    expect(reply._code).toBe(200); // passes through
  });
});
