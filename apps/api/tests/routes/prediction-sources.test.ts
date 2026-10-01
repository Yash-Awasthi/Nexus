// SPDX-License-Identifier: Apache-2.0
/** Prediction markets are served from Kalshi and Metaculus as well as Polymarket, by `source`. */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

delete process.env.POLYMARKET_ENABLED;
delete process.env.METACULUS_TOKEN;

const { buildServer } = await import("../../src/server.js");

let app: FastifyInstance;
const seen: { url: string; auth: string | null }[] = [];
const call = (url: string) =>
  app.inject({ method: "GET", url, headers: { authorization: "Bearer test" } });

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!/kalshi|metaculus/.test(url)) return real(input, init);
    seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
    return Response.json(
      url.includes("kalshi")
        ? {
            markets: [{ ticker: "FED-26DEC", title: "Fed above 4%?", last_price: 62, volume: 10 }],
          }
        : {
            results: [{ id: 7, title: "AGI by 2040?", community_prediction: { q2: 0.41 } }],
            count: 1,
          },
    );
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
});

it("lists Kalshi markets", async () => {
  const r = await call("/api/v1/prediction-markets?source=kalshi&limit=5");
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json<{ markets: { id: string }[] }>().markets[0]!.id).toBe("FED-26DEC");
});

it("needs a token for Metaculus, then sends it", async () => {
  const off = await call("/api/v1/prediction-markets?source=metaculus");
  expect(off.statusCode).toBe(503);
  expect(off.body).toMatch(/METACULUS_TOKEN/);

  process.env.METACULUS_TOKEN = "tok";
  const r = await call("/api/v1/prediction-markets?source=metaculus");
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json<{ markets: { question: string }[] }>().markets[0]!.question).toBe("AGI by 2040?");
  expect(seen.at(-1)!.auth).toBe("Token tok");
});

it("refuses an unknown source", async () => {
  expect((await call("/api/v1/prediction-markets?source=nope")).statusCode).toBe(400);
});
