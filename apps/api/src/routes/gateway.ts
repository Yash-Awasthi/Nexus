// SPDX-License-Identifier: Apache-2.0
/**
 * Model Gateway routes — backed by @nexus/llm-drivers DriverRegistry.
 *
 * POST /api/v1/gateway/messages  — Anthropic Messages-compatible proxy (15 providers)
 * GET  /api/v1/gateway/models    — list available model aliases + registered providers
 *
 * Provider selection precedence:
 *   1. x-nexus-provider header  (explicit override)
 *   2. Model alias table         (nexus/*, claude-*, gemini-*, etc.)
 *   3. 400 if provider unknown or not configured
 */

import {
  DriverRegistry,
  AnthropicDriver,
  GroqDriver,
  GeminiDriver,
  DeepSeekDriver,
  MistralDriver,
  OpenRouterDriver,
  OllamaDriver,
  LMStudioDriver,
  LlamaCppDriver,
  FireworksDriver,
  NvidiaNimDriver,
  CerebrasDriver,
  KimiDriver,
  CodestralDriver,
  type LlmRequestOptions,
  type LlmRole,
} from "@nexus/llm-drivers";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── Model alias table ──────────────────────────────────────────────────────────

export const DRIVER_ALIASES: Record<string, { provider: string; model: string }> = {
  // Nexus smart-routing aliases
  "nexus/fast":           { provider: "groq",       model: "llama-3.3-70b-versatile" },
  "nexus/smart":          { provider: "groq",       model: "llama-3.3-70b-versatile" },
  "nexus/opus":           { provider: "anthropic",  model: "claude-opus-4-5" },
  "nexus/sonnet":         { provider: "anthropic",  model: "claude-3-5-sonnet-20241022" },
  "nexus/haiku":          { provider: "anthropic",  model: "claude-haiku-3-5" },
  "nexus/gemini":         { provider: "gemini",     model: "gemini-1.5-pro" },
  "nexus/gemini-flash":   { provider: "gemini",     model: "gemini-1.5-flash" },
  "nexus/deepseek":       { provider: "deepseek",   model: "deepseek-chat" },
  "nexus/mistral":        { provider: "mistral",    model: "mistral-large-latest" },
  "nexus/router":         { provider: "openrouter", model: "anthropic/claude-3.5-sonnet" },
  "nexus/local":          { provider: "ollama",     model: "llama3.2" },
  "nexus/cerebras":       { provider: "cerebras",   model: "llama3.1-70b" },
  "nexus/kimi":           { provider: "kimi",       model: "moonshot-v1-32k" },
  "nexus/code":           { provider: "codestral",  model: "codestral-latest" },
  "nexus/fireworks":      { provider: "fireworks",  model: "accounts/fireworks/models/llama-v3p1-70b-instruct" },
  "nexus/nvidia":         { provider: "nvidia_nim", model: "meta/llama-3.1-70b-instruct" },
};

/** Resolve model string → { provider, model }. Null if unrecognised. */
function resolveAlias(model: string): { provider: string; model: string } | null {
  if (DRIVER_ALIASES[model]) return DRIVER_ALIASES[model]!;
  if (model.startsWith("claude-"))                        return { provider: "anthropic",  model };
  if (model.startsWith("gemini-"))                        return { provider: "gemini",     model };
  if (model.startsWith("deepseek"))                       return { provider: "deepseek",   model };
  if (model.startsWith("mistral") || model.startsWith("open-mistral")) return { provider: "mistral", model };
  if (model.startsWith("accounts/fireworks"))             return { provider: "fireworks",  model };
  if (model.startsWith("moonshot"))                       return { provider: "kimi",       model };
  if (model.startsWith("codestral"))                      return { provider: "codestral",  model };
  if (model.startsWith("llama") || model.startsWith("meta/")) return { provider: "groq",  model };
  return null;
}

// ── Registry factory (reads env at call-time so tests can mutate process.env) ─

