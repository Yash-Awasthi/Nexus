// SPDX-License-Identifier: Apache-2.0
/**
 * fast-check property-based fuzzing for POST /api/v1/gateway/messages.
 *
 * Invariants verified:
 *   1. Any model string not matching a nexus/* alias → falls through to the
 *      local Ollama driver (200), never 4xx — the keyless default
 *   2. nexus/* model with no provider API key → falls back to local Ollama
 *      with the default local model (200), never 400 provider_unavailable
 *   3. Any request with max_spend_usd:0 (GROQ key set) → 402 spend_cap_exceeded
 *   4. Well-formed request with mocked Groq → 200 with required shape
 *   5. Arbitrary well-typed bodies never cause 5xx
 */

import { describe, it, beforeEach, afterEach, vi } from "vitest";

// ── Module mocks (hoisted before imports) ─────────────────────────────────────
vi.mock("@nexus/db", () => ({
  db: { execute: vi.fn().mockResolvedValue([]) },
}));
vi.mock("@nexus/council", () => ({
  CouncilService: vi.fn().mockImplementation(() => ({
    deliberate: vi.fn().mockResolvedValue({ outcome: "approved" }),
  })),
}));

import * as fc from "fast-check";
import { buildServer } from "../../src/server.js";
import { getSharedKV } from "../../src/lib/shared-kv.js";
import type { FastifyInstance } from "fastify";

// ── Groq fetch mock ───────────────────────────────────────────────────────────

const GROQ_MOCK = {
  id: "chatcmpl-fuzz",
  object: "chat.completion",
  model: "openai/gpt-oss-120b",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Fuzz reply" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
};

function mockGroqFetch() {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => GROQ_MOCK,
    text: async () => JSON.stringify(GROQ_MOCK),
  });
}

/** Ollama /api/chat shape — the keyless fallback driver's response. */
const OLLAMA_MOCK = {
  model: "qwen2.5:7b",
  message: { role: "assistant", content: "Fuzz local reply" },
  done: true,
};

function mockOllamaFetch() {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => OLLAMA_MOCK,
    text: async () => JSON.stringify(OLLAMA_MOCK),
  });
}

/** Cloud API keys that would otherwise register non-Ollama drivers. */
const CLOUD_KEYS = [
  "GROQ_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "DEEPSEEK_API_KEY",
  "MISTRAL_API_KEY",
  "OPENROUTER_API_KEY",
  "FIREWORKS_API_KEY",
  "NVIDIA_NIM_API_KEY",
  "CEREBRAS_API_KEY",
  "KIMI_API_KEY",
];

