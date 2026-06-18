// SPDX-License-Identifier: Apache-2.0
/**
 * Council task handler — processes `council.deliberate` and `council.evaluate` jobs.
 *
 * Phase 1 — LLM backbone:
 *   LlmDriversTransport wraps @nexus/llm-drivers DriverRegistry so council
 *   deliberation can use any configured provider (Groq, Anthropic, Gemini, …)
 *   controlled by COUNCIL_MODEL env var (default: nexus/smart → Groq 70b).
 *
 * Phase 6 — Cost guard:
 *   checkDailyBudget() increments a Redis counter keyed by UTC date. Jobs are
 *   rejected with a thrown Error once COUNCIL_DAILY_BUDGET is exceeded.
 *   Resets automatically at midnight UTC via Redis EXPIREAT.
 *   Fails open if Redis is unreachable so deliberation is never blocked by infra.
 */

import type { CouncilRequest, ModelVote } from "@nexus/contracts";
import type { ILLMTransport, ILLMMessage, ILLMResponse } from "@nexus/council";
import { CouncilService } from "@nexus/council";
import type { CouncilPersistPayload } from "@nexus/council";
import { db } from "@nexus/db";
import { verdicts, councilTranscripts } from "@nexus/db/schema";
import {
  DriverRegistry,
  GroqDriver,
  AnthropicDriver,
  GeminiDriver,
  DeepSeekDriver,
  MistralDriver,
  type LlmRole,
} from "@nexus/llm-drivers";

// ── Council config ─────────────────────────────────────────────────────────────

const COUNCIL_MODEL = process.env.COUNCIL_MODEL ?? "nexus/smart";
const COUNCIL_MAX_TOKENS = parseInt(process.env.COUNCIL_MAX_TOKENS ?? "4096", 10);
const COUNCIL_DAILY_BUDGET = parseInt(process.env.COUNCIL_DAILY_BUDGET ?? "100", 10);

// ── Driver alias table (council-local subset of gateway DRIVER_ALIASES) ───────

const COUNCIL_DRIVER_ALIASES: Record<string, { provider: string; model: string }> = {
  "nexus/fast": { provider: "groq", model: "llama-3.3-70b-versatile" },
  "nexus/smart": { provider: "groq", model: "llama-3.3-70b-versatile" },
  "nexus/opus": { provider: "anthropic", model: "claude-opus-4-5" },
  "nexus/sonnet": { provider: "anthropic", model: "claude-3-5-sonnet-20241022" },
  "nexus/haiku": { provider: "anthropic", model: "claude-haiku-3-5" },
  "nexus/gemini": { provider: "gemini", model: "gemini-1.5-pro" },
  "nexus/deepseek": { provider: "deepseek", model: "deepseek-chat" },
  "nexus/mistral": { provider: "mistral", model: "mistral-large-latest" },
};

// ── LlmDriversTransport ────────────────────────────────────────────────────────

/**
 * ILLMTransport backed by @nexus/llm-drivers DriverRegistry.
 * Lets CouncilService use any registered provider, not just Groq SDK directly.
 */
class LlmDriversTransport implements ILLMTransport {
  constructor(
    private readonly registry: DriverRegistry,
    private readonly modelAlias: string,
  ) {}

  async chat(
    messages: ILLMMessage[],
    options?: { model?: string; temperature?: number; maxTokens?: number },
  ): Promise<ILLMResponse> {
    const aliased = COUNCIL_DRIVER_ALIASES[this.modelAlias] ?? {
      provider: "groq",
      model: "llama-3.3-70b-versatile",
    };

    const driver = this.registry.get(aliased.provider);
    if (!driver) {
      throw new Error(
        `Council: provider "${aliased.provider}" not configured ` +
          `(model alias: ${this.modelAlias}). Set the corresponding API key env var.`,
      );
    }

    const start = Date.now();
    const res = await driver.complete({
      model: aliased.model,
      messages: messages.map((m) => ({ role: m.role as LlmRole, content: m.content })),
      maxTokens: options?.maxTokens ?? COUNCIL_MAX_TOKENS,
      temperature: options?.temperature,
    });

    return {
      content: res.content,
      model: res.model,
      usage: {
        promptTokens: res.usage.inputTokens,
        completionTokens: res.usage.outputTokens,
      },
      latencyMs: res.durationMs ?? Date.now() - start,
    };
  }
}

function buildCouncilRegistry(): DriverRegistry {
  const reg = new DriverRegistry();
  if (process.env.GROQ_API_KEY) reg.register(new GroqDriver({ apiKey: process.env.GROQ_API_KEY }));
  if (process.env.ANTHROPIC_API_KEY)
    reg.register(new AnthropicDriver({ apiKey: process.env.ANTHROPIC_API_KEY }));
  if (process.env.GEMINI_API_KEY)
    reg.register(new GeminiDriver({ apiKey: process.env.GEMINI_API_KEY }));
  if (process.env.DEEPSEEK_API_KEY)
    reg.register(new DeepSeekDriver({ apiKey: process.env.DEEPSEEK_API_KEY }));
  if (process.env.MISTRAL_API_KEY)
    reg.register(new MistralDriver({ apiKey: process.env.MISTRAL_API_KEY }));
  return reg;
}

