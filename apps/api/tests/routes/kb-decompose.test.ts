// SPDX-License-Identifier: Apache-2.0
/** A multi-part question searched as its sub-questions, each retrieved and merged. */
import type { LlmDriver, LlmRequestOptions } from "@nexus/llm-drivers";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const asked: string[] = [];
const splitter = {
  provider: "scripted",
  model: "scripted",
  complete: async (opts: LlmRequestOptions) => {
    asked.push(String(opts.messages.at(-1)?.content ?? ""));
    return {
      id: "s",
      content: "1. What time do nightly backups run?\n2. How many days are backups retained?",
      model: "scripted",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: "stop",
      durationMs: 1,
    };
  },
} as unknown as LlmDriver;

vi.mock("../../src/lib/user-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/user-context.js")>()),
  getUserDrivers: () => [{ id: "scripted", driver: splitter }],
}));

const savedDb = process.env.DATABASE_URL;
const { buildServer } = await import("../../src/server.js");

let app: FastifyInstance;
let kbId = "";
beforeAll(async () => {
  delete process.env.DATABASE_URL;
  app = await buildServer();
  await app.ready();
  kbId = (await app.inject({ method: "POST", url: "/api/kb", payload: { name: "ops" } })).json<{
    id: string;
  }>().id;
  const docs = {
    "schedule.txt": "Nightly backups run at 02:00 UTC on the primary database cluster.",
    "retention.txt": "Backups are retained for 45 days before the retention policy deletes them.",
    "lunch.txt": "The cafeteria serves lunch between noon and two in the afternoon.",
  };
  for (const [name, content] of Object.entries(docs)) {
    await app.inject({
      method: "POST",
      url: `/api/kb/${kbId}/documents`,
      payload: { name, content },
    });
  }
});
afterAll(async () => {
  await app.close();
  if (savedDb) process.env.DATABASE_URL = savedDb;
});

describe("GET /api/kb/:id/search?decompose=1", () => {
  it("asks the model for sub-questions and merges what each one finds", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/kb/${kbId}/search?q=${encodeURIComponent("When do backups run and how long are they kept?")}&decompose=1&limit=2`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ subQuestions: string[]; results: { docName: string }[] }>();
    expect(body.subQuestions).toEqual([
      "What time do nightly backups run?",
      "How many days are backups retained?",
    ]);
    expect(asked[0]).toContain("When do backups run and how long are they kept?");
    const docs = body.results.map((r) => r.docName);
    expect(docs).toEqual(expect.arrayContaining(["schedule.txt", "retention.txt"]));
    expect(new Set(docs).size).toBe(docs.length);
  });

  it("plain search asks no model", async () => {
    asked.length = 0;
    const res = await app.inject({ method: "GET", url: `/api/kb/${kbId}/search?q=backups` });
    expect(res.json()).not.toHaveProperty("subQuestions");
    expect(asked).toHaveLength(0);
  });
});
