// SPDX-License-Identifier: Apache-2.0
/** Bot webhooks act only on requests their platform can be shown to have sent. */
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.TEAMS_BOT_APP_ID = "teams-app";
process.env.TEAMS_BOT_APP_PASSWORD = "teams-password";

const { botsRoutes } = await import("../../src/routes/bots.ts");

let app: FastifyInstance;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  app = Fastify();
  await app.register(botsRoutes, { prefix: "/api/v1" });
  await app.ready();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.TEAMS_BOT_APP_ID = "teams-app";
});

afterAll(async () => {
  await app.close();
});

const activity = {
  type: "message",
  text: "hello",
  serviceUrl: "https://attacker.example/",
  conversation: { id: "c1" },
};

describe("POST /api/v1/bots/teams/activity (NX-SEC-005)", () => {
  it("refuses an unsigned activity and sends nothing anywhere", async () => {
    const outbound = vi.fn(async () => Response.json({}));
    globalThis.fetch = outbound as unknown as typeof fetch;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/bots/teams/activity",
      payload: activity,
    });
    expect(res.statusCode).toBe(401);
    expect(outbound.mock.calls.map((c) => String(c[0]))).not.toContainEqual(
      expect.stringContaining("attacker.example"),
    );
    expect(outbound.mock.calls.map((c) => String(c[0]))).not.toContainEqual(
      expect.stringContaining("login.microsoftonline.com"),
    );
  });

  it("is switched off when Teams is not configured", async () => {
    delete process.env.TEAMS_BOT_APP_ID;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/bots/teams/activity",
      payload: activity,
    });
    expect(res.statusCode).toBe(503);
  });
});
