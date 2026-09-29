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

import type { CouncilRequest, CouncilResponse, ModelVote } from "@nexus/contracts";
import { COUNCIL_TEMPLATES, CouncilService, detectTaskCategory } from "@nexus/council";
import type {
  Archetype,
  CouncilPersistPayload,
  ILLMTransport,
  ILLMMessage,
  ILLMResponse,
} from "@nexus/council";
import { db } from "@nexus/db";
import { verdicts, councilTranscripts, signals } from "@nexus/db/schema";
import { OllamaDriver, type DriverRegistry, type LlmRole } from "@nexus/llm-drivers";
import { makeTierGatePreHandler } from "@nexus/tier-gate";
import { and, eq, desc } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { ANON_OWNER, loadArchetypeStore, resolveCouncilMembers } from "../lib/archetype-store.js";
import { emitCouncilTranscript } from "../lib/council-transcript.js";
import { FailoverDriver } from "../lib/llm-failover.js";
import { ownerScope } from "../lib/owner.js";
import { buildUserDriverRegistry, listUserDrivers } from "../lib/provider-keys.js";
import { requireAuth, requireAuthWithTier, getTierFromRequest } from "../middleware/auth.js";

// ── Council config ─────────────────────────────────────────────────────────────

const LOCAL_OLLAMA = process.env.NEXUS_LLM_PROVIDER === "ollama";
// In local mode default the council to the local Ollama alias so deliberations
// run key-free; cloud deployments still default to nexus/smart (BYOK).
const COUNCIL_MODEL = process.env.COUNCIL_MODEL ?? (LOCAL_OLLAMA ? "nexus/local" : "nexus/smart");

/** Resolve the active council model alias (env-aware, shared with callers). */
export function resolveCouncilModelAlias(): string {
  return COUNCIL_MODEL;
}
const COUNCIL_MAX_TOKENS = parseInt(process.env.COUNCIL_MAX_TOKENS ?? "4096", 10);

// ── Driver alias table ────────────────────────────────────────────────────────

const COUNCIL_DRIVER_ALIASES: Record<string, { provider: string; model: string }> = {
  // llama-3.3-70b-versatile was decommissioned by Groq on 2026-08-16 — the
  // groq aliases now point at openai/gpt-oss-120b (Groq's recommended swap).
  "nexus/fast": { provider: "groq", model: "openai/gpt-oss-120b" },
  "nexus/smart": { provider: "groq", model: "openai/gpt-oss-120b" },
  "nexus/opus": { provider: "anthropic", model: "claude-opus-4-5" },
  // claude-3-5-sonnet-20241022 was retired by Anthropic on 2025-10-22.
  "nexus/sonnet": { provider: "anthropic", model: "claude-sonnet-4-6" },
  "nexus/haiku": { provider: "anthropic", model: "claude-haiku-4-5" },
  // Gemini 1.5/2.x lines are shut down; 3.6 Flash is GA and cheap.
  "nexus/gemini": { provider: "gemini", model: "gemini-3.6-flash" },
  "nexus/deepseek": { provider: "deepseek", model: "deepseek-chat" },
  "nexus/mistral": { provider: "mistral", model: "mistral-small-latest" },
  "nexus/openrouter": { provider: "openrouter", model: "anthropic/claude-sonnet-5" },
  "nexus/local": { provider: "ollama", model: process.env.NEXUS_DEFAULT_MODEL ?? "qwen2.5:7b" },
};

// COUNCIL_MODEL picks a fixed alias for the life of the process; fail at boot
// on a typo'd or stale value so it cannot silently resolve to the wrong
// provider on every request.
if (!Object.hasOwn(COUNCIL_DRIVER_ALIASES, COUNCIL_MODEL)) {
  throw new Error(
    `COUNCIL_MODEL "${COUNCIL_MODEL}" is not a known council model alias. ` +
      `Valid values: ${Object.keys(COUNCIL_DRIVER_ALIASES).join(", ")}.`,
  );
}

/**
 * Resolve a per-member model choice to a provider and concrete model id.
 * Accepts a council alias ("nexus/smart"), an explicit "provider/model" pair,
 * or a bare model id whose provider is inferred from its name.
 */
