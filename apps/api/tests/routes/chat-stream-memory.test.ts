// SPDX-License-Identifier: Apache-2.0
/** A deliberation remembers each member's final position, not its whole transcript. */
import crypto from "node:crypto";

import { DriverRegistry } from "@nexus/llm-drivers";
import type { LlmDriver, LlmRequestOptions, LlmResponse, StreamHandler } from "@nexus/llm-drivers";
import { MemoryManager } from "@nexus/memory";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const SECRET = "chat-stream-memory-secret";
process.env.NEXUS_JWT_SECRET = SECRET;

const replies: Record<string, string[]> = {
  "model-a": [
    "Opening take from Alpha, long enough to count as an answer.",
    "Having read Beta, I still prefer Postgres for the ledger.\n\nFINAL: Use Postgres for the ledger.",
  ],
  "model-b": [
    "Opening take from Beta, long enough to count as an answer.",
    "Alpha convinced me on transactions.\n\nFINAL: Postgres, because the ledger needs transactions.",
  ],
};
const seen: Record<string, number> = {};

async function stream(opts: LlmRequestOptions, handler: StreamHandler): Promise<LlmResponse> {
  const n = (seen[opts.model] = (seen[opts.model] ?? 0) + 1);
  const list = replies[opts.model] ?? ["FINAL: none"];
  const text = list[Math.min(n - 1, list.length - 1)]!;
  await handler({ delta: text, done: true });
  return { id: "s", content: text, model: opts.model, finishReason: "stop" } as LlmResponse;
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

it("stores the question and each member's FINAL line", async () => {
  const remember = vi.spyOn(MemoryManager.prototype, "remember").mockResolvedValue({} as never);
  const res = await app.inject({
    method: "POST",
    url: "/api/chat/stream",
    headers: { authorization: `Bearer ${tokenFor(crypto.randomUUID())}` },
    payload: {
      message: "Which database should hold the ledger?",
      members: [
        { label: "Alpha", provider: "openai", model: "model-a" },
        { label: "Beta", provider: "openai", model: "model-b" },
      ],
      round: 0,
      rounds: 2,
      threadId: "mem-thread",
    },
  });
  expect(res.statusCode).toBe(200);
  const stored = remember.mock.calls.map((c) => c[0]).sort();
  expect(stored).toEqual([
    "Q: Which database should hold the ledger?\nA: Postgres, because the ledger needs transactions.",
    "Q: Which database should hold the ledger?\nA: Use Postgres for the ledger.",
  ]);
});
