// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildServer } from "../../src/server.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;

beforeEach(async () => {
  delete process.env.NEXUS_API_KEY;
  delete process.env.GROQ_API_KEY;
  app = await buildServer();
  await app.ready();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  delete process.env.GROQ_API_KEY;
});

// ── GET /libertas ─────────────────────────────────────────────────────────────

describe("GET /api/v1/libertas", () => {
  it("returns 200 without auth", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/libertas" });
    expect(res.statusCode).toBe(200);
  });

  it("includes rate limit info", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/libertas" });
    const body = res.json<{ limits: { requests_per_minute: number; max_tokens: number } }>();
    expect(body.limits.requests_per_minute).toBe(5);
    expect(body.limits.max_tokens).toBe(512);
  });

  it("includes endpoints list", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/libertas" });
    const body = res.json<{ endpoints: { method: string; path: string }[] }>();
    expect(Array.isArray(body.endpoints)).toBe(true);
    expect(body.endpoints.length).toBeGreaterThanOrEqual(2);
  });

  it("indicates model unavailability when GROQ_API_KEY not set", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/libertas" });
    const body = res.json<{ models: { available: boolean }[] }>();
    expect(body.models[0]!.available).toBe(false);
  });

  it("has public Cache-Control header", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/libertas" });
    expect(res.headers["cache-control"]).toMatch(/max-age=60/);
  });

  it("auth_required is false", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/libertas" });
    const body = res.json<{ auth_required: boolean }>();
    expect(body.auth_required).toBe(false);
  });
});

// ── POST /libertas/complete ───────────────────────────────────────────────────

describe("POST /api/v1/libertas/complete", () => {
  it("returns 400 when prompt missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/libertas/complete",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string }>();
    expect(body.error).toBe("prompt is required");
  });

  it("returns 400 when prompt is empty string", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/libertas/complete",
      payload: { prompt: "   " },
    });
    expect(res.statusCode).toBe(400);
  });

  it("echo-stubs when GROQ_API_KEY not set", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/libertas/complete",
      payload: { prompt: "Hello world" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ text: string; model: string; remaining: number }>();
    expect(body.text).toContain("[echo");
    expect(body.model).toBe("stub");
    expect(typeof body.remaining).toBe("number");
  });

  it("completes with mocked Groq when key set", async () => {
    process.env.GROQ_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "Groq says hi" } }],
          model: "llama-3.1-8b-instant",
          usage: { prompt_tokens: 3, completion_tokens: 4 },
        }),
        text: async () => "",
      }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/libertas/complete",
      payload: { prompt: "Hello" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ text: string; model: string }>();
    expect(body.text).toBe("Groq says hi");
    expect(body.model).toBe("llama-3.1-8b-instant");
  });

  it("caps max_tokens at 512", async () => {
    const captured: { body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
        captured.push({ body: init.body });
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: "ok" } }],
            model: "llama-3.1-8b-instant",
            usage: { prompt_tokens: 3, completion_tokens: 1 },
          }),
          text: async () => "",
        };
      }),
    );
    process.env.GROQ_API_KEY = "test-key";

    await app.inject({
      method: "POST",
      url: "/api/v1/libertas/complete",
      payload: { prompt: "hello", max_tokens: 9999 },
    });

    const sent = JSON.parse(captured[0]!.body) as { max_tokens: number };
    expect(sent.max_tokens).toBeLessThanOrEqual(512);
  });

  it("sets X-RateLimit headers", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/libertas/complete",
      payload: { prompt: "hi" },
    });
    expect(res.headers["x-ratelimit-limit"]).toBe("5");
    expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
  });

  it("returns 429 after 5 requests from same IP", async () => {
    // All 5 burst through, 6th should 429
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: "POST",
        url: "/api/v1/libertas/complete",
        headers: { "x-forwarded-for": "55.55.55.55" },
        payload: { prompt: `p${i}` },
      });
    }
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/libertas/complete",
      headers: { "x-forwarded-for": "55.55.55.55" },
      payload: { prompt: "over-limit" },
    });
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("502 when Groq returns non-ok status", async () => {
    process.env.GROQ_API_KEY = "bad-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      }),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/libertas/complete",
      headers: { "x-forwarded-for": "99.0.0.1" },
      payload: { prompt: "hello" },
    });
    expect(res.statusCode).toBe(502);
  });
});