function buildDriverRegistry(): DriverRegistry {
  const reg = new DriverRegistry();

  if (process.env.GROQ_API_KEY) {
    reg.register(new GroqDriver({ apiKey: process.env.GROQ_API_KEY }));
  }
  if (process.env.ANTHROPIC_API_KEY) {
    reg.register(new AnthropicDriver({ apiKey: process.env.ANTHROPIC_API_KEY }));
  }
  if (process.env.GEMINI_API_KEY) {
    reg.register(new GeminiDriver({ apiKey: process.env.GEMINI_API_KEY }));
  }
  if (process.env.DEEPSEEK_API_KEY) {
    reg.register(new DeepSeekDriver({ apiKey: process.env.DEEPSEEK_API_KEY }));
  }
  if (process.env.MISTRAL_API_KEY) {
    reg.register(new MistralDriver({ apiKey: process.env.MISTRAL_API_KEY }));
    reg.register(new CodestralDriver({ apiKey: process.env.MISTRAL_API_KEY }));
  }
  if (process.env.OPENROUTER_API_KEY) {
    reg.register(new OpenRouterDriver({ apiKey: process.env.OPENROUTER_API_KEY }));
  }
  if (process.env.FIREWORKS_API_KEY) {
    reg.register(new FireworksDriver({ apiKey: process.env.FIREWORKS_API_KEY }));
  }
  if (process.env.NVIDIA_NIM_API_KEY) {
    reg.register(new NvidiaNimDriver({ apiKey: process.env.NVIDIA_NIM_API_KEY }));
  }
  if (process.env.CEREBRAS_API_KEY) {
    reg.register(new CerebrasDriver({ apiKey: process.env.CEREBRAS_API_KEY }));
  }
  if (process.env.KIMI_API_KEY) {
    reg.register(new KimiDriver({ apiKey: process.env.KIMI_API_KEY }));
  }
  // Local / no-auth providers (always registered; no-op if unreachable)
  reg.register(new OllamaDriver({
    baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
  }));
  if (process.env.LM_STUDIO_BASE_URL) {
    reg.register(new LMStudioDriver({ baseUrl: process.env.LM_STUDIO_BASE_URL }));
  }
  if (process.env.LLAMA_CPP_BASE_URL) {
    reg.register(new LlamaCppDriver({ baseUrl: process.env.LLAMA_CPP_BASE_URL }));
  }

  return reg;
}

// ── Anthropic-format request/response types ───────────────────────────────────

interface AnthropicContentPart { type: "text"; text: string; }
interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentPart[];
}
interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

function toDriverRequest(body: AnthropicRequest, resolvedModel: string): LlmRequestOptions {
  return {
    model: resolvedModel,
    messages: body.messages.map((m) => ({
      role: m.role as LlmRole,
      content: typeof m.content === "string"
        ? m.content
        : m.content.map((p) => p.text).join(""),
    })),
    systemPrompt: body.system,
    maxTokens: body.max_tokens,
    temperature: body.temperature,
  };
}

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function gatewayRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /gateway/messages
   *
   * Drop-in replacement for POST https://api.anthropic.com/v1/messages.
   * Translates to the resolved LlmDriver; returns Anthropic-format response.
   * stream:true is silently treated as non-streaming for now.
   */
  app.post<{
    Headers: { "x-nexus-provider"?: string };
    Body: AnthropicRequest;
  }>("/gateway/messages", { preHandler: requireAuth }, async (request, reply) => {
    const overrideProvider = request.headers["x-nexus-provider"];
    const registry = buildDriverRegistry();

    const alias = resolveAlias(request.body.model);
    const providerName = overrideProvider ?? alias?.provider;
    const resolvedModel = alias?.model ?? request.body.model;

    if (!providerName) {
      return reply.code(400).send({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: `Unknown model: "${request.body.model}". Use a nexus/* alias or a known model prefix.`,
        },
      });
    }

    const driver = registry.get(providerName);
    if (!driver) {
      return reply.code(400).send({
        type: "error",
        error: {
          type: "provider_unavailable",
          message: `Provider "${providerName}" is not configured. Set the corresponding API key env var.`,
        },
      });
    }

    try {
      const opts = toDriverRequest(request.body, resolvedModel);
      const response = await driver.complete(opts);

      return reply.code(200).send({
        id: response.id,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: response.content }],
        model: response.model,
        stop_reason: response.finishReason,
        usage: {
          input_tokens: response.usage.inputTokens,
          output_tokens: response.usage.outputTokens,
        },
      });
    } catch (err: unknown) {
      const e = err as { code?: string; statusCode?: number; message?: string };
      const statusCode = e.statusCode && e.statusCode >= 400 ? e.statusCode : 502;
      return reply.code(statusCode).send({
        type: "error",
        error: {
          type: e.code ?? "server_error",
          message: e.message ?? "Upstream provider error",
        },
      });
    }
  });

  /**
   * GET /gateway/models
   *
   * Returns the alias table with availability flags,
   * plus the list of currently-configured providers.
   */
  app.get("/gateway/models", { preHandler: requireAuth }, async (_request, reply) => {
    const registry = buildDriverRegistry();
    const models = Object.entries(DRIVER_ALIASES).map(([alias, target]) => ({
      id: alias,
      provider: target.provider,
      backend_model: target.model,
      available: registry.has(target.provider),
    }));
    return reply.send({ models, providers: registry.list() });
  });
}
