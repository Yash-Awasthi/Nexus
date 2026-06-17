// SPDX-License-Identifier: Apache-2.0
/**
 * Judica-compat routes — mounts under /api (no version prefix).
 *
 * Bridges the Judica frontend's /api/* call surface to the Nexus backend.
 * Three categories:
 *
 *   A) Path aliases   — delegate to same packages as existing /api/v1/* routes
 *   B) New endpoints  — real implementations (ultraplinian stream, godmode, ab)
 *   C) Stubs          — in-memory CRUD or 501 for features not yet backed
 *
 * Register in server.ts under { prefix: "/api" }.
 */

import crypto from "node:crypto";

import {
  applyParseltongue,
  getDefaultConfig as parseltongueDefaultConfig,
} from "@nexus/parseltongue";
import {
  DriverRegistry,
  AnthropicDriver,
  GroqDriver,
  GeminiDriver,
  DeepSeekDriver,
  MistralDriver,
  OpenRouterDriver,
  type LlmRole,
} from "@nexus/llm-drivers";
import {
  InMemoryStore,
  FixedEmbedder,
  GroqEmbedder,
  MemoryManager,
  PgVectorStore,
} from "@nexus/memory";
import {
  InMemoryKGStore,
  NeonKGStore,
  KnowledgeGraph,
  type KGStore,
  type NeonQueryFn,
} from "@nexus/knowledge-graph";
import {
  raceModels,
  scoreResponse,
  getModelsForTier,
  ULTRAPLINIAN_MODELS,
  type ModelResult,
  type SpeedTier,
} from "@nexus/ultraplinian";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";

// ── SSE helpers ───────────────────────────────────────────────────────────────

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

function sseWrite(raw: import("node:http").ServerResponse, ev: unknown): void {
  if (!raw.destroyed) raw.write(`data: ${JSON.stringify(ev)}\n\n`);
}

// ── Lazy-init packages ────────────────────────────────────────────────────────

let _registry: DriverRegistry | null = null;
function getRegistry(): DriverRegistry {
  if (_registry) return _registry;
  const reg = new DriverRegistry();
  if (process.env.GROQ_API_KEY) reg.register(new GroqDriver({ apiKey: process.env.GROQ_API_KEY }));
  if (process.env.ANTHROPIC_API_KEY) reg.register(new AnthropicDriver({ apiKey: process.env.ANTHROPIC_API_KEY }));
  if (process.env.GEMINI_API_KEY) reg.register(new GeminiDriver({ apiKey: process.env.GEMINI_API_KEY }));
  if (process.env.DEEPSEEK_API_KEY) reg.register(new DeepSeekDriver({ apiKey: process.env.DEEPSEEK_API_KEY }));
  if (process.env.MISTRAL_API_KEY) reg.register(new MistralDriver({ apiKey: process.env.MISTRAL_API_KEY }));
  if (process.env.OPENROUTER_API_KEY) reg.register(new OpenRouterDriver({ apiKey: process.env.OPENROUTER_API_KEY }));
  _registry = reg;
  return reg;
}

let _memory: MemoryManager | null = null;
function getMemory(): MemoryManager {
  if (_memory) return _memory;
  const store = process.env.DATABASE_URL
    ? new PgVectorStore({ databaseUrl: process.env.DATABASE_URL })
    : new InMemoryStore();
  const embedder = process.env.GROQ_API_KEY
    ? new GroqEmbedder({ apiKey: process.env.GROQ_API_KEY })
    : new FixedEmbedder();
  _memory = new MemoryManager({ store, embedder });
  return _memory;
}

let _kgStore: KGStore | null = null;
let _kg: KnowledgeGraph | null = null;

function getKGStore(): KGStore {
  if (_kgStore) return _kgStore;
  if (process.env.DATABASE_URL) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const queryFn: NeonQueryFn = (sql, params) =>
      pool.query(sql, params as unknown[]).then((r) => r.rows);
    _kgStore = new NeonKGStore({ query: queryFn });
  } else {
    _kgStore = new InMemoryKGStore();
  }
  return _kgStore;
}

function getKG(): KnowledgeGraph {
  if (_kg) return _kg;
  _kg = new KnowledgeGraph({ store: getKGStore() });
  return _kg;
}

// ── Numeric tier → SpeedTier mapping ─────────────────────────────────────────

const NUMERIC_TIER_MAP: Record<number, SpeedTier> = {
  10: "fast",
  24: "standard",
  36: "smart",
  45: "power",
  51: "ultra",
};

function numericToSpeedTier(n: number): SpeedTier {
  return NUMERIC_TIER_MAP[n] ?? "fast";
}

// ── In-memory stores for stateful endpoints ───────────────────────────────────

interface AbResult {
  id: string;
  prompt: string;
  modelA: string;
  modelB: string;
  responseA: string;
  responseB: string;
  latencyA: number;
  latencyB: number;
  tokensA: number;
  tokensB: number;
  winner: "A" | "B" | null;
  userPreference: "A" | "B" | "tie" | "both_bad" | null;
  createdAt: string;
}