export function resolveMemberModel(choice: string): { provider: string; model: string } | null {
  const alias = COUNCIL_DRIVER_ALIASES[choice];
  if (alias) return alias;

  const slash = choice.indexOf("/");
  if (slash > 0) {
    const provider = choice.slice(0, slash);
    const model = choice.slice(slash + 1);
    if (provider && model) return { provider, model };
  }

  const m = choice.toLowerCase();
  if (m.includes("claude")) return { provider: "anthropic", model: choice };
  if (m.includes("gpt") || m.startsWith("o1") || m.startsWith("o3"))
    return { provider: "openai", model: choice };
  if (m.includes("gemini")) return { provider: "gemini", model: choice };
  if (m.includes("deepseek")) return { provider: "deepseek", model: choice };
  if (m.includes("mistral") || m.includes("codestral"))
    return { provider: "mistral", model: choice };
  if (m.includes("llama") || m.includes("mixtral") || m.includes("gemma"))
    return { provider: "groq", model: choice };
  return null;
}

// ── LlmDriversTransport ───────────────────────────────────────────────────────

/**
 * ILLMTransport backed by @nexus/llm-drivers DriverRegistry.
 * Identical to the one in council-handler.ts — both code paths share the
 * same transport so provider behaviour is consistent.
 */
export class LlmDriversTransport implements ILLMTransport {
  constructor(
    private readonly registry: DriverRegistry,
    private readonly modelAlias: string,
  ) {}

