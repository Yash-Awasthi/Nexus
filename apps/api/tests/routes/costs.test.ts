// SPDX-License-Identifier: Apache-2.0
/**
 * Costs surface route tests — the §16.7 extraction of /costs/* from
 * api-bridge.ts into routes/costs.ts.
 *
 * Pin the byte-identical response shapes through the real HTTP surface, with
 * real entries recorded into the shared cost log (the same in-memory array the
 * recording path writes to). Synthetic model keys keep each test independent —
 * unknown models fall back to the [1.0, 3.0] default pricing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildServer } from "../../src/server.js";
import { costLogStore } from "../../src/lib/cost-log.js";

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildServer();
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

/** Record one entry with the default fallback price [1.0, 3.0] per 1M tokens. */
function recordCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  ts: string = new Date().toISOString(),
): number {
  const costUsd = (inputTokens * 1.0 + outputTokens * 3.0) / 1_000_000;
  costLogStore.record({ ts, model, inputTokens, outputTokens, costUsd });
  return costUsd;
}

describe("GET /api/costs (real log-derived analytics)", () => {
  it("pricing lists the shared MODEL_PRICES table", async () => {
    const res = await app.inject({ method: "GET", url: "/api/costs/pricing" });
    expect(res.statusCode).toBe(200);
    const models = res.json<{ models: { model: string; inputPer1MTokens: number }[] }>().models;
    const gpt4o = models.find((m) => m.model === "openai/gpt-4o");
    expect(gpt4o).toBeDefined();
    expect(gpt4o!.inputPer1MTokens).toBe(2.5);
    expect(gpt4o!.outputPer1MTokens).toBe(10);
  });

  it("breakdown aggregates recorded entries per model", async () => {
    const usd = recordCost("test/model-a", 1000, 500); // (1000*1 + 500*3)/1e6
    const res = await app.inject({ method: "GET", url: "/api/costs/breakdown" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      breakdown: { model: string; calls: number; tokens: number; usd: number }[];
      totalUsd: number;
    }>();
    const row = body.breakdown.find((b) => b.model === "test/model-a");
    expect(row).toEqual({ model: "test/model-a", calls: 1, tokens: 1500, usd });
    // Global totals may include other tests' entries (shared log) — at least ours.
    expect(body.totalUsd).toBeGreaterThanOrEqual(usd);
  });

  it("per-provider derives the provider from the model prefix", async () => {
    recordCost("test/model-b", 1000, 1000); // 0.004
    const res = await app.inject({ method: "GET", url: "/api/costs/per-provider" });
    const providers = res.json<{ providers: { name: string; usd: number }[] }>().providers;
    const provider = providers.find((p) => p.name === "test");
    expect(provider).toBeDefined();
    expect(provider!.usd).toBeGreaterThanOrEqual(0.004);
  });

  it("efficiency reports tokens per dollar", async () => {
    recordCost("test/model-c", 1000, 500); // 0.0025 for 1500 tokens
    const res = await app.inject({ method: "GET", url: "/api/costs/efficiency" });
    const efficiency = res.json<{ efficiency: { model: string; tokensPerDollar: number }[] }>()
      .efficiency;
    const row = efficiency.find((e) => e.model === "test/model-c");
    expect(row).toEqual({ model: "test/model-c", tokensPerDollar: 600_000 });
  });

  it("organization reports a single seat and the total spend", async () => {
    const usd = recordCost("test/model-d", 1000, 500);
    const res = await app.inject({ method: "GET", url: "/api/costs/organization" });
    const body = res.json<{ totalUsd: number; seats: number; perSeatUsd: number }>();
    expect(body.seats).toBe(1);
    expect(body.totalUsd).toBeGreaterThanOrEqual(usd);
    expect(body.perSeatUsd).toBeGreaterThanOrEqual(usd);
  });

  it("limits reports spend windows (and is not hard-enforced)", async () => {
    recordCost("test/model-e", 1000, 500);
    const res = await app.inject({ method: "GET", url: "/api/costs/limits" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      limits: { monthly_usd: number | null; daily_usd: number | null };
      spent: { monthly_usd: number; daily_usd: number };
      remaining: { monthly_usd: number | null; daily_usd: number | null };
      enforced: boolean;
    }>();
    expect(body.enforced).toBe(false);
    // A fresh entry lands in both the month and the day window.
    expect(body.spent.monthly_usd).toBeGreaterThan(0);
    expect(body.spent.daily_usd).toBeGreaterThan(0);
    // No limits configured → remaining is null, keys still present.
    expect(body.limits.monthly_usd).toBeNull();
    expect(body.remaining.monthly_usd).toBeNull();
  });

  it("dashboard returns the windowed series grouped by day and model", async () => {
    const usd = recordCost("test/model-f", 1000, 500);
    const res = await app.inject({ method: "GET", url: "/api/costs/dashboard?days=30" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      totalUsd: number;
      totalTokens: number;
      byDay: Record<string, number>;
      byModel: Record<string, number>;
      period: string;
      requests: number;
    }>();
    expect(body.period).toBe("30 days");
    expect(body.totalUsd).toBeGreaterThanOrEqual(usd);
    expect(body.totalTokens).toBeGreaterThanOrEqual(1500);
    expect(body.requests).toBeGreaterThanOrEqual(1);
    expect(body.byModel["test/model-f"]).toBeCloseTo(usd, 6);
    const today = new Date().toISOString().slice(0, 10);
    expect(body.byDay[today]).toBeGreaterThanOrEqual(usd);
  });
});