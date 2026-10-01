// SPDX-License-Identifier: Apache-2.0
/** An optional backend that is not configured says so instead of answering with invented data. */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

delete process.env.POLYMARKET_ENABLED;
delete process.env.YOUTUBE_API_KEY;
delete process.env.HF_TOKEN;

const { buildServer } = await import("../../src/server.js");

let app: FastifyInstance;
const call = (method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({ method, url, headers: { authorization: "Bearer test" }, payload });

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

describe("unconfigured backends", () => {
  it("prediction markets refuse rather than list made-up markets", async () => {
    const r = await call("GET", "/api/v1/prediction-markets");
    expect(r.statusCode).toBe(503);
    expect(r.body).toMatch(/POLYMARKET_ENABLED/);
  });
});
