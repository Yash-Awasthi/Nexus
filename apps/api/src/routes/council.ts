// SPDX-License-Identifier: Apache-2.0
/**
 * Council routes
 *   POST /api/v1/council/deliberate          — ad-hoc deliberation
 *   GET  /api/v1/council/verdicts            — paginated verdict list  (Phase 3)
 *   GET  /api/v1/council/verdicts/:verdictId — single verdict
 *   GET  /api/v1/council/transcripts/:verdictId
 *   POST /api/v1/council/trigger             — deliberate by signalId  (Phase 3)
 *
 * Phase 1 — LLM backbone:
 *   Same LlmDriversTransport used in council-handler.ts so the API (sync) and
 *   worker (queued) paths share a single transport implementation.
 */

import type { CouncilRequest, ModelVote } from "@nexus/contracts";
import { CouncilService } from "@nexus/council";
import type { CouncilPersistPayload, ILLMTransport, ILLMMessage, ILLMResponse } from "@nexus/council";
import { db } from "@nexus/db";
import { verdicts, councilTranscripts, signals } from "@nexus/db/schema";
import { eq, desc } from "drizzle-orm";
import {
  DriverRegistry,
  GroqDriver,
  AnthropicDriver,
  GeminiDriver,
  DeepSeekDriver,
  MistralDriver,
  type LlmRole,
} from "@nexus/llm-drivers";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── Council config ─────────────────────────────────────────────────────────────

const COUNCIL_MODEL      = process.env.COUNCIL_MODEL      ?? "nexus/smart";
const COUNCIL_MAX_TOKENS = parseInt(process.env.COUNCIL_MAX_TOKENS ?? "4096", 10);

// ── Driver alias table ────────────────────────────────────────────────────────

const COUNCIL_DRIVER_ALIASES: Record<string, { provider: string; model: string }> = {
  "nexus/fast":     { provider: "groq",      model: "llama-3.3-70b-versatile" },
  "nexus/smart":    { provider: "groq",      model: "llama-3.3-70b-versatile" },
  "nexus/opus":     { provider: "anthropic", model: "claude-opus-4-5" },
  "nexus/sonnet":   { provider: "anthropic", model: "claude-3-5-sonnet-20241022" },
  "nexus/haiku":    { provider: "anthropic", model: "claude-haiku-3-5" },
  "nexus/gemini":   { provider: "gemini",    model: "gemini-1.5-pro" },
  "nexus/deepseek": { provider: "deepseek",  model: "deepseek-chat" },
  "nexus/mistral":  { provider: "mistral",   model: "mistral-large-latest" },
};

// ── LlmDriversTransport ───────────────────────────────────────────────────────