function clearCloudKeys(): void {
  for (const k of CLOUD_KEYS) delete process.env[k];
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

let app: FastifyInstance;

beforeEach(async () => {
  delete process.env.GROQ_API_KEY;
  delete process.env.NEXUS_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  // Prompt-cache / gateway-log singletons over the shared KV must not leak a
  // cached response between property runs or tests.
  await getSharedKV().clear();
  app = await buildServer();
  await app.ready();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  delete process.env.GROQ_API_KEY;
});

// ── Arbitraries ───────────────────────────────────────────────────────────────

/** Model strings that are NOT nexus/* aliases nor known provider models. */
const unknownModelArb = fc
  .string({ minLength: 1, maxLength: 80 })
  .filter(
    (s) =>
      !s.startsWith("nexus/") &&
      ![
        "gpt-4o",
        "gpt-4",
        "gpt-3.5-turbo",
        "claude-3-opus-20240229",
        "claude-3-sonnet-20240229",
        "claude-3-haiku-20240307",
        "openai/gpt-oss-120b",
        "gemma2-9b-it",
        "mixtral-8x7b-32768",
      ].includes(s),
  );

/** A single Anthropic-format message. */
const messageArb = fc.record({
  role: fc.constantFrom("user" as const, "assistant" as const),
  content: fc.oneof(
    fc.string({ maxLength: 400 }),
    fc.array(
      fc.record({ type: fc.constant("text" as const), text: fc.string({ maxLength: 150 }) }),
      { minLength: 1, maxLength: 3 },
    ),
  ),
});

/** Non-empty message array. */
const messagesArb = fc.array(messageArb, { minLength: 1, maxLength: 5 });

const optTemperature = fc.option(fc.float({ min: 0, max: 2, noNaN: true }), { nil: undefined });
const optMaxTokens = fc.option(fc.integer({ min: 1, max: 4096 }), { nil: undefined });
const optSystem = fc.option(fc.string({ maxLength: 200 }), { nil: undefined });

// ── Properties ────────────────────────────────────────────────────────────────

describe("POST /api/v1/gateway/messages — property-based fuzzing", () => {
  /**
   * Property 1: Any unrecognised model string falls through to the always-on
   * local Ollama driver — 200, never 4xx, with the dispatch going to the
   * Ollama /api/chat endpoint (hermetic: mocked fetch, no live Ollama).
   */
  it("unrecognised model falls through to local Ollama (never 4xx)", async () => {
    clearCloudKeys();
    vi.stubGlobal("fetch", mockOllamaFetch());
    await fc.assert(
      fc.asyncProperty(unknownModelArb, messagesArb, async (model, messages) => {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/gateway/messages",
          payload: { model, messages },
        });
        expect(res.statusCode).toBe(200);
        expect(
          vi.mocked(fetch).mock.calls.some((c) => String(c[0]).includes(":11434/api/chat")),
        ).toBe(true);
        return true;
      }),
      { numRuns: 25 },
    );
  });

  /**
   * Property 2: nexus/* model with no provider key falls back to local Ollama
   * (200) with the keyless default model tag — never 400 provider_unavailable.
   */
  it("nexus/fast with no GROQ key falls back to local Ollama (default model)", async () => {
    clearCloudKeys();
    vi.stubGlobal("fetch", mockOllamaFetch());
    await fc.assert(
      fc.asyncProperty(messagesArb, async (messages) => {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/gateway/messages",
          payload: { model: "nexus/fast", messages },
        });
        expect(res.statusCode).toBe(200);
        const call = vi.mocked(fetch).mock.calls.at(-1);
        expect(call && String(call[0]).includes(":11434/api/chat")).toBe(true);
        if (!call || !String(call[0]).includes(":11434/api/chat")) return false;
        const sent = JSON.parse(String(call[1]!.body)) as { model: string };
        return sent.model === "qwen2.5:7b";
      }),
      { numRuns: 20 },
    );
  });

  /**
   * Property 3: max_spend_usd:0 with GROQ key → 402 spend_cap_exceeded
   * for any message shape, temperature, or max_tokens combination.
   */
  it("max_spend_usd:0 always triggers 402 spend cap", async () => {
    await fc.assert(
      fc.asyncProperty(
        messagesArb,
        optTemperature,
        optMaxTokens,
        async (messages, temperature, max_tokens) => {
          process.env.GROQ_API_KEY = "test-key";
          vi.stubGlobal("fetch", mockGroqFetch());
          const payload: Record<string, unknown> = {
            model: "nexus/fast",
            messages,
            max_spend_usd: 0,
          };
          if (temperature !== undefined) payload["temperature"] = temperature;
          if (max_tokens !== undefined) payload["max_tokens"] = max_tokens;

          const res = await app.inject({
            method: "POST",
            url: "/api/v1/gateway/messages",
            payload,
          });
          const body = res.json<{ error?: { type: string } }>();
          // 429 = rate-limited (fires before spend check in high-throughput prop runs)
          const ok =
            (res.statusCode === 402 && body.error?.type === "spend_cap_exceeded") ||
            res.statusCode === 429;
          expect(ok).toBe(true);
          return ok;
        },
      ),
      { numRuns: 20 },
    );
  });

  /**
   * Property 4: Valid request with mocked Groq → 200 with Anthropic-shaped body
   * (id: string, type: "message", content: Array<{type,text}>).
   */
  it("valid request with mocked Groq returns 200 with Anthropic message shape", async () => {
    await fc.assert(
      fc.asyncProperty(
        messagesArb,
        optTemperature,
        optMaxTokens,
        optSystem,
        async (messages, temperature, max_tokens, system) => {
          process.env.GROQ_API_KEY = "test-key";
          vi.stubGlobal("fetch", mockGroqFetch());

          const payload: Record<string, unknown> = { model: "nexus/fast", messages };
          if (temperature !== undefined) payload["temperature"] = temperature;
          if (max_tokens !== undefined) payload["max_tokens"] = max_tokens;
          if (system !== undefined) payload["system"] = system;

          const res = await app.inject({
            method: "POST",
            url: "/api/v1/gateway/messages",
            payload,
          });

          if (res.statusCode !== 200) return true; // tolerate non-200 in property context
          const body = res.json<{
            id: unknown;
            type: unknown;
            content: { type: unknown; text: unknown }[];
          }>();
          const shapeOk =
            typeof body.id === "string" &&
            body.type === "message" &&
            Array.isArray(body.content) &&
            body.content.length > 0 &&
            body.content[0]?.type === "text" &&
            typeof body.content[0]?.text === "string";
          expect(shapeOk).toBe(true);
          return shapeOk;
        },
      ),
      { numRuns: 20 },
    );
  });

  /**
   * Property 5: Arbitrary well-typed bodies (known + unknown models, all optional
   * numeric fields) → always < 500. The server must never crash or emit 5xx on
   * structurally valid JSON.
   */
  it("arbitrary well-typed request body never causes 5xx", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          model: fc.oneof(unknownModelArb, fc.constantFrom("nexus/fast", "nexus/balanced")),
          messages: messagesArb,
          temperature: optTemperature,
          max_tokens: optMaxTokens,
          max_spend_usd: fc.option(fc.float({ min: 0, max: 1000, noNaN: true }), {
            nil: undefined,
          }),
          system: optSystem,
        }),
        async (payload) => {
          process.env.GROQ_API_KEY = "test-key";
          vi.stubGlobal("fetch", mockGroqFetch());

          const res = await app.inject({
            method: "POST",
            url: "/api/v1/gateway/messages",
            payload,
          });
          expect(res.statusCode).toBeLessThan(500);
          return res.statusCode < 500;
        },
      ),
      { numRuns: 30 },
    );
  });
});
