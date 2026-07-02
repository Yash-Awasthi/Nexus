// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { AccountPool, type AccountConfig, type PoolOptions } from "../src/index.js";

// Deterministic clock + RNG so routing and backoff are fully reproducible.
function fixedPool(accounts: AccountConfig[], overrides: Partial<PoolOptions> = {}) {
  let t = 1_000_000;
  const clock = { advance: (ms: number) => (t += ms) };
  const pool = new AccountPool(accounts, {
    now: () => t,
    random: () => 0, // deterministic: weighted/p2c always take the first choice
    cooldownMs: 30_000,
    breakerThreshold: 3,
    breakerResetMs: 60_000,
    jitterMs: 0,
    ...overrides,
  });
  return { pool, clock };
}

const THREE: AccountConfig[] = [
  { id: "sub1", provider: "anthropic", tier: "sub" },
  { id: "cheap1", provider: "anthropic", tier: "cheap" },
  { id: "free1", provider: "anthropic", tier: "free" },
];

describe("tier ladder", () => {
  it("prefers the highest tier when healthy", () => {
    const { pool } = fixedPool(THREE);
    expect(pool.pick("anthropic")?.id).toBe("sub1");
  });

  it("falls down the ladder as higher tiers become unavailable", () => {
    const { pool } = fixedPool(THREE);
    pool.recordFailure("sub1", { status: 429 }); // sub1 → cooldown
    expect(pool.pick("anthropic")?.id).toBe("cheap1");
    pool.recordFailure("cheap1", { status: 429 });
    expect(pool.pick("anthropic")?.id).toBe("free1");
    pool.recordFailure("free1", { status: 429 });
    expect(pool.pick("anthropic")).toBeNull(); // all cooling down
  });

  it("recovers after cooldown elapses", () => {
    const { pool, clock } = fixedPool(THREE);
    pool.recordFailure("sub1", { status: 429 });
    expect(pool.pick("anthropic")?.id).toBe("cheap1");
    clock.advance(30_001);
    expect(pool.pick("anthropic")?.id).toBe("sub1"); // sub1 healthy again
  });

  it("only returns accounts for the requested provider", () => {
    const { pool } = fixedPool([
      { id: "a", provider: "anthropic", tier: "free" },
      { id: "o", provider: "openai", tier: "sub" },
    ]);
    expect(pool.pick("openai")?.id).toBe("o");
    expect(pool.pick("groq")).toBeNull();
  });

  it("honours minTier", () => {
    const { pool } = fixedPool(THREE);
    pool.recordFailure("sub1", { status: 429 });
    // Only sub is acceptable, but it's cooling down → null.
    expect(pool.pick("anthropic", { minTier: "sub" })).toBeNull();
  });
});

describe("circuit breaker", () => {
  it("opens after the failure threshold and blocks the account", () => {
    const { pool } = fixedPool([{ id: "a", provider: "x", tier: "sub" }]);
    for (let i = 0; i < 3; i++) pool.recordFailure("a");
    expect(pool.health("a")).toBe("open");
    expect(pool.pick("x")).toBeNull();
  });

  it("half-opens after the reset window and closes on success", () => {
    const { pool, clock } = fixedPool([{ id: "a", provider: "x", tier: "sub" }]);
    for (let i = 0; i < 3; i++) pool.recordFailure("a");
    clock.advance(60_001);
    expect(pool.health("a")).toBe("healthy"); // probe allowed
    pool.recordSuccess("a");
    expect(pool.get("a")!.failures).toBe(0);
    expect(pool.get("a")!.breakerTrips).toBe(0);
  });

  it("backs off exponentially across repeated trips", () => {
    const { pool, clock } = fixedPool([{ id: "a", provider: "x", tier: "sub" }]);
    for (let i = 0; i < 3; i++) pool.recordFailure("a"); // trip 1 → 60s
    clock.advance(60_001);
    for (let i = 0; i < 3; i++) pool.recordFailure("a"); // trip 2 → 120s
    clock.advance(60_001);
    expect(pool.health("a")).toBe("open"); // still open (needs 120s)
    clock.advance(60_001);
    expect(pool.health("a")).toBe("healthy");
  });

  it("a success resets the consecutive-failure count", () => {
    const { pool } = fixedPool([{ id: "a", provider: "x", tier: "sub" }]);
    pool.recordFailure("a");
    pool.recordFailure("a");
    pool.recordSuccess("a");
    pool.recordFailure("a");
    expect(pool.health("a")).toBe("healthy"); // only 1 failure since success
  });
});

describe("quota", () => {
  it("excludes accounts without room for the estimate", () => {
    const { pool } = fixedPool([
      { id: "small", provider: "x", tier: "sub", quotaLimit: 100 },
      { id: "big", provider: "x", tier: "cheap", quotaLimit: 10_000 },
    ]);
    pool.recordUsage("small", 60);
    // sub has 40 left, need 50 → falls to cheap.
    expect(pool.pick("x", { estTokens: 50 })?.id).toBe("big");
  });

  it("resets the quota window at quotaResetAt", () => {
    let t = 0;
    const pool = new AccountPool([{ id: "a", provider: "x", quotaLimit: 100, quotaResetAt: 5_000 }], {
      now: () => t,
    });
    pool.recordUsage("a", 100);
    expect(pool.remainingQuota("a")).toBe(0);
    t = 5_001;
    expect(pool.remainingQuota("a")).toBe(100);
  });

  it("quota-aware strategy picks the account with the most remaining", () => {
    const { pool } = fixedPool([
      { id: "a", provider: "x", tier: "free", quotaLimit: 1000 },
      { id: "b", provider: "x", tier: "free", quotaLimit: 1000 },
    ]);
    pool.recordUsage("a", 900);
    expect(pool.pick("x", { strategy: "quota-aware" })?.id).toBe("b");
  });
});

describe("strategies", () => {
  it("round-robin rotates across eligible accounts", () => {
    const { pool } = fixedPool([
      { id: "a", provider: "x", tier: "free" },
      { id: "b", provider: "x", tier: "free" },
    ]);
    const seq = [0, 1, 2, 3].map(() => pool.pick("x", { strategy: "round-robin" })?.id);
    expect(seq).toEqual(["a", "b", "a", "b"]);
  });

  it("weighted honours weights (RNG=0 → first bucket)", () => {
    const { pool } = fixedPool([
      { id: "a", provider: "x", tier: "free", weight: 1 },
      { id: "b", provider: "x", tier: "free", weight: 9 },
    ]);
    // random()=0 lands in the first weight bucket → "a".
    expect(pool.pick("x", { strategy: "weighted" })?.id).toBe("a");
  });

  it("power-of-2 picks the less-loaded of two", () => {
    const { pool } = fixedPool([
      { id: "a", provider: "x", tier: "free", quotaLimit: 100 },
      { id: "b", provider: "x", tier: "free", quotaLimit: 100 },
    ]);
    pool.recordUsage("a", 90); // a more loaded
    // random()=0 → compares index 0 (a) vs 1 (b); b less loaded → b.
    expect(pool.pick("x", { strategy: "power-of-2" })?.id).toBe("b");
  });
});
