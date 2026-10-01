// SPDX-License-Identifier: Apache-2.0
/** A request missing its required body fields is the caller's error (400), not a crash (500). */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

const { buildServer } = await import("../../src/server.js");

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

it.each(["/api/v1/session-sync/s1/push", "/api/v1/stm/transform/partial"])(
  "POST %s with an empty body answers 400",
  async (url) => {
    const r = await app.inject({
      method: "POST",
      url,
      headers: { authorization: "Bearer test" },
      payload: {},
    });
    expect(r.statusCode, r.body).toBe(400);
  },
);
