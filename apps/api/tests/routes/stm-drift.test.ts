// SPDX-License-Identifier: Apache-2.0
/** Each council answer feeds per-model style metrics; a sudden change is flagged as drift. */
import crypto from "node:crypto";

import { DriverRegistry } from "@nexus/llm-drivers";
import type { LlmDriver, LlmRequestOptions, StreamHandler } from "@nexus/llm-drivers";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const SECRET = "stm-drift-secret";
process.env.NEXUS_JWT_SECRET = SECRET;

let hedgy = false;
vi.mock("../../src/lib/provider-keys.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/provider-keys.js")>()),
  buildUserDriverRegistry: async (_u: string | undefined, providers: Iterable<string>) => {
    const registry = new DriverRegistry();
    const reply = async (o: LlmRequestOptions, h: StreamHandler) => {
      const text =
        o.model === "steady" && hedgy
          ? "Perhaps it is maybe fine. I think it seems okay. Apparently, maybe."
          : `Use Postgres. It is reliable. Answer ${crypto.randomUUID().slice(0, 4)}.`;
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

const as = (sub: string) => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub, role: "agent", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return { authorization: `Bearer ${head}.${body}.${sig}` };
};
const alice = as(crypto.randomUUID());

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

const ask = () =>
  app.inject({
    method: "POST",
    url: "/api/chat/stream",
    headers: alice,
    payload: {
      message: `Which database? ${crypto.randomUUID()}`,
      members: [{ label: "S", provider: "openai", model: "steady" }],
      round: 0,
      rounds: 1,
      threadId: "drift",
    },
  });

interface ModelDrift {
  model: string;
  answers: number;
  metrics: Record<string, { mean: number; latest: number | null }>;
  drifting: string[];
}

describe("GET /api/v1/stm/drift", () => {
  it("tracks each model's answers and flags a sudden jump in hedging", async () => {
    for (let i = 0; i < 12; i++) await ask();
    const get = async (h = alice) =>
      (await app.inject({ method: "GET", url: "/api/v1/stm/drift", headers: h })).json<{
        models: ModelDrift[];
      }>().models;
    const before = (await get()).find((m) => m.model === "steady")!;
    expect(before.answers).toBe(12);
    expect(before.drifting).toEqual([]);
    expect(before.metrics.hedgeDensity!.mean).toBe(0);

    hedgy = true;
    await ask();
    const after = (await get()).find((m) => m.model === "steady")!;
    expect(after.metrics.hedgeDensity!.latest).toBeGreaterThan(20);
    expect(after.drifting).toContain("hedgeDensity");

    expect(await get(as(crypto.randomUUID()))).toEqual([]);
  });
});
