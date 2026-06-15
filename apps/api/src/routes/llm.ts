// SPDX-License-Identifier: Apache-2.0
/**
 * LLM-router routes — multi-provider LLM abstraction with alias routing + fallbacks.
 *
 * POST /llm/complete   — send a chat completion request through the router
 * GET  /llm/providers  — list registered providers and their model lists
 * GET  /llm/aliases    — list registered model aliases
 * GET  /llm/latency    — observed avg latency per provider (empty until first call)
 *
 * Router configuration
 * ────────────────────
 *   GROQ_API_KEY set     → GroqProvider registered ("groq")
 *   ANTHROPIC_API_KEY set → ClaudeProvider registered ("claude")
 *   Neither set           → NullProvider for local dev / CI
 *
 * Aliases (always registered):
 *   nexus/fast  → groq  | llama-3.1-70b-versatile   (or null fallback)
 *   nexus/smart → claude | claude-sonnet-4-5          (or null fallback)
 *
 * Fallback chain: nexus/smart → nexus/fast → null
 */

import {
  ClaudeProvider,
  GroqProvider,
  LLMRouter,
  NullProvider,
  type LLMMessage,
  type RoutingStrategy,
} from "@nexus/llm-router";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── Router factory ────────────────────────────────────────────────────────────

function buildRouter(): LLMRouter {
  const providers = [];

  if (process.env.ANTHROPIC_API_KEY) {
    providers.push(new ClaudeProvider({ apiKey: process.env.ANTHROPIC_API_KEY }));
  }
  if (process.env.GROQ_API_KEY) {
    providers.push(new GroqProvider({ apiKey: process.env.GROQ_API_KEY }));
  }
  if (providers.length === 0) {
    providers.push(
      new NullProvider({
        name: "null",
        models: ["nexus/fast", "nexus/smart"],
        content: "LLM router: no providers configured (set GROQ_API_KEY or ANTHROPIC_API_KEY)",
      }),
    );
  }

  return new LLMRouter({
    providers,
    aliases: [
      { alias: "nexus/fast", provider: "groq", model: "llama-3.1-70b-versatile" },
      { alias: "nexus/fast", provider: "null", model: "nexus/fast" },
      { alias: "nexus/smart", provider: "claude", model: "claude-sonnet-4-5" },
      { alias: "nexus/smart", provider: "null", model: "nexus/smart" },
    ],
    fallbacks: {
      "nexus/smart": ["nexus/fast"],
    },
    strategy: "first" as RoutingStrategy,
  });
}

const router = buildRouter();

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function llmRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /llm/complete
   *
   * Send a chat completion request through the LLMRouter.
   *
   * Body:
   *   model      — alias ("nexus/fast", "nexus/smart") or concrete model name
   *   messages   — [{ role: "system"|"user"|"assistant", content: string }]
   *   maxTokens  — optional token limit (default: 1024)
   *   temperature — optional temperature override
   *
   * Returns: { id, model, content, usage, provider, latencyMs }
   */
  app.post<{
    Body: {
      model: string;
      messages: LLMMessage[];
      maxTokens?: number;
      temperature?: number;
    };
  }>("/llm/complete", { preHandler: requireAuth }, async (request, reply) => {
    const { model, messages, maxTokens, temperature } = request.body;

    if (!model || !messages?.length) {
      return reply.code(400).send({ error: "model and messages are required" });
    }

    try {
      const response = await router.complete({ model, messages, maxTokens, temperature });
      return reply.send(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(502).send({ error: message });
    }
  });

  /**
   * GET /llm/providers
   *
   * List all registered providers with their supported model names.
   */
  app.get(
    "/llm/providers",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (_request, reply) => {
      const names = router.listProviders();
      const providers = names.map((name) => {
        const p = router.getProvider(name);
        return { name, models: p ? [...p.models] : [] };
      });
      return reply.send({ providers });
    },
  );

  /**
   * GET /llm/aliases
   *
   * List all registered model aliases (alias → provider, model).
   */
  app.get(
    "/llm/aliases",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (_request, reply) => {
      return reply.send({ aliases: router.listAliases() });
    },
  );

  /**
   * GET /llm/latency
   *
   * Observed average latency (ms) per provider.
   * Empty until the first successful completion.
   */
  app.get(
    "/llm/latency",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (_request, reply) => {
      const providerNames = router.listProviders();
      const latency: Record<string, number | null> = {};
      for (const name of providerNames) {
        latency[name] = router.getLatencyAvg(name) ?? null;
      }
      return reply.send({ latency });
    },
  );
}
