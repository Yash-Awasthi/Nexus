// SPDX-License-Identifier: Apache-2.0
/** Bot webhooks act only on requests their platform can be shown to have sent. */
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.TEAMS_BOT_APP_ID = "teams-app";
process.env.TEAMS_BOT_APP_PASSWORD = "teams-password";
process.env.SLACK_SIGNING_SECRET = "slack-signing-secret";
process.env.TELEGRAM_BOT_TOKEN = "123:telegram";
delete process.env.TELEGRAM_WEBHOOK_SECRET;
process.env.NEXUS_API_KEY = "bots-master-key";

const { botsRoutes } = await import("../../src/routes/bots.ts");
const { signSlackRequest } = await import("@nexus/bots");

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

describe("POST /api/v1/bots/slack/events (NX-SEC-008)", () => {
  const slack = (raw: string, headers: Record<string, string>) =>
    app.inject({
      method: "POST",
      url: "/api/v1/bots/slack/events",
      headers: { "content-type": "application/json", ...headers },
      payload: raw,
    });

  it("verifies the signature over the exact bytes Slack sent", async () => {
    const raw = `{"type": "url_verification",  "challenge": "c-123"}`;
    const { signature, timestamp } = signSlackRequest(raw, "slack-signing-secret");
    const res = await slack(raw, {
      "x-slack-signature": signature,
      "x-slack-request-timestamp": timestamp,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ challenge: "c-123" });
  });

  it("refuses an unsigned event", async () => {
    const res = await slack(`{"type":"url_verification","challenge":"x"}`, {});
    expect(res.statusCode).toBe(401);
  });

  it("forwards to the gateway with the server API key", async () => {
    const calls: { url: string; auth: string }[] = [];
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        auth: String((init?.headers as Record<string, string>)?.Authorization),
      });
      return Response.json({ content: [{ type: "text", text: "hi" }] });
    }) as unknown as typeof fetch;
    const raw = JSON.stringify({
      type: "event_callback",
      event: { type: "message", text: "<@U0> hi", user: "U1", channel: "C1", ts: "1.0" },
    });
    const { signature, timestamp } = signSlackRequest(raw, "slack-signing-secret");
    await slack(raw, { "x-slack-signature": signature, "x-slack-request-timestamp": timestamp });
    const gateway = calls.find((c) => c.url.includes("/api/v1/gateway/messages"));
    expect(gateway?.auth).toBe("Bearer bots-master-key");
  });
});

describe("POST /api/v1/bots/telegram/webhook (NX-SEC-008)", () => {
  it("is switched off while no webhook secret is configured", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/bots/telegram/webhook",
      payload: { update_id: 1, message: { message_id: 1, chat: { id: 1 }, text: "hi" } },
    });
    expect(res.statusCode).toBe(503);
  });
});
