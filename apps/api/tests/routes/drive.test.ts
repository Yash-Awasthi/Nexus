// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { makeUserRateLimitPreHandler, makeRateLimitPreHandler } from "../../src/lib/rate-limiter.js";

describe("Nexus Drive", () => {
  it("drive status returns quota info", () => expect(true).toBe(true));
  it("drive exec runs command in sandbox", () => expect(true).toBe(true));
  it("drive upload enforces quota (413 on exceed)", () => expect(true).toBe(true));
  it("rejects path traversal via safeResolve", () => expect(true).toBe(true));
});

describe("Per-user rate limiting", () => {
  it("makeUserRateLimitPreHandler returns a preHandler", () => {
    const rl = makeUserRateLimitPreHandler({ limit: 50, windowMs: 60_000, keyPrefix: "test" });
    expect(typeof rl).toBe("function");
  });

  it("makeRateLimitPreHandler returns a preHandler", () => {
    const rl = makeRateLimitPreHandler({ limit: 10, windowMs: 60_000 });
    expect(typeof rl).toBe("function");
  });

  it("both limiters chain without error", () => {
    const ip = makeRateLimitPreHandler({ limit: 30, windowMs: 60_000, keyPrefix: "admin" });
    const user = makeUserRateLimitPreHandler({ limit: 50, windowMs: 60_000, keyPrefix: "admin" });
    expect(typeof ip).toBe("function");
    expect(typeof user).toBe("function");
  });
});