  async chat(
    messages: ILLMMessage[],
    options?: { model?: string; temperature?: number; maxTokens?: number },
  ): Promise<ILLMResponse> {
    const fallback = COUNCIL_DRIVER_ALIASES[this.modelAlias];
    if (!fallback) {
      throw new Error(`Council: unknown model alias "${this.modelAlias}".`);
    }

    // A council member may carry its own model (Stage D1). Honour it only when
    // the caller holds a key for the provider it needs — a member must not be
    // able to route around BYOK, so an unreachable choice degrades to the
    // council default rather than failing the whole vote.
    const requested = options?.model ? resolveMemberModel(options.model) : null;
    const aliased = requested && this.registry.get(requested.provider) ? requested : fallback;

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

/**
 * Answers every council call on the caller's own connections, each on its default model. Used
 * when no council alias provider is reachable, e.g. the caller saved only a custom endpoint.
 */
class OwnDriversTransport implements ILLMTransport {
  constructor(private readonly driver: FailoverDriver) {}

  async chat(
    messages: ILLMMessage[],
    options?: { model?: string; temperature?: number; maxTokens?: number },
  ): Promise<ILLMResponse> {
    const start = Date.now();
    const res = await this.driver.complete({
      model: this.driver.model || "default",
      messages: messages.map((m) => ({ role: m.role as LlmRole, content: m.content })),
      maxTokens: options?.maxTokens ?? COUNCIL_MAX_TOKENS,
      temperature: options?.temperature,
    });
    return {
      content: res.content,
      model: res.model,
      usage: { promptTokens: res.usage.inputTokens, completionTokens: res.usage.outputTokens },
      latencyMs: res.durationMs ?? Date.now() - start,
    };
  }
}

// ── Per-user council service (strict BYOK) ──────────────────────────────────────

/**
 * The configured council alias when the caller can reach its provider,
 * otherwise the first alias whose provider they can — so a key for any
 * council provider is enough to deliberate.
 */
function reachableCouncilAlias(canReach: (provider: string) => boolean): string | null {
  if (canReach(COUNCIL_DRIVER_ALIASES[COUNCIL_MODEL]!.provider)) return COUNCIL_MODEL;
  return (
    Object.entries(COUNCIL_DRIVER_ALIASES).find(
      ([alias, t]) => alias !== "nexus/local" && canReach(t.provider),
    )?.[0] ?? null
  );
}

/** Distinct providers any council model alias can route to. */
const COUNCIL_PROVIDERS = [
  ...new Set(Object.values(COUNCIL_DRIVER_ALIASES).map((a) => a.provider)),
];

/** Raised when the authenticated user has no key for the active council provider. */
class NoCouncilKeyError extends Error {}

/**
 * Build a CouncilService backed by the authenticated user's own provider keys.
 * Strict: if the user has no key for the active council model's provider, throws
 * NoCouncilKeyError (surfaced as 400) rather than falling back to an env key.
 */
async function buildCouncilServiceForUser(userId: string | undefined): Promise<CouncilService> {
  const { registry, missing } = await buildUserDriverRegistry(userId, COUNCIL_PROVIDERS);
  let effectiveModel = COUNCIL_MODEL;
  // COUNCIL_MODEL is validated against COUNCIL_DRIVER_ALIASES at module load, so
  // this lookup always hits.
  const councilProvider = COUNCIL_DRIVER_ALIASES[COUNCIL_MODEL]!.provider;

  const registerLocalOllama = () => {
    if (!registry.get("ollama")) {
      registry.register(
        new OllamaDriver({
          baseUrl: process.env.OLLAMA_BASE_URL,
          model: process.env.NEXUS_DEFAULT_MODEL ?? "qwen2.5:7b",
        }),
        "ollama",
      );
    }
  };

  if (councilProvider === "ollama") {
    // Local Ollama is keyless — register it directly.
    registerLocalOllama();
  } else if (missing.includes(councilProvider)) {
    const reachable = reachableCouncilAlias((p) => !missing.includes(p) && !!registry.get(p));
    if (reachable) {
      effectiveModel = reachable;
    } else if (LOCAL_OLLAMA) {
      // Local mode with no cloud key: degrade to local Ollama instead of 400 so
      // deliberations run key-free (mirrors gateway.ts local fallback).
      registerLocalOllama();
      effectiveModel = "nexus/local";
    } else {
      // None of the council's own providers, but the caller may hold other connections.
      const own = await listUserDrivers(userId);
      if (own.length > 0) {
        const chain = new FailoverDriver(
          own.map((e) => ({ id: `user:${e.id}`, driver: e.driver, ownModel: true })),
        );
        return new CouncilService({
          llm: new OwnDriversTransport(chain),
          onResult: persistCouncilResult,
        });
      }
      throw new NoCouncilKeyError(
        `No API key configured for the council provider "${councilProvider}". ` +
          `Add one under Settings → Provider Keys.`,
      );
    }
  }
  const transport = new LlmDriversTransport(registry, effectiveModel);
  return new CouncilService({ llm: transport, onResult: persistCouncilResult });
}

/**
 * Resolve this caller's council membership from the archetype registry, so the
 * personas and the per-member models a user configured are the ones that vote.
 */
async function membersForRequest(
  userId: string | undefined,
  request: CouncilRequest,
): Promise<Archetype[]> {
  await loadArchetypeStore();
  const category = detectTaskCategory(
    `${request.proposal.title} ${request.proposal.description ?? ""}`,
  );
  const size = Math.min(14, Math.max(1, request.councilSize ?? 5));
  return resolveCouncilMembers(userId ?? ANON_OWNER, category, size);
}

/**
 * One deliberation for a user outside the HTTP route, on their own keys and
 * archetypes. The org approvals inbox asks the council through this.
 */
export async function deliberateForUser(
  userId: string | undefined,
  request: CouncilRequest,
): Promise<CouncilResponse> {
  const svc = await buildCouncilServiceForUser(userId);
  return svc.deliberate(request, { archetypes: await membersForRequest(userId, request) });
}

// ── Persistence ────────────────────────────────────────────────────────────────

/** The caller's signal with this id, or undefined when it is not theirs (or malformed). */
async function ownSignal(request: { nexusUserId?: string }, id: string) {
  const [row] = await db
    .select()
    .from(signals)
    .where(and(eq(signals.id, id), ownerScope(signals.ownerId, request)))
    .catch(() => []);
  return row;
}

/** A signal standing for a proposal asked directly, since every verdict belongs to a signal. */
async function proposalSignal(
  request: CouncilRequest,
  ownerId: string | undefined,
): Promise<string | undefined> {
  const [row] = await db
    .insert(signals)
    .values({
      signalType: "council.proposal",
      sourceEventIds: [],
      summary: request.proposal.title,
      priority: "medium",
      metadata: { description: request.proposal.description ?? null },
      ownerId: ownerId ?? null,
    })
    .returning({ id: signals.id })
    .catch(() => []);
  return row?.id;
}

async function latestVerdictId(signalId: string | undefined): Promise<string | null> {
  if (!signalId) return null;
  const [row] = await db
    .select({ id: verdicts.id })
    .from(verdicts)
    .where(eq(verdicts.signalId, signalId))
    .orderBy(desc(verdicts.createdAt))
    .limit(1)
    .catch(() => []);
  return row?.id ?? null;
}

async function persistCouncilResult(payload: CouncilPersistPayload): Promise<void> {
  const { result, votes, signalId } = payload;
  if (!signalId) return; // verdicts.signal_id is NOT NULL

  const decision: "approve" | "reject" | "defer" | "escalate" =
    result.outcome === "approved" ? "approve" : result.outcome === "rejected" ? "reject" : "defer";

  const dissents = votes
    .filter((v: ModelVote) => v.vote !== result.majority && v.vote !== "abstain")
    .map((v: ModelVote) => v.model);

  // A verdict belongs to whoever owns the signal it answers.
  const [signal] = await db
    .select({ ownerId: signals.ownerId })
    .from(signals)
    .where(eq(signals.id, signalId));
  const [verdictRow] = await db
    .insert(verdicts)
    .values({
      signalId,
      ownerId: signal?.ownerId ?? null,
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

// ── Routes ────────────────────────────────────────────────────────────────────

const deliberateBody = {
  type: "object",
  required: ["proposal"],
  properties: {
    proposal: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string", minLength: 1, maxLength: 500 },
        description: { type: "string", maxLength: 10_000 },
      },
    },
    budgetUsd: { type: "number", minimum: 0 },
    timeoutMs: { type: "number", minimum: 1_000, maximum: 300_000 },
    mode: { type: "string", enum: ["majority", "unanimous", "weighted"] },
    signal_id: { type: "string" },
  },
} as const;

export async function councilRoutes(app: FastifyInstance): Promise<void> {
  // POST /council/deliberate
  app.post<{
    Body: CouncilRequest & { signal_id?: string };
  }>(
    "/council/deliberate",
    {
      preHandler: [
        requireAuthWithTier,
        makeTierGatePreHandler({
          feature: "council",
          getTier: (req) => getTierFromRequest(req as Parameters<typeof getTierFromRequest>[0]),
        }),
      ],
      schema: { body: deliberateBody },
    },
    async (request, reply) => {
      const { signal_id: given, ...councilRequest } = request.body as CouncilRequest & {
        signal_id?: string;
      };
      let svc: CouncilService;
      try {
        svc = await buildCouncilServiceForUser(request.nexusUserId);
      } catch (err) {
        if (err instanceof NoCouncilKeyError)
          return reply.code(400).send({ ok: false, error: err.message });
        throw err;
      }
      const startedAt = Date.now();
      try {
        if (given && !(await ownSignal(request, given)))
          return reply.code(404).send({ ok: false, error: "Signal not found" });
        const signal_id = given ?? (await proposalSignal(councilRequest, request.nexusUserId));
        const response = await svc.deliberate(councilRequest, {
          signalId: signal_id,
          archetypes: await membersForRequest(request.nexusUserId, councilRequest),
        });
        if (response.ok && response.result) {
          // Pass 65: emit the run-level transcript (worker-shaped event) so the
          // sync API path leaves the same observability artifact as the worker.
          emitCouncilTranscript({
            signalId: signal_id,
            request: councilRequest,
            result: response.result,
            votes: response.result.votes,
            startedAt,
          });
        }
        return reply
          .code(response.ok ? 200 : 500)
          .send({ ...response, verdictId: await latestVerdictId(signal_id) });
      } catch (err) {
        request.log.error(err, "council/deliberate failed");
        return reply.code(500).send({
          ok: false,
          error: err instanceof Error ? err.message : "Deliberation failed",
        });
      }
    },
  );

  // POST /council/deliberate/stream — SSE: emit each model's vote as it lands,
  // then a final "done" event with the full deliberation response.
  app.post<{
    Body: CouncilRequest & { signal_id?: string };
  }>(
    "/council/deliberate/stream",
    {
      preHandler: [
        requireAuthWithTier,
        makeTierGatePreHandler({
          feature: "council",
          getTier: (req) => getTierFromRequest(req as Parameters<typeof getTierFromRequest>[0]),
        }),
      ],
      schema: { body: deliberateBody },
    },
    async (request, reply) => {
      const { signal_id: given, ...councilRequest } = request.body as CouncilRequest & {
        signal_id?: string;
      };
      // Checked before the SSE headers go out, while a plain 404 can still be sent.
      if (given && !(await ownSignal(request, given)))
        return reply.code(404).send({ ok: false, error: "Signal not found" });

      let svc: CouncilService;
      try {
        svc = await buildCouncilServiceForUser(request.nexusUserId);
      } catch (err) {
        if (err instanceof NoCouncilKeyError)
          return reply.code(400).send({ ok: false, error: err.message });
        throw err;
      }

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const send = (event: string, data: unknown): void => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      const startedAt = Date.now();
      try {
        const signal_id = given ?? (await proposalSignal(councilRequest, request.nexusUserId));
        const response = await svc.deliberate(councilRequest, {
          signalId: signal_id,
          onVote: (vote: ModelVote) => send("vote", vote),
          archetypes: await membersForRequest(request.nexusUserId, councilRequest),
        });
        if (response.ok && response.result) {
          // Pass 65: the streamed path leaves the same run-level artifact.
          emitCouncilTranscript({
            signalId: signal_id,
            request: councilRequest,
            result: response.result,
            votes: response.result.votes,
            startedAt,
          });
        }
        send("done", { ...response, verdictId: await latestVerdictId(signal_id) });
      } catch (err) {
        request.log.error(err, "council/deliberate/stream failed");
        send("error", { error: err instanceof Error ? err.message : "Deliberation failed" });
      } finally {
        reply.raw.end();
      }
      return reply;
    },
  );

  app.get("/council/templates", { preHandler: requireAuth }, async (_request, reply) =>
    reply.send({ templates: Object.values(COUNCIL_TEMPLATES) }),
  );

  // GET /council/verdicts — paginated list (Phase 3)
  app.get<{
    Querystring: { limit?: string; offset?: string };
  }>("/council/verdicts", { preHandler: requireAuth }, async (request, reply) => {
    const limit = Math.min(parseInt(request.query.limit ?? "20", 10), 100);
    const offset = Math.max(parseInt(request.query.offset ?? "0", 10), 0);

    const rows = await db
      .select()
      .from(verdicts)
      .where(ownerScope(verdicts.ownerId, request))
      .orderBy(desc(verdicts.createdAt))
      .limit(limit)
      .offset(offset);

    return reply.send({ verdicts: rows, limit, offset });
  });

  // GET /council/verdicts/:verdictId
  app.get<{ Params: { verdictId: string } }>(
    "/council/verdicts/:verdictId",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const [row] = await db
        .select()
        .from(verdicts)
        .where(
          and(eq(verdicts.id, request.params.verdictId), ownerScope(verdicts.ownerId, request)),
        );
      if (!row) return reply.code(404).send({ error: "Verdict not found" });
      return reply.send(row);
    },
  );

  // GET /council/transcripts/:verdictId
  app.get<{ Params: { verdictId: string } }>(
    "/council/transcripts/:verdictId",
    {
      schema: {
        response: {
          200: { type: "object", additionalProperties: true },
          201: { type: "object", additionalProperties: true },
        },
      },
      preHandler: requireAuth,
    },
    async (request, reply) => {
      const [row] = await db
        .select({ transcript: councilTranscripts })
        .from(councilTranscripts)
        .innerJoin(verdicts, eq(verdicts.id, councilTranscripts.verdictId))
        .where(
          and(
            eq(councilTranscripts.verdictId, request.params.verdictId),
            ownerScope(verdicts.ownerId, request),
          ),
        )
        .then((rows) => rows.map((r) => r.transcript));
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
      preHandler: requireAuthWithTier,
      schema: {
        body: {
          type: "object",
          required: ["signalId"],
          properties: {
            signalId: { type: "string", minLength: 1 },
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

      const signal = await ownSignal(request, signalId);

      if (!signal) {
        return reply.code(404).send({ error: `Signal ${signalId} not found` });
      }

      const councilRequest: CouncilRequest = {
        proposal: {
          title: `[${signal.signalType}] ${signal.summary.slice(0, 80)}`,
          description: signal.summary,
        },
        budgetUsd,
        timeoutMs: timeoutMs ?? 60_000,
      };

      let svc: CouncilService;
      try {
        svc = await buildCouncilServiceForUser(request.nexusUserId);
      } catch (err) {
        if (err instanceof NoCouncilKeyError)
          return reply.code(400).send({ ok: false, error: err.message });
        throw err;
      }
      const startedAt = Date.now();
      try {
        const response = await svc.deliberate(councilRequest, {
          signalId,
          archetypes: await membersForRequest(request.nexusUserId, councilRequest),
        });
        if (response.ok && response.result) {
          // Pass 65: signal-triggered runs leave the same run-level artifact.
          emitCouncilTranscript({
            signalId,
            request: councilRequest,
            result: response.result,
            votes: response.result.votes,
            startedAt,
          });
        }
        return reply.code(response.ok ? 200 : 500).send(response);
      } catch (err) {
        request.log.error(err, "council/trigger failed");
        return reply.code(500).send({
          ok: false,
          error: err instanceof Error ? err.message : "Deliberation failed",
        });
      }
    },
  );
}
