// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildServer } from "../../src/server.js";
import type { FastifyInstance } from "fastify";

// ── Groq mock response ─────────────────────────────────────────────────────────

const GROQ_RESPONSE = {
  id:      "chatcmpl-test",
  object:  "chat.completion",
  model:   "llama-3.3-70b-versatile",
  choices: [
    {
      index:        0,
      message:      { role: "assistant", content: "Hello from mock!" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
};

function mockGroqFetch(overrides: Partial<typeof GROQ_RESPONSE> = {}): typeof vi.fn {
  return vi.fn().mockResolvedValue({
    ok:   true,
    json: async () => ({ ...GROQ_RESPONSE, ...overrides }),
    text: async () => JSON.stringify(GROQ_RESPONSE),
  });
}

// ── Server setup ──────────────────────────────────────────────────────────────

let app: FastifyInstance;

beforeEach(async () => {
  delete process.env.NEXUS_API_KEY;
  delete process.env.GROQ_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  app = await buildServer();
  await app.ready();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  delete process.env.GROQ_API_KEY;
});

// ── GET /gateway/models ───────────────────────────────────────────────────────

describe("GET /api/v1/gateway/models", () => {
  it("returns 200 with model list", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/gateway/models" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ models: unknown[]; providers: unknown[] }>();
    expect(Array.isArray(body.models)).toBe(true);
    expect(body.models.length).toBeGreaterThan(0);
  });

  it("sets public Cache-Control header", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/gateway/models" });
    expect(res.headers["cache-control"]).toMatch(/max-age=60/);
    expect(res.headers["cache-control"]).toMatch(/public/);
  });

  it("model entries have expected shape", async () => {
    const res  = await app.inject({ method: "GET", url: "/api/v1/gateway/models" });
    const body = res.json<{ models: Array<{ id: string; provider: string; backend_model: string; available: boolean }> }>();
    const first = body.models[0]!;
    expect(first).toHaveProperty("id");
    expect(first).toHaveProperty("provider");
    expect(first).toHaveProperty("backend_model");
    expect(typeof first.available).toBe("boolean");
  });
});

// ── GET /gateway/tools ────────────────────────────────────────────────────────

describe("GET /api/v1/gateway/tools", () => {
  it("returns 200 with tools list", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/gateway/tools" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ tools: unknown[]; total: number }>();
    expect(Array.isArray(body.tools)).toBe(true);
    expect(typeof body.total).toBe("number");
  });

  it("sets aggressive public Cache-Control", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/gateway/tools" });
    expect(res.headers["cache-control"]).toMatch(/max-age=300/);
  });
});

// ── GET /gateway/cost-report ──────────────────────────────────────────────────

describe("GET /api/v1/gateway/cost-report", () => {
  it("returns 200 with aggregate stats", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/gateway/cost-report" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ totalRuns: number; totalUsd: number; runs: unknown[] }>();
    expect(typeof body.totalRuns).toBe("number");
    expect(typeof body.totalUsd).toBe("number");
    expect(Array.isArray(body.runs)).toBe(true);
  });

  it("sets private no-store Cache-Control", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/gateway/cost-report" });
    expect(res.headers["cache-control"]).toMatch(/private/);
    expect(res.headers["cache-control"]).toMatch(/no-store/);
  });

  it("respects limit query param", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/gateway/cost-report?limit=5" });
    const body = res.json<{ limit: number }>();
    expect(body.limit).toBe(5);
  });
});

// ── POST /gateway/messages ────────────────────────────────────────────────────

describe("POST /api/v1/gateway/messages", () => {
  it("returns 400 for unrecognised model", async () => {
    const res = await app.inject({
      method:  "POST",
      url:     "/api/v1/gateway/messages",
      payload: { model: "totally-unknown-model-xyz", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ type: string; error: { type: string } }>();
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
  });

  it("returns 400 when provider not configured (no GROQ_API_KEY)", async () => {
    delete process.env.GROQ_API_KEY;
    const res = await app.inject({
      method:  "POST",
      url:     "/api/v1/gateway/messages",
      payload: {
        model:    "nexus/fast",
        messages: [{ role: "user", content: "hello" }],
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { type: string } }>();
    expect(body.error.type).toBe("provider_unavailable");
  });

  it("returns 402 when spend cap exceeded", async () => {
    process.env.GROQ_API_KEY = "test-key";
    vi.stubGlobal("fetch", mockGroqFetch());
    const res = await app.inject({
      method:  "POST",
      url:     "/api/v1/gateway/messages",
      payload: {
        model:         "nexus/fast",
        messages:      [{ role: "user", content: "hi" }],
        max_spend_usd: 0, // cap at $0 → always reject
      },
    });
    // $0 cap with zero spend means totalUsd(0) >= 0 → 402
    expect(res.statusCode).toBe(402);
    const body = res.json<{ error: { type: string } }>();
    expect(body.error.type).toBe("spend_cap_exceeded");
  });

  it("completes non-streaming request with mocked Groq", async () => {
    process.env.GROQ_API_KEY = "test-key";
    vi.stubGlobal("fetch", mockGroqFetch());

    const res = await app.inject({
      method:  "POST",
      url:     "/api/v1/gateway/messages",
      payload: {
        model:    "nexus/fast",
        messages: [{ role: "user", content: "Hello!" }],
        temperature: 0,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      type:        string;
      role:        string;
      content:     Array<{ type: string; text: string }>;
      model:       string;
      usage:       { input_tokens: number; output_tokens: number };
    }>();
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.content[0]!.text).toBe("Hello from mock!");
    expect(body.usage.input_tokens).toBe(5);
    expect(body.usage.output_tokens).toBe(7);
  });

  it("returns X-Nexus-Cache: MISS on first non-streaming call", async () => {
    process.env.GROQ_API_KEY = "test-key";
    vi.stubGlobal("fetch", mockGroqFetch());

    const res = await app.inject({
      method:  "POST",
      url:     "/api/v1/gateway/messages",
      payload: { model: "nexus/fast", messages: [{ role: "user", content: "unique-1234" }], temperature: 0 },
    });
    expect(res.headers["x-nexus-cache"]).toBe("MISS");
  });

  it("x-nexus-provider header overrides provider selection", async () => {
    // With no ANTHROPIC_API_KEY, provider 'anthropic' is not registered
    delete process.env.ANTHROPIC_API_KEY;
    const res = await app.inject({
      method:  "POST",
      url:     "/api/v1/gateway/messages",
      headers: { "x-nexus-provider": "anthropic" },
      payload: { model: "nexus/fast", messages: [{ role: "user", content: "hi" }] },
    });
    // anthropic not configured → 400 provider_unavailable
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { type: string } }>();
    expect(body.error.type).toBe("provider_unavailable");
  });
});

// ── GET /gateway/tools/invoke ─────────────────────────────────────────────────

describe("POST /api/v1/gateway/tools/invoke", () => {
  it("returns 400 when name missing", async () => {
    const res = await app.inject({
      method:  "POST",
      url:     "/api/v1/gateway/tools/invoke",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 422 for unknown tool name", async () => {
    const res = await app.inject({
      method:  "POST",
      url:     "/api/v1/gateway/tools/invoke",
      payload: { name: "totally_fake_tool_xyz" },
    });
    expect(res.statusCode).toBe(422);
  });
});
