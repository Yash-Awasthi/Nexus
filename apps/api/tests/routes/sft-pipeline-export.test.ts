// SPDX-License-Identifier: Apache-2.0
/**
 * §15.3 — POST /sft/pipeline/export route contract.
 *
 * Assembles a dataset from corpus documents + raw conversations via
 * @nexus/finetune-pipeline and returns OpenAI chat-completions JSONL, enforcing
 * the ≥10-example export precondition (422 insufficient_data).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildServer } from "../../src/server.js";
import type { FastifyInstance } from "fastify";

vi.mock("@nexus/db", () => ({
  db: { execute: vi.fn().mockResolvedValue([{ "?column?": 1 }]) },
}));

// obs-providers.ts constructs a Pg-backed store at MODULE SCOPE whenever
// DATABASE_URL is set (tests/setup.ts always sets it), firing an eager
// CREATE TABLE at import. Stub `pg` to keep this file hermetic (same pattern
// as tests/routes/health.test.ts).
vi.mock("pg", () => {
  class FakePool {
    query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    on = vi.fn().mockReturnThis();
    end = vi.fn().mockResolvedValue(undefined);
  }
  return { Pool: FakePool };
});

const AUTH_HEADERS = { authorization: "Bearer test" };

function docs(n: number): { id: string; title: string; content: string }[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `doc-${i}`,
    title: `Topic ${i}`,
    content: `A reference passage about topic ${i} with enough substance to score well past the quality gate.`,
  }));
}

describe("POST /sft/pipeline/export", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildServer();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("400 on empty input", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sft/pipeline/export",
      headers: AUTH_HEADERS,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("empty_input");
  });

  it("422 below the 10-example precondition", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sft/pipeline/export",
      headers: AUTH_HEADERS,
      payload: { documents: docs(3) },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json<{ error: string; readyCount: number }>();
    expect(body.error).toBe("insufficient_data");
    expect(body.readyCount).toBe(3);
  });

  it("exports OpenAI chat-completions JSONL from corpus documents", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sft/pipeline/export",
      headers: AUTH_HEADERS,
      payload: {
        documents: docs(12),
        systemPrompt: "You are Nexus.",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/x-ndjson");
    // Metadata rides headers; the body is pure JSONL — every line parses.
    expect(res.headers["x-dataset-count-corpus"]).toBe("12");
    expect(res.headers["x-dataset-lines"]).toBe("12");
    const dataLines = (res.body as string).split("\n").filter(Boolean);
    expect(dataLines).toHaveLength(12);
    for (const line of dataLines) {
      const rec = JSON.parse(line) as { messages: { role: string; content: string }[] };
      expect(rec.messages[0]).toEqual({ role: "system", content: "You are Nexus." });
      expect(rec.messages.some((m) => m.role === "user")).toBe(true);
      expect(rec.messages.some((m) => m.role === "assistant")).toBe(true);
    }
  });

  it("accepts raw conversations as a source", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sft/pipeline/export",
      headers: AUTH_HEADERS,
      payload: {
        conversations: Array.from({ length: 11 }, () => [
          { role: "user", content: "Please explain something useful." },
          { role: "assistant", content: "Here is a detailed explanation that covers the topic thoroughly." },
        ]),
      },
    });
    expect(res.statusCode).toBe(200);
    const dataLines = (res.body as string).split("\n").filter(Boolean);
    expect(dataLines).toHaveLength(11);
  });
});