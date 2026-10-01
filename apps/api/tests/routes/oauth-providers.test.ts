// SPDX-License-Identifier: Apache-2.0
/** The sign-in page only offers the OAuth providers this server can complete. */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";

delete process.env.GOOGLE_CLIENT_ID;
process.env.GITHUB_CLIENT_ID = "gh-client";

const { buildServer } = await import("../../src/server.js");

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

it("lists only the configured sign-in providers", async () => {
  const res = await app.inject({ method: "GET", url: "/api/v1/oauth/providers" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ google: false, github: true });
});
