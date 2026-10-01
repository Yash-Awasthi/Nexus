// SPDX-License-Identifier: Apache-2.0
/**
 * Costs surface route tests — the §16.7 extraction of /costs/* from
 * api-bridge.ts into routes/costs.ts.
 *
 * Pin the response shapes through the real HTTP surface, with real entries
 * recorded into the shared cost log (the same in-memory array the recording
 * path writes to). Synthetic model keys keep each test independent — unknown
 * models fall back to the [1.0, 3.0] default pricing.
 *
 * Every test authenticates as its own freshly-numbered user. These surfaces are
 * scoped to the caller, so a unique owner per test makes the log process-global
 * and the assertions exact at the same time: other tests' entries belong to
 * other owners and are excluded.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";

import { buildServer } from "../../src/server.js";
import { costLogStore } from "../../src/lib/cost-log.js";

const SECRET = "costs-route-test-secret";

let app: FastifyInstance;
let userSeq = 0;

function makeJwt(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(
    JSON.stringify({ sub, role: "admin", iat: now, exp: now + 3600 }),
  ).toString("base64url");
  const sig = createHmac("sha256", SECRET).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

/** A fresh owner for one test, plus the header that authenticates as them. */
function asNewUser(): { sub: string; headers: Record<string, string> } {
  const sub = `costs-user-${++userSeq}`;
  return { sub, headers: { authorization: `Bearer ${makeJwt(sub)}` } };
}

beforeEach(async () => {
  process.env.NEXUS_JWT_SECRET = SECRET;
  app = await buildServer();
  await app.ready();
});

afterEach(async () => {
  await app.close();
  delete process.env.NEXUS_JWT_SECRET;
});

/**
 * Record one entry owned by `sub` with the default fallback price [1.0, 3.0]
 * per 1M tokens. Entries recorded without an owner belong to no user and are
 * deliberately invisible to these per-user surfaces.
 */
function recordCost(
  sub: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  ts: string = new Date().toISOString(),
): number {
  const costUsd = (inputTokens * 1.0 + outputTokens * 3.0) / 1_000_000;
  costLogStore.record({ ts, model, inputTokens, outputTokens, costUsd, userId: sub });
  return costUsd;
}

describe("GET /api/costs (real log-derived analytics)", () => {
  it("pricing lists the shared MODEL_PRICES table", async () => {
    const { headers } = asNewUser();
    const res = await app.inject({ method: "GET", url: "/api/costs/pricing", headers });
    expect(res.statusCode).toBe(200);
    const models = res.json<{
      models: { model: string; inputPer1MTokens: number; outputPer1MTokens: number }[];
    }>().models;
    const gpt4o = models.find((m) => m.model === "openai/gpt-4o");
    expect(gpt4o).toBeDefined();
    expect(gpt4o!.inputPer1MTokens).toBe(2.5);
    expect(gpt4o!.outputPer1MTokens).toBe(10);
  });

  it("breakdown aggregates recorded entries per model", async () => {
    const { sub, headers } = asNewUser();
    const usd = recordCost(sub, "test/model-a", 1000, 500); // (1000*1 + 500*3)/1e6
    const res = await app.inject({ method: "GET", url: "/api/costs/breakdown", headers });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      breakdown: { model: string; calls: number; tokens: number; usd: number }[];
      totalUsd: number;
    }>();
    const row = body.breakdown.find((b) => b.model === "test/model-a");
    expect(row).toEqual({ model: "test/model-a", calls: 1, tokens: 1500, usd });
    expect(body.totalUsd).toBeCloseTo(usd, 10);
  });

  it("per-provider derives the provider from the model prefix", async () => {
    const { sub, headers } = asNewUser();
    recordCost(sub, "test/model-b", 1000, 1000); // 0.004
    const res = await app.inject({ method: "GET", url: "/api/costs/per-provider", headers });
    const providers = res.json<{ providers: { name: string; usd: number }[] }>().providers;
    const provider = providers.find((p) => p.name === "test");
    expect(provider).toBeDefined();
    expect(provider!.usd).toBeCloseTo(0.004, 10);
  });

  it("efficiency reports tokens per dollar", async () => {
    const { sub, headers } = asNewUser();
    recordCost(sub, "test/model-c", 1000, 500); // 0.0025 for 1500 tokens
    const res = await app.inject({ method: "GET", url: "/api/costs/efficiency", headers });
    const efficiency = res.json<{ efficiency: { model: string; tokensPerDollar: number }[] }>()
      .efficiency;
    const row = efficiency.find((e) => e.model === "test/model-c");
    expect(row).toEqual({ model: "test/model-c", tokensPerDollar: 600_000 });
  });

  it("limits reports spend windows (and is not hard-enforced)", async () => {
    const { sub, headers } = asNewUser();
    recordCost(sub, "test/model-e", 1000, 500);
    const res = await app.inject({ method: "GET", url: "/api/costs/limits", headers });
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
    const { sub, headers } = asNewUser();
    const usd = recordCost(sub, "test/model-f", 1000, 500);
    const res = await app.inject({ method: "GET", url: "/api/costs/dashboard?days=30", headers });
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
    expect(body.totalUsd).toBeCloseTo(usd, 10);
    expect(body.totalTokens).toBe(1500);
    expect(body.requests).toBe(1);
    expect(body.byModel["test/model-f"]).toBeCloseTo(usd, 6);
    const today = new Date().toISOString().slice(0, 10);
    expect(body.byDay[today]).toBeCloseTo(usd, 6);
  });
});

describe("cost surfaces are scoped to the caller", () => {
  it("hides another user's entries from the dashboard", async () => {
    const alice = asNewUser();
    const bob = asNewUser();
    recordCost(alice.sub, "test/only-alice", 1000, 0);
    const bobUsd = recordCost(bob.sub, "test/only-bob", 2000, 0);

    const res = await app.inject({
      method: "GET",
      url: "/api/costs/dashboard?days=30",
      headers: bob.headers,
    });
    const body = res.json<{ totalUsd: number; byModel: Record<string, number> }>();

    expect(body.byModel["test/only-alice"]).toBeUndefined();
    expect(body.byModel["test/only-bob"]).toBeCloseTo(bobUsd, 6);
    expect(body.totalUsd).toBeCloseTo(bobUsd, 10);
  });

  it("shows nothing to a caller whose identity did not resolve", async () => {
    const alice = asNewUser();
    recordCost(alice.sub, "test/owned-by-alice", 1000, 0);

    // A valid master key authenticates but owns no user.
    process.env.NEXUS_API_KEY = "master-key-for-test";
    const res = await app.inject({
      method: "GET",
      url: "/api/costs/dashboard?days=30",
      headers: { authorization: "Bearer master-key-for-test" },
    });
    delete process.env.NEXUS_API_KEY;

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      totalUsd: number;
      requests: number;
      byModel: Record<string, number>;
    }>();
    expect(body.requests).toBe(0);
    expect(body.totalUsd).toBe(0);
    expect(body.byModel["test/owned-by-alice"]).toBeUndefined();
  });

  it("never attributes an unowned entry to a caller", async () => {
    const { headers } = asNewUser();
    const orphanUsd = (1000 * 1.0) / 1_000_000;
    costLogStore.record({
      ts: new Date().toISOString(),
      model: "test/orphan",
      inputTokens: 1000,
      outputTokens: 0,
      costUsd: orphanUsd,
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/costs/dashboard?days=30",
      headers,
    });
    const body = res.json<{ byModel: Record<string, number> }>();
    expect(body.byModel["test/orphan"]).toBeUndefined();
  });
});
