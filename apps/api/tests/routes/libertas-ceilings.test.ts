// SPDX-License-Identifier: Apache-2.0
/** NX-SEC-007: the public completion endpoint spends the operator's key, so no header or address change lifts its ceiling. */
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const { libertasRoutes } = await import("../../src/routes/libertas.ts");

let app: FastifyInstance;

beforeAll(async () => {
  delete process.env.GROQ_API_KEY;
  app = Fastify();
  await app.register(libertasRoutes, { prefix: "/api/v1" });
  await app.ready();
});

afterAll(async () => {
  delete process.env.NEXUS_LIBERTAS_GLOBAL_PER_MIN;
  await app.close();
});

const ask = (
  remoteAddress: string,
  extra: { headers?: Record<string, string>; payload?: object } = {},
) =>
  app.inject({
    method: "POST",
    url: "/api/v1/libertas/complete",
    remoteAddress,
    headers: extra.headers,
    payload: extra.payload ?? { prompt: "hi" },
  });

describe("POST /api/v1/libertas/complete ceilings", () => {
  it("holds a global ceiling whatever addresses the requests come from", async () => {
    process.env.NEXUS_LIBERTAS_GLOBAL_PER_MIN = "3";
    const codes: number[] = [];
    for (const ip of ["198.51.100.1", "198.51.100.2", "198.51.100.3", "198.51.100.4"])
      codes.push((await ask(ip)).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
    process.env.NEXUS_LIBERTAS_GLOBAL_PER_MIN = "100000";
  });

  it("ignores a caller-written X-Forwarded-For", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++)
      codes.push(
        (await ask("203.0.113.9", { headers: { "x-forwarded-for": `10.0.0.${i}` } })).statusCode,
      );
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes[5]).toBe(429);
  });

  it("counts one IPv6 /64 as one client", async () => {
    const codes: number[] = [];
    for (let i = 1; i <= 6; i++) codes.push((await ask(`2001:db8:5:6::${i}`)).statusCode);
    expect(codes[5]).toBe(429);
  });

  it("refuses an oversized prompt and clamps max_tokens", async () => {
    const long = await ask("192.0.2.50", { payload: { prompt: "x".repeat(4001) } });
    expect(long.statusCode).toBe(400);
    const neg = await ask("192.0.2.51", { payload: { prompt: "hi", max_tokens: -5 } });
    expect(neg.statusCode).toBe(200);
  });
});
