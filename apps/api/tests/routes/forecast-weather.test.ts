// SPDX-License-Identifier: Apache-2.0
/** Weather for any city, and no invented numbers for domains nothing forecasts. */
import crypto from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const SECRET = "forecast-weather-secret";
process.env.NEXUS_JWT_SECRET = SECRET;
delete process.env.OWM_API_KEY;

const realFetch = globalThis.fetch;
const seen: string[] = [];
vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("geocoding-api.open-meteo.com")) {
      seen.push(url);
      return new Response(
        JSON.stringify({
          results: [{ name: "Oslo", country: "Norway", latitude: 59.91, longitude: 10.75 }],
        }),
      );
    }
    if (url.includes("api.open-meteo.com/v1/forecast"))
      return new Response(
        JSON.stringify({
          daily: {
            time: ["2026-09-29"],
            temperature_2m_max: [12],
            temperature_2m_min: [4],
            precipitation_probability_max: [60],
            weather_code: [63],
          },
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

describe("GET /api/v1/forecast/weather", () => {
  it("forecasts the named city", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/forecast/weather?city=Oslo",
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(seen[0]).toContain("name=Oslo");
    expect(res.json()).toMatchObject({
      city: "Oslo",
      result: {
        summary: "Oslo, Norway: rain, 4–12°C",
        scenarios: [{ label: "2026-09-29", probability: 0.6 }],
      },
    });
  });

  it("needs a city", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/forecast/weather", headers });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/v1/forecast/:domain", () => {
  it("says a domain has no source instead of inventing a forecast", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/forecast/military", headers });
    expect(res.json()).toMatchObject({
      result: { confidence: 0, scenarios: [], indicators: { source: "noop" } },
    });
  });
});
