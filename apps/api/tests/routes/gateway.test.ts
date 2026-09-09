// SPDX-License-Identifier: Apache-2.0
import { signJwt } from "@nexus/auth";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildServer } from "../../src/server.js";
import { getSharedKV } from "../../src/lib/shared-kv.js";
import type { FastifyInstance } from "fastify";

// §4.1: resolveFresh is mocked here — it exercises gateway.ts's own OAuth wiring
// (pool → store.resolveFresh → provider.toDriverCredentials → VertexDriver), not
// @nexus/llm-oauth's TokenRefresher, which already has its own unit coverage.
vi.mock("../../src/lib/oauth-token-store.js", () => ({
  createOAuthTokenStore: () => ({
    resolveFresh: async () => ({
      accessToken: "ya29.mock-vertex-token",
      expiresAt: Date.now() + 3_600_000,
    }),
  }),
}));

// ── Groq mock response ─────────────────────────────────────────────────────────

const GROQ_RESPONSE = {
  id: "chatcmpl-test",
  object: "chat.completion",
  model: "openai/gpt-oss-120b",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Hello from mock!" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
};

function mockGroqFetch(overrides: Partial<typeof GROQ_RESPONSE> = {}): typeof vi.fn {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ ...GROQ_RESPONSE, ...overrides }),
    text: async () => JSON.stringify(GROQ_RESPONSE),
  });
}

// ── Ollama mock response (/api/chat shape: { message: { content } }) ───────────

const OLLAMA_RESPONSE = {
  model: "qwen2.5:7b",
  message: { role: "assistant", content: "Hello from local Ollama!" },
  done: true,
};

function mockOllamaFetch(): typeof vi.fn {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ ...OLLAMA_RESPONSE }),
    text: async () => JSON.stringify(OLLAMA_RESPONSE),
  });
}

// ── Server setup ──────────────────────────────────────────────────────────────

let app: FastifyInstance;

