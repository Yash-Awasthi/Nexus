// SPDX-License-Identifier: Apache-2.0
/** A market's live order book, and a council of models forecasting it against the price. */
import crypto from "node:crypto";

import { DriverRegistry } from "@nexus/llm-drivers";
import type { LlmDriver, LlmRequestOptions } from "@nexus/llm-drivers";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const SECRET = "pm-forecast-secret";
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.POLYMARKET_ENABLED = "true";

const replies: Record<string, string> = {
  "model-a": "PROBABILITY: 70%\nREASON: Polls lean yes.",
  "model-b": "PROBABILITY: 60%\nREASON: Momentum.",
  "model-c": "I cannot say.",
};
const prompts: string[] = [];

vi.mock("../../src/lib/provider-keys.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/provider-keys.js")>()),
  buildUserDriverRegistry: async (_u: string | undefined, providers: Iterable<string>) => {
    const registry = new DriverRegistry();
    for (const p of new Set(providers)) {
      registry.register(
        {
          provider: p,
          model: "scripted",
          complete: async (o: LlmRequestOptions) => {
            prompts.push(String(o.messages.at(-1)?.content));
            return { content: replies[o.model] ?? "", model: o.model, usage: {} };
          },
        } as unknown as LlmDriver,
        p,
      );
    }
    return { registry, missing: [] as string[] };
  },
}));

const MARKET = {
  condition_id: "cond-1",
  question: "Will it rain in Paris tomorrow?",
  tokens: [
    { token_id: "tok-yes", outcome: "Yes", price: 0.55 },
    { token_id: "tok-no", outcome: "No", price: 0.45 },
  ],
};
const realFetch = globalThis.fetch;
vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://clob.polymarket.com/markets/cond-1"))
      return new Response(JSON.stringify(MARKET));
    if (url.startsWith("https://clob.polymarket.com/book?token_id=tok-yes"))
      return new Response(
        JSON.stringify({
          bids: [
            { price: "0.50", size: "10" },
            { price: "0.54", size: "5" },
          ],
          asks: [{ price: "0.56", size: "8" }],
        }),
      );
    return realFetch(input, init);
  }),
);

const { buildServer } = await import("../../src/server.js");

const headers = (() => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: crypto.randomUUID(), role: "agent", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return { authorization: `Bearer ${head}.${body}.${sig}` };
})();

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  vi.unstubAllGlobals();
});

describe("GET /api/v1/prediction-markets/:id/book", () => {
  it("returns the outcome's book with midpoint and spread", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/prediction-markets/cond-1/book?outcome=tok-yes",
      headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ bids: { price: number }[]; midpoint: number; spread: number }>();
    expect(body.bids.map((b) => b.price)).toEqual([0.54, 0.5]);
    expect(body.midpoint).toBeCloseTo(0.55);
    expect(body.spread).toBeCloseTo(0.02);
  });
});

describe("POST /api/v1/prediction-markets/:id/forecast", () => {
  it("aggregates the members' probabilities and compares them with the price", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/prediction-markets/cond-1/forecast",
      headers,
      payload: {
        members: [
          { label: "A", provider: "tokenharbor", model: "model-a" },
          { label: "B", provider: "tokenharbor", model: "model-b" },
          { label: "C", provider: "tokenharbor", model: "model-c" },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      marketYes: number;
      consensus: number;
      edge: number;
      predictions: { label: string; value: number | null }[];
    }>();
    expect(prompts[0]).toContain("Will it rain in Paris tomorrow?");
    expect(prompts[0]).toContain("55%");
    expect(body.marketYes).toBeCloseTo(0.55);
    expect(body.consensus).toBeCloseTo(0.6);
    expect(body.edge).toBeCloseTo(0.05);
    expect(body.predictions.find((p) => p.label === "C")?.value).toBeNull();
  });

  it("needs at least one member", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/prediction-markets/cond-1/forecast",
      headers,
      payload: { members: [] },
    });
    expect(res.statusCode).toBe(400);
  });
});
