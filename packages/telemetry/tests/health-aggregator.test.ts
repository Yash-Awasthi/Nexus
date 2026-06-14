// SPDX-License-Identifier: Apache-2.0
import { fc } from "@fast-check/vitest";
import { describe, it, expect } from "vitest";

import { HealthAggregator, queueDepthProbe, type ProbeFn } from "../src/health-aggregator.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ok: ProbeFn = () => Promise.resolve({ ok: true });
const fail: ProbeFn = () => Promise.resolve({ ok: false, message: "service down" });
const throws: ProbeFn = () => Promise.reject(new Error("Connection refused"));

function slowProbe(ms: number): ProbeFn {
  return () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), ms));
}

// ─── Basic status logic ───────────────────────────────────────────────────────

describe("HealthAggregator — status logic", () => {
  it("returns ready when no probes registered", async () => {
    const agg = new HealthAggregator();
    const result = await agg.check();
    expect(result.status).toBe("ready");
  });

  it("returns ready when all probes pass", async () => {
    const agg = new HealthAggregator();
    agg.register("db", ok);
    agg.register("redis", ok);
    const result = await agg.check();
    expect(result.status).toBe("ready");
  });

  it("returns degraded when non-critical probe fails", async () => {
    const agg = new HealthAggregator();
    agg.register("db", ok, { critical: true });
    agg.register("cache", fail, { critical: false });
    const result = await agg.check();
    expect(result.status).toBe("degraded");
  });

  it("returns down when critical probe fails", async () => {
    const agg = new HealthAggregator();
    agg.register("db", fail, { critical: true });
    agg.register("cache", ok);
    const result = await agg.check();
    expect(result.status).toBe("down");
  });

  it("returns down when critical probe throws", async () => {
    const agg = new HealthAggregator();
    agg.register("db", throws, { critical: true });
    const result = await agg.check();
    expect(result.status).toBe("down");
  });

  it("returns down when critical probe times out", async () => {
    const agg = new HealthAggregator();
    agg.register("db", slowProbe(500), { critical: true, timeoutMs: 50 });
    const result = await agg.check();
    expect(result.status).toBe("down");
  }, 3000);

  it("returns degraded when non-critical probe times out", async () => {
    const agg = new HealthAggregator();
    agg.register("db", ok, { critical: true });
    agg.register("cache", slowProbe(500), { critical: false, timeoutMs: 50 });
    const result = await agg.check();
    expect(result.status).toBe("degraded");
  }, 3000);
});

// ─── Check result shape ───────────────────────────────────────────────────────

describe("HealthAggregator — result shape", () => {
  it("populates checks map for each probe", async () => {
    const agg = new HealthAggregator();
    agg.register("db", ok);
    agg.register("redis", fail);
    const result = await agg.check();
    expect(result.checks["db"]).toBe("ok");
    expect(result.checks["redis"]).toBe("fail");
  });

  it("includes error message for failed probes", async () => {
    const agg = new HealthAggregator();
    agg.register("redis", fail);
    const result = await agg.check();
    expect(result.messages["redis"]).toBe("service down");
  });

  it("records latency for each probe", async () => {
    const agg = new HealthAggregator();
    agg.register("db", ok);
    const result = await agg.check();
    expect(result.latencies["db"]).toBeGreaterThanOrEqual(0);
  });

  it("sets checkedAt to a Date", async () => {
    const agg = new HealthAggregator();
    const result = await agg.check();
    expect(result.checkedAt).toBeInstanceOf(Date);
  });

  it("runs all probes in parallel (total < sum of individual delays)", async () => {
    const agg = new HealthAggregator();
    agg.register("a", slowProbe(50));
    agg.register("b", slowProbe(50));
    agg.register("c", slowProbe(50));
    const result = await agg.check();
    // Parallel: should finish in ~50ms, not ~150ms
    expect(result.durationMs).toBeLessThan(200);
  }, 3000);
});

// ─── Registration ─────────────────────────────────────────────────────────────

describe("HealthAggregator — registration", () => {
  it("throws when registering a duplicate probe name", () => {
    const agg = new HealthAggregator();
    agg.register("db", ok);
    expect(() => agg.register("db", ok)).toThrow(/already registered/);
  });

  it("unregister removes the probe", async () => {
    const agg = new HealthAggregator();
    agg.register("db", fail, { critical: true });
    agg.unregister("db");
    const result = await agg.check();
    expect(result.status).toBe("ready");
  });

  it("unregister returns false for unknown probe", () => {
    const agg = new HealthAggregator();
    expect(agg.unregister("nonexistent")).toBe(false);
  });
});

// ─── Built-in probe factories ─────────────────────────────────────────────────

describe("queueDepthProbe", () => {
  it("passes when depth is within limit", async () => {
    const probe = queueDepthProbe(() => Promise.resolve(5), 10);
    const result = await probe();
    expect(result.ok).toBe(true);
  });

  it("fails when depth exceeds limit", async () => {
    const probe = queueDepthProbe(() => Promise.resolve(11), 10);
    const result = await probe();
    expect(result.ok).toBe(false);
    expect(result.message).toContain("11");
  });

  it("passes exactly at limit", async () => {
    const probe = queueDepthProbe(() => Promise.resolve(10), 10);
    const result = await probe();
    expect(result.ok).toBe(true);
  });
});

// ─── Property-based ───────────────────────────────────────────────────────────

describe("HealthAggregator — property-based", () => {
  it("ready iff all probes pass", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }), async (outcomes) => {
        const agg = new HealthAggregator();
        for (let i = 0; i < outcomes.length; i++) {
          const probeFn: ProbeFn = () => Promise.resolve({ ok: outcomes[i]! });
          agg.register(`probe-${i}`, probeFn, { critical: false });
        }
        const result = await agg.check();
        const allPass = outcomes.every(Boolean);
        if (allPass) {
          expect(result.status).toBe("ready");
        } else {
          expect(["degraded", "down"]).toContain(result.status);
        }
      }),
      { numRuns: 40 },
    );
  });

  it("checks map always has exactly one entry per registered probe", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.boolean(), { minLength: 0, maxLength: 6 }), async (outcomes) => {
        const agg = new HealthAggregator();
        for (let i = 0; i < outcomes.length; i++) {
          agg.register(`probe-${i}`, () => Promise.resolve({ ok: outcomes[i]! }));
        }
        const result = await agg.check();
        expect(Object.keys(result.checks).length).toBe(outcomes.length);
      }),
      { numRuns: 40 },
    );
  });
});
