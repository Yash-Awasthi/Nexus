// SPDX-License-Identifier: Apache-2.0
/** NX-SEC-024: a bucket's expiry is set in the same request that creates it, so it can never be left without one. */
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";

import { makeRateLimitPreHandler } from "../../src/lib/rate-limiter.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

it("sends INCR and a create-only EXPIRE in one pipeline", async () => {
  process.env.UPSTASH_REDIS_REST_URL = "https://upstash.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "t";
  const bodies: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return Response.json([{ result: 1 }, { result: 1 }]);
    }),
  );
  const app = Fastify();
  app.get(
    "/x",
    {
      preHandler: makeRateLimitPreHandler({
        limit: 5,
        windowMs: 60_000,
        keyPrefix: "upstash-test",
      }),
    },
    async () => "ok",
  );
  const res = await app.inject({ method: "GET", url: "/x" });
  expect(res.statusCode).toBe(200);
  expect(bodies).toEqual([
    [
      ["INCR", "ratelimit:upstash-test:127.0.0.1"],
      ["EXPIRE", "ratelimit:upstash-test:127.0.0.1", 60, "NX"],
    ],
  ]);
  await app.close();
});
