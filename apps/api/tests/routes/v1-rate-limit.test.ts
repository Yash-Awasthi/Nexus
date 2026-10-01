// SPDX-License-Identifier: Apache-2.0
/** Every /api/v1 route is rate limited, including ones no named group covers. */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

import { buildServer } from "../../src/server.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

it("throttles one address on an ungrouped /api/v1 route", async () => {
  const hit = () =>
    app.inject({
      method: "GET",
      url: "/api/v1/connectors",
      remoteAddress: "203.0.113.7",
    });
  for (let i = 0; i < 300; i++) expect((await hit()).statusCode).not.toBe(429);
  expect((await hit()).statusCode).toBe(429);
});