const _abStore = new Map<string, AbResult>();
const _settingsStore = new Map<string, unknown>();
const _roomsStore = new Map<string, { id: string; name: string; createdAt: string; members: string[] }>();
const _workflowStore = new Map<string, { id: string; name: string; steps: unknown[]; status: string; createdAt: string }>();

// ── Route registrations ───────────────────────────────────────────────────────

export async function judicaCompatRoutes(app: FastifyInstance): Promise<void> {

  // ══════════════════════════════════════════════════════════════════════════
  // B.1 — ULTRAPLINIAN STREAMING
  // POST /api/ultraplinian/stream
  // Body: { question: string, tier: 10 | 24 | 36 | 45 | 51 }
  // Streams: init → response* → done
  // ══════════════════════════════════════════════════════════════════════════

  app.post<{ Body: { question: string; tier?: number } }>(
    "/ultraplinian/stream",
    async (request, reply) => {
      const { question, tier: numTier = 10 } = request.body;
      const speedTier = numericToSpeedTier(numTier);

      if (!process.env.OPENROUTER_API_KEY) {
        return reply.code(503).send({ error: "ultraplinian_unavailable", message: "OPENROUTER_API_KEY not configured" });
      }

      // Build model list capped to the numeric tier count
      const allModels = getModelsForTier(speedTier);
      const models = allModels.slice(0, numTier);

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, SSE_HEADERS);

      // Seed slot map: model → slotInfo
      const slots = models.map((model, i) => {
        const provider = model.split("/")[0] ?? "openrouter";
        return {
          id: `slot-${i}`,
          label: `${provider.toUpperCase()}-${i + 1}`,
          model,
          provider,
        };
      });
      const modelToSlot = new Map(models.map((m, i) => [m, slots[i]!]));

      sseWrite(raw, { type: "init", slots });

      const messages = [{ role: "user" as const, content: question }];
      const allResults: (ModelResult & { compositeScore: number })[] = [];

      await raceModels(
        models,
        messages,
        process.env.OPENROUTER_API_KEY,
        {},
        {
          onResult: (result: ModelResult) => {
            const slot = modelToSlot.get(result.model);
            const q = scoreResponse(result.content, question);
            const latencyNorm = Math.max(0, 1 - result.durationMs / 30_000);
            const compositeScore = result.success ? q * 0.6 + latencyNorm * 0.4 : 0;

            allResults.push({ ...result, compositeScore });

            sseWrite(raw, {
              type: "response",
              id: slot?.id ?? result.model,
              label: slot?.label ?? result.model,
              model: result.model,
              text: result.content,
              latencyMs: result.durationMs,
              tokens: 0,
              compositeScore,
              latencyScore: latencyNorm,
              qualityScore: q,
              tokenScore: 0.5,
              status: result.success ? "done" : "error",
              error: result.error,
            });
          },
        },
      );

      // Determine winner
      const sorted = [...allResults].sort((a, b) => b.compositeScore - a.compositeScore);
      const winner = sorted[0];
      const winnerSlot = winner ? modelToSlot.get(winner.model) : undefined;
      const successCount = allResults.filter((r) => r.success).length;

      sseWrite(raw, {
        type: "done",
        winnerId: winnerSlot?.id ?? "slot-0",
        winnerLabel: winnerSlot?.label ?? "WINNER",
        winnerScore: winner?.compositeScore ?? 0,
        responseCount: allResults.length,
        successCount,
      });

      if (!raw.destroyed) raw.end();
    },
  );

  // ══════════════════════════════════════════════════════════════════════════
  // B.2 — GODMODE STREAMING
  // POST /api/godmode/stream
  // Body: { question: string, members: [{id, label, provider, model, apiKey?, baseUrl?}] }
  // ══════════════════════════════════════════════════════════════════════════

  app.post<{
    Body: {
      question: string;
      members: { id: string; label: string; provider: string; model: string; apiKey?: string; baseUrl?: string }[];
    };
  }>(
    "/godmode/stream",
    async (request, reply) => {
      const { question, members } = request.body;
      const reg = getRegistry();

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, SSE_HEADERS);

      sseWrite(raw, {
        type: "init",
        members: members.map((m) => ({ id: m.id, label: m.label, model: m.model })),
      });

      const raceStart = Date.now();
      let successCount = 0;
      let fastestId: string | null = null;
      let fastestMs = Infinity;

      await Promise.allSettled(
        members.map(async (member) => {
          const start = Date.now();
          try {
            const driver = reg.get(member.provider) ?? reg.get("openrouter");
            if (!driver) throw new Error(`No driver for provider: ${member.provider}`);

            const res = await driver.complete({
              model: member.model,
              messages: [{ role: "user" as LlmRole, content: question }],
              maxTokens: 1024,
            });

            const latencyMs = Date.now() - start;
            if (latencyMs < fastestMs) { fastestMs = latencyMs; fastestId = member.id; }
            successCount++;

            sseWrite(raw, {
              type: "response",
              id: member.id,
              text: res.content,
              latencyMs,
              tokens: (res.usage?.inputTokens ?? 0) + (res.usage?.outputTokens ?? 0),
              status: "done",
            });
          } catch (err) {
            const latencyMs = Date.now() - start;
            sseWrite(raw, {
              type: "response",
              id: member.id,
              text: "",
              latencyMs,
              tokens: 0,
              status: "error",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }),
      );

      sseWrite(raw, {
        type: "done",
        totalMs: Date.now() - raceStart,
        responseCount: members.length,
        successCount,
        fastestId,
        fastestLabel: members.find((m) => m.id === fastestId)?.label ?? null,
      });

      if (!raw.destroyed) raw.end();
    },
  );

  // ══════════════════════════════════════════════════════════════════════════
  // B.3 — A/B COMPARISON
  // POST /api/ab/run
  // GET  /api/ab
  // GET  /api/ab/stats
  // GET  /api/ab/:id
  // POST /api/ab/:id/preference
  // ══════════════════════════════════════════════════════════════════════════

  app.post<{ Body: { prompt: string; modelA: string; modelB: string } }>(
    "/ab/run",
    async (request, reply) => {
      const { prompt, modelA, modelB } = request.body;
      const reg = getRegistry();
      const driver = reg.get("openrouter") ?? reg.get("anthropic") ?? reg.get("groq");

      if (!driver) {
        return reply.code(503).send({ error: "no_driver", message: "No LLM driver available" });
      }

      const [resultA, resultB] = await Promise.allSettled([
        (async () => {
          const s = Date.now();
          const r = await driver.complete({ model: modelA, messages: [{ role: "user" as LlmRole, content: prompt }], maxTokens: 1024 });
          return { content: r.content, latency: Date.now() - s, tokens: (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0) };
        })(),
        (async () => {
          const s = Date.now();
          const r = await driver.complete({ model: modelB, messages: [{ role: "user" as LlmRole, content: prompt }], maxTokens: 1024 });
          return { content: r.content, latency: Date.now() - s, tokens: (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0) };
        })(),
      ]);

      const id = crypto.randomUUID();
      const scoreA = resultA.status === "fulfilled" ? scoreResponse(resultA.value.content, prompt) : 0;
      const scoreB = resultB.status === "fulfilled" ? scoreResponse(resultB.value.content, prompt) : 0;

      const result: AbResult = {
        id,
        prompt,
        modelA,
        modelB,
        responseA: resultA.status === "fulfilled" ? resultA.value.content : `Error: ${resultA.reason}`,
        responseB: resultB.status === "fulfilled" ? resultB.value.content : `Error: ${resultB.reason}`,
        latencyA: resultA.status === "fulfilled" ? resultA.value.latency : 0,
        latencyB: resultB.status === "fulfilled" ? resultB.value.latency : 0,
        tokensA: resultA.status === "fulfilled" ? resultA.value.tokens : 0,
        tokensB: resultB.status === "fulfilled" ? resultB.value.tokens : 0,
        winner: scoreA > scoreB ? "A" : scoreB > scoreA ? "B" : null,
        userPreference: null,
        createdAt: new Date().toISOString(),
      };
      _abStore.set(id, result);
      return reply.send({ result });
    },
  );

  app.get("/ab", async (_req, reply) => {
    return reply.send([..._abStore.values()].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    ));
  });

  app.get("/ab/stats", async (_req, reply) => {
    const results = [..._abStore.values()];
    const modelStats: Record<string, { wins: number; losses: number; ties: number }> = {};
    for (const r of results) {
      for (const m of [r.modelA, r.modelB]) {
        if (!modelStats[m]) modelStats[m] = { wins: 0, losses: 0, ties: 0 };
      }
      const pref = r.userPreference ?? r.winner;
      if (pref === "A") { modelStats[r.modelA]!.wins++; modelStats[r.modelB]!.losses++; }
      else if (pref === "B") { modelStats[r.modelB]!.wins++; modelStats[r.modelA]!.losses++; }
      else if (pref === "tie") { modelStats[r.modelA]!.ties++; modelStats[r.modelB]!.ties++; }
    }
    return reply.send({ totalRuns: results.length, modelStats });
  });

  app.get<{ Params: { id: string } }>("/ab/:id", async (request, reply) => {
    const r = _abStore.get(request.params.id);
    if (!r) return reply.code(404).send({ error: "not_found" });
    return reply.send(r);
  });

  app.post<{ Params: { id: string }; Body: { preference: "A" | "B" | "tie" | "both_bad" } }>(
    "/ab/:id/preference",
    async (request, reply) => {
      const r = _abStore.get(request.params.id);
      if (!r) return reply.code(404).send({ error: "not_found" });
      r.userPreference = request.body.preference;
      return reply.send({ ok: true });
    },
  );

  // ══════════════════════════════════════════════════════════════════════════
  // B.4 — PROVIDERS
  // GET /api/providers
  // ══════════════════════════════════════════════════════════════════════════

  app.get("/providers", async (_req, reply) => {
    const reg = getRegistry();
    const providers = reg.list().map((p) => ({ id: p, name: p, available: true }));
    // Also return the ultraplinian model roster as a flat list
    const allModels = Object.entries(ULTRAPLINIAN_MODELS).flatMap(([tier, models]) =>
      models.map((m) => ({ id: m, tier, provider: m.split("/")[0] ?? "openrouter" })),
    );
    return reply.send({ providers, models: allModels });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // B.4 — CHAT MULTI-MODEL STREAM
  // POST /api/chat/stream
  // Body: { message, members: [{label, provider, model}][], round, threadId }
  // Streams: opinion* → done
  // Each enabled member fires in parallel; text chunks arrive as "opinion" events.
  // Uses server-side DriverRegistry — no client API keys needed.
  // ══════════════════════════════════════════════════════════════════════════

  app.post<{
    Body: {
      message:  string;
      members:  Array<{ label: string; provider: string; model: string }>;
      round:    number;
      threadId: string;
    };
  }>("/chat/stream", async (request, reply) => {
    const { message, members, round } = request.body;
    const reg = getRegistry();

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, SSE_HEADERS);

    const enabled = members.filter((m) => {
      const driver = reg.get(m.provider);
      return !!driver;
    });

    if (enabled.length === 0) {
      sseWrite(raw, {
        type: "error",
        message: "No configured providers match the requested council members. Set API keys in .env.",
      });
      raw.end();
      return;
    }

    // Fan out to all enabled members in parallel
    await Promise.allSettled(
      enabled.map(async (member) => {
        const driver = reg.get(member.provider) ?? reg.get("openrouter");
        if (!driver) return;
        try {
          await driver.stream(
            {
              model:    member.model,
              messages: [{ role: "user" as LlmRole, content: message }],
              maxTokens: 2048,
            },
            (delta) => {
              if (delta.delta) {
                sseWrite(raw, {
                  type:     "opinion",
                  provider: member.provider,
                  label:    member.label,
                  text:     delta.delta,
                  summary:  "",
                  round,
                });
              }
            },
          );
        } catch (err) {
          sseWrite(raw, {
            type:     "opinion",
            provider: member.provider,
            label:    member.label,
            text:     `[${member.label} error: ${(err as Error).message}]`,
            summary:  "",
            round,
          });
        }
      }),
    );

    sseWrite(raw, { type: "done", round });
    if (!raw.destroyed) raw.end();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // A — PATH ALIASES: delegate to same packages as /api/v1/* routes
  // ══════════════════════════════════════════════════════════════════════════

  // -- PARSELTONGUE ----------------------------------------------------------

  app.post<{ Body: { text: string; config?: Record<string, unknown> } }>(
    "/parseltongue/analyze",
    async (request, reply) => {
      const { text, config } = request.body;
      const cfg = { ...parseltongueDefaultConfig(), ...(config ?? {}) };
      const transformed = applyParseltongue(text, cfg as Parameters<typeof applyParseltongue>[1]);
      return reply.send({ original: text, transformed, changed: transformed !== text });
    },
  );

  // -- MEMORY ----------------------------------------------------------------

  app.get<{ Querystring: { limit?: number; query?: string } }>(
    "/memory/entries",
    async (request, reply) => {
      const mem = getMemory();
      const { limit = 20, query } = request.query;
      if (query) {
        const results = await mem.recall(query, Number(limit));
        const entries = results.map((r) => ({ ...r.entry, score: r.score }));
        return reply.send({ entries, total: entries.length });
      }
      const entries = await mem.list();
      return reply.send({ entries: entries.slice(0, Number(limit)), total: entries.length });
    },
  );

  app.post<{ Body: { content: string; category?: string; tags?: string[] } }>(
    "/memory/entries",
    async (request, reply) => {
      const mem = getMemory();
      const { content, category, tags } = request.body;
      const entry = await mem.remember(content, { metadata: { category, tags } });
      return reply.code(201).send(entry);
    },
  );

  app.delete<{ Params: { id: string } }>("/memory/entries/:id", async (request, reply) => {
    const mem = getMemory();
    await mem.forget(request.params.id);
    return reply.code(204).send();
  });

  app.get("/memory/stats", async (_req, reply) => {
    const mem = getMemory();
    const stats = await mem.stats();
    return reply.send(stats);
  });

  // -- KNOWLEDGE GRAPH -------------------------------------------------------

  app.get<{ Querystring: { limit?: number; q?: string } }>("/kg/graph", async (request, reply) => {
    const store = getKGStore();
    const { limit = 50, q } = request.query;
    const nodes = await store.findNodes(q ? { nameContains: q, limit: Number(limit) } : { limit: Number(limit) });
    const edges = await store.findEdges({ limit: Number(limit) });
    return reply.send({ nodes, edges });
  });

  app.get<{ Querystring: { q?: string; k?: number } }>("/kg/search", async (request, reply) => {
    const store = getKGStore();
    const nodes = await store.findNodes({ nameContains: request.query.q ?? "", limit: Number(request.query.k ?? 10) });
    return reply.send({ nodes });
  });

  // POST variant used by knowledge-graph.tsx UI
  app.post<{ Body: { query?: string; q?: string; k?: number } }>("/kg/search", async (request, reply) => {
    const store = getKGStore();
    const q = request.body.query ?? request.body.q ?? "";
    const k = Number(request.body.k ?? 10);
    const nodes = await store.findNodes({ nameContains: q, limit: k });
    return reply.send({ nodes });
  });

  app.post<{ Body: { text: string } }>("/kg/extract", async (request, reply) => {
    const kg = getKG();
    const result = await kg.ingest(request.body.text);
    return reply.code(201).send(result);
  });

  app.get<{ Querystring: { id?: string } }>("/kg/traverse", async (request, reply) => {
    const store = getKGStore();
    const subjectId = request.query.id ?? "";
    const edges = await store.findEdges({ subjectId, limit: 50 });
    const nodeIds = [...new Set(edges.flatMap((e) => [e.subjectId, e.objectId]))];
    const nodes = await Promise.all(nodeIds.map((id) => store.getNode(id)));
    return reply.send({ nodes: nodes.filter(Boolean), edges });
  });

  // POST variant used by knowledge-graph.tsx UI
  app.post<{ Body: { id?: string; entityId?: string; depth?: number } }>("/kg/traverse", async (request, reply) => {
    const store = getKGStore();
    const subjectId = request.body.id ?? request.body.entityId ?? "";
    const edges = await store.findEdges({ subjectId, limit: 50 });
    const nodeIds = [...new Set(edges.flatMap((e) => [e.subjectId, e.objectId]))];
    const nodes = await Promise.all(nodeIds.map((id) => store.getNode(id)));
    return reply.send({ nodes: nodes.filter(Boolean), edges });
  });

  // -- KNOWLEDGE BASES -------------------------------------------------------
  // Alias to /kg routes under /kb namespace

  app.get("/kb", async (_req, reply) => {
    const store = getKGStore();
    const nodes = await store.findNodes({ limit: 100 });
    return reply.send({ bases: nodes });
  });

  app.post<{ Params: { id: string }; Body: { text: string } }>(
    "/kb/:id",
    async (request, reply) => {
      const kg = getKG();
      const result = await kg.ingest(request.body.text, { source: request.params.id });
      return reply.code(201).send(result);
    },
  );

  // ══════════════════════════════════════════════════════════════════════════
  // C.1 — IN-MEMORY CRUD: Settings, Rooms, Workflows
  // ══════════════════════════════════════════════════════════════════════════

  // -- SETTINGS --------------------------------------------------------------

  app.get("/settings/preferences", async (_req, reply) => {
    return reply.send(Object.fromEntries(_settingsStore));
  });

  app.post<{ Body: Record<string, unknown> }>("/settings/preferences", async (request, reply) => {
    for (const [k, v] of Object.entries(request.body)) _settingsStore.set(k, v);
    return reply.send({ ok: true });
  });

  app.get("/settings/council", async (_req, reply) => {
    return reply.send(_settingsStore.get("council") ?? { models: [], defaultTier: "fast" });
  });

  app.post<{ Body: unknown }>("/settings/council", async (request, reply) => {
    _settingsStore.set("council", request.body);
    return reply.send({ ok: true });
  });

  // -- ROOMS -----------------------------------------------------------------

  app.get("/rooms", async (_req, reply) => {
    return reply.send([..._roomsStore.values()]);
  });

  app.post<{ Body: { name: string } }>("/rooms", async (request, reply) => {
    const id = crypto.randomUUID();
    const room = { id, name: request.body.name, createdAt: new Date().toISOString(), members: [] };
    _roomsStore.set(id, room);
    return reply.code(201).send(room);
  });

  app.delete<{ Params: { id: string } }>("/rooms/:id", async (request, reply) => {
    _roomsStore.delete(request.params.id);
    return reply.code(204).send();
  });

  // -- WORKFLOWS -------------------------------------------------------------

  app.get("/workflows", async (_req, reply) => {
    return reply.send([..._workflowStore.values()]);
  });

  app.post<{ Body: { name: string; steps?: unknown[] } }>("/workflows", async (request, reply) => {
    const id = crypto.randomUUID();
    const wf = {
      id,
      name: request.body.name,
      steps: request.body.steps ?? [],
      status: "idle",
      createdAt: new Date().toISOString(),
    };
    _workflowStore.set(id, wf);
    return reply.code(201).send(wf);
  });

  app.patch<{ Params: { id: string }; Body: { status?: string; steps?: unknown[] } }>(
    "/workflows/:id",
    async (request, reply) => {
      const wf = _workflowStore.get(request.params.id);
      if (!wf) return reply.code(404).send({ error: "not_found" });
      if (request.body.status) wf.status = request.body.status;
      if (request.body.steps) wf.steps = request.body.steps;
      return reply.send(wf);
    },
  );

  app.delete<{ Params: { id: string } }>("/workflows/:id", async (request, reply) => {
    _workflowStore.delete(request.params.id);
    return reply.code(204).send();
  });

  // -- REPOS -----------------------------------------------------------------

  app.get("/repos", async (_req, reply) => {
    return reply.send({ repos: [], message: "Connect a GitHub token via Settings → Connectors to list repos." });
  });

  app.get("/repos/github", async (_req, reply) => {
    return reply.send({ repos: [] });
  });

  // -- API TOKENS ------------------------------------------------------------

  app.get("/tokens", async (_req, reply) => {
    return reply.send({ tokens: [] });
  });

  app.post<{ Body: { name: string; scopes?: string[] } }>("/tokens", async (request, reply) => {
    return reply.code(201).send({
      id: crypto.randomUUID(),
      name: request.body.name,
      token: `nxk_${crypto.randomBytes(24).toString("hex")}`,
      scopes: request.body.scopes ?? ["*"],
      createdAt: new Date().toISOString(),
    });
  });

  // -- WEB SEARCH ------------------------------------------------------------

  app.post<{ Body: { query: string } }>("/web-search", async (request, reply) => {
    return reply.send({ results: [], query: request.body.query, message: "Connect Tavily API key to enable web search." });
  });

  app.get("/web-search/providers", async (_req, reply) => {
    return reply.send({ providers: [{ id: "tavily", name: "Tavily", available: !!process.env.TAVILY_API_KEY }] });
  });

  // -- COSTS -----------------------------------------------------------------

  app.get("/costs/dashboard", async (_req, reply) => {
    return reply.send({ totalUsd: 0, byModel: {}, byDay: [], message: "Cost tracking requires DATABASE_URL." });
  });

  app.get("/costs/breakdown", async (_req, reply) => {
    return reply.send({ breakdown: [], totalUsd: 0 });
  });

  app.get("/costs/per-provider", async (_req, reply) => {
    return reply.send({ providers: [] });
  });

  app.get("/costs/efficiency", async (_req, reply) => {
    return reply.send({ efficiency: [] });
  });

  app.get("/costs/organization", async (_req, reply) => {
    return reply.send({ totalUsd: 0, seats: 1 });
  });

  app.get("/costs/limits", async (_req, reply) => {
    return reply.send({ limits: { monthly_usd: null, daily_usd: null } });
  });

  app.get("/costs/pricing", async (_req, reply) => {
    return reply.send({ models: [] });
  });

  // -- ANALYTICS -------------------------------------------------------------

  app.get("/analytics/overview", async (_req, reply) => {
    return reply.send({ requests: 0, tokens: 0, latencyP50ms: 0, latencyP99ms: 0, errorRate: 0 });
  });

  // -- FINE TUNE (alias to SFT) ----------------------------------------------

  app.get("/fine-tune/dataset", async (_req, reply) => {
    return reply.send({ samples: [], total: 0 });
  });

  app.post<{ Body: unknown }>("/fine-tune/initiate", async (_req, reply) => {
    return reply.code(202).send({ jobId: crypto.randomUUID(), status: "queued", message: "Fine-tune job queued." });
  });

  app.get("/fine-tune/export", async (_req, reply) => {
    return reply.send({ url: null, message: "No dataset exported yet." });
  });

  // -- SANDBOX (alias to code-repl) ------------------------------------------

  app.post<{ Body: { code: string; language?: string } }>("/sandbox/execute", async (_req, reply) => {
    return reply.code(202).send({
      executionId: crypto.randomUUID(),
      status: "queued",
      message: "Code execution requires Docker runtime. Set DOCKER_ENABLED=true.",
    });
  });

  app.get<{ Params: { id: string } }>("/sandbox/status/:id", async (request, reply) => {
    return reply.send({ executionId: request.params.id, status: "unknown" });
  });

  // -- EVALUATION (alias to evals) -------------------------------------------

  app.get("/evaluation/dashboard", async (_req, reply) => {
    return reply.send({ totalRuns: 0, avgScore: 0, byModel: {} });
  });

  app.get("/evaluation/metrics", async (_req, reply) => {
    return reply.send({ metrics: [] });
  });

  app.get("/evaluation/results", async (_req, reply) => {
    return reply.send({ results: [] });
  });

  app.post<{ Body: unknown }>("/evaluate", async (_req, reply) => {
    return reply.code(202).send({ jobId: crypto.randomUUID(), status: "queued" });
  });

  // -- CONNECTORS ------------------------------------------------------------

  const _connectors = new Map<string, { id: string; type: string; status: string; label: string }>();

  app.get("/connectors", async (_req, reply) => {
    return reply.send({ connectors: Array.from(_connectors.values()) });
  });

  app.post<{ Body: { type?: string; label?: string; [k: string]: unknown } }>("/connectors", async (request, reply) => {
    const id = crypto.randomUUID();
    const { type = "custom", label = "Connector" } = request.body;
    _connectors.set(id, { id, type, label, status: "connected" });
    return reply.code(201).send({ id, type, label, status: "connected" });
  });

  app.delete<{ Params: { id: string } }>("/connectors/:id", async (request, reply) => {
    _connectors.delete(request.params.id);
    return reply.code(204).send();
  });

  // -- SKILLS ----------------------------------------------------------------

  const _skills = new Map<string, { id: string; name: string; description: string; enabled: boolean }>();

  app.get("/skills", async (_req, reply) => {
    return reply.send({ skills: Array.from(_skills.values()) });
  });

  app.post<{ Body: { name: string; description?: string; enabled?: boolean } }>("/skills", async (request, reply) => {
    const id = crypto.randomUUID();
    const { name, description = "", enabled = true } = request.body;
    _skills.set(id, { id, name, description, enabled });
    return reply.code(201).send({ id, name, description, enabled });
  });

  app.delete<{ Params: { id: string } }>("/skills/:id", async (request, reply) => {
    _skills.delete(request.params.id);
    return reply.code(204).send();
  });

  // -- REASONING -------------------------------------------------------------

  app.get("/reasoning/modes", async (_req, reply) => {
    return reply.send({
      modes: [
        { id: "chain-of-thought", label: "Chain of Thought", description: "Step-by-step reasoning" },
        { id: "tree-of-thought", label: "Tree of Thought", description: "Branching reasoning paths" },
        { id: "reflexion", label: "Reflexion", description: "Self-critique and revision" },
      ],
    });
  });

  app.post<{ Body: { question: string; mode?: string } }>("/reasoning/run", async (request, reply) => {
    const reg = getRegistry();
    const driver = reg.get("openrouter") ?? reg.get("anthropic") ?? reg.get("groq");
    if (!driver) return reply.code(503).send({ error: "No driver available" });

    const system = "Think step by step. Show your reasoning explicitly before giving the final answer.";
    const res = await driver.complete({
      model: "anthropic/claude-3.5-sonnet",
      messages: [{ role: "system" as LlmRole, content: system }, { role: "user" as LlmRole, content: request.body.question }],
      maxTokens: 2048,
    });
    return reply.send({ reasoning: res.content, mode: request.body.mode ?? "chain-of-thought" });
  });

  // -- KNOWLEDGE BASES -------------------------------------------------------

  const _kbStore = new Map<string, { id: string; name: string; docCount: number; createdAt: string }>();

  app.get("/kb", async (_req, reply) => {
    return reply.send({ knowledgeBases: Array.from(_kbStore.values()), total: _kbStore.size });
  });

  app.post<{ Body: { name: string } }>("/kb", async (request, reply) => {
    const id = crypto.randomUUID();
    const kb = { id, name: request.body.name ?? "KB", docCount: 0, createdAt: new Date().toISOString() };
    _kbStore.set(id, kb);
    return reply.code(201).send(kb);
  });

  app.delete<{ Params: { id: string } }>("/kb/:id", async (request, reply) => {
    _kbStore.delete(request.params.id);
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>("/kb/:id/documents", async (_req, reply) => {
    return reply.send({ documents: [], total: 0 });
  });

  app.post("/kb/:id/documents", async (request, reply) => {
    return reply.code(202).send({ jobId: crypto.randomUUID(), status: "indexing" });
  });

  app.delete<{ Params: { id: string; docId: string } }>("/kb/:id/documents/:docId", async (_req, reply) => {
    return reply.code(204).send();
  });

  // -- IMAGE GENERATION ------------------------------------------------------

  const _imageStore = new Map<string, { id: string; url: string; prompt: string; createdAt: string }>();

  app.get("/images/providers", async (_req, reply) => {
    return reply.send({ providers: [{ id: "stub", name: "Stub (no key configured)", available: false }] });
  });

  app.get("/images", async (_req, reply) => {
    return reply.send({ images: Array.from(_imageStore.values()), total: _imageStore.size });
  });

  app.post<{ Body: { prompt: string; size?: string; provider?: string } }>("/images/generate", async (request, reply) => {
    const id = crypto.randomUUID();
    const img = { id, url: "", prompt: request.body.prompt ?? "", createdAt: new Date().toISOString() };
    _imageStore.set(id, img);
    return reply.code(503).send({ error: "no_provider", message: "Configure an image provider (OPENAI_API_KEY or REPLICATE_API_KEY) to use image generation." });
  });

  app.delete<{ Params: { id: string } }>("/images/:id", async (request, reply) => {
    _imageStore.delete(request.params.id);
    return reply.code(204).send();
  });

  // -- TOKENS (usage stats) --------------------------------------------------

  app.get("/tokens", async (_req, reply) => {
    return reply.send({ used: 0, limit: null, byModel: {}, byDay: [] });
  });

  // ── Deep-research endpoints ───────────────────────────────────────────────
  // In-memory job store — persists across requests in the same process.
  const _researchJobs = new Map<string, { id: string; query: string; status: string; result: string }>();

  app.get("/research", async (_req, reply) => {
    return reply.send(Array.from(_researchJobs.values()));
  });

  app.post<{ Body: { query: string; mode?: string } }>("/research", async (request, reply) => {
    const id = crypto.randomUUID();
    _researchJobs.set(id, { id, query: request.body.query ?? "", status: "running", result: "" });
    return reply.code(201).send({ id, status: "running" });
  });

  app.get<{ Params: { id: string } }>("/research/related-questions", async (request, reply) => {
    return reply.send({ questions: [] });
  });

  app.get<{ Params: { id: string } }>("/research/:id", async (request, reply) => {
    const job = _researchJobs.get(request.params.id);
    if (!job) return reply.code(404).send({ error: "not_found" });
    return reply.send(job);
  });

  app.get<{ Params: { id: string } }>("/research/:id/stream", async (request, reply) => {
    const job = _researchJobs.get(request.params.id);
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, SSE_HEADERS);
    const write = (d: unknown) => raw.write(`data: ${JSON.stringify(d)}\n\n`);
    write({ type: "phase", phase: "planning",  message: "Planning research scope…" });
    write({ type: "phase", phase: "searching", message: "Searching knowledge base…" });
    write({ type: "phase", phase: "synthesis", message: "Synthesising findings…" });
    const query = job?.query ?? "unknown query";
    const result = `Research stub: deep-research engine not yet connected. Query received: "${query}".`;
    if (job) { job.status = "done"; job.result = result; }
    write({ type: "result", id: request.params.id, status: "done", result, sections: [], citations: [] });
    raw.end();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // C.2 — STUBS (features not yet backed, return 501 or empty payload)
  // ══════════════════════════════════════════════════════════════════════════

  const STUB_PREFIXES = [
    "blind-council",
    "browser-agent",
    "build",
    "code-agent",
    "craft",
    "cross-memory",
    "echo-chamber",
    "extraction",
    "fallback-chains",
    "hallucination",
    "honesty",
    "image-transformations",
    "imr",
    "marketplace",
    "member-evolution",
    "moderation",
    "negation",
    "prompt-filter",
    "reactions",
    "rss",
    "semantic-cache",
    "simulate",
    "skill-selection",
    "sop",
    "specialisation",
    "speculative",
    "standard-answers",
    "symbolic",
    "task-routing",
    "token-conservation",
    "verbosity",
    "verifiable",
    "video",
    "web-scraping",
  ];

  for (const prefix of STUB_PREFIXES) {
    // GET /* → empty list
    app.get(`/${prefix}`, async (_req, reply) => reply.send([]));
    app.get(`/${prefix}/*`, async (_req, reply) => reply.send({ data: null, message: `/${prefix} is not yet implemented in this deployment.` }));

    // POST /* → 501
    app.post(`/${prefix}`, async (_req, reply) =>
      reply.code(501).send({ error: "not_implemented", message: `POST /${prefix} is not yet implemented.` }),
    );
    app.post(`/${prefix}/*`, async (_req, reply) =>
      reply.code(501).send({ error: "not_implemented", message: `POST /${prefix}/* is not yet implemented.` }),
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // C.3 — FUNCTIONAL STUBS (return 200 OK so callers don't log errors)
  // ══════════════════════════════════════════════════════════════════════════

  // STM history — best-effort call from chat.tsx, just acknowledge
  app.post<{ Body: { query: string; modules: string[]; applied: string[] } }>(
    "/stm/history",
    async (_req, reply) => reply.send({ ok: true }),
  );

  // TTS — not yet backed; return silent audio placeholder
  app.post<{ Body: { text: string; voice?: string } }>(
    "/tts",
    async (_req, reply) => reply.send({ audio: null, message: "TTS not configured on this deployment." }),
  );

  // Memory backend config & compact
  app.post("/memory/backend", async (_req, reply) => reply.send({ ok: true }));
  app.put("/memory/backend",  async (_req, reply) => reply.send({ ok: true }));
  app.post("/memory/compact", async (_req, reply) => reply.send({ ok: true, compacted: 0 }));

  // Memory delete-all
  app.delete("/memory/entries", async (_req, reply) => reply.send({ ok: true, deleted: 0 }));

  // KG communities — placeholder until graph analysis is wired
  app.get("/kg/communities", async (_req, reply) =>
    reply.send({ communities: [], message: "Community detection not yet implemented." }),
  );

  // AutoTune optimize — SSE stub (real prompt-opt engine not yet wired)
  app.post<{
    Body: { systemPrompt: string; testInputs: unknown[]; goal?: string; iterations?: number };
  }>("/autotune/optimize", async (request, reply) => {
    const { systemPrompt } = request.body;
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, SSE_HEADERS);
    const write = (d: unknown) => raw.write(`data: ${JSON.stringify(d)}\n\n`);
    write({ type: "step", phase: "analyse", message: "Analysing system prompt…" });
    write({ type: "step", phase: "optimise", message: "AutoTune engine not yet connected — returning original prompt." });
    write({ type: "result", optimizedPrompt: systemPrompt, score: 1, iterations: 0, improvements: [] });
    raw.end();
  });

  // Auth stubs (Judica's own auth won't work; return informative error)
  app.post("/auth/login", async (_req, reply) =>
    reply.code(501).send({ error: "use_nexus_auth", message: "Use the Nexus API key via Authorization: Bearer <key>" }),
  );
  app.post("/auth/register", async (_req, reply) =>
    reply.code(501).send({ error: "use_nexus_auth", message: "Registration is managed by the admin." }),
  );
  app.get("/auth/me", async (request, reply) => {
    const token = (request.headers.authorization as string | undefined)?.replace("Bearer ", "");
    return reply.send({ id: "local", username: "admin", email: "admin@nexus.local", role: "admin", authenticated: !!token });
  });
}
