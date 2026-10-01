// SPDX-License-Identifier: Apache-2.0
/** Dissent is each user's own preference: turning it on changes only that user's council. */
import crypto from "node:crypto";

import { DriverRegistry } from "@nexus/llm-drivers";
import type { LlmDriver, LlmRequestOptions, LlmResponse, StreamHandler } from "@nexus/llm-drivers";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const SECRET = "chat-stream-dissent-secret";
process.env.NEXUS_JWT_SECRET = SECRET;

const systems: Record<string, string> = {};

async function stream(opts: LlmRequestOptions, handler: StreamHandler): Promise<LlmResponse> {
  const question = String(opts.messages.at(-1)?.content ?? "");
  systems[question] ??= opts.messages
    .filter((m) => m.role === "system")
    .map((m) => String(m.content))
    .join("\n");
  await handler({ delta: "FINAL: fine.", done: true });
  return {
    id: "s",
    content: "FINAL: fine.",
    model: opts.model,
    finishReason: "stop",
  } as LlmResponse;
}

vi.mock("../../src/lib/provider-keys.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/provider-keys.js")>()),
  buildUserDriverRegistry: async (_userId: string | undefined, providers: Iterable<string>) => {
    const registry = new DriverRegistry();
    for (const p of new Set(providers))
      registry.register(
        { provider: p, model: "s", complete: stream, stream } as unknown as LlmDriver,
        p,
      );
    return { registry, missing: [] as string[] };
  },
}));

const { buildServer } = await import("../../src/server.js");

function tokenFor(userId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: userId, role: "admin", iat: now, exp: now + 3600 });
  const sig = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

const ask = (token: string, message: string) =>
  app.inject({
    method: "POST",
    url: "/api/chat/stream",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      message,
      members: [{ label: "Solo", provider: "openai", model: "m" }],
      round: 0,
      threadId: crypto.randomUUID(),
    },
  });

it("argues against the consensus only for the user who asked for it", async () => {
  const alice = tokenFor(crypto.randomUUID());
  const bob = tokenFor(crypto.randomUUID());
  const saved = await app.inject({
    method: "POST",
    url: "/api/settings/preferences",
    headers: { authorization: `Bearer ${alice}` },
    payload: { dissent: "strong" },
  });
  expect(saved.json<{ dissent: string }>().dissent).toBe("strong");

  await ask(alice, "Alice asks about tabs?");
  await ask(bob, "Bob asks about tabs?");
  const systemFor = (who: string) =>
    Object.entries(systems).find(([q]) => q.startsWith(who))?.[1] ?? "";
  expect(systemFor("Alice")).toMatch(/argue hard against the emerging consensus/);
  expect(systemFor("Bob")).not.toMatch(/echo chamber/);
});
