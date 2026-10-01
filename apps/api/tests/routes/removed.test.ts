// SPDX-License-Identifier: Apache-2.0
/** Removed features stay removed: none of their endpoints is registered. */
import type { FastifyInstance } from "fastify";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { buildServer } from "../../src/server.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("removed features", () => {
  it("answer 404 on every old endpoint", async () => {
    for (const [method, url] of [
      ["POST", "/api/v1/projects/p1/autopilot/runs"],
      ["GET", "/api/v1/autopilot/runs/r1"],
      ["GET", "/api/v1/autopilot/runs/r1/stream"],
      ["GET", "/api/v1/intelligence-hub/modules"],
      ["POST", "/api/v1/intelligence-hub/moa"],
      ["POST", "/api/deliberate"],
    ] as const) {
      const r = await app.inject({ method, url, payload: method === "POST" ? {} : undefined });
      expect(r.statusCode, `${method} ${url}`).toBe(404);
    }
    const routes = app.printRoutes({ commonPrefix: false });
    expect(routes).not.toMatch(/autopilot|intelligence-hub/);
  });
});
