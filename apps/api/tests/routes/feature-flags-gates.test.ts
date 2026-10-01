// SPDX-License-Identifier: Apache-2.0
/** Admin feature flags are one registry, persisted, and real behaviour reads it. */
import crypto from "node:crypto";

import { DriverRegistry } from "@nexus/llm-drivers";
import type { LlmDriver, LlmRequestOptions, LlmResponse, StreamHandler } from "@nexus/llm-drivers";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const SECRET = "feature-flags-gates-secret";
const DB = "pglite://:memory:feature-flags-gates";
process.env.NEXUS_JWT_SECRET = SECRET;
process.env.DATABASE_URL = DB;

const turns: Record<string, number> = {};
async function streamReply(opts: LlmRequestOptions, handler: StreamHandler): Promise<LlmResponse> {
  const judging = String(opts.messages.at(-1)?.content).includes("Group the members");
  const n = judging ? 0 : (turns[opts.model] = (turns[opts.model] ?? 0) + 1);
  const text = `${opts.model} position ${n}: ${crypto.randomUUID()}`;
  await handler({ delta: text, done: true });
  return {
    id: "scripted",
    content: text,
    model: opts.model,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: "stop",
    durationMs: 1,
  } as LlmResponse;
}

vi.mock("../../src/lib/provider-keys.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/provider-keys.js")>()),
  buildUserDriverRegistry: async (_userId: string | undefined, providers: Iterable<string>) => {
    const registry = new DriverRegistry();
    for (const p of new Set(providers)) {
      registry.register(
        {
          provider: p,
          model: "scripted",
          complete: (o: LlmRequestOptions) => streamReply(o, () => {}),
          stream: streamReply,
        } as unknown as LlmDriver,
        p,
      );
    }
    return { registry, missing: [] as string[] };
  },
}));

const { migrateEmbedded } = await import("../../src/lib/migrate-embedded.js");
const { closePgPools, getPgPool } = await import("../../src/lib/pg-pool.js");
const { buildServer } = await import("../../src/server.js");
const { globalFlags } = await import("@nexus/feature-flags");
const { db } = await import("@nexus/db");
const { users } = await import("@nexus/db/schema");

const ADMIN = crypto.randomUUID();
function tokenFor(userId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "admin", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}
const auth = () => ({ authorization: `Bearer ${tokenFor(ADMIN)}` });

let app: FastifyInstance;
beforeAll(async () => {
  await migrateEmbedded(getPgPool(DB)!);
  await db.insert(users).values({
    id: ADMIN,
    email: "flags-admin@example.com",
    passwordHash: "x",
    role: "admin",
  });
  app = await buildServer();
  await app.ready();
}, 120_000);
afterAll(async () => {
  for (const def of globalFlags.listFlags()) globalFlags.resetFlag(def.key);
  await app.close();
  await closePgPools();
});

const setFlag = (key: string, value: unknown) =>
  app.inject({
    method: "PATCH",
    url: `/api/v1/feature-flags/${key}`,
    headers: auth(),
    payload: { value },
  });
const resetFlag = (key: string) =>
  app.inject({ method: "DELETE", url: `/api/v1/feature-flags/${key}`, headers: auth() });

describe("feature flags", () => {
  it("lists only flags that gate real behaviour", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/feature-flags", headers: auth() });
    const keys = (res.json() as { flags: { key: string }[] }).flags.map((f) => f.key).sort();
    expect(keys).toEqual(["council.max_debate_rounds", "drive.exec", "search.web"]);
  });

  it("rejects a value of the wrong type", async () => {
    expect((await setFlag("drive.exec", "nope")).statusCode).toBe(400);
    expect((await setFlag("council.max_debate_rounds", true)).statusCode).toBe(400);
  });

  it("persists overrides and forgets them on reset", async () => {
    expect((await setFlag("search.web", false)).statusCode).toBe(200);
    const rows = async () =>
      (
        await getPgPool(DB)!.query<{ id: string; data: { value: unknown } }>(
          "SELECT id, data FROM nexus_kv WHERE collection = 'feature-flag-overrides'",
        )
      ).rows;
    await vi.waitFor(async () =>
      expect(await rows()).toEqual([
        { id: "search.web", data: { key: "search.web", value: false } },
      ]),
    );
    await resetFlag("search.web");
    await vi.waitFor(async () => expect(await rows()).toEqual([]));
  });

  it("the old admin flag store is gone", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/feature-flags/admin/flags",
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("behaviour behind the flags", () => {
  it("search.web off stops web search", async () => {
    await setFlag("search.web", false);
    const res = await app.inject({
      method: "GET",
      url: "/api/context/web?q=nexus",
      headers: auth(),
    });
    expect(res.json()).toMatchObject({ results: [], message: expect.stringMatching(/turned off/) });
    await resetFlag("search.web");
  });

  it("drive.exec off refuses drive commands", async () => {
    await setFlag("drive.exec", false);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/drive/exec",
      headers: auth(),
      payload: { command: "echo hi" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "drive_exec_disabled" });
    await resetFlag("drive.exec");
  });

  it("council.max_debate_rounds caps the rounds a council asks for", async () => {
    await setFlag("council.max_debate_rounds", 1);
    await app.inject({
      method: "POST",
      url: "/api/chat/stream",
      headers: auth(),
      payload: {
        message: `Pick a colour ${crypto.randomUUID()}`,
        members: [
          { label: "Alpha", provider: "openai", model: "cap-a" },
          { label: "Beta", provider: "openai", model: "cap-b" },
        ],
        round: 0,
        rounds: 3,
        threadId: "flags",
      },
    });
    // One debate turn each; the lead member also chairs the synthesis.
    expect(turns["cap-a"]).toBe(2);
    expect(turns["cap-b"]).toBe(1);
    await resetFlag("council.max_debate_rounds");
  });
});
