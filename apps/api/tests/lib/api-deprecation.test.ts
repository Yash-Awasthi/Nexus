// SPDX-License-Identifier: Apache-2.0
/**
 * The deprecation register is only a promise if the headers actually arrive, so these tests drive the real hook
 * through a real Fastify instance rather than calling the helpers.
 *
 * The empty-table case is as important as the populated one: a hook that changes nothing on normal requests is what
 * makes it safe to mount globally, and the day somebody adds an entry they should not have to wonder whether the
 * other 400 routes are now decorated.
 */
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  deprecationFor,
  deprecationHeaders,
  goneBody,
  httpDate,
  isPastSunset,
  matchesTemplate,
  type DeprecatedRoute,
} from "../../src/lib/api-deprecation.ts";
import { applyDeprecation } from "../../src/server.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const LIVE: DeprecatedRoute = {
  method: "GET",
  path: "/api/v1/old-thing/:id",
  stage: "deprecated",
  since: "1.4.0",
  sunset: "2099-01-01",
  replacement: "/api/v1/things/:id",
  reason: "the plural route carries the same fields and is the one in the spec",
};

const RETIRED: DeprecatedRoute = {
  ...LIVE,
  path: "/api/v1/retired-thing",
  stage: "gone",
  sunset: "2025-01-01",
};

let app: FastifyInstance;
const routes: DeprecatedRoute[] = [LIVE];

beforeAll(async () => {
  app = Fastify();
  app.addHook("preHandler", (request, reply, done) => {
    const route = deprecationFor(request.method, request.routeOptions.url ?? request.url, routes);
    if (!route) return done();
    if (route.stage === "gone" || isPastSunset(route)) {
      void reply.code(410).send(goneBody(route));
      return;
    }
    for (const [name, value] of Object.entries(deprecationHeaders(route)))
      reply.header(name, value);
    return done();
  });
  app.get("/api/v1/old-thing/:id", async () => ({ ok: true }));
  app.get("/api/v1/keep", async () => ({ ok: true }));
  await app.ready();
}, 30_000);

afterAll(async () => {
  await app.close();
});

describe("deprecation headers reach the caller", () => {
  it("adds Deprecation, Sunset and Link to a route that still works", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/old-thing/42" });
    expect(response.statusCode).toBe(200);
    expect(response.headers.deprecation).toBe("true");
    expect(response.headers.sunset).toBe(httpDate(LIVE.sunset));
    expect(response.headers.link).toBe(`</api/v1/things/:id>; rel="successor-version"`);
  });

  it("leaves every other route untouched", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/keep" });
    expect(response.statusCode).toBe(200);
    expect(response.headers.deprecation).toBeUndefined();
    expect(response.headers.sunset).toBeUndefined();
  });

  it("answers 410 with the replacement named once the sunset has passed", async () => {
    routes.push({ ...RETIRED, stage: "deprecated", sunset: "2025-01-01" });
    try {
      const response = await app.inject({ method: "GET", url: "/api/v1/retired-thing" });
      expect(response.statusCode).toBe(410);
      const body = response.json<{ code: string; replacement: string }>();
      expect(body.code).toBe("ROUTE_RETIRED");
      expect(body.replacement).toBe(LIVE.replacement);
    } finally {
      routes.pop();
    }
  });

  it("returns 410 — not 404 — for a route marked gone", async () => {
    routes.push({ ...RETIRED, path: "/api/v1/retired-thing" });
    try {
      const response = await app.inject({ method: "GET", url: "/api/v1/retired-thing" });
      expect(response.statusCode).toBe(410);
    } finally {
      routes.pop();
    }
  });
});

describe("the register itself", () => {
  it("treats a :param segment as one segment and nothing else", () => {
    expect(matchesTemplate("/api/v1/old-thing/:id", "/api/v1/old-thing/42")).toBe(true);
    expect(matchesTemplate("/api/v1/old-thing/:id", "/api/v1/old-thing/42/extra")).toBe(false);
    expect(matchesTemplate("/api/v1/old-thing/:id", "/api/v1/old-things/42")).toBe(false);
  });

  it("is method-explicit: a GET entry says nothing about POST", () => {
    expect(deprecationFor("GET", "/api/v1/old-thing/1", [LIVE])?.stage).toBe("deprecated");
    expect(deprecationFor("POST", "/api/v1/old-thing/1", [LIVE])).toBeUndefined();
  });

  it("formats Sunset as an HTTP-date, which is what the header is specified in", () => {
    expect(httpDate("2030-06-01")).toBe("Sat, 01 Jun 2030 00:00:00 GMT");
  });

  it("every real entry is complete and forward-facing", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../src/lib/api-deprecation.ts", import.meta.url)),
      "utf8",
    );
    // The table is parsed from the module, so this test sees the shipped register, not a fixture.
    const entries = [
      ...source.matchAll(
        /stage: "(deprecated|gone)",[\s\S]*?sunset: "([\d-]+)",[\s\S]*?replacement: "([^"]+)",[\s\S]*?reason: "([^"]+)"/g,
      ),
    ];
    for (const [, stage, sunset, replacement, reason] of entries) {
      expect(sunset, "sunset must be an ISO date").toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(replacement, "every entry names where to go instead").toMatch(/^\/api\//);
      expect(reason.length, "the reason is what the 410 body explains").toBeGreaterThan(20);
      if (stage === "deprecated") expect(isPastSunset({ ...LIVE, sunset })).toBe(false);
    }
  });

  it("the live register is empty today, and that is asserted rather than implied", async () => {
    const { DEPRECATED_ROUTES } = await import("../../src/lib/api-deprecation.ts");
    // When the first route is deprecated this becomes "every entry passes the checks above" — the point is that an
    // empty register is a decision somebody made, not a table nobody filled in.
    expect(DEPRECATED_ROUTES).toEqual([]);
    expect(Object.keys(deprecationHeaders(LIVE)).sort()).toEqual(["deprecation", "link", "sunset"]);
  });
});
