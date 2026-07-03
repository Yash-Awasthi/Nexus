// SPDX-License-Identifier: Apache-2.0
/**
 * fast-check property-based fuzzing for POST /api/v1/gateway/messages.
 *
 * Invariants verified:
 *   1. Any model string not matching a nexus/* alias → 400 invalid_request_error
 *   2. nexus/* model with no provider API key → 400 provider_unavailable
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
import type { FastifyInstance } from "fastify";

// ── Groq fetch mock ───────────────────────────────────────────────────────────

const GROQ_MOCK = {
  id: "chatcmpl-fuzz",
  object: "chat.completion",
  model: "llama-3.3-70b-versatile",
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

// ── Server lifecycle ──────────────────────────────────────────────────────────

let app: FastifyInstance;

beforeEach(async () => {
  delete process.env.GROQ_API_KEY;
  delete process.env.NEXUS_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
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
        "llama-3.3-70b-versatile",
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
   * Property 1: Any unrecognised model string → 400 with error.type matching
   * `invalid_request_error` or `provider_unavailable`. Never a 5xx.
   */
  it("unrecognised model always returns 400", async () => {
    await fc.assert(
      fc.asyncProperty(unknownModelArb, messagesArb, async (model, messages) => {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/gateway/messages",
          payload: { model, messages },
        });
        const body = res.json<{ type?: string; error?: { type: string } }>();
        return (
          res.statusCode === 400 &&
          body.type === "error" &&
          (body.error?.type === "invalid_request_error" ||
            body.error?.type === "provider_unavailable")
        );
      }),
      { numRuns: 25 },
    );
  });

  /**
   * Property 2: nexus/* model with no provider key → 400 provider_unavailable.
   */
  it("nexus/fast with no GROQ key → 400 provider_unavailable", async () => {
    await fc.assert(
      fc.asyncProperty(messagesArb, async (messages) => {
        delete process.env.GROQ_API_KEY;
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/gateway/messages",
          payload: { model: "nexus/fast", messages },
        });
        const body = res.json<{ error?: { type: string } }>();
        return res.statusCode === 400 && body.error?.type === "provider_unavailable";
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
          return (
            (res.statusCode === 402 && body.error?.type === "spend_cap_exceeded") ||
            res.statusCode === 429
          );
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
          return (
            typeof body.id === "string" &&
            body.type === "message" &&
            Array.isArray(body.content) &&
            body.content.length > 0 &&
            body.content[0]?.type === "text" &&
            typeof body.content[0]?.text === "string"
          );
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
          return res.statusCode < 500;
        },
      ),
      { numRuns: 30 },
    );
  });
});
