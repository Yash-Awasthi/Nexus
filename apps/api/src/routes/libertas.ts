// SPDX-License-Identifier: Apache-2.0
/**
 * Libertas — public, unauthenticated free-tier endpoint.
 *
 * "Libertas" (Latin: freedom) exposes a deliberately open window into the
 * Nexus platform to help developers evaluate the gateway without signing up.
 *
 * Routes (all public — no Authorization header required):
 *
 *   GET  /libertas              — platform capabilities + limits + status
 *   POST /libertas/complete     — rate-limited single-turn LLM completion
 *                                 Uses Groq (when GROQ_API_KEY set) or
 *                                 a simple echo stub for local dev.
 *
 * Rate limit:  5 requests per 60 s per IP (IP extracted from X-Forwarded-For
 *              or socket remoteAddress).  Returns 429 + Retry-After on breach.
 *
 * Scope limits:
 *   - max_tokens capped at 512
 *   - single "user" message only (system prompt stripped, history stripped)
 *   - no streaming
 *   - temperature fixed at 0.7 (non-deterministic, not cached)
 *
 * Telemetry: each call is tracked as a "libertas.completion" hook event so
 * the AlertEngine and PostHog analytics can observe free-tier usage patterns.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getSharedKV } from "../lib/shared-kv.js";
import { globalHooks } from "@nexus/hooks";

// ── Constants ─────────────────────────────────────────────────────────────────

const LIBERTAS_RATE_LIMIT    = 5;             // requests
const LIBERTAS_WINDOW_MS     = 60_000;        // per 60 s
const LIBERTAS_MAX_TOKENS    = 512;           // hard cap
const LIBERTAS_TEMPERATURE   = 0.7;           // fixed
const LIBERTAS_KV_PREFIX     = "libertas:rl"; // KV key namespace

// ── IP extraction ─────────────────────────────────────────────────────────────

function getClientIp(request: FastifyRequest): string {
  const fwd = request.headers["x-forwarded-for"];
  if (fwd) return (Array.isArray(fwd) ? fwd[0] : fwd.split(",")[0] ?? "").trim();
  return request.socket?.remoteAddress ?? "unknown";
}

// ── Groq completion (free tier — no auth required for public endpoint) ────────

interface LlmMessage { role: "user" | "assistant" | "system"; content: string; }

async function groqComplete(
  prompt: string,
  maxTokens: number,
): Promise<{ text: string; model: string; input_tokens: number; output_tokens: number }> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    // Local dev / CI stub — echo back the prompt
    return {
      text:          `[echo — set GROQ_API_KEY to enable real completions] ${prompt}`,
      model:         "stub",
      input_tokens:  0,
      output_tokens: 0,
    };
  }

  const body = {
    model:       "llama-3.1-8b-instant",    // smallest+fastest Groq free model
    messages:    [{ role: "user", content: prompt }] satisfies LlmMessage[],
    max_tokens:  maxTokens,
    temperature: LIBERTAS_TEMPERATURE,
    stream:      false,
  };

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method:  "POST",
    headers: {
      Authorization:  `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => String(res.status));
    throw new Error(`Groq error: ${res.status} ${msg}`);
  }

  const data = await res.json() as {
    choices: Array<{ message: { content: string } }>;
    model:   string;
    usage:   { prompt_tokens: number; completion_tokens: number };
  };

  return {
    text:          data.choices[0]?.message.content ?? "",
    model:         data.model,
    input_tokens:  data.usage.prompt_tokens,
    output_tokens: data.usage.completion_tokens,
  };
}

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function libertasRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /libertas
   *
   * Public capability manifest — no auth, no rate limit.
   * Returns: rate limits, available models, endpoint list, platform status.
   */
  app.get("/libertas", async (_request, reply) => {
    reply.header("Cache-Control", "public, max-age=60");
    return reply.send({
      name:        "Nexus Libertas — Free Tier",
      description: "Public, unauthenticated access to the Nexus gateway for evaluation.",
      endpoints: [
        { method: "GET",  path: "/api/v1/libertas",          description: "This manifest" },
        { method: "POST", path: "/api/v1/libertas/complete",  description: "Single-turn LLM completion" },
      ],
      limits: {
        requests_per_minute: LIBERTAS_RATE_LIMIT,
        max_tokens:          LIBERTAS_MAX_TOKENS,
        temperature:         LIBERTAS_TEMPERATURE,
        streaming:           false,
        system_prompts:      false,
        history:             false,
      },
      models: [
        {
          id:       "libertas/fast",
          backend:  "groq/llama-3.1-8b-instant",
          available: !!process.env.GROQ_API_KEY,
        },
      ],
      auth_required: false,
      upgrade_path:  "Set X-Nexus-Api-Key header or use /api/v1/oauth/google to access the full platform.",
    });
  });

  /**
   * POST /libertas/complete
   *
   * Body:
   *   { prompt: string; max_tokens?: number }
   *
   * Enforces per-IP rate limit via shared KV.
   * Returns: { text, model, usage, remaining, reset_at }
   */
  app.post<{
    Body: { prompt: string; max_tokens?: number };
  }>("/libertas/complete", async (request: FastifyRequest, reply: FastifyReply) => {
    // ── Rate limit check ─────────────────────────────────────────────────────
    const ip    = getClientIp(request);
    const kvKey = `${LIBERTAS_KV_PREFIX}:${ip}`;
    const kv    = getSharedKV();

    let current = 0;
    try {
      current = (await kv.get<number>(kvKey)) ?? 0;
    } catch { /* fail open */ }

    if (current >= LIBERTAS_RATE_LIMIT) {
      const retryAfterSec = Math.ceil(LIBERTAS_WINDOW_MS / 1000);
      return reply
        .code(429)
        .header("Retry-After", String(retryAfterSec))
        .header("X-RateLimit-Limit",     String(LIBERTAS_RATE_LIMIT))
        .header("X-RateLimit-Remaining", "0")
        .send({
          error:      "rate_limit_exceeded",
          message:    `Free tier limit is ${LIBERTAS_RATE_LIMIT} req/min. Upgrade for higher limits.`,
          retryAfterSec,
        });
    }

    // Increment counter (fire-and-forget — don't block on KV write)
    kv.set<number>(kvKey, current + 1, LIBERTAS_WINDOW_MS).catch(() => {});

    // ── Validate body ────────────────────────────────────────────────────────
    const body = request.body as { prompt?: string; max_tokens?: number };
    const prompt = (body?.prompt ?? "").trim();
    if (!prompt) {
      return reply.code(400).send({ error: "prompt is required" });
    }
    const maxTokens = Math.min(body?.max_tokens ?? 256, LIBERTAS_MAX_TOKENS);

    // ── LLM call ─────────────────────────────────────────────────────────────
    const _start = Date.now();
    let result: Awaited<ReturnType<typeof groqComplete>>;
    try {
      result = await groqComplete(prompt, maxTokens);
    } catch (err) {
      return reply.code(502).send({
        error:   "completion_failed",
        message: err instanceof Error ? err.message : "LLM unavailable",
      });
    }
    const latencyMs = Date.now() - _start;

    // Hook: task.after — notify observers
    globalHooks.emit("task.after", {
      taskId:     `libertas-${_start}`,
      taskType:   "libertas.completion",
      durationMs: latencyMs,
      result:     { model: result.model, tokens: result.output_tokens },
    }).catch(() => {});

    const remaining = Math.max(0, LIBERTAS_RATE_LIMIT - current - 1);

    reply.header("X-RateLimit-Limit",     String(LIBERTAS_RATE_LIMIT));
    reply.header("X-RateLimit-Remaining", String(remaining));
    reply.header("Cache-Control",         "private, no-store");

    return reply.code(200).send({
      text:   result.text,
      model:  result.model,
      usage: {
        input_tokens:  result.input_tokens,
        output_tokens: result.output_tokens,
      },
      latencyMs,
      remaining,
      upgrade: remaining === 0
        ? "You have used all free-tier requests. Upgrade to remove limits."
        : undefined,
    });
  });
}
