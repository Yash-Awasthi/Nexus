// SPDX-License-Identifier: Apache-2.0
/** With peer ranking on, members rank each other's anonymised answers and the chair sees the standings. */
import crypto from "node:crypto";

import { DriverRegistry } from "@nexus/llm-drivers";
import type { LlmDriver, LlmRequestOptions, StreamHandler } from "@nexus/llm-drivers";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const SECRET = "peer-ranking-secret";
process.env.NEXUS_JWT_SECRET = SECRET;

const FINALS: Record<string, string> = {
  "m-a": "FINAL: Use Postgres.",
  "m-b": "FINAL: Use SQLite.",
  "m-c": "FINAL: Use Postgres with nightly backups.",
};
const chairPrompts: string[] = [];
let rankingCalls = 0;
vi.mock("../../src/lib/provider-keys.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/provider-keys.js")>()),
  buildUserDriverRegistry: async (_u: string | undefined, providers: Iterable<string>) => {
    const registry = new DriverRegistry();
    const reply = async (o: LlmRequestOptions, h: StreamHandler) => {
      const last = String(o.messages.at(-1)?.content ?? "");
      let text = FINALS[o.model] ?? "";
      if (last.includes("from strongest to weakest")) {
        rankingCalls++;
        const letter = (answer: string) =>
          new RegExp(`Response ([A-H]):\\n${answer.replace(/\./g, "\\.")}\\n`).exec(last)![1];
        text = ["Use Postgres with nightly backups.", "Use Postgres.", "Use SQLite."]
          .map(letter)
          .join(", ");
      } else if (last.startsWith("Question:") && o.messages[0]?.role === "system") {
        chairPrompts.push(o.messages.map((m) => m.content).join("\n"));
        text = "**Answer** Postgres with backups.";
      }
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

const ask = async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/chat/stream",
    headers,
    payload: {
      message: `Which database? ${crypto.randomUUID()}`,
      members: ["m-a", "m-b", "m-c"].map((model, i) => ({
        label: ["Qwen", "DeepSeek", "Mimo"][i],
        provider: "openai",
        model,
      })),
      round: 0,
      rounds: 1,
      threadId: "peer",
    },
  });
  return res.payload
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)) as { type: string; text?: string })
    .filter((e) => e.type === "verdict")
    .map((e) => e.text)
    .join("");
};

describe("peer-ranked synthesis", () => {
  it("is off by default", async () => {
    const verdict = await ask();
    expect(rankingCalls).toBe(0);
    expect(verdict).not.toContain("Peer ranking");
  });

  it("when switched on, ranks, tells the chair and shows the standings", async () => {
    await app.inject({
      method: "POST",
      url: "/api/settings/preferences",
      headers,
      payload: { peerRanking: true },
    });
    const verdict = await ask();
    expect(rankingCalls).toBe(3);
    expect(verdict).toContain(
      "Peer ranking (consensus): 1. Mimo 6 pts, 2. Qwen 3 pts, 3. DeepSeek 0 pts",
    );
    expect(chairPrompts.at(-1)).toContain("1. Mimo 6 pts");
  });
});
