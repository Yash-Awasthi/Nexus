// SPDX-License-Identifier: Apache-2.0
/**
 * The half of rate limiting that a 429 test does not prove: that the window **resets**.
 *
 * "Returns 429" is easy to satisfy and worth nothing on its own — a limiter that never lets the
 * caller back in is an outage with extra steps. This file pins the reset at the exact boundary,
 * shows the `Retry-After` counting down rather than repeating the whole window, and proves that
 * traffic *inside* the window cannot extend it (the bug that makes a limiter permanent: every
 * request refreshing the expiry).
 *
 * Time is injected rather than slept through: `MemoryKVStore({ now })` for the counter and
 * `vi.setSystemTime` for the limiter's own clock, so a 60-second window is exercised in
 * milliseconds and the assertion is exact.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { MemoryKVStore } from "@nexus/kv";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const kv = { current: new MemoryKVStore({ now: () => Date.now() }) };

vi.mock("../../src/lib/shared-kv.ts", () => ({
  getSharedKV: () => kv.current,
}));

const { makeRateLimitPreHandler, makeUserRateLimitPreHandler } =
  await import("../../src/lib/rate-limiter.ts");

const T0 = new Date("2026-01-01T00:00:00Z");

function request(opts: { ip?: string; user?: string } = {}): FastifyRequest {
  return {
    headers: {},
    socket: { remoteAddress: opts.ip ?? "203.0.113.7" },
    ...(opts.user ? { nexusUserId: opts.user } : {}),
  } as unknown as FastifyRequest;
}

interface Answer {
  code: number;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

function reply(): { target: FastifyReply; answer: Answer } {
  const answer: Answer = { code: 200, headers: {}, body: undefined };
  const target = {
    code(c: number) {
      answer.code = c;
      return target;
    },
    header(k: string, v: string) {
      answer.headers[k] = String(v);
      return target;
    },
    send(b: Record<string, unknown>) {
      answer.body = b;
      return target;
    },
  } as unknown as FastifyReply;
  return { target, answer };
}

/** One request through the limiter, returning the status and headers it would send. */
async function hit(
  handler: (req: FastifyRequest, res: FastifyReply) => Promise<void>,
  req = request(),
): Promise<Answer> {
  const { target, answer } = reply();
  await handler(req, target);
  return answer;
}

beforeEach(async () => {
  kv.current = new MemoryKVStore({ now: () => Date.now() });
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the window", () => {
  it("allows the limit, refuses the next request, and allows again when the window ends", async () => {
    const limit = makeRateLimitPreHandler({ limit: 3, windowMs: 60_000, keyPrefix: "reset" });

    for (let i = 0; i < 3; i++) expect((await hit(limit)).code, `request ${i + 1}`).toBe(200);

    const refused = await hit(limit);
    expect(refused.code).toBe(429);
    expect(refused.body?.["code"]).toBe("RATE_LIMIT_EXCEEDED");
    expect(refused.headers["Retry-After"]).toBe("60");

    // One millisecond before the boundary: still refused.
    vi.setSystemTime(new Date(T0.getTime() + 59_999));
    expect((await hit(limit)).code).toBe(429);

    // At the boundary the bucket is gone, and the caller is a first-time caller again.
    vi.setSystemTime(new Date(T0.getTime() + 60_000));
    const allowed = await hit(limit);
    expect(allowed.code).toBe(200);
    expect(allowed.headers["X-RateLimit-Remaining"]).toBe("2");
  });

  it("counts down Retry-After instead of repeating the whole window", async () => {
    const limit = makeRateLimitPreHandler({ limit: 1, windowMs: 60_000, keyPrefix: "count-down" });
    await hit(limit);
    expect((await hit(limit)).headers["Retry-After"]).toBe("60");

    vi.setSystemTime(new Date(T0.getTime() + 45_000));
    const later = await hit(limit);
    expect(later.code).toBe(429);
    // 15 seconds left, not another minute: a client that honours this recovers on time.
    expect(later.headers["Retry-After"]).toBe("15");

    vi.setSystemTime(new Date(T0.getTime() + 59_100));
    expect((await hit(limit)).headers["Retry-After"]).toBe("1");
  });

  it("does not extend the window when traffic keeps arriving", async () => {
    const limit = makeRateLimitPreHandler({ limit: 2, windowMs: 10_000, keyPrefix: "no-extend" });
    await hit(limit);
    // A request every 3 seconds for the whole window: each one is inside it, so none may
    // push the expiry out.
    for (const offset of [3_000, 6_000, 9_000]) {
      vi.setSystemTime(new Date(T0.getTime() + offset));
      await hit(limit);
    }
    vi.setSystemTime(new Date(T0.getTime() + 10_000));
    expect((await hit(limit)).code).toBe(200);
  });

  it("keeps each identity in its own window", async () => {
    const limit = makeRateLimitPreHandler({ limit: 1, windowMs: 60_000, keyPrefix: "per-ip" });
    expect((await hit(limit, request({ ip: "203.0.113.7" }))).code).toBe(200);
    expect((await hit(limit, request({ ip: "203.0.113.7" }))).code).toBe(429);
    // A different address has not spent anything, so it is not refused for its neighbour's
    // behaviour — the failure mode of a shared bucket.
    expect((await hit(limit, request({ ip: "198.51.100.9" }))).code).toBe(200);
  });
});

describe("the per-identity limiter", () => {
  it("resets the user's window too, and reports which identity it bucketed", async () => {
    const limit = makeUserRateLimitPreHandler({ limit: 2, windowMs: 30_000, keyPrefix: "user" });
    const alice = request({ user: "alice" });
    expect((await hit(limit, alice)).code).toBe(200);
    expect((await hit(limit, alice)).code).toBe(200);
    const refused = await hit(limit, alice);
    expect(refused.code).toBe(429);
    expect(refused.headers["X-RateLimit-User"]).toBe("alice");
    expect(refused.headers["Retry-After"]).toBe("30");

    // Bob is unaffected while Alice is throttled.
    expect((await hit(limit, request({ user: "bob" }))).code).toBe(200);

    vi.setSystemTime(new Date(T0.getTime() + 30_000));
    expect((await hit(limit, alice)).code).toBe(200);
  });

  it("never leaks the token it bucketed on", async () => {
    const limit = makeUserRateLimitPreHandler({ limit: 1, windowMs: 60_000, keyPrefix: "byok" });
    const byok = {
      headers: { authorization: "Bearer sk-live-supersecret" },
      socket: { remoteAddress: "203.0.113.7" },
    } as unknown as FastifyRequest;
    await hit(limit, byok);
    const refused = await hit(limit, byok);
    expect(refused.headers["X-RateLimit-User"]).toBe("key");
    expect(JSON.stringify(refused)).not.toContain("supersecret");
  });
});
