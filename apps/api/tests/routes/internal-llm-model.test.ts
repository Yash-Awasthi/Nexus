// SPDX-License-Identifier: Apache-2.0
/** With no default model configured, internal calls ask the first provider for its own model. */
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

process.env.GROQ_API_KEY = "gsk_test";
delete process.env.NEXUS_DEFAULT_MODEL;

const asked: string[] = [];
const realFetch = globalThis.fetch;
vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url instanceof Request ? url.url : url);
  if (!u.includes("api.groq.com")) return realFetch(url, init);
  asked.push((JSON.parse(String(init?.body)) as { model: string }).model);
  return new Response(
    JSON.stringify({
      id: "x",
      model: "openai/gpt-oss-120b",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "A short summary." },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
});

const { buildServer } = await import("../../src/server.ts");
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
});

it("does not send another provider's model name to Groq", async () => {
  const scored = await app.inject({
    method: "POST",
    url: "/api/deliberations/d1/scoring",
    payload: { members: [{ name: "a", agreement: 0.8, final: 0.9 }] },
  });
  expect(scored.statusCode, scored.body).toBe(201);
  const replay = await app.inject({ method: "GET", url: "/api/deliberations/d1/replay" });
  expect(replay.statusCode, replay.body).toBe(200);
  expect(asked.length).toBeGreaterThan(0);
  expect(asked.every((m) => m === "openai/gpt-oss-120b")).toBe(true);
});
