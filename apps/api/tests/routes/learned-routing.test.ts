// SPDX-License-Identifier: Apache-2.0
/**
 * Council runs where members converge become routing samples; the learned
 * routers switch on only once there are enough questions.
 */
import crypto from "node:crypto";

import { DriverRegistry } from "@nexus/llm-drivers";
import type { LlmDriver, LlmRequestOptions, StreamHandler } from "@nexus/llm-drivers";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const SECRET = "learned-routing-secret";
process.env.NEXUS_JWT_SECRET = SECRET;

vi.mock("../../src/lib/provider-keys.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/provider-keys.js")>()),
  buildUserDriverRegistry: async (_u: string | undefined, providers: Iterable<string>) => {
    const registry = new DriverRegistry();
    const reply = async (o: LlmRequestOptions, h: StreamHandler) => {
      const q = String(o.messages.at(-1)?.content ?? "");
      const poem = /poem|haiku|story/.test(q);
      // coder and critic agree on code; bard and critic agree on prose.
      const answer =
        o.model === "critic" ? (poem ? "verse" : "patch") : o.model === "coder" ? "patch" : "verse";
      const text = `Reasoning.\nFINAL: ${answer}`;
      await h({ delta: text, done: true });
      return { content: text, model: o.model, usage: {}, finishReason: "stop" };
    };
    for (const p of new Set(providers))
      registry.register(
        {
          provider: p,
          model: "x",
          stream: reply,
          complete: (o: LlmRequestOptions) => reply(o, () => {}),
        } as unknown as LlmDriver,
        p,
      );
    return { registry, missing: [] as string[] };
  },
}));

const { buildServer } = await import("../../src/server.js");
const { MIN_ROUTING_QUESTIONS } = await import("../../src/lib/routing-data.js");

const headers = (() => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: crypto.randomUUID(), role: "agent", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return { authorization: `Bearer ${head}.${body}.${sig}` };
})();

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

const CODE = ["fix my typescript function", "debug this python error", "refactor the sql query"];
const PROSE = ["write a poem about rain", "a haiku about the sea", "a bedtime story for kids"];

const ask = (message: string) =>
  app.inject({
    method: "POST",
    url: "/api/chat/stream",
    headers,
    payload: {
      message: `${message} ${crypto.randomUUID().slice(0, 6)}`,
      members: ["coder", "bard", "critic"].map((model) => ({
        label: model,
        provider: "openai",
        model,
      })),
      round: 0,
      rounds: 2,
      threadId: "routing",
    },
  });

const status = async (q?: string) =>
  (
    await app.inject({
      method: "GET",
      url: `/api/v1/llm/learned-route${q ? `?q=${encodeURIComponent(q)}` : ""}`,
      headers,
    })
  ).json<{
    questions: number;
    needed: number;
    active: boolean;
    route?: { model: string; votes: Record<string, string> };
  }>();

describe("learned routing", () => {
  it("collects converged council runs and stays off until there are enough", async () => {
    await ask(CODE[0]!);
    const s = await status("fix my code");
    expect(s).toMatchObject({ questions: 1, needed: MIN_ROUTING_QUESTIONS, active: false });
    expect(s.route).toBeUndefined();
  });

  it("switches on at the threshold and every router votes", async () => {
    for (let i = 1; i < MIN_ROUTING_QUESTIONS; i++) await ask((i % 2 ? PROSE : CODE)[i % 3]!);
    const s = await status("fix the python function");
    expect(s.active).toBe(true);
    expect(["coder", "bard", "critic"]).toContain(s.route?.model);
    expect(Object.keys(s.route!.votes).sort()).toEqual(["knn", "mf", "mlp", "svm"]);
  }, 120_000);
});
