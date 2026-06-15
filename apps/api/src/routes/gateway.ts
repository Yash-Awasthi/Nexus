// SPDX-License-Identifier: Apache-2.0
/**
 * Model Gateway routes — backed by @nexus/llm-drivers DriverRegistry.
 *
 * POST /api/v1/gateway/messages  — Anthropic Messages-compatible proxy (15 providers)
 *                                   stream:true → text/event-stream SSE (Anthropic format)
 * GET  /api/v1/gateway/models    — list available model aliases + registered providers
 *
 * Provider selection precedence:
 *   1. x-nexus-provider header  (explicit override)
 *   2. Model alias table         (nexus/*, claude-*, gemini-*, etc.)
 *   3. 400 if provider unknown or not configured
 *
 * Streaming pipeline (when stream:true):
 *   driver.stream() → ThinkTagParser (strip <think>) → SSE text/event-stream → client
 *   Errors wrapped by StreamRecoveryOrchestrator (continuation suffix + block close).
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
import {
  PrunerChain,
  SlidingWindowPruner,
  NaiveTokenizer,
  type Message as PrunerMessage,
} from "@nexus/context-pruner";
import { ThinkTagParser } from "@nexus/think-parser";
import { StreamRecoveryOrchestrator } from "@nexus/stream-recovery";
import { KVGatewayLog } from "@nexus/gateway-log";
import {
  UltraplinianRunner,
  type SpeedTier,
  type UltraplinianMessage,
  type SamplingParams as UltraplinianSamplingParams,
} from "@nexus/ultraplinian";
import { ToolRegistry, createDefaultRegistry } from "@nexus/tool-registry";
import { globalHooks } from "@nexus/hooks";
import { KVTokenBudget, BudgetExceededError } from "@nexus/token-budget";
import { RunCostTracker, InMemoryRunCostStore } from "@nexus/run-cost";
import { globalTierGate, makeTierGatePreHandler } from "@nexus/tier-gate";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

import { requireAuth } from "../middleware/auth.js";
import { getTierFromRequest } from "../middleware/auth.js";
import { getSharedKV } from "../lib/shared-kv.js";
import { getPromptCache, PromptCache, type CacheableRequest } from "../lib/prompt-cache.js";

// ── Run-cost tracker (per-gateway-call USD accounting) ────────────────────────
// Records inputTokens + outputTokens per completion; exposes GET /gateway/cost-report.
// Upgrade path: swap InMemoryRunCostStore for PgRunCostStore when DATABASE_URL set.

export const _costStore   = new InMemoryRunCostStore();
export const costTracker  = new RunCostTracker({ store: _costStore });

// ── Token budget (RPM limiting per identity) ──────────────────────────────────
// GATEWAY_RPM_LIMIT (default 60) requests per 60-second sliding window.
// Identity = first 20 chars of Authorization token, or "anon".
// KVTokenBudget: cross-pod safe when backed by Upstash/Redis (see shared-kv.ts).
// Falls back to MemoryKVStore in dev — independent windows per pod, not global.

const _RPM_LIMIT   = parseInt(process.env.GATEWAY_RPM_LIMIT ?? "60", 10);
const _tokenBudget = new KVTokenBudget(getSharedKV(), { limit: _RPM_LIMIT, windowMs: 60_000 });

async function _budgetPreHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const identity = (request.headers.authorization as string | undefined)?.slice(7, 27) ?? "anon";
  try {
    await _tokenBudget.consume({ identity, tokens: 1 });
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      const retryAfterSec = Math.ceil((err.resetAt - Date.now()) / 1000);
      reply
        .code(429)
        .header("Retry-After", String(retryAfterSec))
        .send({
          error:      "rate_limit_exceeded",
          message:    `Gateway RPM limit (${_RPM_LIMIT}) reached. Retry in ${retryAfterSec}s.`,
          resetAt:    err.resetAt,
          retryAfterSec,
        });
    }
  }
}

// ── SSE stream timeout ────────────────────────────────────────────────────────
// Default 30 s — override via STREAM_TIMEOUT_MS env var.
// Prevents a slow or stalled provider from holding an SSE connection indefinitely.

const STREAM_TIMEOUT_MS = parseInt(process.env.STREAM_TIMEOUT_MS ?? "30000", 10);

// ── Context-window pre-flight pruner ─────────────────────────────────────────
// Long threads can silently overflow the provider's context window, causing
// a hard 400 error (Anthropic) or silent truncation (Groq/Gemini).
// Prune aggressively BEFORE dispatching so every request fits the budget.
//
// Budget: GATEWAY_CONTEXT_BUDGET_TOKENS (default 32 000 — conservative for all
// providers).  Each request reserves max_tokens for the completion; the rest is
// available for the prompt.  SlidingWindowPruner keeps the system message plus
// the most recent messages that fit.  Zero-cost when history is short (no-op).

const GATEWAY_CONTEXT_BUDGET = parseInt(process.env.GATEWAY_CONTEXT_BUDGET_TOKENS ?? "32000", 10);

const _gatewayPruner = new PrunerChain([
  new SlidingWindowPruner({ tokenizer: new NaiveTokenizer() }),
]);

// ── Gateway-log (KV-backed, cross-pod safe) ───────────────────────────────────
// Exported so admin.ts can expose /admin/traces without coupling to server state.
// KVGatewayLog: entries TTL 7 days (604_800_000 ms); cross-pod when shared KV is Redis.
export const gatewayLog = new KVGatewayLog(getSharedKV(), {
  keyPrefix:   "nexus",
  entryTtlMs:  7 * 24 * 60 * 60 * 1000,
});

// ── Ultraplinian runner ────────────────────────────────────────────────────────
// Activated when OPENROUTER_API_KEY is set; otherwise POST /gateway/race → 503.
const _ultraRunner = process.env.OPENROUTER_API_KEY
  ? new UltraplinianRunner({ apiKey: process.env.OPENROUTER_API_KEY })
  : null;

// ── Tool registry ──────────────────────────────────────────────────────────────
// Pre-loaded with all built-in tools; Tavily web_search wired when key present.
const _toolRegistry: ToolRegistry = createDefaultRegistry({
  web_search: process.env.TAVILY_API_KEY
    ? async (input) => {
        const i = input as { query: string; maxResults?: number };
        const resp = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key:     process.env.TAVILY_API_KEY,
            query:       i.query,
            max_results: i.maxResults ?? 5,
          }),
        });
        const data = await resp.json() as {
          results?: Array<{ title: string; url: string; content: string }>;
        };
        return {
          results: (data.results ?? []).map((r) => ({
            title:   r.title,
            url:     r.url,
            snippet: r.content,
          })),
        };
      }
    : undefined,
});

function pruneGatewayMessages(
  opts: LlmRequestOptions,
  reserveTokens: number,
): LlmRequestOptions {
  const budget = GATEWAY_CONTEXT_BUDGET - Math.max(0, reserveTokens);
  if (budget <= 0) return opts;
  const input: PrunerMessage[] = opts.messages.map((m) => ({
    role: m.role as PrunerMessage["role"],
    content: m.content,
  }));
  const result = _gatewayPruner.prune(input, budget);
  if (result.prunedCount === 0) return opts; // no change — return original
  return {
    ...opts,
    messages: result.messages.map((m) => ({
      role: m.role as LlmRole,
      content: m.content,
    })),
  };
}

// ── Prompt cache (KV-backed, cross-pod safe) ───────────────────────────────────
// Only caches non-streaming deterministic (temperature=0) requests.
// TTL: PROMPT_CACHE_TTL_MS (default 1 h).
// Cache hits are served with X-Nexus-Cache: HIT header, no LLM call made.

const _promptCache = getPromptCache(getSharedKV());

// ── SSE headers ───────────────────────────────────────────────────────────────

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

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
  /**
   * Optional per-request USD spend guard.
   * If total gateway cost already exceeds this value, the request is
   * rejected 402 before any LLM call is made.
   */
  max_spend_usd?: number;
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
   * When stream:true → hijacks response and emits SSE in Anthropic format:
   *   message_start → content_block_start → content_block_delta* →
   *   content_block_stop → message_delta → message_stop → [DONE]
   *
   * ThinkTagParser strips <think>…</think> blocks from the delta stream so
   * chain-of-thought tokens never reach the client.
   * StreamRecoveryOrchestrator injects a continuation suffix on error.
   */
  app.post<{
    Headers: { "x-nexus-provider"?: string };
    Body: AnthropicRequest;
  }>("/gateway/messages", { preHandler: [requireAuth, _budgetPreHandler] }, async (request, reply) => {
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

    // Prune message history to fit the context window before dispatching.
    // No-op when the thread is short; drops oldest non-system messages when long.
    const opts = pruneGatewayMessages(
      toDriverRequest(request.body, resolvedModel),
      request.body.max_tokens ?? 4096,
    );

    const _logStart  = Date.now();
    const _logIdent  = (request.headers.authorization as string | undefined)?.slice(7, 27) ?? "anon";

    // Hook: task.before — notify observers before dispatch
    globalHooks.emit("task.before", {
      taskId:   `gw-${_logStart}`,
      taskType: "gateway.completion",
      payload:  { model: resolvedModel, provider: providerName },
      attempt:  1,
    }).catch(() => {});

    // ── USD spend cap (best-effort pre-call guard) ───────────────────────────
    if (request.body.max_spend_usd !== undefined) {
      try {
        const runs = await _costStore.list();
        const totalUsd = runs.reduce(
          (s, r) => s + r.steps.reduce((a, st) => a + (st.costUsd ?? 0), 0),
          0,
        );
        if (totalUsd >= request.body.max_spend_usd) {
          return reply.code(402).send({
            type: "error",
            error: {
              type: "spend_cap_exceeded",
              message: `Gateway cumulative spend ($${totalUsd.toFixed(6)}) exceeds max_spend_usd ($${request.body.max_spend_usd}).`,
              total_usd:    totalUsd,
              max_spend_usd: request.body.max_spend_usd,
            },
          });
        }
      } catch { /* non-fatal — proceed if cost store unavailable */ }
    }

    // ── Streaming branch ────────────────────────────────────────────────────
    if (request.body.stream) {
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, SSE_HEADERS);

      const parser = new ThinkTagParser();
      const orchestrator = new StreamRecoveryOrchestrator({ holdMs: 50 });
      const msgId = `nexus-${Date.now()}`;
      let lastText = "";

      const writeEvent = (data: unknown): void => {
        if (!raw.destroyed) {
          raw.write(`data: ${JSON.stringify(data)}\n\n`);
        }
      };

      // Send opening frames
      writeEvent({
        type: "message_start",
        message: { id: msgId, type: "message", role: "assistant", model: resolvedModel },
      });
      writeEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });

      let streamTimeoutId: ReturnType<typeof setTimeout> | undefined;

      try {
        // Race the provider stream against a hard timeout so a stalled upstream
        // can't hold the SSE connection open forever.
        const streamPromise = driver.stream(opts, async ({ delta, done, usage }) => {
          if (done) {
            // Flush any remaining buffered content from the parser
            for (const chunk of parser.flush()) {
              if (chunk.type === "TEXT" && chunk.text) {
                lastText += chunk.text;
                writeEvent({
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: chunk.text },
                });
              }
            }
            writeEvent({ type: "content_block_stop", index: 0 });
            writeEvent({
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: usage?.outputTokens ?? 0 },
            });
            writeEvent({ type: "message_stop" });
            if (!raw.destroyed) raw.write("data: [DONE]\n\n");
            if (!raw.destroyed) raw.end();
            gatewayLog.append({
              timestamp: _logStart,
              model:     resolvedModel,
              provider:  providerName,
              status:    "success",
              latencyMs: Date.now() - _logStart,
              usage:     usage ? { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 } : undefined,
              identity:  _logIdent,
            }).catch(() => {});
          } else {
            // Feed through think-parser; only emit TEXT chunks to client
            for (const chunk of parser.feed(delta)) {
              if (chunk.type === "TEXT" && chunk.text) {
                lastText += chunk.text;
                writeEvent({
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: chunk.text },
                });
              }
              // THINKING chunks silently dropped — chain-of-thought stays server-side
            }
          }
        });

        const timeoutPromise = new Promise<never>((_, reject) => {
          streamTimeoutId = setTimeout(
            () => reject(new Error(`Gateway stream timed out after ${STREAM_TIMEOUT_MS}ms`)),
            STREAM_TIMEOUT_MS,
          );
        });

        await Promise.race([streamPromise, timeoutPromise]);
        clearTimeout(streamTimeoutId);
      } catch (err: unknown) {
        clearTimeout(streamTimeoutId);
        const e = err as { message?: string };
        // Inject continuation suffix so the client gets a graceful truncation notice
        const { text: recoveredText } = orchestrator.handleError(lastText, "plain");
        const suffix = recoveredText.slice(lastText.length);
        if (suffix) {
          writeEvent({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: suffix },
          });
        }
        writeEvent({
          type: "error",
          error: { type: "stream_error", message: e.message ?? "Stream interrupted" },
        });
        if (!raw.destroyed) raw.write("data: [DONE]\n\n");
        if (!raw.destroyed) raw.end();
        gatewayLog.append({
          timestamp:    _logStart,
          model:        resolvedModel,
          provider:     providerName,
          status:       "error",
          latencyMs:    Date.now() - _logStart,
          errorMessage: (err as Error).message ?? "Stream interrupted",
          identity:     _logIdent,
        }).catch(() => {});
      }

      return; // hijacked — Fastify must not touch reply after this
    }

    // ── Non-streaming branch ────────────────────────────────────────────────

    // ── Prompt cache check (deterministic requests only) ────────────────────
    if (PromptCache.isEligible(request.body)) {
      const cacheReq: CacheableRequest = {
        model:       resolvedModel,
        messages:    opts.messages as CacheableRequest["messages"],
        system:      request.body.system,
        max_tokens:  request.body.max_tokens,
        temperature: request.body.temperature,
      };
      const cached = await _promptCache.get(cacheReq);
      if (cached.hit && cached.response) {
        reply.header("X-Nexus-Cache", "HIT");
        reply.header("X-Nexus-Cache-Key", cached.cacheKey.split(":")[1]?.slice(0, 16) ?? "");
        reply.header("Cache-Control", "private, max-age=3600");
        return reply.code(200).send(cached.response);
      }
    }

    try {
      const response = await driver.complete(opts);

      const _latMs = Date.now() - _logStart;

      gatewayLog.append({
        timestamp: _logStart,
        model:     resolvedModel,
        provider:  providerName,
        status:    "success",
        latencyMs: _latMs,
        usage:     { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens },
        identity:  _logIdent,
      }).catch(() => {});

      // Run-cost accounting (fire-and-forget)
      try {
        const runId = costTracker.startRun(`gw-${resolvedModel}`);
        costTracker.recordStep(runId, {
          step:         "completion",
          model:        resolvedModel,
          inputTokens:  response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
        });
        costTracker.endRun(runId);
      } catch { /* non-fatal */ }

      globalHooks.emit("task.after", {
        taskId:      `gw-${_logStart}`,
        taskType:    "gateway.completion",
        durationMs:  _latMs,
        result:      { model: resolvedModel, tokens: response.usage.outputTokens },
      }).catch(() => {});

      const responseBody = {
        id:          response.id,
        type:        "message" as const,
        role:        "assistant" as const,
        content:     [{ type: "text" as const, text: response.content }],
        model:       response.model,
        stop_reason: response.finishReason ?? null,
        usage: {
          input_tokens:  response.usage.inputTokens,
          output_tokens: response.usage.outputTokens,
        },
      };

      // Cache deterministic responses for future identical requests
      if (PromptCache.isEligible(request.body)) {
        const cacheReq: CacheableRequest = {
          model:       resolvedModel,
          messages:    opts.messages as CacheableRequest["messages"],
          system:      request.body.system,
          max_tokens:  request.body.max_tokens,
          temperature: request.body.temperature,
        };
        _promptCache.set(cacheReq, responseBody).catch(() => {});
      }

      reply.header("X-Nexus-Cache", "MISS");
      reply.header("Cache-Control", "private, no-store");
      return reply.code(200).send(responseBody);
    } catch (err: unknown) {
      const e = err as { code?: string; statusCode?: number; message?: string };
      const statusCode = e.statusCode && e.statusCode >= 400 ? e.statusCode : 502;
      gatewayLog.append({
        timestamp:    _logStart,
        model:        resolvedModel,
        provider:     providerName,
        status:       "error",
        latencyMs:    Date.now() - _logStart,
        errorMessage: e.message ?? "Upstream provider error",
        identity:     _logIdent,
      }).catch(() => {});
      globalHooks.emit("task.error", {
        taskId:    `gw-${_logStart}`,
        taskType:  "gateway.completion",
        error:     e.message ?? "Upstream provider error",
        attempt:   1,
      }).catch(() => {});
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
    // Model alias table is stable; safe to cache at the CDN + browser level.
    reply.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    const registry = buildDriverRegistry();
    const models = Object.entries(DRIVER_ALIASES).map(([alias, target]) => ({
      id: alias,
      provider: target.provider,
      backend_model: target.model,
      available: registry.has(target.provider),
    }));
    return reply.send({ models, providers: registry.list() });
  });

  /**
   * POST /gateway/race
   *
   * ULTRAPLINIAN — races N models in parallel (via OpenRouter) and returns the
   * winner scored on substance/directness/completeness.
   *
   * Body:
   *   tier      — "fast" | "standard" | "smart" | "power" | "ultra" (default: "fast")
   *   messages  — chat messages [{ role, content }]
   *   models    — override model list (bypasses tier)
   *   params    — sampling params (temperature, max_tokens, …)
   *   stream    — if true, returns text/event-stream with result + [DONE]
   *
   * Requires OPENROUTER_API_KEY; returns 503 if not configured.
   */
  app.post<{
    Body: {
      tier?:     SpeedTier;
      messages:  UltraplinianMessage[];
      models?:   string[];
      params?:   UltraplinianSamplingParams;
      stream?:   boolean;
    };
  }>("/gateway/race", {
    preHandler: [requireAuth, makeTierGatePreHandler({ feature: "ultraplinian", getTier: getTierFromRequest })],
  }, async (request, reply) => {
    if (!_ultraRunner) {
      return reply.code(503).send({
        error: "ultraplinian_unavailable",
        message: "OPENROUTER_API_KEY is not configured",
      });
    }

    const { tier = "fast", messages, models, params, stream = false } = request.body;

    if (stream) {
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, SSE_HEADERS);
      const writeEvent = (d: unknown) => {
        if (!raw.destroyed) raw.write(`data: ${JSON.stringify(d)}\n\n`);
      };
      try {
        const result = await _ultraRunner.race({ tier, messages, models, params });
        writeEvent({ type: "result", ...result });
      } catch (err) {
        writeEvent({ type: "error", message: (err instanceof Error ? err.message : String(err)) });
      }
      if (!raw.destroyed) { raw.write("data: [DONE]\n\n"); raw.end(); }
      return;
    }

    try {
      const result = await _ultraRunner.race({ tier, messages, models, params });
      return reply.send(result);
    } catch (err) {
      return reply.code(502).send({
        error: "race_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * GET /gateway/tools
   *
   * List all registered tools in LLM function-calling schema format.
   */
  app.get("/gateway/tools", { preHandler: requireAuth }, async (_request, reply) => {
    // Tool schema is static for the process lifetime; cache aggressively.
    reply.header("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
    return reply.send({
      tools: _toolRegistry.toLlmTools(),
      total: _toolRegistry.size(),
    });
  });

  /**
   * POST /gateway/tools/invoke
   *
   * Invoke a registered tool by name.
   * Body: { name: string, input: unknown }
   *
   * Returns ToolResult { tool, success, output?, error?, durationMs }.
   */
  app.post<{
    Body: { name: string; input?: unknown };
  }>("/gateway/tools/invoke", { preHandler: requireAuth }, async (request, reply) => {
    const { name, input = {} } = request.body;
    if (!name) return reply.code(400).send({ error: "name is required" });
    const result = await _toolRegistry.invoke(name, input);
    return reply.code(result.success ? 200 : 422).send(result);
  });

  /**
   * GET /gateway/cost-report?limit=&cursor=
   *
   * Returns aggregate USD cost + token breakdown for completed gateway runs.
   * Supports cursor-based pagination: cursor is an opaque runId; pass the
   * nextCursor from the previous response to get the next page.
   *
   * Replace InMemoryRunCostStore with a Pg-backed store for persistence.
   */
  app.get<{
    Querystring: { limit?: string; cursor?: string };
  }>("/gateway/cost-report", { preHandler: requireAuth }, async (request, reply) => {
    // Cost data is user-specific and live — must not be shared or persisted.
    reply.header("Cache-Control", "private, no-store");
    const limit  = Math.min(parseInt(request.query.limit ?? "50", 10) || 50, 200);
    const cursor = request.query.cursor;

    const allRuns  = await _costStore.list();
    const totalUsd = allRuns.reduce((s, r) => s + r.steps.reduce((a, st) => a + (st.costUsd     ?? 0), 0), 0);
    const totalTok = allRuns.reduce((s, r) => s + r.steps.reduce((a, st) => a + (st.totalTokens ?? 0), 0), 0);

    // Cursor: index of the run AFTER the one with the given runId
    let startIdx = 0;
    if (cursor) {
      const cursorIdx = allRuns.findIndex((r) => r.runId === cursor);
      if (cursorIdx !== -1) startIdx = cursorIdx + 1;
    }

    const page       = allRuns.slice(startIdx, startIdx + limit);
    const nextCursor = allRuns.length > startIdx + limit
      ? allRuns[startIdx + limit - 1]!.runId
      : null;

    return reply.send({
      totalRuns:    allRuns.length,
      totalUsd:     Math.round(totalUsd * 1_000_000) / 1_000_000,
      totalTokens:  totalTok,
      limit,
      cursor:       cursor ?? null,
      nextCursor,
      runs: page.map((r) => ({
        runId:       r.runId,
        label:       r.label,
        startedAt:   r.startedAt,
        endedAt:     r.endedAt,
        totalUsd:    r.steps.reduce((a, st) => a + (st.costUsd     ?? 0), 0),
        totalTokens: r.steps.reduce((a, st) => a + (st.totalTokens ?? 0), 0),
        steps:       r.steps.length,
      })),
    });
  });
}