/**
 * ILLMTransport backed by @nexus/llm-drivers DriverRegistry.
 * Identical to the one in council-handler.ts — both code paths share the
 * same transport so provider behaviour is consistent.
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
    const aliased = COUNCIL_DRIVER_ALIASES[this.modelAlias]
      ?? { provider: "groq", model: "llama-3.3-70b-versatile" };

    const driver = this.registry.get(aliased.provider);
    if (!driver) {
      throw new Error(
        `Council: provider "${aliased.provider}" not configured ` +
          `(model alias: ${this.modelAlias}). Set the corresponding API key env var.`,
      );
    }

    const start = Date.now();
    const res = await driver.complete({
      model:       aliased.model,
      messages:    messages.map((m) => ({ role: m.role as LlmRole, content: m.content })),
      maxTokens:   options?.maxTokens ?? COUNCIL_MAX_TOKENS,
      temperature: options?.temperature,
    });

    return {
      content:  res.content,
      model:    res.model,
      usage: {
        promptTokens:     res.usage.inputTokens,
        completionTokens: res.usage.outputTokens,
      },
      latencyMs: res.durationMs ?? (Date.now() - start),
    };
  }
}

function buildCouncilRegistry(): DriverRegistry {
  const reg = new DriverRegistry();
  if (process.env.GROQ_API_KEY)      reg.register(new GroqDriver({ apiKey: process.env.GROQ_API_KEY }));
  if (process.env.ANTHROPIC_API_KEY) reg.register(new AnthropicDriver({ apiKey: process.env.ANTHROPIC_API_KEY }));
  if (process.env.GEMINI_API_KEY)    reg.register(new GeminiDriver({ apiKey: process.env.GEMINI_API_KEY }));
  if (process.env.DEEPSEEK_API_KEY)  reg.register(new DeepSeekDriver({ apiKey: process.env.DEEPSEEK_API_KEY }));
  if (process.env.MISTRAL_API_KEY)   reg.register(new MistralDriver({ apiKey: process.env.MISTRAL_API_KEY }));
  return reg;
}

// ── Service singleton ──────────────────────────────────────────────────────────

let _councilService: CouncilService | null = null;

function getCouncilService(): CouncilService {
  if (!_councilService) {
    const registry  = buildCouncilRegistry();
    const transport = new LlmDriversTransport(registry, COUNCIL_MODEL);
    _councilService = new CouncilService({ llm: transport, onResult: persistCouncilResult });
  }
  return _councilService;
}

// ── Persistence ────────────────────────────────────────────────────────────────

async function persistCouncilResult(payload: CouncilPersistPayload): Promise<void> {
  const { result, votes, signalId } = payload;
  if (!signalId) return; // verdicts.signal_id is NOT NULL

  const decision: "approve" | "reject" | "defer" | "escalate" =
    result.outcome === "approved" ? "approve"
      : result.outcome === "rejected" ? "reject"
      : "defer";

  const dissents = votes
    .filter((v: ModelVote) => v.vote !== result.majority && v.vote !== "abstain")
    .map((v: ModelVote) => v.model);

  const [verdictRow] = await db
    .insert(verdicts)
    .values({
      signalId,
      decision,
      confidence: result.consensus,
      rationale:  result.summary,
      dissents,
      actions:    null,
      costUsd: payload.totalCostUsd > 0 ? payload.totalCostUsd.toFixed(6) : null,
    })
    .returning({ id: verdicts.id });

  if (!verdictRow) return;

  await db.insert(councilTranscripts).values({
    verdictId: verdictRow.id,
    turns: votes.map((v: ModelVote) => ({
      archetype:  v.model,
      role:       "assistant",
      content:    v.reasoning,
      confidence: v.confidence,
      latencyMs:  v.latencyMs,
    })),
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

export async function councilRoutes(app: FastifyInstance): Promise<void> {
  // POST /council/deliberate
  app.post<{
    Body: CouncilRequest & { signal_id?: string };
  }>(
    "/council/deliberate",
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: "object",
          required: ["proposal"],
          properties: {
            proposal: {
              type: "object",
              required: ["title"],
              properties: {
                title:       { type: "string", minLength: 1, maxLength: 500 },
                description: { type: "string", maxLength: 10_000 },
              },
            },
            budgetUsd:  { type: "number", minimum: 0 },
            timeoutMs:  { type: "number", minimum: 1_000, maximum: 300_000 },
            signal_id:  { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
    const { signal_id, ...councilRequest } = request.body as CouncilRequest & {
      signal_id?: string;
    };
    const svc = getCouncilService();
    try {
      const response = await svc.deliberate(councilRequest, { signalId: signal_id });
      return reply.code(response.ok ? 200 : 500).send(response);
    } catch (err) {
      request.log.error(err, "council/deliberate failed");
      return reply.code(500).send({
        ok:    false,
        error: err instanceof Error ? err.message : "Deliberation failed",
      });
    }
  });

  // GET /council/verdicts — paginated list (Phase 3)
  app.get<{
    Querystring: { limit?: string; offset?: string };
  }>("/council/verdicts", { preHandler: requireAuth }, async (request, reply) => {
    const limit  = Math.min(parseInt(request.query.limit  ?? "20", 10), 100);
    const offset = Math.max(parseInt(request.query.offset ?? "0",  10), 0);

    const rows = await db
      .select()
      .from(verdicts)
      .orderBy(desc(verdicts.createdAt))
      .limit(limit)
      .offset(offset);

    return reply.send({ verdicts: rows, limit, offset });
  });

  // GET /council/verdicts/:verdictId
  app.get<{ Params: { verdictId: string } }>(
    "/council/verdicts/:verdictId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const [row] = await db
        .select()
        .from(verdicts)
        .where(eq(verdicts.id, request.params.verdictId));
      if (!row) return reply.code(404).send({ error: "Verdict not found" });
      return reply.send(row);
    },
  );

  // GET /council/transcripts/:verdictId
  app.get<{ Params: { verdictId: string } }>(
    "/council/transcripts/:verdictId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const [row] = await db
        .select()
        .from(councilTranscripts)
        .where(eq(councilTranscripts.verdictId, request.params.verdictId));
      if (!row) return reply.code(404).send({ error: "Transcript not found" });
      return reply.send(row);
    },
  );

  // POST /council/trigger — manual deliberation by signalId (Phase 3)
  app.post<{
    Body: { signalId: string; budgetUsd?: number; timeoutMs?: number };
  }>(
    "/council/trigger",
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: "object",
          required: ["signalId"],
          properties: {
            signalId:  { type: "string", minLength: 1 },
            budgetUsd: { type: "number", minimum: 0 },
            timeoutMs: { type: "number", minimum: 1_000, maximum: 300_000 },
          },
        },
      },
    },
    async (request, reply) => {
    const { signalId, budgetUsd, timeoutMs } = request.body;

    if (!signalId) {
      return reply.code(400).send({ error: "signalId is required" });
    }

    const [signal] = await db
      .select()
      .from(signals)
      .where(eq(signals.id, signalId));

    if (!signal) {
      return reply.code(404).send({ error: `Signal ${signalId} not found` });
    }

    const councilRequest: CouncilRequest = {
      proposal: {
        title:       `[${signal.signalType}] ${signal.summary.slice(0, 80)}`,
        description: signal.summary,
      },
      budgetUsd,
      timeoutMs: timeoutMs ?? 60_000,
    };

    const svc = getCouncilService();
    try {
      const response = await svc.deliberate(councilRequest, { signalId });
      return reply.code(response.ok ? 200 : 500).send(response);
    } catch (err) {
      request.log.error(err, "council/trigger failed");
      return reply.code(500).send({
        ok:    false,
        error: err instanceof Error ? err.message : "Deliberation failed",
      });
    }
  });
}