// ── Daily budget guard ────────────────────────────────────────────────────────

type RedisLike = {
  incr(k: string): Promise<number>;
  expireat(k: string, ts: number): Promise<unknown>;
};
let _redis: RedisLike | null = null;

async function getRedis(): Promise<RedisLike | null> {
  if (!process.env.REDIS_URL) return null;
  if (_redis) return _redis;
  try {
    const ioredis = await import("ioredis");
    const Redis = (ioredis.default ?? ioredis) as unknown as new (
      url: string,
      opts: Record<string, unknown>,
    ) => RedisLike;
    _redis = new Redis(process.env.REDIS_URL, {
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
    });
  } catch {
    // ioredis unavailable — fail open
  }
  return _redis;
}

function midnightUtcUnix(): number {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return Math.floor(d.getTime() / 1_000);
}

async function checkDailyBudget(): Promise<{ ok: boolean; count: number; limit: number }> {
  try {
    const redis = await getRedis();
    if (!redis) return { ok: true, count: 0, limit: COUNCIL_DAILY_BUDGET };

    const key = `nexus:council:daily:${new Date().toISOString().slice(0, 10)}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expireat(key, midnightUtcUnix());

    return { ok: count <= COUNCIL_DAILY_BUDGET, count, limit: COUNCIL_DAILY_BUDGET };
  } catch {
    return { ok: true, count: 0, limit: COUNCIL_DAILY_BUDGET }; // fail open if Redis down
  }
}

// ── Persistence ────────────────────────────────────────────────────────────────

async function persistCouncilResult(payload: CouncilPersistPayload): Promise<void> {
  const { result, votes, signalId } = payload;
  if (!signalId) return; // verdicts.signal_id is NOT NULL

  const decision: "approve" | "reject" | "defer" | "escalate" =
    result.outcome === "approved" ? "approve" : result.outcome === "rejected" ? "reject" : "defer";

  const dissents = votes
    .filter((v: ModelVote) => v.vote !== result.majority && v.vote !== "abstain")
    .map((v: ModelVote) => v.model);

  const [verdictRow] = await db
    .insert(verdicts)
    .values({
      signalId,
      decision,
      confidence: result.consensus,
      rationale: result.summary,
      dissents,
      actions: null,
      costUsd: payload.totalCostUsd > 0 ? payload.totalCostUsd.toFixed(6) : null,
    })
    .returning({ id: verdicts.id });

  if (!verdictRow) return;

  await db.insert(councilTranscripts).values({
    verdictId: verdictRow.id,
    turns: votes.map((v: ModelVote) => ({
      archetype: v.model,
      role: "assistant",
      content: v.reasoning,
      confidence: v.confidence,
      latencyMs: v.latencyMs,
    })),
  });
}

// ── Service singleton ──────────────────────────────────────────────────────────

let _svc: CouncilService | null = null;

function getSvc(): CouncilService {
  if (!_svc) {
    const registry = buildCouncilRegistry();
    const transport = new LlmDriversTransport(registry, COUNCIL_MODEL);
    _svc = new CouncilService({ llm: transport, onResult: persistCouncilResult });
  }
  return _svc;
}

// ── Job payload + handler ──────────────────────────────────────────────────────

export interface CouncilJobPayload {
  proposal: CouncilRequest["proposal"];
  budgetUsd?: number;
  timeoutMs?: number;
  signalId?: string;
}

export async function handleCouncilJob(payload: CouncilJobPayload): Promise<unknown> {
  // Phase 6 — reject early if daily budget exhausted
  const budget = await checkDailyBudget();
  if (!budget.ok) {
    throw new Error(
      `Council daily budget exceeded (${budget.count}/${budget.limit} today). ` +
        "Resets at midnight UTC. Raise COUNCIL_DAILY_BUDGET to increase the limit.",
    );
  }

  const svc = getSvc();
  const request: CouncilRequest = {
    proposal: payload.proposal,
    budgetUsd: payload.budgetUsd,
    timeoutMs: payload.timeoutMs ?? 60_000,
  };

  const response = await svc.deliberate(request, { signalId: payload.signalId });

  if (response.ok && response.result) {
    const r = response.result;
    console.log(
      JSON.stringify({
        level: "info",
        event: "council.deliberation.complete",
        signalId: payload.signalId,
        outcome: r.outcome,
        consensus: r.consensus,
        model: COUNCIL_MODEL,
        costUsd: r.totalCostUsd,
        dailyCount: budget.count,
        dailyLimit: budget.limit,
      }),
    );
  }

  return response;
}