beforeEach(async () => {
  delete process.env.NEXUS_API_KEY;
  delete process.env.GROQ_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  // The prompt cache / gateway log / token budget are module-scope singletons
  // over the shared KV — clear it so one test's cached 200 can't replay into
  // the next test's request (deterministic cache-eligible payloads collide
  // otherwise).
  await getSharedKV().clear();
  app = await buildServer();
  await app.ready();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
    const res = await app.inject({ method: "GET", url: "/api/v1/gateway/models" });
    const body = res.json<{
      models: { id: string; provider: string; backend_model: string; available: boolean }[];
    }>();
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
  it("unknown model falls through to local Ollama instead of 400", async () => {
    // Current contract: an unrecognised model defaults to the always-registered
    // local Ollama driver so a keyless instance still answers. This must hold
    // hermetically — the dispatch is asserted against the mocked fetch, never a
    // live localhost:11434.
    vi.stubGlobal("fetch", mockOllamaFetch());
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/gateway/messages",
      payload: { model: "totally-unknown-model-xyz", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ content: { type: string; text: string }[] }>();
    expect(body.content[0]!.text).toBe("Hello from local Ollama!");
    expect(vi.mocked(fetch).mock.calls.some((c) => String(c[0]).includes(":11434/api/chat"))).toBe(
      true,
    );
  });

  it("returns 502 when the local Ollama fallback is unreachable", async () => {
    // The only failure mode left for an unknown model is an unreachable local
    // fallback — the gateway maps an upstream connect failure to 502.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed: ECONNREFUSED 127.0.0.1:11434")),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/gateway/messages",
      payload: { model: "totally-unknown-model-xyz", messages: [{ role: "user", content: "hi" }] },
    });
    expect(res.statusCode).toBe(502);
    const body = res.json<{ error: { type: string } }>();
    expect(body.error.type).toBe("server_error");
  });

  it("nexus/fast with no GROQ key falls back to local Ollama instead of 400", async () => {
    // With no GROQ_API_KEY the groq driver isn't registered, so the alias falls
    // back to the local Ollama driver with the default local model tag.
    vi.stubGlobal("fetch", mockOllamaFetch());
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/gateway/messages",
      payload: {
        model: "nexus/fast",
        messages: [{ role: "user", content: "hello" }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ content: { text: string }[] }>();
    expect(body.content[0]!.text).toBe("Hello from local Ollama!");
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.some((c) => String(c[0]).includes(":11434/api/chat"))).toBe(true);
    // The fallback rewrites the model to the keyless default tag.
    const sent = JSON.parse(String(calls[0]![1]!.body)) as { model: string };
    expect(sent.model).toBe("qwen2.5:7b");
  });

  it("returns 402 when spend cap exceeded", async () => {
    process.env.GROQ_API_KEY = "test-key";
    vi.stubGlobal("fetch", mockGroqFetch());
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/gateway/messages",
      payload: {
        model: "nexus/fast",
        messages: [{ role: "user", content: "hi" }],
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
      method: "POST",
      url: "/api/v1/gateway/messages",
      payload: {
        model: "nexus/fast",
        messages: [{ role: "user", content: "Hello!" }],
        temperature: 0,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      type: string;
      role: string;
      content: { type: string; text: string }[];
      model: string;
      usage: { input_tokens: number; output_tokens: number };
    }>();
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.content[0]!.text).toBe("Hello from mock!");
    expect(body.usage.input_tokens).toBe(5);
    expect(body.usage.output_tokens).toBe(7);
  });

  it("BYOK spend-guard is a no-op for a non-api-key Bearer token", async () => {
    // A Bearer token that doesn't resolve to an api_keys row (master key / JWT /
    // no DB) must NOT block the request — the cap is best-effort, enforced only
    // for real nxk_ BYOK keys.
    process.env.GROQ_API_KEY = "test-key";
    vi.stubGlobal("fetch", mockGroqFetch());

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/gateway/messages",
      headers: { authorization: "Bearer not-a-billing-key" },
      payload: {
        model: "nexus/fast",
        messages: [{ role: "user", content: "Hello!" }],
        temperature: 0,
      },
    });

    expect(res.statusCode).toBe(200);
  });

  it("compresses message bodies only when x-nexus-compress: lossless is set", async () => {
    process.env.GROQ_API_KEY = "test-key";
    vi.stubGlobal("fetch", mockGroqFetch());
    // Content with lots of trailing whitespace + blank lines → lossless-compressible.
    const bloated = "line one   \n\n\n\nline two   \n\n\n\nline three   ";

    const withHeader = await app.inject({
      method: "POST",
      url: "/api/v1/gateway/messages",
      headers: { "x-nexus-compress": "lossless" },
      payload: {
        model: "nexus/fast",
        messages: [{ role: "user", content: bloated }],
        temperature: 0,
      },
    });
    expect(withHeader.statusCode).toBe(200);
    expect(Number(withHeader.headers["x-nexus-compress-saved-tokens"])).toBeGreaterThan(0);

    const withoutHeader = await app.inject({
      method: "POST",
      url: "/api/v1/gateway/messages",
      payload: {
        model: "nexus/fast",
        messages: [{ role: "user", content: bloated }],
        temperature: 0,
      },
    });
    expect(withoutHeader.statusCode).toBe(200);
    expect(withoutHeader.headers["x-nexus-compress-saved-tokens"]).toBeUndefined();
  });

  it("returns X-Nexus-Cache: MISS on first non-streaming call", async () => {
    process.env.GROQ_API_KEY = "test-key";
    vi.stubGlobal("fetch", mockGroqFetch());

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/gateway/messages",
      payload: {
        model: "nexus/fast",
        messages: [{ role: "user", content: "unique-1234" }],
        temperature: 0,
      },
    });
    expect(res.headers["x-nexus-cache"]).toBe("MISS");
  });

  it("x-nexus-provider header overrides provider selection", async () => {
    // Override to a configured provider → the dispatch goes to that provider's
    // endpoint (not the alias default).
    process.env.GROQ_API_KEY = "test-key";
    vi.stubGlobal("fetch", mockGroqFetch());
    const groq = await app.inject({
      method: "POST",
      url: "/api/v1/gateway/messages",
      headers: { "x-nexus-provider": "groq" },
      payload: { model: "nexus/fast", messages: [{ role: "user", content: "hi" }] },
    });
    expect(groq.statusCode).toBe(200);
    expect(vi.mocked(fetch).mock.calls.some((c) => String(c[0]).includes("api.groq.com"))).toBe(
      true,
    );

    // Override to an unconfigured provider (no ANTHROPIC_API_KEY) → falls back
    // to local Ollama rather than 400-ing.
    delete process.env.GROQ_API_KEY;
    vi.stubGlobal("fetch", mockOllamaFetch());
    const ollama = await app.inject({
      method: "POST",
      url: "/api/v1/gateway/messages",
      headers: { "x-nexus-provider": "anthropic" },
      payload: { model: "nexus/fast", messages: [{ role: "user", content: "hi" }] },
    });
    expect(ollama.statusCode).toBe(200);
    expect(vi.mocked(fetch).mock.calls.some((c) => String(c[0]).includes(":11434/api/chat"))).toBe(
      true,
    );
  });

  // ── §4.1 AccountPool wiring ──────────────────────────────────────────────

  it("trips the circuit breaker after repeated failures; the next pick is rejected", async () => {
    process.env.GROQ_API_KEY = "test-key";
    const failingFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: { message: "boom" } }),
      text: async () => JSON.stringify({ error: { message: "boom" } }),
    });
    vi.stubGlobal("fetch", failingFetch);

    const payload = { model: "nexus/fast", messages: [{ role: "user", content: "hi" }] };

    // Breaker threshold is 5 consecutive failures (AccountPool default).
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: "POST", url: "/api/v1/gateway/messages", payload });
      expect(res.statusCode).toBe(500);
    }
    expect(failingFetch).toHaveBeenCalledTimes(5);

    // 6th call: the account's breaker is open — pool.pick() rejects before any driver call.
    const tripped = await app.inject({ method: "POST", url: "/api/v1/gateway/messages", payload });
    expect(tripped.statusCode).toBe(503);
    const body = tripped.json<{ error: { type: string } }>();
    expect(body.error.type).toBe("provider_unavailable");
    expect(failingFetch).toHaveBeenCalledTimes(5); // breaker skipped the driver entirely
  });

  it("resolves a linked Google OAuth account to the vertex driver", async () => {
    process.env.NEXUS_JWT_SECRET = "test-gateway-jwt-secret";
    process.env.GOOGLE_OAUTH_CLIENT_ID = "cid";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "csecret";
    process.env.GOOGLE_CLOUD_PROJECT = "proj-1";
    vi.stubGlobal("fetch", mockGroqFetch());

    try {
      const token = signJwt(
        { sub: "user-oauth-1", role: "admin", iat: 1_000, exp: 9_999_999_999 } as Parameters<
          typeof signJwt
        >[0],
        process.env.NEXUS_JWT_SECRET,
      );

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/gateway/messages",
        headers: { "x-nexus-provider": "vertex", authorization: `Bearer ${token}` },
        payload: {
          model: "google/gemini-2.0-flash-001",
          messages: [{ role: "user", content: "hi" }],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ content: { text: string }[] }>();
      expect(body.content[0]!.text).toBe("Hello from mock!");

      // Dispatched via VertexDriver (aiplatform endpoint), not a registry driver.
      const calledUrls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
      expect(calledUrls.some((u) => u.includes("aiplatform.googleapis.com"))).toBe(true);
    } finally {
      delete process.env.NEXUS_JWT_SECRET;
      delete process.env.GOOGLE_OAUTH_CLIENT_ID;
      delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
      delete process.env.GOOGLE_CLOUD_PROJECT;
    }
  });
});

// ── GET /gateway/tools/invoke ─────────────────────────────────────────────────

describe("POST /api/v1/gateway/tools/invoke", () => {
  it("returns 400 when name missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/gateway/tools/invoke",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 422 for unknown tool name", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/gateway/tools/invoke",
      payload: { name: "totally_fake_tool_xyz" },
    });
    expect(res.statusCode).toBe(422);
  });
});
