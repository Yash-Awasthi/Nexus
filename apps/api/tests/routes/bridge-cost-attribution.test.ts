// SPDX-License-Identifier: Apache-2.0
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { LlmDriver } from "@nexus/llm-drivers";

const state = vi.hoisted(() => ({ model: "openai/gpt-oss-120b" }));
const savedConnection = () => [
  {
    id: "saved-connection",
    driver: {
      provider: "groq",
      model: "requested-alias",
      countTokens: () => 1,
      complete: async () => ({
        id: "answer",
        content: "Summary",
        model: state.model,
        usage: { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 },
        finishReason: "stop",
        durationMs: 1,
      }),
    } as LlmDriver,
  },
];
// asUser reads listUserDrivers through its own module binding, so both are replaced.
vi.mock("../../src/lib/provider-keys.js", async (original) => {
  const { userContext } = await import("../../src/lib/user-context.js");
  return {
    ...(await original<typeof import("../../src/lib/provider-keys.js")>()),
    listUserDrivers: async () => savedConnection(),
    asUser: (userId: string | null, fn: () => unknown) =>
      userContext.run({ userId, userDrivers: savedConnection() }, fn),
  };
});
const { buildServer } = await import("../../src/server.js");
const { costLogStore } = await import("../../src/lib/cost-log.js");
const secret = "bridge-cost-regression-secret";
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const head = b64({ alg: "HS256", typ: "JWT" });
const body = b64({
  sub: "bridge-cost-owner",
  role: "admin",
  exp: Math.floor(Date.now() / 1000) + 3600,
});
const signature = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
const headers = { authorization: `Bearer ${head}.${body}.${signature}` };
let app: FastifyInstance;
beforeAll(async () => {
  process.env.NEXUS_JWT_SECRET = secret;
  app = await buildServer();
  await app.ready();
  await app.inject({
    method: "POST",
    url: "/api/deliberations/attribution/scoring",
    headers,
    payload: { members: [] },
  });
});
afterAll(async () => {
  await app.close();
  delete process.env.NEXUS_JWT_SECRET;
});

it("internal bridge calls record the returned model and canonical provider, not DEFAULT_MODEL", async () => {
  const response = await app.inject({ url: "/api/deliberations/attribution/replay", headers });
  expect(response.statusCode, response.body).toBe(200);
  expect(costLogStore.entries.at(-1)).toMatchObject({
    model: "groq/openai/gpt-oss-120b",
    inputTokens: 1000,
    outputTokens: 1000,
    costUsd: 0.00075,
    userId: "bridge-cost-owner",
  });
});

it("keeps unpriced usage visible without inventing a rate", async () => {
  state.model = "private-model";
  // Different scores make a different prompt, so the first test's cached answer is not reused.
  await app.inject({
    method: "POST",
    url: "/api/deliberations/unpriced/scoring",
    headers,
    payload: { members: [{ agreement: 0.5, final: 0.5 }] },
  });
  await app.inject({ url: "/api/deliberations/unpriced/replay", headers });
  expect(costLogStore.entries.at(-1)).toMatchObject({
    model: "groq/private-model",
    costUsd: 0,
    pricingKnown: false,
    inputTokens: 1000,
  });
  const report = await app.inject({ url: "/api/costs/dashboard", headers });
  expect(report.json()).toMatchObject({ unpricedRequests: 1 });
});
