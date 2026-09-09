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
 *   nexus/fast  → groq  | openai/gpt-oss-120b   (or null fallback)
 *   nexus/smart → claude | claude-sonnet-4-5          (or null fallback)
 *
 * Fallback chain: nexus/smart → nexus/fast → null
 */

import {
  ClaudeProvider,
  GroqProvider,
  LLMRouter,
  NullProvider,
  OpenAIProvider,
  type LLMMessage,
  type RoutingStrategy,
} from "@nexus/llm-router";
import type { FastifyInstance } from "fastify";

import { discoverModels, type ReasoningTier } from "../lib/model-discovery.js";
import { routeModel, type CapabilityRequirement } from "../lib/model-routing.js";
import { requireAuth } from "../middleware/auth.js";

// ── Router factory ────────────────────────────────────────────────────────────

function buildRouter(): LLMRouter {
  const providers = [];
  const aliases = [];

  // Local-first: when configured for Ollama, route both aliases to the local
  // model via Ollama's OpenAI-compatible /v1 endpoint. Registered first so the
  // "first" strategy prefers it over cloud providers.
  if (process.env.NEXUS_LLM_PROVIDER === "ollama") {
    const base = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/+$/, "");
    const model = process.env.NEXUS_DEFAULT_MODEL ?? "qwen2.5:7b";
    providers.push(
      new OpenAIProvider({ apiKey: "ollama", baseUrl: `${base}/v1`, providerName: "ollama" }),
    );
    aliases.push(
      { alias: "nexus/fast", provider: "ollama", model },
      { alias: "nexus/smart", provider: "ollama", model },
    );
  }

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

  aliases.push(
    { alias: "nexus/fast", provider: "groq", model: "openai/gpt-oss-120b" },
    { alias: "nexus/fast", provider: "null", model: "nexus/fast" },
    { alias: "nexus/smart", provider: "claude", model: "claude-sonnet-4-5" },
    { alias: "nexus/smart", provider: "null", model: "nexus/smart" },
  );

  return new LLMRouter({
    providers,
    aliases,
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
   * GET /llm/models
   *
   * Model discovery with per-model capabilities (mission pillar 4 —
   * OpenCode-depth provider layer). Returns every known model grouped by
   * provider with contextWindow / maxOutput / vision / toolUse / streaming /
   * reasoningTier / cost, plus a live probe of the local Ollama daemon when
   * it is reachable.
   */
  app.get("/llm/models", { preHandler: requireAuth }, async (_request, reply) => {
    const result = await discoverModels({
      ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
      declaredProviders: process.env.NEXUS_LLM_PROVIDER
        ? [process.env.NEXUS_LLM_PROVIDER]
        : undefined,
    });
    return reply.send(result);
  });

  /**
   * GET /llm/route — §15.7 per-model capability routing.
   *
   * Picks the best model for a requirement set on top of the discovery
   * surface: hard requirements filter (vision / toolUse / streaming /
   * minContextWindow / maxOutputNeeded / minReasoningTier), soft preferences
   * rank (capability-first, or preferCheapest). Returns the chosen model,
   * the ranked top 5 with reasons, and — when nothing qualifies — every
   * filter each candidate failed.
   */
  app.get<{ Querystring: Record<string, string> }>(
    "/llm/route",
    { preHandler: requireAuth },
    async (request, reply) => {
      const q = request.query;
      const bool = (k: string): boolean | undefined =>
        q[k] === undefined ? undefined : q[k] === "true" || q[k] === "1";
      const num = (k: string): number | undefined => {
        if (q[k] === undefined) return undefined;
        const n = Number(q[k]);
        return Number.isFinite(n) && n >= 0 ? n : undefined;
      };
      const tier = (k: string): ReasoningTier | undefined => {
        if (q[k] !== "fast" && q[k] !== "reasoning" && q[k] !== "deep") return undefined;
        return q[k];
      };

      const discovery = await discoverModels({
        ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
        declaredProviders: process.env.NEXUS_LLM_PROVIDER
          ? [process.env.NEXUS_LLM_PROVIDER]
          : undefined,
      });
      const models = discovery.providers.flatMap((p) => p.models);

      const requirement: CapabilityRequirement = {
        vision: bool("vision"),
        toolUse: bool("toolUse"),
        streaming: bool("streaming"),
        minContextWindow: num("minContextWindow"),
        maxOutputNeeded: num("maxOutputNeeded"),
        minReasoningTier: tier("minReasoningTier"),
        preferCheapest: bool("preferCheapest"),
      };
      const result = routeModel(models, requirement);
      return reply.send({ requirement, ...result });
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
