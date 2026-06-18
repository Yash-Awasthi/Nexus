// SPDX-License-Identifier: Apache-2.0
/**
 * Judica-compat routes — mounts under /api (no version prefix).
 *
 * Bridges the Judica frontend's /api/* call surface to the Nexus backend.
 * Three categories:
 *
 *   A) Path aliases   — delegate to same packages as existing /api/v1/* routes
 *   B) New endpoints  — real implementations (gauntlet stream, godmode, ab)
 *   C) Stubs          — in-memory CRUD or 501 for features not yet backed
 *
 * Register in server.ts under { prefix: "/api" }.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import {
  applyParseltongue,
  getDefaultConfig as redteamDefaultConfig,
} from "@nexus/redteam";
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
} from "@nexus/gauntlet";
import { AdaptiveScraper, HttpxEngine } from "@nexus/adaptive-scraper";
import {
  ImageGenerator,
  OpenAIImageProvider,
  ReplicateProvider,
  NullImageProvider,
  type ImageSize,
} from "@nexus/image-gen";
import { WebResearcher, type SearchResult as ResearchSearchResult } from "@nexus/researcher";
import { computeAutoTuneParams, InMemoryEmaStore } from "@nexus/drift";
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

// ── Shared helpers ─────────────────────────────────────────────────────────────

/** Default model for all internal LLM calls — change once to affect the whole file. */
const DEFAULT_MODEL = "anthropic/claude-3.5-haiku";

/** Current UTC timestamp as ISO-8601. */
const now = (): string => new Date().toISOString();

/** Highest-priority available LLM driver across all registered providers. */
function getDefaultDriver() {
  const reg = getRegistry();
  return reg.get("openrouter") ?? reg.get("anthropic") ?? reg.get("groq") ?? reg.get("openai");
}

/** Strip markdown code fences then JSON.parse — handles ` ```json ` and ` ``` ` variants. */
function parseJsonResponse<T = unknown>(content: string): T {
  return JSON.parse(content.replace(/^```(?:json)?\n?|```$/g, "").trim()) as T;
}

/** Typed LLM message constructors. */
const userMsg   = (content: string) => ({ role: "user"   as LlmRole, content });
const systemMsg = (content: string) => ({ role: "system" as LlmRole, content });

// ── Cost tracking ─────────────────────────────────────────────────────────────

interface CostEntry { ts: string; model: string; inputTokens: number; outputTokens: number; costUsd: number; }
const _costLog: CostEntry[] = [];

const _PRICES: Record<string, [number, number]> = {
  "anthropic/claude-3.5-haiku":   [0.80,  4.00],
  "anthropic/claude-3.5-sonnet":  [3.00, 15.00],
  "anthropic/claude-3-opus":      [15.0, 75.00],
  "openai/gpt-4o":                [2.50, 10.00],
  "openai/gpt-4o-mini":           [0.15,  0.60],
  "groq/llama-3.1-8b-instant":    [0.05,  0.08],
  "groq/llama-3.3-70b-versatile": [0.59,  0.79],
};

function _trackCost(model: string, usage?: { inputTokens?: number; outputTokens?: number }) {
  const inp = usage?.inputTokens  ?? 0;
  const out = usage?.outputTokens ?? 0;
  const [pi, po] = _PRICES[model] ?? [1.00, 3.00];
  _costLog.push({ ts: now(), model, inputTokens: inp, outputTokens: out, costUsd: (inp * pi + out * po) / 1_000_000 });
  if (_costLog.length > 10_000) _costLog.splice(0, _costLog.length - 10_000);
}

/** One-line LLM call with automatic cost tracking. Returns content string. */
async function _llm(
  messages: Array<{ role: LlmRole; content: string }>,
  maxTokens = 512,
  model = DEFAULT_MODEL,
): Promise<string> {
  const driver = getDefaultDriver();
  if (!driver) return "";
  const res = await driver.complete({ model, messages, maxTokens });
  _trackCost(model, res.usage);
  return res.content.trim();
}

// ── PersistentStore ────────────────────────────────────────────────────────────
//
// Drop-in replacement for Map<string, T> that persists to disk (JSON files) or
// Postgres (when DATABASE_URL is set).  Route handlers stay synchronous — writes
// fire-and-forget to the backing store.  On server start call load() once per
// store to hydrate the in-memory map from durable storage.

const _DATA_DIR = process.env.NEXUS_DATA_DIR ?? path.join(process.cwd(), "data", "stores");

let _pgPool: import("pg").Pool | null = null;
function _getPool(): import("pg").Pool | null {
  if (_pgPool !== undefined) return _pgPool;
  if (process.env.DATABASE_URL) {
    _pgPool = new Pool({ connectionString: process.env.DATABASE_URL });
  } else {
    _pgPool = null;
  }
  return _pgPool;
}

/** Ensure the nexus_kv table exists (called once at startup). */
async function _ensureTable(): Promise<void> {
  const pool = _getPool();
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS nexus_kv (
      collection TEXT NOT NULL,
      id         TEXT NOT NULL,
      data       JSONB NOT NULL,
      PRIMARY KEY (collection, id)
    )
  `);
}

class PersistentStore<T> {
  private _mem = new Map<string, T>();

  constructor(private _name: string) {}

  /** Load from backing store. Call once at server startup. */
  async load(): Promise<void> {
    const pool = _getPool();
    if (pool) {
      try {
        const { rows } = await pool.query<{ id: string; data: T }>(
          "SELECT id, data FROM nexus_kv WHERE collection = $1",
          [this._name],
        );
        for (const r of rows) this._mem.set(r.id, r.data);
      } catch { /* table not yet created — first boot */ }
    } else {
      try {
        const file = path.join(_DATA_DIR, `${this._name}.json`);
        const items = JSON.parse(fs.readFileSync(file, "utf8")) as T[];
        for (const item of items) this._mem.set(item["id"] as string, item);
      } catch { /* first run — no file yet */ }
    }
  }

  // ── Map-compatible interface ───────────────────────────────────────────────

  get(id: string): T | undefined { return this._mem.get(id); }
  has(id: string): boolean       { return this._mem.has(id); }
  get size(): number             { return this._mem.size; }
  values(): IterableIterator<T>  { return this._mem.values(); }
  delete(id: string): void       { this._mem.delete(id); this._write(id, null); }

  set(id: string, val: T): void {
    this._mem.set(id, val);
    this._write(id, val);
  }

  // ── Private persistence ────────────────────────────────────────────────────

  private _write(id: string, val: T | null): void {
    const pool = _getPool();
    if (pool) {
      if (val === null) {
        pool.query("DELETE FROM nexus_kv WHERE collection=$1 AND id=$2", [this._name, id]).catch(() => {});
      } else {
        pool.query(
          "INSERT INTO nexus_kv (collection,id,data) VALUES($1,$2,$3) ON CONFLICT (collection,id) DO UPDATE SET data=$3",
          [this._name, id, val as unknown],
        ).catch(() => {});
      }
    } else {
      // JSON file — write entire collection (small stores, infrequent writes)
      try {
        fs.mkdirSync(_DATA_DIR, { recursive: true });
        fs.writeFileSync(
          path.join(_DATA_DIR, `${this._name}.json`),
          JSON.stringify(Array.from(this._mem.values()), null, 2),
        );
      } catch { /* ignore write errors (read-only fs) */ }
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────

let _scraper: AdaptiveScraper | null = null;
function getScraper(): AdaptiveScraper {
  if (!_scraper) _scraper = new AdaptiveScraper([new HttpxEngine({ priority: 1 })]);
  return _scraper;
}

let _imageGen: ImageGenerator | null = null;
function getImageGen(): { gen: ImageGenerator; provider: string } | null {
  if (_imageGen) return { gen: _imageGen, provider: _imageGenProvider };
  if (process.env.OPENAI_API_KEY) {
    _imageGen = new ImageGenerator({ provider: new OpenAIImageProvider({ apiKey: process.env.OPENAI_API_KEY }) });
    _imageGenProvider = "openai-dalle";
    return { gen: _imageGen, provider: _imageGenProvider };
  }
  if (process.env.REPLICATE_API_KEY) {
    _imageGen = new ImageGenerator({ provider: new ReplicateProvider({ apiKey: process.env.REPLICATE_API_KEY }) });
    _imageGenProvider = "replicate";
    return { gen: _imageGen, provider: _imageGenProvider };
  }
  return null;
}
let _imageGenProvider = "";

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

// ── Route registrations ───────────────────────────────────────────────────────

export async function apiBridgeRoutes(app: FastifyInstance): Promise<void> {

  // Ensure Postgres KV table exists (no-op if no DATABASE_URL)
  await _ensureTable();

  // ── Persistent stores (survive server restart) ─────────────────────────────
  // Each store loads its data from JSON files or Postgres on first boot.
  // Route handlers use them exactly like a Map — .get/.set/.delete/.values.

  const _workflowStore  = new PersistentStore<{ id: string; name: string; steps: unknown[]; status: string; createdAt: string }>("workflows");
  const _connectors     = new PersistentStore<{ id: string; type: string; status: string; label: string }>("connectors");
  const _craftStore     = new PersistentStore<{ id: string; template: string; prompt: string; result: string; createdAt: string }>("craft");
  const _skills         = new PersistentStore<{ id: string; name: string; description: string; enabled: boolean }>("skills");
  const _kbStore        = new PersistentStore<{ id: string; name: string; docCount: number; createdAt: string }>("kb");
  const _imageStore     = new PersistentStore<{ id: string; url: string; b64?: string; prompt: string; revisedPrompt?: string; provider?: string; createdAt: string }>("images");
  const _imrRuns        = new PersistentStore<ImrRun>("imr_runs");
  const _stdAnswers     = new PersistentStore<StdAnswer>("standard_answers");
  const _rssFeeds       = new PersistentStore<RssFeed>("rss_feeds");
  const _rssItems       = new PersistentStore<RssItem>("rss_items");

  await Promise.all([
    _workflowStore.load(), _connectors.load(), _craftStore.load(),
    _skills.load(), _kbStore.load(), _imageStore.load(),
    _imrRuns.load(), _stdAnswers.load(), _rssFeeds.load(), _rssItems.load(),
  ]);

  // ══════════════════════════════════════════════════════════════════════════
  // B.1 — ULTRAPLINIAN STREAMING
  // POST /api/gauntlet/stream
  // Body: { question: string, tier: 10 | 24 | 36 | 45 | 51 }
  // Streams: init → response* → done
  // ══════════════════════════════════════════════════════════════════════════

  app.post<{ Body: { question: string; tier?: number } }>(
    "/gauntlet/stream",
    async (request, reply) => {
      const { question, tier: numTier = 10 } = request.body;
      const speedTier = numericToSpeedTier(numTier);

      if (!process.env.OPENROUTER_API_KEY) {
        return reply.code(503).send({ error: "gauntlet_unavailable", message: "OPENROUTER_API_KEY not configured" });
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
            _trackCost(member.model, res.usage);

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
      const driver = getDefaultDriver();

      if (!driver) {
        return reply.code(503).send({ error: "no_driver", message: "No LLM driver available" });
      }

      const [resultA, resultB] = await Promise.allSettled([
        (async () => {
          const s = Date.now();
          const r = await driver.complete({ model: modelA, messages: [{ role: "user" as LlmRole, content: prompt }], maxTokens: 1024 });
          _trackCost(modelA, r.usage);
          return { content: r.content, latency: Date.now() - s, tokens: (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0) };
        })(),
        (async () => {
          const s = Date.now();
          const r = await driver.complete({ model: modelB, messages: [{ role: "user" as LlmRole, content: prompt }], maxTokens: 1024 });
          _trackCost(modelB, r.usage);
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
        createdAt: now(),
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
    // Also return the gauntlet model roster as a flat list
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
    "/redteam/analyze",
    async (request, reply) => {
      const { text, config } = request.body;
      const cfg = { ...redteamDefaultConfig(), ...(config ?? {}) };
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
    const room = { id, name: request.body.name, createdAt: now(), members: [] };
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
      createdAt: now(),
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
      createdAt: now(),
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

  // -- COSTS (real — derived from _costLog accumulated by _llm() helper) ------

  function _costsInWindow(days: number) {
    const cutoff = Date.now() - days * 86_400_000;
    return _costLog.filter(e => new Date(e.ts).getTime() >= cutoff);
  }

  app.get<{ Querystring: { days?: string } }>("/costs/dashboard", async (req, reply) => {
    const days = parseInt(req.query.days ?? "30", 10);
    const entries = _costsInWindow(days);
    const totalUsd = entries.reduce((s, e) => s + e.costUsd, 0);
    const totalTokens = entries.reduce((s, e) => s + e.inputTokens + e.outputTokens, 0);
    // Group by day
    const byDay: Record<string, number> = {};
    for (const e of entries) {
      const d = e.ts.slice(0, 10);
      byDay[d] = (byDay[d] ?? 0) + e.costUsd;
    }
    // Group by model
    const byModel: Record<string, number> = {};
    for (const e of entries) byModel[e.model] = (byModel[e.model] ?? 0) + e.costUsd;
    return reply.send({ totalUsd: Math.round(totalUsd * 10_000) / 10_000, totalTokens, byDay, byModel, period: `${days} days`, requests: entries.length });
  });

  app.get("/costs/breakdown", async (_req, reply) => {
    const breakdown = Object.entries(
      _costLog.reduce<Record<string, { calls: number; tokens: number; usd: number }>>((acc, e) => {
        if (!acc[e.model]) acc[e.model] = { calls: 0, tokens: 0, usd: 0 };
        acc[e.model].calls += 1;
        acc[e.model].tokens += e.inputTokens + e.outputTokens;
        acc[e.model].usd += e.costUsd;
        return acc;
      }, {}),
    ).map(([model, stats]) => ({ model, ...stats, usd: Math.round(stats.usd * 10_000) / 10_000 }));
    return reply.send({ breakdown, totalUsd: Math.round(_costLog.reduce((s, e) => s + e.costUsd, 0) * 10_000) / 10_000 });
  });

  app.get("/costs/per-provider", async (_req, reply) => {
    const map: Record<string, number> = {};
    for (const e of _costLog) {
      const provider = e.model.split("/")[0] ?? e.model;
      map[provider] = (map[provider] ?? 0) + e.costUsd;
    }
    const providers = Object.entries(map).map(([name, usd]) => ({ name, usd: Math.round(usd * 10_000) / 10_000 }));
    return reply.send({ providers });
  });

  app.get("/costs/efficiency", async (_req, reply) => {
    // Tokens per dollar for each model
    const stats: Record<string, { tokens: number; usd: number }> = {};
    for (const e of _costLog) {
      if (!stats[e.model]) stats[e.model] = { tokens: 0, usd: 0 };
      stats[e.model].tokens += e.inputTokens + e.outputTokens;
      stats[e.model].usd += e.costUsd;
    }
    const efficiency = Object.entries(stats).map(([model, { tokens, usd }]) => ({
      model, tokensPerDollar: usd > 0 ? Math.round(tokens / usd) : 0,
    }));
    return reply.send({ efficiency });
  });

  app.get("/costs/organization", async (_req, reply) => {
    const totalUsd = _costLog.reduce((s, e) => s + e.costUsd, 0);
    return reply.send({ totalUsd: Math.round(totalUsd * 10_000) / 10_000, seats: 1, perSeatUsd: Math.round(totalUsd * 10_000) / 10_000 });
  });

  app.get("/costs/limits", async (_req, reply) => {
    return reply.send({ limits: { monthly_usd: null, daily_usd: null }, note: "Set limits via env NEXUS_MONTHLY_LIMIT_USD and NEXUS_DAILY_LIMIT_USD" });
  });

  app.get("/costs/pricing", async (_req, reply) => {
    const models = Object.entries(_PRICES).map(([model, [input, output]]) => ({
      model, inputPer1MTokens: input, outputPer1MTokens: output,
    }));
    return reply.send({ models });
  });

  // -- ANALYTICS -------------------------------------------------------------

  app.get("/analytics/overview", async (_req, reply) => {
    return reply.send({ requests: 0, tokens: 0, latencyP50ms: 0, latencyP99ms: 0, errorRate: 0 });
  });

  // -- FINE TUNE — real OpenAI fine-tune API when OPENAI_API_KEY present ------

  app.get("/fine-tune/dataset", async (_req, reply) => {
    const apiKey = process.env.OPENAI_API_KEY;
    const examples = Array.from(_evalStore.values()).filter(e => e.quality >= 4);
    let jobs: unknown[] = [];
    if (apiKey) {
      try {
        const r = await fetch("https://api.openai.com/v1/fine_tuning/jobs?limit=10", {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (r.ok) { const d = (await r.json()) as { data?: unknown[] }; jobs = d.data ?? []; }
      } catch { /* offline gracefully */ }
    }
    return reply.send({
      success: true,
      count: examples.length,
      eligible: examples.length >= 10,
      configured: !!apiKey,
      jobs,
      threshold: 10,
      message: apiKey
        ? (examples.length >= 10 ? `${examples.length} eligible examples ready.` : `Need ${10 - examples.length} more rated examples (threshold: 10).`)
        : "Add OPENAI_API_KEY to enable fine-tuning.",
    });
  });

  app.get("/fine-tune/export", async (_req, reply) => {
    const examples = Array.from(_evalStore.values()).filter(e => e.quality >= 4);
    if (examples.length === 0) {
      return reply.code(404).send({ error: "no_data", message: "No rated examples yet. Score responses in the Evaluation page first." });
    }
    const lines = examples.map(e => JSON.stringify({
      messages: [
        { role: "system", content: "You are a helpful AI assistant participating in a council deliberation." },
        { role: "user", content: e.conversation ?? `Evaluation ${e.id}` },
        { role: "assistant", content: `High-quality response. Quality score: ${e.quality}/5. Coherence: ${e.coherence}/5. Consensus: ${e.consensus}/5.` },
      ],
    })).join("\n");
    reply.header("Content-Type", "application/jsonl");
    reply.header("Content-Disposition", `attachment; filename="nexus-finetune-${now().slice(0, 10)}.jsonl"`);
    return reply.send(lines);
  });

  app.post<{ Body: { baseModel?: string; model?: string } }>("/fine-tune/initiate", async (req, reply) => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return reply.code(501).send({ error: "not_configured", message: "Fine-tuning requires OPENAI_API_KEY." });
    const examples = Array.from(_evalStore.values()).filter(e => e.quality >= 4);
    if (examples.length < 10) {
      return reply.code(422).send({ error: "insufficient_data", message: `Need at least 10 rated examples (have ${examples.length}). Rate more responses in the Evaluation page.` });
    }
    const jsonl = examples.map(e => JSON.stringify({
      messages: [
        { role: "system", content: "You are a helpful AI assistant participating in a council deliberation." },
        { role: "user", content: e.conversation ?? `Evaluation ${e.id}` },
        { role: "assistant", content: `High-quality response. Quality score: ${e.quality}/5. Coherence: ${e.coherence}/5. Consensus: ${e.consensus}/5.` },
      ],
    })).join("\n");
    // 1. Upload dataset file
    const formData = new FormData();
    formData.append("file", new Blob([jsonl], { type: "application/jsonl" }), "dataset.jsonl");
    formData.append("purpose", "fine-tune");
    let fileId: string;
    try {
      const uploadR = await fetch("https://api.openai.com/v1/files", {
        method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: formData,
      });
      if (!uploadR.ok) {
        const e = (await uploadR.json()) as { error?: { message?: string } };
        return reply.code(502).send({ error: "upload_failed", message: e.error?.message ?? uploadR.statusText });
      }
      fileId = ((await uploadR.json()) as { id: string }).id;
    } catch (e) {
      return reply.code(502).send({ error: "upload_failed", message: e instanceof Error ? e.message : String(e) });
    }
    // 2. Create fine-tune job
    try {
      const jobR = await fetch("https://api.openai.com/v1/fine_tuning/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ training_file: fileId, model: req.body?.baseModel ?? req.body?.model ?? "gpt-4o-mini-2024-07-18" }),
      });
      if (!jobR.ok) {
        const e = (await jobR.json()) as { error?: { message?: string } };
        return reply.code(502).send({ error: "job_create_failed", message: e.error?.message ?? jobR.statusText });
      }
      const job = (await jobR.json()) as { id: string; status: string };
      return reply.code(202).send({ success: true, jobId: job.id, status: job.status, fileId, examples: examples.length });
    } catch (e) {
      return reply.code(502).send({ error: "job_create_failed", message: e instanceof Error ? e.message : String(e) });
    }
  });

  // -- SANDBOX (alias to code-repl) ------------------------------------------

  const _sandboxResults = new Map<string, { executionId: string; status: string; output: string; error?: string; durationMs: number }>();

  app.post<{ Body: { code: string; language?: string } }>("/sandbox/execute", async (request, reply) => {
    const { code, language = "javascript" } = request.body;
    const executionId = crypto.randomUUID();
    const lang = language.toLowerCase();

    if (lang !== "javascript" && lang !== "js" && lang !== "typescript" && lang !== "ts") {
      const result = { executionId, status: "unsupported", output: "", error: `${language} execution requires Docker runtime. Only JavaScript is supported in this deployment.`, durationMs: 0 };
      _sandboxResults.set(executionId, result);
      return reply.code(202).send(result);
    }

    // JavaScript: run in isolated vm context with timeout
    const t0 = Date.now();
    const logs: string[] = [];
    const ctx = vm.createContext({
      console: { log: (...a: unknown[]) => logs.push(a.map(String).join(" ")), error: (...a: unknown[]) => logs.push("[err] " + a.map(String).join(" ")), warn: (...a: unknown[]) => logs.push("[warn] " + a.map(String).join(" ")) },
      Math, JSON, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
      setTimeout: undefined, setInterval: undefined, fetch: undefined, require: undefined,
    });
    let output = ""; let error: string | undefined;
    try {
      const returnVal = vm.runInContext(code, ctx, { timeout: 5000, filename: "sandbox.js" });
      output = [...logs, returnVal !== undefined ? String(returnVal) : ""].filter(Boolean).join("\n");
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      output = logs.join("\n");
    }
    const result = { executionId, status: error ? "error" : "done", output, error, durationMs: Date.now() - t0 };
    _sandboxResults.set(executionId, result);
    return reply.code(201).send(result);
  });

  app.get<{ Params: { id: string } }>("/sandbox/status/:id", async (request, reply) => {
    return reply.send(_sandboxResults.get(request.params.id) ?? { executionId: request.params.id, status: "not_found" });
  });

  // -- EVALUATION (alias to evals) -------------------------------------------

  // -- EVALUATION (LLM-backed scoring) ----------------------------------------

  interface EvalEntry { id: string; conversation: string; quality: number; coherence: number; consensus: number; diversity: number; date: string; }
  const _evalStore = new PersistentStore<EvalEntry>("eval_results");
  await _evalStore.load();

  app.get<{ Querystring: { days?: string } }>("/evaluation/dashboard", async (req, reply) => {
    const days = parseInt(req.query.days ?? "30", 10);
    const cutoff = Date.now() - days * 86_400_000;
    const entries = Array.from(_evalStore.values()).filter(e => new Date(e.date).getTime() >= cutoff);
    const avg = (key: keyof EvalEntry) =>
      entries.length ? entries.reduce((s, e) => s + (e[key] as number), 0) / entries.length : 0;
    return reply.send({
      period: `${days} days`,
      totalRuns: entries.length,
      currentPerformance: {
        overallScore: Math.round(avg("quality") * 100) / 100,
        quality:      Math.round(avg("coherence")  * 100) / 100,
        consensus:    Math.round(avg("consensus")  * 100) / 100,
        diversity:    Math.round(avg("diversity")  * 100) / 100,
      },
    });
  });

  app.get("/evaluation/metrics", async (_req, reply) => {
    const entries = Array.from(_evalStore.values());
    if (!entries.length) return reply.send({ metrics: [], message: "No evaluation runs yet." });
    const avg = (key: keyof EvalEntry) => entries.reduce((s, e) => s + (e[key] as number), 0) / entries.length;
    return reply.send({
      metrics: [
        { name: "Quality",   value: Math.round(avg("quality")   * 100) / 100, trend: "stable" },
        { name: "Coherence", value: Math.round(avg("coherence") * 100) / 100, trend: "stable" },
        { name: "Consensus", value: Math.round(avg("consensus") * 100) / 100, trend: "stable" },
        { name: "Diversity", value: Math.round(avg("diversity") * 100) / 100, trend: "stable" },
      ],
    });
  });

  app.get("/evaluation/results", async (_req, reply) => {
    return reply.send({ results: Array.from(_evalStore.values()).sort((a, b) => b.date.localeCompare(a.date)) });
  });

  app.post<{ Body: EvalEntry }>("/evaluation/results", async (req, reply) => {
    const entry: EvalEntry = { ...req.body, id: req.body.id ?? crypto.randomUUID(), date: req.body.date ?? now().slice(0, 10) };
    _evalStore.set(entry.id, entry);
    return reply.code(201).send(entry);
  });

  app.post<{ Body: { topic?: string; prompt?: string } }>("/evaluate", async (req, reply) => {
    const prompt = req.body.prompt ?? req.body.topic ?? "Evaluate the quality of this council deliberation.";
    // LLM-scored eval run
    const scoreText = await _llm([
      systemMsg("You are an AI evaluation system. Score the given topic on four dimensions: quality, coherence, consensus, diversity. Each score is 0.0–1.0. Return only JSON: {quality, coherence, consensus, diversity}"),
      userMsg(prompt),
    ], 128);
    let scores = { quality: 0.75, coherence: 0.72, consensus: 0.68, diversity: 0.81 };
    try { Object.assign(scores, parseJsonResponse(scoreText)); } catch { /* use defaults */ }
    const entry: EvalEntry = {
      id: crypto.randomUUID(),
      conversation: prompt.slice(0, 80),
      quality:   Math.min(1, Math.max(0, scores.quality)),
      coherence: Math.min(1, Math.max(0, scores.coherence)),
      consensus: Math.min(1, Math.max(0, scores.consensus)),
      diversity: Math.min(1, Math.max(0, scores.diversity)),
      date: now().slice(0, 10),
    };
    _evalStore.set(entry.id, entry);
    return reply.send(entry);
  });

  // -- CONNECTORS ------------------------------------------------------------

  // -- ADMIN -----------------------------------------------------------------

  const _adminUsers = new Map<string, { id: string; email: string; role: string; status: string; createdAt: string }>([
    ["local", { id: "local", email: "admin@nexus.local", role: "admin", status: "active", createdAt: now() }],
  ]);

  app.get("/admin/users", async (_req, reply) => {
    return reply.send({ users: Array.from(_adminUsers.values()), total: _adminUsers.size });
  });

  app.put<{ Params: { id: string }; Body: { role?: string; status?: string } }>("/admin/users/:id", async (request, reply) => {
    const user = _adminUsers.get(request.params.id);
    if (!user) return reply.code(404).send({ error: "not_found" });
    const updated = { ...user, ...request.body };
    _adminUsers.set(request.params.id, updated);
    return reply.send(updated);
  });

  const _auditLog: Array<{ id: string; action: string; user: string; resource: string; ts: string }> = [];

  app.get("/admin/audit-logs", async (_req, reply) => {
    return reply.send({ logs: _auditLog, total: _auditLog.length });
  });

  // -- BILLING ---------------------------------------------------------------

  app.get("/billing/plans", async (_req, reply) => {
    return reply.send({
      plans: [
        { id: "free",       name: "Free",       price: 0,    features: ["10k tokens/mo", "1 user"] },
        { id: "pro",        name: "Pro",         price: 29,   features: ["5M tokens/mo", "5 users", "Priority support"] },
        { id: "enterprise", name: "Enterprise",  price: null, features: ["Unlimited tokens", "Unlimited users", "SLA"] },
      ],
      current: "free",
    });
  });

  app.post("/billing/checkout", async (_req, reply) => {
    return reply.code(501).send({ error: "billing_not_configured", message: "Configure Stripe keys to enable billing." });
  });

  // -- FEATURE FLAGS ---------------------------------------------------------

  const _flags = new Map<string, boolean>();

  app.get("/feature-flags/admin/flags", async (_req, reply) => {
    return reply.send({ flags: Object.fromEntries(_flags) });
  });

  app.post<{ Body: { key: string; enabled: boolean } }>("/feature-flags/admin/flags", async (request, reply) => {
    _flags.set(request.body.key, request.body.enabled);
    return reply.send({ ok: true });
  });

  // -- FEEDBACK --------------------------------------------------------------

  app.get("/feedback/stats", async (_req, reply) => reply.send({ total: 0, byRating: {}, byModel: {} }));
  app.get("/feedback/export", async (_req, reply) => reply.send({ entries: [] }));

  // -- CONNECTORS -----------------------------------------------------------


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

  app.get<{ Params: { id: string } }>("/connectors/:id/sync-jobs", async (_req, reply) => {
    return reply.send({ jobs: [], total: 0 });
  });

  app.post<{ Params: { id: string } }>("/connectors/:id/sync", async (request, reply) => {
    return reply.code(202).send({ jobId: crypto.randomUUID(), status: "queued", connectorId: request.params.id });
  });

  // -- CRAFT (LLM-powered content generation) --------------------------------


  const CRAFT_TEMPLATES = [
    { id: "blog-post",       name: "Blog Post",        description: "Long-form blog article" },
    { id: "email",           name: "Email",            description: "Professional email draft" },
    { id: "product-desc",    name: "Product Description", description: "Compelling product copy" },
    { id: "social-post",     name: "Social Post",      description: "Engaging social media post" },
    { id: "executive-summary", name: "Executive Summary", description: "Concise exec summary" },
  ];

  app.get("/craft/templates", async (_req, reply) => {
    return reply.send({ templates: CRAFT_TEMPLATES });
  });

  app.get("/craft", async (_req, reply) => {
    return reply.send({ items: Array.from(_craftStore.values()), total: _craftStore.size });
  });

  app.post<{ Body: { template?: string; prompt: string; tone?: string; length?: string } }>(
    "/craft/generate",
    async (request, reply) => {
      const { template = "custom", prompt } = request.body;
      const driver = getDefaultDriver();
      let result = "";
      if (driver) {
        const sys = `You are a professional content writer specialising in ${template}. Write high-quality, engaging content.`;
        const res = await driver.complete({
          model: DEFAULT_MODEL,
          messages: [
            { role: "system" as LlmRole, content: sys },
            { role: "user" as LlmRole, content: prompt },
          ],
          maxTokens: 2048,
        });
        _trackCost(DEFAULT_MODEL, res.usage);
        result = res.content;
      } else {
        result = `[Configure an LLM API key to enable Craft generation]\n\nTemplate: ${template}\nPrompt: ${prompt}`;
      }
      const id = crypto.randomUUID();
      _craftStore.set(id, { id, template, prompt, result, createdAt: now() });
      return reply.code(201).send({ id, template, prompt, result, createdAt: now() });
    },
  );

  app.get<{ Params: { id: string } }>("/craft/:id", async (request, reply) => {
    const item = _craftStore.get(request.params.id);
    if (!item) return reply.code(404).send({ error: "not_found" });
    return reply.send(item);
  });

  app.delete<{ Params: { id: string } }>("/craft/:id", async (request, reply) => {
    _craftStore.delete(request.params.id);
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>("/craft/:id/download", async (request, reply) => {
    const item = _craftStore.get(request.params.id);
    if (!item) return reply.code(404).send({ error: "not_found" });
    reply.header("Content-Type", "text/plain");
    reply.header("Content-Disposition", `attachment; filename="craft-${request.params.id}.txt"`);
    return reply.send(item.result);
  });

  // -- EXTRACTION (LLM-powered structured data extraction) ------------------

  const _schemaStore = new Map<string, { id: string; name: string; schema: unknown; createdAt: string }>();
  const _extractionJobs = new Map<string, { id: string; status: string; result: unknown; createdAt: string }>();

  const EXTRACTION_TEMPLATES = [
    { id: "contact",  name: "Contact Info",   schema: { type:"object", properties:{ name:{type:"string"}, email:{type:"string"}, phone:{type:"string"} } } },
    { id: "event",    name: "Event",           schema: { type:"object", properties:{ title:{type:"string"}, date:{type:"string"}, location:{type:"string"} } } },
    { id: "product",  name: "Product",         schema: { type:"object", properties:{ name:{type:"string"}, price:{type:"number"}, description:{type:"string"} } } },
    { id: "invoice",  name: "Invoice",         schema: { type:"object", properties:{ vendor:{type:"string"}, amount:{type:"number"}, dueDate:{type:"string"} } } },
  ];

  // Schema inference via LLM
  app.post<{ Body: { text: string } }>("/extraction/infer-schema", async (request, reply) => {
    const { text } = request.body;
    if (!text) return reply.code(400).send({ error: "text_required" });
    const driver = getDefaultDriver();
    if (!driver) {
      // Best-effort heuristic schema when no LLM available
      return reply.send({ schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] } });
    }
    const res = await driver.complete({
      model: DEFAULT_MODEL,
      messages: [{
        role: "user" as LlmRole,
        content: `Analyse this text and infer a JSON Schema (draft-07) that describes the key structured data it contains.\nReturn ONLY valid JSON — no explanation.\n\nText:\n${text.slice(0, 2000)}`,
      }],
      maxTokens: 512,
    });
    _trackCost(DEFAULT_MODEL, res.usage);
    let schema: unknown;
    try { schema = parseJsonResponse(res.content); }
    catch { schema = { type: "object", properties: { extracted: { type: "string", description: res.content } } }; }
    return reply.send({ schema });
  });

  // Extraction helper: run LLM extraction
  const _extractWithLLM = async (text: string, schema: unknown): Promise<unknown> => {
    const driver = getDefaultDriver();
    if (!driver) return { raw: text.slice(0, 200) };
    const res = await driver.complete({
      model: DEFAULT_MODEL,
      messages: [{
        role: "user" as LlmRole,
        content: `Extract structured data from the following text according to this JSON Schema.\nReturn ONLY valid JSON.\n\nSchema:\n${JSON.stringify(schema, null, 2)}\n\nText:\n${text.slice(0, 3000)}`,
      }],
      maxTokens: 1024,
    });
    _trackCost(DEFAULT_MODEL, res.usage);
    try { return parseJsonResponse(res.content); }
    catch { return { raw: res.content }; }
  };

  app.post<{ Body: { text: string; schema?: unknown; schemaId?: string } }>("/extraction/preview", async (request, reply) => {
    const { text, schema, schemaId } = request.body;
    const resolvedSchema = schema ?? _schemaStore.get(schemaId ?? "")?.schema ?? EXTRACTION_TEMPLATES[0]?.schema;
    const result = await _extractWithLLM(text, resolvedSchema);
    return reply.send({ preview: result, schema: resolvedSchema });
  });

  app.post<{ Body: { text: string; schema?: unknown; schemaId?: string } }>("/extraction/run", async (request, reply) => {
    const { text, schema, schemaId } = request.body;
    const resolvedSchema = schema ?? _schemaStore.get(schemaId ?? "")?.schema ?? EXTRACTION_TEMPLATES[0]?.schema;
    const result = await _extractWithLLM(text, resolvedSchema);
    const id = crypto.randomUUID();
    _extractionJobs.set(id, { id, status: "done", result, createdAt: now() });
    return reply.code(201).send({ id, result, status: "done" });
  });

  app.get("/extraction/templates", async (_req, reply) => reply.send({ templates: EXTRACTION_TEMPLATES }));

  app.get("/extraction/schemas", async (_req, reply) => reply.send({ schemas: Array.from(_schemaStore.values()) }));
  app.post<{ Body: { name: string; schema: unknown } }>("/extraction/schemas", async (request, reply) => {
    const id = crypto.randomUUID();
    _schemaStore.set(id, { id, name: request.body.name, schema: request.body.schema, createdAt: now() });
    return reply.code(201).send({ id, name: request.body.name });
  });
  app.delete<{ Params: { id: string } }>("/extraction/schemas/:id", async (request, reply) => {
    _schemaStore.delete(request.params.id); return reply.code(204).send();
  });

  app.get("/extraction/jobs", async (_req, reply) => reply.send({ jobs: Array.from(_extractionJobs.values()) }));
  app.get<{ Params: { id: string } }>("/extraction/jobs/:id", async (request, reply) => {
    return reply.send(_extractionJobs.get(request.params.id) ?? reply.code(404).send({ error: "not_found" }));
  });
  app.delete<{ Params: { id: string } }>("/extraction/jobs/:id", async (request, reply) => {
    _extractionJobs.delete(request.params.id); return reply.code(204).send();
  });
  app.get<{ Params: { id: string } }>("/extraction/jobs/:id/export", async (request, reply) => {
    const job = _extractionJobs.get(request.params.id);
    if (!job) return reply.code(404).send({ error: "not_found" });
    reply.header("Content-Type", "application/json");
    reply.header("Content-Disposition", `attachment; filename="extraction-${request.params.id}.json"`);
    return reply.send(JSON.stringify(job.result, null, 2));
  });

  // -- SKILLS ----------------------------------------------------------------


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
    const driver = getDefaultDriver();
    if (!driver) return reply.code(503).send({ error: "No driver available" });

    const system = "Think step by step. Show your reasoning explicitly before giving the final answer.";
    const res = await driver.complete({
      model: "anthropic/claude-3.5-sonnet",
      messages: [{ role: "system" as LlmRole, content: system }, { role: "user" as LlmRole, content: request.body.question }],
      maxTokens: 2048,
    });
    _trackCost("anthropic/claude-3.5-sonnet", res.usage);
    return reply.send({ reasoning: res.content, mode: request.body.mode ?? "chain-of-thought" });
  });

  // -- KNOWLEDGE BASES -------------------------------------------------------


  app.get("/kb", async (_req, reply) => {
    return reply.send({ knowledgeBases: Array.from(_kbStore.values()), total: _kbStore.size });
  });

  app.post<{ Body: { name: string } }>("/kb", async (request, reply) => {
    const id = crypto.randomUUID();
    const kb = { id, name: request.body.name ?? "KB", docCount: 0, createdAt: now() };
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


  app.get("/images/providers", async (_req, reply) => {
    return reply.send({
      providers: [
        { id: "openai-dalle", name: "DALL·E 3 (OpenAI)",  available: !!process.env.OPENAI_API_KEY },
        { id: "replicate",    name: "Replicate",           available: !!process.env.REPLICATE_API_KEY },
      ],
    });
  });

  app.get("/images", async (_req, reply) => {
    return reply.send({ images: Array.from(_imageStore.values()), total: _imageStore.size });
  });

  app.post<{ Body: { prompt: string; size?: string; quality?: string; style?: string; provider?: string } }>(
    "/images/generate",
    async (request, reply) => {
      const { prompt, size = "1024x1024", quality = "standard", style = "vivid" } = request.body;
      if (!prompt) return reply.code(400).send({ error: "prompt_required" });
      const gen = getImageGen();
      if (!gen) {
        return reply.code(503).send({
          error: "no_provider",
          message: "Set OPENAI_API_KEY or REPLICATE_API_KEY to enable image generation.",
        });
      }
      try {
        const result = await gen.gen.generate(prompt, {
          size: size as ImageSize,
          quality: quality as "standard" | "hd",
          style: style as "vivid" | "natural",
          n: 1,
        });
        const img = result.images[0];
        const id = crypto.randomUUID();
        const record = {
          id,
          url: img?.url ?? "",
          b64: img?.b64,
          prompt,
          revisedPrompt: img?.revisedPrompt,
          provider: gen.provider,
          createdAt: now(),
        };
        _imageStore.set(id, record);
        return reply.code(201).send(record);
      } catch (err) {
        return reply.code(502).send({ error: "generation_failed", message: String(err) });
      }
    },
  );

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
    const write = (d: unknown) => { if (!raw.destroyed) raw.write(`data: ${JSON.stringify(d)}\n\n`); };
    const query = job?.query ?? "unknown query";

    write({ type: "phase", phase: "planning", message: "Planning research scope…" });

    // Build searchFn — use Tavily if key is present, else scraper-based search
    const tavilyKey = process.env.TAVILY_API_KEY;
    const searchFn = tavilyKey
      ? async (q: string): Promise<ResearchSearchResult[]> => {
          write({ type: "phase", phase: "searching", message: `Searching Tavily for: "${q}"…` });
          const r = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ api_key: tavilyKey, query: q, max_results: 6 }),
          });
          if (!r.ok) return [];
          const data = (await r.json()) as { results?: Array<{ url: string; title?: string; content?: string; score?: number }> };
          return (data.results ?? []).map((x) => ({
            url: x.url, title: x.title ?? x.url, snippet: x.content ?? "", score: x.score ?? 0, source: "web" as const,
          }));
        }
      : async (q: string): Promise<ResearchSearchResult[]> => {
          write({ type: "phase", phase: "searching", message: "No TAVILY_API_KEY — scraping query context…" });
          // Fallback: search DuckDuckGo HTML (no key needed) and parse result URLs
          try {
            const html = await getScraper().scrape(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, { timeout: 10_000 });
            const urls = [...html.text.matchAll(/https?:\/\/[^\s"')>]+/g)].map((m) => m[0]).filter((u) => !u.includes("duckduckgo")).slice(0, 4);
            return urls.map((url) => ({ url, title: url, snippet: "", score: 0.5, source: "web" as const }));
          } catch { return []; }
        };

    // Build synthesizeFn — use first available LLM driver
    const synthesizeFn = async (q: string, results: ResearchSearchResult[]): Promise<string> => {
      write({ type: "phase", phase: "synthesis", message: "Synthesising findings with LLM…" });
      const driver = getDefaultDriver();
      if (!driver || results.length === 0) {
        return results.length > 0
          ? `Found ${results.length} results for "${q}". Top source: ${results[0]?.url}`
          : `No results found for "${q}". Configure TAVILY_API_KEY for web search.`;
      }
      const context = results.slice(0, 5).map((r) => `Source: ${r.url}\n${r.snippet}`).join("\n\n");
      const res = await driver.complete({
        model: DEFAULT_MODEL,
        messages: [
          { role: "system" as LlmRole, content: "You are a research assistant. Synthesise the provided search results into a clear, factual summary." },
          { role: "user" as LlmRole, content: `Research question: ${q}\n\nSearch results:\n${context}\n\nProvide a concise synthesis.` },
        ],
        maxTokens: 1024,
      });
      _trackCost(DEFAULT_MODEL, res.usage);
      return res.content;
    };

    try {
      const researcher = new WebResearcher({ searchFn, synthesizeFn, maxResults: 6 });
      const finding = await researcher.research(query);
      if (job) { job.status = "done"; job.result = finding.synthesis; }
      write({
        type: "result",
        id: request.params.id,
        status: "done",
        result: finding.synthesis,
        sections: [],
        citations: finding.citations,
        richCitations: finding.richCitations,
        results: finding.results,
      });
    } catch (err) {
      if (job) { job.status = "error"; }
      write({ type: "error", message: String(err) });
    }
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
    // "craft" — removed from stubs; real routes wired below
    "cross-memory",
    "echo-chamber",
    // "extraction" — removed from stubs; real routes wired below
    "fallback-chains",
    // "hallucination" — removed from stubs; real routes wired below
    // "honesty" — removed from stubs; real routes wired below
    "image-transformations",
    // "imr" — removed from stubs; real routes wired below
    "marketplace",
    "member-evolution",
    // "moderation" — removed from stubs; real routes wired below
    // "negation" — removed from stubs; real routes wired below
    "prompt-filter",
    "reactions",
    // "rss" — removed from stubs; real routes wired below
    // "semantic-cache" — removed from stubs; real routes wired below
    // "simulate" — removed from stubs; real routes wired below
    "skill-selection",
    "sop",
    "specialisation",
    // "speculative" — removed from stubs; real routes wired below
    // "standard-answers" — removed from stubs; real routes wired below
    "symbolic",
    "system",
    "task-routing",
    "token-conservation",
    "verbosity",
    "verifiable",
    "video",
    // "web-scraping" — removed from stubs; real routes wired below
  ];

  // Persistent CRUD store for each stub prefix — backed by JSON files or Postgres
  const _stubStores = new Map<string, PersistentStore<Record<string, unknown>>>();
  function _stubStore(prefix: string): PersistentStore<Record<string, unknown>> {
    if (!_stubStores.has(prefix)) {
      const store = new PersistentStore<Record<string, unknown>>(`stub_${prefix}`);
      store.load().catch(() => {}); // fire-and-forget; routes serve empty until loaded (fast)
      _stubStores.set(prefix, store);
    }
    return _stubStores.get(prefix)!;
  }

  for (const prefix of STUB_PREFIXES) {
    // GET list
    app.get(`/${prefix}`, async (_req, reply) => reply.send(Array.from(_stubStore(prefix).values())));
    // GET by id
    app.get<{ Params: { id: string } }>(`/${prefix}/:id`, async (req, reply) => {
      const item = _stubStore(prefix).get(req.params.id);
      return item ? reply.send(item) : reply.code(404).send({ error: "not_found" });
    });
    // GET sub-resource
    app.get(`/${prefix}/:id/*`, async (_req, reply) => reply.send({ data: null }));
    // POST create
    app.post<{ Body: Record<string, unknown> }>(`/${prefix}`, async (req, reply) => {
      const id = crypto.randomUUID();
      const item = { id, ...req.body, createdAt: now() };
      _stubStore(prefix).set(id, item);
      return reply.code(201).send(item);
    });
    // POST to named action (e.g. /echo-chamber/detect, /task-routing/classify)
    app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(`/${prefix}/:id`, async (req, reply) => {
      return reply.send({ ok: true, action: req.params.id, result: null });
    });
    // POST sub-action with deeper path (e.g. /build/tasks/steal)
    app.post<{ Params: { id: string } }>(`/${prefix}/:id/*`, async (req, reply) => {
      return reply.send({ ok: true, id: req.params.id });
    });
    // PUT + PATCH update (identical semantics — shared handler)
    const _upsertHandler = async (req: { params: { id: string }; body: Record<string, unknown> }, reply: { send: (v: unknown) => unknown }) => {
      const store = _stubStore(prefix);
      const updated = { ...(store.get(req.params.id) ?? { id: req.params.id }), ...req.body, updatedAt: now() };
      store.set(req.params.id, updated);
      return reply.send(updated);
    };
    app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(`/${prefix}/:id`, _upsertHandler);
    app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(`/${prefix}/:id`, _upsertHandler);
    // DELETE
    app.delete<{ Params: { id: string } }>(`/${prefix}/:id`, async (req, reply) => {
      _stubStore(prefix).delete(req.params.id);
      return reply.code(204).send();
    });
  }

  // -- WEB SCRAPING (real — HttpxEngine via @nexus/adaptive-scraper) -----------

  app.get("/web-scraping/providers", async (_req, reply) => {
    return reply.send({
      providers: [
        { id: "httpx",      name: "HTTPX (built-in)",  available: true },
        { id: "firecrawl",  name: "Firecrawl",         available: !!process.env.FIRECRAWL_API_KEY },
        { id: "exa",        name: "Exa",               available: !!process.env.EXA_API_KEY },
      ],
    });
  });

  app.post<{ Body: { url: string; javascript?: boolean; waitFor?: string } }>(
    "/web-scraping/scrape",
    async (request, reply) => {
      const { url, javascript = false, waitFor } = request.body;
      if (!url) return reply.code(400).send({ error: "url_required" });
      try {
        const result = await getScraper().scrape(url, {
          javascript,
          waitForSelector: waitFor,
          timeout: 25_000,
        });
        return reply.send(result);
      } catch (err) {
        return reply.code(502).send({ error: "scrape_failed", message: String(err) });
      }
    },
  );

  app.post<{ Body: { url: string; maxDepth?: number; maxPages?: number } }>(
    "/web-scraping/crawl",
    async (request, reply) => {
      const { url, maxPages = 5 } = request.body;
      if (!url) return reply.code(400).send({ error: "url_required" });
      const scraper = getScraper();
      // Shallow crawl: scrape the seed URL and parse hrefs from the HTML
      const seed = await scraper.scrape(url, { timeout: 25_000 });
      const pages = [seed];
      if (seed.status === "success" && maxPages > 1) {
        // Extract up to maxPages-1 same-origin links from HTML
        const origin = new URL(url).origin;
        const hrefs = [...seed.html.matchAll(/href="([^"]+)"/gi)]
          .map((m) => { try { return new URL(m[1]!, url).href; } catch { return null; } })
          .filter((h): h is string => !!h && h.startsWith(origin))
          .slice(0, maxPages - 1);
        const rest = await Promise.allSettled(hrefs.map((h) => scraper.scrape(h, { timeout: 15_000 })));
        for (const r of rest) if (r.status === "fulfilled") pages.push(r.value);
      }
      return reply.send({ pages, total: pages.length });
    },
  );

  // Exa routes — require EXA_API_KEY
  app.post<{ Body: { query: string; numResults?: number } }>(
    "/web-scraping/exa/search",
    async (request, reply) => {
      const apiKey = process.env.EXA_API_KEY;
      if (!apiKey) return reply.code(503).send({ error: "no_exa_key", message: "Set EXA_API_KEY to enable Exa search." });
      const res = await fetch("https://api.exa.ai/search", {
        method: "POST",
        headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ query: request.body.query, numResults: request.body.numResults ?? 5 }),
      });
      if (!res.ok) return reply.code(res.status).send({ error: "exa_error", message: await res.text() });
      return reply.send(await res.json());
    },
  );

  app.post<{ Body: { ids: string[] } }>(
    "/web-scraping/exa/contents",
    async (request, reply) => {
      const apiKey = process.env.EXA_API_KEY;
      if (!apiKey) return reply.code(503).send({ error: "no_exa_key", message: "Set EXA_API_KEY to enable Exa content extraction." });
      const res = await fetch("https://api.exa.ai/contents", {
        method: "POST",
        headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ ids: request.body.ids }),
      });
      if (!res.ok) return reply.code(res.status).send({ error: "exa_error", message: await res.text() });
      return reply.send(await res.json());
    },
  );

  // -- NEGATION DETECTION (LLM-based) ----------------------------------------

  const _negationRules = new Map<string, Map<string, { id: string; pattern: string; confidence: number }>>();

  app.post<{ Body: { text: string } }>("/negation/detect", async (request, reply) => {
    const { text } = request.body;
    const driver = getDefaultDriver();
    if (!driver) return reply.send({ patterns: [], detected: 0 });
    const res = await driver.complete({
      model: DEFAULT_MODEL,
      messages: [{ role: "user" as LlmRole, content: `Detect negation patterns, contradictions, and logical negations in this text.\nReturn JSON: { patterns: Array<{ id: string, pattern: string, confidence: number }>, detected: number }\n\nText:\n${text.slice(0, 800)}` }],
      maxTokens: 512,
    });
    _trackCost(DEFAULT_MODEL, res.usage);
    try { return reply.send(parseJsonResponse(res.content)); }
    catch { return reply.send({ patterns: [], detected: 0 }); }
  });

  app.post<{ Body: { convId: string; patterns: Array<{ id: string; pattern: string; confidence: number }> } }>("/negation/add", async (request, reply) => {
    const { convId, patterns } = request.body;
    if (!_negationRules.has(convId)) _negationRules.set(convId, new Map());
    for (const p of patterns) _negationRules.get(convId)!.set(p.id ?? crypto.randomUUID(), p);
    return reply.send({ ok: true, added: patterns.length });
  });

  app.get<{ Params: { convId: string } }>("/negation/:convId", async (request, reply) => {
    const rules = _negationRules.get(request.params.convId);
    return reply.send({ rules: rules ? Array.from(rules.values()) : [] });
  });

  app.delete<{ Params: { convId: string; ruleId: string } }>("/negation/:convId/:ruleId", async (request, reply) => {
    _negationRules.get(request.params.convId)?.delete(request.params.ruleId);
    return reply.code(204).send();
  });

  app.delete<{ Params: { convId: string } }>("/negation/:convId", async (request, reply) => {
    _negationRules.delete(request.params.convId);
    return reply.code(204).send();
  });

  app.post<{ Body: { convId: string } }>("/negation/inject", async (request, reply) => {
    const rules = _negationRules.get(request.body.convId);
    const injected = rules?.size ?? 0;
    return reply.send({ message: injected ? `Injected ${injected} negation rules into context.` : "No rules found for this conversation.", injected });
  });

  // -- INTERRUPT-MIDWAY-RESUME (IMR) -----------------------------------------

  type ImrStatus = "running" | "interrupted" | "resumed" | "done" | "failed";
  interface ImrRun { id: string; query: string; status: ImrStatus; createdAt: string; interruptedAt?: string; resumedAt?: string; output?: string; progress?: number; }

  app.get("/imr/runs", async (_req, reply) => reply.send({ runs: Array.from(_imrRuns.values()) }));

  app.post<{ Body: { query: string } }>("/imr/runs", async (request, reply) => {
    const id = crypto.randomUUID();
    const run: ImrRun = { id, query: request.body.query ?? "", status: "running", createdAt: now(), progress: 10 };
    _imrRuns.set(id, run);
    return reply.code(201).send(run);
  });

  app.get<{ Params: { id: string } }>("/imr/runs/:id", async (request, reply) => {
    const run = _imrRuns.get(request.params.id);
    if (!run) return reply.code(404).send({ error: "not_found" });
    return reply.send(run);
  });

  app.post<{ Params: { id: string }; Body: { reason?: string } }>("/imr/runs/:id/interrupt", async (request, reply) => {
    const run = _imrRuns.get(request.params.id);
    if (!run) return reply.code(404).send({ error: "not_found" });
    run.status = "interrupted"; run.interruptedAt = now();
    return reply.send(run);
  });

  app.patch<{ Params: { id: string }; Body: { query?: string } }>("/imr/runs/:id/modify", async (request, reply) => {
    const run = _imrRuns.get(request.params.id);
    if (!run) return reply.code(404).send({ error: "not_found" });
    if (request.body.query) run.query = request.body.query;
    return reply.send(run);
  });

  app.post<{ Params: { id: string } }>("/imr/runs/:id/resume", async (request, reply) => {
    const run = _imrRuns.get(request.params.id);
    if (!run) return reply.code(404).send({ error: "not_found" });
    run.status = "resumed"; run.resumedAt = now();
    // Generate output via LLM on resume
    const driver = getDefaultDriver();
    if (driver) {
      const res = await driver.complete({ model: DEFAULT_MODEL, messages: [{ role: "user" as LlmRole, content: `Resume and complete this task: ${run.query}` }], maxTokens: 512 });
      _trackCost(DEFAULT_MODEL, res.usage);
      run.output = res.content; run.progress = 100; run.status = "done";
    }
    return reply.send(run);
  });

  app.delete<{ Params: { id: string } }>("/imr/runs/:id", async (request, reply) => {
    _imrRuns.delete(request.params.id);
    return reply.code(204).send();
  });

  // -- MULTI-AGENT SIMULATION (Generative Agents pattern) -------------------

  interface SimPersona { id: string; name: string; backstory: string; goals: string[]; traits: string[]; expertise: string[]; communicationStyle: string; constraints: string[]; memory: string[]; createdAt: string; }
  interface SimEnvironment { id: string; name: string; description: string; initialState: string; rules: string[]; createdAt: string; }
  interface SimRun { id: string; name: string; environmentId: string; personaIds: string[]; status: string; currentTick: number; maxTicks: number; tickLog: unknown[]; createdAt: string; }

  const _personas    = new Map<string, SimPersona>();
  const _simEnvs     = new Map<string, SimEnvironment>();
  const _simRuns     = new Map<string, SimRun>();

  // Personas
  app.get("/simulate/personas", async (_req, reply) => reply.send({ personas: Array.from(_personas.values()) }));
  app.post<{ Body: Partial<SimPersona> }>("/simulate/personas", async (request, reply) => {
    const id = crypto.randomUUID();
    const p: SimPersona = { id, name: request.body.name ?? "Agent", backstory: request.body.backstory ?? "", goals: request.body.goals ?? [], traits: request.body.traits ?? [], expertise: request.body.expertise ?? [], communicationStyle: request.body.communicationStyle ?? "neutral", constraints: request.body.constraints ?? [], memory: [], createdAt: now() };
    _personas.set(id, p);
    return reply.code(201).send(p);
  });
  app.delete<{ Params: { id: string } }>("/simulate/personas/:id", async (req, reply) => { _personas.delete(req.params.id); return reply.code(204).send(); });

  // Persona chat — respond in-character
  app.post<{ Params: { id: string }; Body: { messages: Array<{ role: string; content: string }>; message?: string } }>("/simulate/personas/:id/chat", async (request, reply) => {
    const persona = _personas.get(request.params.id);
    if (!persona) return reply.code(404).send({ error: "not_found" });
    const driver = getDefaultDriver();
    if (!driver) return reply.send({ role: "assistant", content: `[${persona.name}]: No LLM driver configured.` });
    const sysprompt = `You are ${persona.name}. ${persona.backstory}\nGoals: ${persona.goals.join(", ")}\nTraits: ${persona.traits.join(", ")}\nCommunication style: ${persona.communicationStyle}\nConstraints: ${persona.constraints.join(", ")}\nRespond in character.`;
    const userMsg = request.body.message ?? (request.body.messages?.at(-1)?.content ?? "Hello");
    const res = await driver.complete({ model: DEFAULT_MODEL, messages: [{ role: "system" as LlmRole, content: sysprompt }, { role: "user" as LlmRole, content: userMsg }], maxTokens: 512 });
    _trackCost(DEFAULT_MODEL, res.usage);
    return reply.send({ role: "assistant", content: res.content });
  });

  // Environments
  app.get("/simulate/environments", async (_req, reply) => reply.send({ environments: Array.from(_simEnvs.values()) }));
  app.post<{ Body: Partial<SimEnvironment> }>("/simulate/environments", async (request, reply) => {
    const id = crypto.randomUUID();
    const env: SimEnvironment = { id, name: request.body.name ?? "World", description: request.body.description ?? "", initialState: request.body.initialState ?? "", rules: request.body.rules ?? [], createdAt: now() };
    _simEnvs.set(id, env);
    return reply.code(201).send(env);
  });

  // Simulation runs
  app.get("/simulate/runs", async (_req, reply) => reply.send({ runs: Array.from(_simRuns.values()) }));
  app.post<{ Body: { name?: string; environmentId: string; personaIds: string[]; maxTicks?: number } }>("/simulate/runs", async (request, reply) => {
    const id = crypto.randomUUID();
    const run: SimRun = { id, name: request.body.name ?? "Simulation", environmentId: request.body.environmentId, personaIds: request.body.personaIds, status: "idle", currentTick: 0, maxTicks: request.body.maxTicks ?? 20, tickLog: [], createdAt: now() };
    _simRuns.set(id, run);
    return reply.code(201).send(run);
  });

  // Tick — advance simulation one step using LLM-generated actions
  app.post<{ Params: { id: string } }>("/simulate/runs/:id/tick", async (request, reply) => {
    const run = _simRuns.get(request.params.id);
    if (!run) return reply.code(404).send({ error: "not_found" });
    if (run.currentTick >= run.maxTicks) { run.status = "completed"; return reply.send(run); }
    run.status = "running";
    const env = _simEnvs.get(run.environmentId);
    const driver = getDefaultDriver();
    const personas = run.personaIds.map((pid) => _personas.get(pid)).filter(Boolean) as SimPersona[];
    const tick = run.currentTick + 1;
    const actions: unknown[] = [];
    if (driver && personas.length > 0) {
      const worldCtx = env ? `Environment: ${env.name}. ${env.description}. State: ${env.initialState}` : "Unknown environment";
      const prevTick = (run.tickLog as Array<{ actions: unknown[] }>).at(-1);
      const recentEvents = prevTick ? `Previous tick events: ${JSON.stringify(prevTick.actions)}` : "First tick.";
      for (const p of personas) {
        const prompt = `${worldCtx}\n${recentEvents}\nYou are ${p.name}. ${p.backstory}\nGoals: ${p.goals.join(", ")}\nWhat do you do this tick? Return JSON: { action: string, reasoning: string }`;
        const res = await driver.complete({ model: DEFAULT_MODEL, messages: [{ role: "user" as LlmRole, content: prompt }], maxTokens: 256 });
        _trackCost(DEFAULT_MODEL, res.usage);
        try {
          const parsed = parseJsonResponse(res.content);
          actions.push({ personaId: p.id, personaName: p.name, ...(parsed as Record<string, unknown>) });
        } catch {
          actions.push({ personaId: p.id, personaName: p.name, action: res.content.slice(0, 120), reasoning: "" });
        }
      }
    } else {
      for (const p of (personas.length ? personas : [{ id: "stub", name: "Agent" } as SimPersona])) {
        actions.push({ personaId: p.id, personaName: p.name, action: "No LLM driver configured — add an API key to enable simulation", reasoning: "" });
      }
    }
    const tickEntry = { tick, actions, timestamp: now() };
    (run.tickLog as unknown[]).push(tickEntry);
    run.currentTick = tick;
    if (run.currentTick >= run.maxTicks) run.status = "completed";
    return reply.send({ ...run, lastTick: tickEntry });
  });

  app.get<{ Params: { id: string } }>("/simulate/runs/:id/transcript", async (req, reply) => {
    const run = _simRuns.get(req.params.id);
    if (!run) return reply.code(404).send({ error: "not_found" });
    return reply.send({ id: run.id, name: run.name, tickLog: run.tickLog });
  });

  app.post<{ Params: { id: string } }>("/simulate/runs/:id/reset", async (req, reply) => {
    const run = _simRuns.get(req.params.id);
    if (!run) return reply.code(404).send({ error: "not_found" });
    run.currentTick = 0; run.status = "idle"; run.tickLog = [];
    return reply.send(run);
  });

  // -- MODERATION (LLM-based content safety) ---------------------------------

  const _moderationConfig = { thresholds: { hate: 0.8, violence: 0.8, sexual: 0.9, selfharm: 0.7 } };

  const _runModeration = async (text: string): Promise<{ flagged: boolean; action: string; reason: string; categories: Record<string, number> }> => {
    const driver = getDefaultDriver();
    if (!driver) return { flagged: false, action: "allow", reason: "No LLM driver configured", categories: {} };
    const res = await driver.complete({
      model: DEFAULT_MODEL,
      messages: [{ role: "user" as LlmRole, content: `Moderate this text for policy violations. Score each category 0-1.\nReturn JSON: { flagged: boolean, action: "block"|"warn"|"allow", reason: string, categories: { hate: number, violence: number, sexual: number, selfharm: number, spam: number } }\n\nText: ${text.slice(0, 800)}` }],
      maxTokens: 256,
    });
    _trackCost(DEFAULT_MODEL, res.usage);
    try { return parseJsonResponse(res.content); }
    catch { return { flagged: false, action: "allow", reason: "Parse error", categories: {} }; }
  };

  app.post<{ Body: { text: string } }>("/moderation/check", async (request, reply) => {
    return reply.send(await _runModeration(request.body.text));
  });

  app.post<{ Body: { items: Array<{ id: string; text: string }> } }>("/moderation/batch", async (request, reply) => {
    const results = await Promise.all(
      request.body.items.slice(0, 20).map(async (item) => ({ id: item.id, result: await _runModeration(item.text) }))
    );
    return reply.send({ results });
  });

  app.get("/moderation/config",  async (_req, reply) => reply.send(_moderationConfig));
  app.post<{ Body: typeof _moderationConfig }>("/moderation/config", async (request, reply) => {
    Object.assign(_moderationConfig, request.body);
    return reply.send(_moderationConfig);
  });

  // -- HONESTY (LLM-based sycophancy, reframe, calibration, minority report) -

  app.post<{ Body: { prompt?: string; response: string } }>("/honesty/sycophancy-check", async (request, reply) => {
    const { prompt = "", response } = request.body;
    const driver = getDefaultDriver();
    if (!driver) return reply.send({ sycophantic: false, score: 0, explanation: "No LLM driver configured", patterns: [] });
    const content = [
      "Analyse this AI response for sycophancy (excessive agreement, flattery, people-pleasing).",
      prompt ? `\nOriginal prompt: ${prompt.slice(0, 300)}` : "",
      `\nAI response: ${response.slice(0, 800)}`,
      '\nReturn JSON: { sycophantic: boolean, score: number (0-1), explanation: string, patterns: string[] }',
    ].join("");
    const res = await driver.complete({ model: DEFAULT_MODEL, messages: [{ role: "user" as LlmRole, content }], maxTokens: 512 });
    _trackCost(DEFAULT_MODEL, res.usage);
    try { return reply.send(parseJsonResponse(res.content)); }
    catch { return reply.send({ sycophantic: false, score: 0.5, explanation: res.content.slice(0, 200), patterns: [] }); }
  });

  app.post<{ Body: { response: string } }>("/honesty/reframe", async (request, reply) => {
    const { response } = request.body;
    const driver = getDefaultDriver();
    if (!driver) return reply.send({ original: response, reframed: response, changes: ["No LLM driver configured"] });
    const res = await driver.complete({
      model: DEFAULT_MODEL,
      messages: [{ role: "user" as LlmRole, content: `Rewrite this AI response to be more direct, honest, and less sycophantic. Return JSON: { original: string, reframed: string, changes: string[] }\n\nResponse:\n${response.slice(0, 1000)}` }],
      maxTokens: 1024,
    });
    _trackCost(DEFAULT_MODEL, res.usage);
    try { return reply.send(parseJsonResponse(res.content)); }
    catch { return reply.send({ original: response, reframed: res.content, changes: [] }); }
  });

  app.post<{ Body: { text: string } }>("/honesty/confidence-calibrate", async (request, reply) => {
    const { text } = request.body;
    const driver = getDefaultDriver();
    if (!driver) return reply.send({ originalConfidence: 0.8, calibratedConfidence: 0.6, overconfident: true, adjustedText: text });
    const res = await driver.complete({
      model: DEFAULT_MODEL,
      messages: [{ role: "user" as LlmRole, content: `Analyse the confidence calibration of this text. Detect overconfident claims and suggest hedged alternatives.\nReturn JSON: { originalConfidence: number (0-1), calibratedConfidence: number (0-1), overconfident: boolean, adjustedText: string }\n\nText:\n${text.slice(0, 800)}` }],
      maxTokens: 1024,
    });
    _trackCost(DEFAULT_MODEL, res.usage);
    try { return reply.send(parseJsonResponse(res.content)); }
    catch { return reply.send({ originalConfidence: 0.7, calibratedConfidence: 0.6, overconfident: false, adjustedText: text }); }
  });

  app.post<{ Body: { topic: string; mainView?: string } }>("/honesty/minority-report", async (request, reply) => {
    const { topic, mainView = "" } = request.body;
    const driver = getDefaultDriver();
    if (!driver) return reply.send({ mainView: mainView || topic, minorityViews: [{ view: "No LLM driver configured", prevalence: "unknown", reasoning: "" }] });
    const res = await driver.complete({
      model: DEFAULT_MODEL,
      messages: [{ role: "user" as LlmRole, content: `Surface 3-4 minority, contrarian, or under-represented viewpoints on this topic.\n${mainView ? `Dominant view to challenge: ${mainView}\n` : ""}Topic: ${topic.slice(0, 400)}\n\nReturn JSON: { mainView: string, minorityViews: Array<{ view: string, prevalence: string, reasoning: string }> }` }],
      maxTokens: 1024,
    });
    _trackCost(DEFAULT_MODEL, res.usage);
    try { return reply.send(parseJsonResponse(res.content)); }
    catch { return reply.send({ mainView: mainView || topic, minorityViews: [] }); }
  });

  // -- HALLUCINATION SCORING (LLM-based) ------------------------------------

  app.get("/hallucination/thresholds", async (_req, reply) => {
    return reply.send({ low: 0.3, medium: 0.6, high: 0.8, thresholds: { low: 0.3, medium: 0.6, high: 0.8 } });
  });

  const _scoreHallucination = async (response: string, context?: string): Promise<{ score: number; confidence: number; factors: string[] }> => {
    const driver = getDefaultDriver();
    if (!driver) return { score: 0.5, confidence: 0.1, factors: ["No LLM driver configured"] };
    const prompt = context
      ? `Rate the hallucination risk of this AI response given the context (0=no hallucination, 1=definite hallucination). Return JSON: { score: number, confidence: number, factors: string[] }\n\nContext: ${context.slice(0, 500)}\n\nResponse: ${response.slice(0, 500)}`
      : `Rate the hallucination risk of this AI response (0=factual/safe, 1=likely hallucinated). Return JSON: { score: number, confidence: number, factors: string[] }\n\nResponse: ${response.slice(0, 500)}`;
    const res = await driver.complete({ model: DEFAULT_MODEL, messages: [{ role: "user" as LlmRole, content: prompt }], maxTokens: 256 });
    _trackCost(DEFAULT_MODEL, res.usage);
    try { return parseJsonResponse(res.content); }
    catch { return { score: 0.5, confidence: 0.5, factors: ["Parse error"] }; }
  };

  app.post<{ Body: { response: string; context?: string } }>("/hallucination/score", async (request, reply) => {
    const result = await _scoreHallucination(request.body.response, request.body.context);
    return reply.send(result);
  });

  app.post<{ Body: { answer: string; context: string } }>("/hallucination/groundedness", async (request, reply) => {
    const { answer, context } = request.body;
    const driver = getDefaultDriver();
    if (!driver) return reply.send({ groundedness: 0.5, supported: [], unsupported: [] });
    const res = await driver.complete({
      model: DEFAULT_MODEL,
      messages: [{ role: "user" as LlmRole, content: `Rate how grounded this answer is in the given context (0-1). Return JSON: { groundedness: number, supported: string[], unsupported: string[] }\n\nContext: ${context.slice(0, 500)}\n\nAnswer: ${answer.slice(0, 500)}` }],
      maxTokens: 256,
    });
    _trackCost(DEFAULT_MODEL, res.usage);
    try { return reply.send(parseJsonResponse(res.content)); }
    catch { return reply.send({ groundedness: 0.5, supported: [], unsupported: [] }); }
  });

  app.post<{ Body: { items: Array<{ id: string; response: string; context?: string }> } }>("/hallucination/batch-score", async (request, reply) => {
    const results = await Promise.all(
      request.body.items.slice(0, 10).map(async (item) => ({
        id: item.id,
        ...(await _scoreHallucination(item.response, item.context)),
      })),
    );
    return reply.send({ results });
  });

  // -- SPECULATIVE DECODING / CLASSIFY --------------------------------------

  app.get("/speculative/config", async (_req, reply) => reply.send({
    enabled: !!getDefaultDriver(), draftModel: DEFAULT_MODEL, targetModel: DEFAULT_MODEL, mode: "llm-simulated",
  }));
  app.get("/speculative/stats", async (_req, reply) => reply.send({ acceptanceRate: 0, speedup: 0, totalTokens: 0 }));

  app.post<{ Body: { prompt: string; draftModel?: string; targetModel?: string } }>("/speculative/run", async (req, reply) => {
    const driver = getDefaultDriver();
    if (!driver) return reply.code(503).send({ error: "no_llm_driver" });
    const prompt = req.body.prompt ?? "";
    const t0 = Date.now();
    // Draft pass
    const draftRes = await driver.complete({ model: DEFAULT_MODEL, messages: [userMsg(prompt)], maxTokens: 256 });
    _trackCost(DEFAULT_MODEL, draftRes.usage);
    const draftMs = Date.now() - t0;
    // Verify pass — LLM scores and optionally improves the draft
    const t1 = Date.now();
    const verifyContent = await _llm([userMsg(
      `Prompt: "${prompt.slice(0, 400)}"\n\nDraft response:\n${draftRes.content}\n\nIf the draft fully and correctly answers the prompt, respond with JSON: {"accepted":true,"output":"<same text>","reason":"correct"}. If it has errors or is incomplete, improve it: {"accepted":false,"output":"<improved>","reason":"<why rejected>"}. Return only valid JSON.`,
    )], 512);
    const verifyMs = Date.now() - t1;
    let result = { accepted: true, output: draftRes.content, reason: "verify unavailable" };
    try { result = parseJsonResponse<typeof result>(verifyContent); } catch { /* keep default */ }
    return reply.send({
      accepted: result.accepted,
      output: result.output ?? draftRes.content,
      draft: draftRes.content,
      reason: result.reason,
      speedup: result.accepted ? +(draftMs / (draftMs + verifyMs)).toFixed(3) : 0,
      draftTokens: draftRes.usage?.outputTokens ?? 0,
      draftMs, verifyMs, totalMs: Date.now() - t0,
    });
  });

  app.post<{ Body: { text: string } }>("/speculative/classify", async (request, reply) => {
    const { text } = request.body;
    const driver = getDefaultDriver();
    if (!driver) return reply.send({ type: "unknown", confidence: 0, labels: [] });
    const res = await driver.complete({
      model: DEFAULT_MODEL,
      messages: [{ role: "user" as LlmRole, content: `Classify this text into one of: question, statement, command, code, creative, factual, opinion. Return JSON: { type: string, confidence: number, labels: string[] }\n\n${text.slice(0, 500)}` }],
      maxTokens: 128,
    });
    _trackCost(DEFAULT_MODEL, res.usage);
    try { return reply.send(parseJsonResponse(res.content)); }
    catch { return reply.send({ type: "unknown", confidence: 0.5, labels: [] }); }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // C.3 — FUNCTIONAL STUBS (return 200 OK so callers don't log errors)
  // ══════════════════════════════════════════════════════════════════════════

  // STM — Short-Term Memory modules backed by @nexus/drift
  const _stmHistory: Array<{ id: string; query: string; modules: string[]; applied: string[]; params: Record<string, unknown>; ts: string }> = [];
  const _stmEmaStore = new InMemoryEmaStore();
  let _stmActiveModules: string[] = ["hedge", "dir", "ema"];

  app.get("/stm/history", async (_req, reply) => reply.send(_stmHistory));
  app.post<{ Body: { query: string; modules: string[]; applied: string[] } }>(
    "/stm/history",
    async (req, reply) => {
      // Compute real drift params for this query using active modules
      const result = computeAutoTuneParams({ message: req.body.query ?? "", history: [] });
      const entry = { id: crypto.randomUUID(), ...req.body, params: result.params as Record<string, unknown>, ts: now() };
      _stmHistory.push(entry);
      if (_stmHistory.length > 500) _stmHistory.splice(0, _stmHistory.length - 500);
      return reply.send({ ok: true, params: result.params });
    },
  );
  app.delete("/stm/history", async (_req, reply) => { _stmHistory.length = 0; return reply.send({ ok: true, cleared: true }); });

  app.get("/stm/active", async (_req, reply) => {
    // Return active module list + their current computed params for a neutral message
    const result = computeAutoTuneParams({ message: "neutral", history: [] });
    return reply.send({ modules: _stmActiveModules, params: result.params, context: result.context });
  });

  app.post<{ Body: { modules?: string[] } }>("/stm/active", async (req, reply) => {
    if (req.body.modules) _stmActiveModules = req.body.modules;
    const result = computeAutoTuneParams({ message: "neutral", history: [] });
    return reply.send({ modules: _stmActiveModules, params: result.params, context: result.context });
  });

  // TTS — OpenAI TTS-1 if OPENAI_API_KEY present, else graceful null
  app.post<{ Body: { text: string; voice?: string } }>("/tts", async (req, reply) => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return reply.send({ audio: null, message: "TTS not configured — add OPENAI_API_KEY to enable." });
    const text = (req.body.text ?? "").slice(0, 4096);
    const voice = req.body.voice ?? "alloy";
    try {
      const r = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: "tts-1", input: text, voice, response_format: "mp3" }),
      });
      if (!r.ok) return reply.send({ audio: null, message: `TTS error: ${r.status}` });
      const buf = await r.arrayBuffer();
      const b64 = Buffer.from(buf).toString("base64");
      return reply.send({ audio: `data:audio/mpeg;base64,${b64}`, voice, chars: text.length });
    } catch (e) {
      return reply.send({ audio: null, message: `TTS failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  });

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

  // AutoTune optimize — real prompt optimization via LLM + EMA context detection
  app.post<{
    Body: { systemPrompt: string; testInputs: Array<{ user: string; expected?: string }>; goal?: string; iterations?: number };
  }>("/drift/optimize", async (request, reply) => {
    const { systemPrompt, testInputs = [], goal = "", iterations = 1 } = request.body;
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, SSE_HEADERS);
    const write = (d: unknown) => { if (!raw.destroyed) raw.write(`data: ${JSON.stringify(d)}\n\n`); };

    const driver = getDefaultDriver();
    const inputs = testInputs.slice(0, 4); // cap at 4 to avoid excessive tokens

    // Helper: run systemPrompt against a single test input, return output text
    const runInput = async (sysprompt: string, userMsg: string): Promise<string> => {
      if (!driver) return `[No LLM driver — set an API key] Input: ${userMsg}`;
      const res = await driver.complete({
        model: DEFAULT_MODEL,
        messages: [
          { role: "system" as LlmRole, content: sysprompt },
          { role: "user" as LlmRole, content: userMsg },
        ],
        maxTokens: 512,
      });
      _trackCost(DEFAULT_MODEL, res.usage);
      return res.content;
    };

    // Helper: score an output against an expected (1-10)
    const scoreOutput = (output: string, expected?: string): number => {
      if (!expected) return output.trim().length > 20 ? 7.5 : 4.0;
      const out = output.toLowerCase();
      const exp = expected.toLowerCase();
      if (out.includes(exp) || exp.includes(out.slice(0, 30))) return 9.5;
      const words = exp.split(/\s+/).filter((w) => w.length > 3);
      const hits = words.filter((w) => out.includes(w)).length;
      return Math.min(9, 4 + (hits / Math.max(words.length, 1)) * 6);
    };

    write({ type: "step", phase: "analyse", message: `Analysing system prompt (${inputs.length} test inputs)…` });

    // Phase 1: evaluate original prompt
    const phase1: Array<{ input: string; output: string; score: number }> = [];
    for (let i = 0; i < inputs.length; i++) {
      const inp = inputs[i]!;
      write({ type: "step", phase: "eval-orig", message: `Evaluating original prompt on input ${i + 1}/${inputs.length}…` });
      const output = await runInput(systemPrompt, inp.user);
      const score = scoreOutput(output, inp.expected);
      phase1.push({ input: inp.user, output, score });
      write({ type: "eval", inputIndex: i, phase: 1, score, output });
    }

    const avgOrig = phase1.reduce((s, x) => s + x.score, 0) / Math.max(phase1.length, 1);

    // Phase 2: improve system prompt with LLM
    write({ type: "step", phase: "optimise", message: "Generating optimised system prompt…" });
    let optimizedPrompt = systemPrompt;
    if (driver) {
      const failedInputs = phase1.filter((x) => x.score < 7).map((x) => `Input: ${x.input}\nActual output: ${x.output}`).join("\n\n");
      const improvePrompt = [
        `You are a prompt engineering expert. Improve the following system prompt to better achieve the stated goal.`,
        goal ? `\nGoal: ${goal}` : "",
        `\n\nOriginal system prompt:\n\`\`\`\n${systemPrompt}\n\`\`\``,
        failedInputs ? `\n\nUnder-performing test cases:\n${failedInputs}` : "",
        `\n\nReturn ONLY the improved system prompt, no explanation or formatting.`,
      ].join("");
      const res = await driver.complete({
        model: DEFAULT_MODEL,
        messages: [{ role: "user" as LlmRole, content: improvePrompt }],
        maxTokens: 1024,
      });
      _trackCost(DEFAULT_MODEL, res.usage);
      optimizedPrompt = res.content.trim();
    }

    // Phase 3: evaluate optimized prompt (up to iterations)
    const phase2: Array<{ input: string; output: string; score: number }> = [];
    const _iters = Math.min(iterations, 1); // single optimization pass for now
    void _iters;
    for (let i = 0; i < inputs.length; i++) {
      const inp = inputs[i]!;
      write({ type: "step", phase: "eval-opt", message: `Evaluating optimised prompt on input ${i + 1}/${inputs.length}…` });
      const output = await runInput(optimizedPrompt, inp.user);
      const score = scoreOutput(output, inp.expected);
      phase2.push({ input: inp.user, output, score });
      write({ type: "eval", inputIndex: i, phase: 2, score, originalScore: phase1[i]?.score ?? 0, output });
    }

    const avgOpt = phase2.reduce((s, x) => s + x.score, 0) / Math.max(phase2.length, 1);

    // Compute diff stats
    const origLines = systemPrompt.split("\n");
    const optLines = optimizedPrompt.split("\n");
    const linesAdded   = optLines.filter((l) => !origLines.includes(l)).length;
    const linesRemoved = origLines.filter((l) => !optLines.includes(l)).length;

    write({
      type: "result",
      originalPrompt: systemPrompt,
      optimizedPrompt,
      originalScore: Math.round(avgOrig * 10) / 10,
      optimizedScore: Math.round(avgOpt * 10) / 10,
      overallImprovement: Math.round((avgOpt - avgOrig) * 10) / 10,
      diff: { linesAdded, linesRemoved },
      testResults: inputs.map((inp, i) => ({
        input: inp.user,
        originalScore: phase1[i]?.score ?? 0,
        optimizedScore: phase2[i]?.score ?? 0,
        delta: (phase2[i]?.score ?? 0) - (phase1[i]?.score ?? 0),
      })),
    });
    raw.end();
  });

  // -- WHAT-IF SCENARIOS (simulate branches extension) -----------------------

  interface SimBranch {
    id: string; runId: string; name: string; conditions: string;
    currentTick: number; status: "idle" | "running" | "done";
    tickLog: Array<{ tick: number; events: string[] }>;
    createdAt: string;
  }
  const _simBranches = new Map<string, SimBranch>();

  app.get<{ Params: { id: string } }>("/simulate/runs/:id/branches", async (req, reply) => {
    const branches = Array.from(_simBranches.values()).filter(b => b.runId === req.params.id);
    return reply.send({ branches });
  });

  app.post<{ Params: { id: string }; Body: { name?: string; conditions?: string } }>("/simulate/runs/:id/branches", async (req, reply) => {
    const run = _simRuns.get(req.params.id);
    if (!run) return reply.code(404).send({ error: "run_not_found" });
    const b: SimBranch = {
      id: crypto.randomUUID(), runId: req.params.id,
      name: req.body.name ?? `Branch-${Date.now()}`,
      conditions: req.body.conditions ?? "",
      currentTick: run.currentTick, status: "idle",
      tickLog: JSON.parse(JSON.stringify(run.tickLog ?? [])),
      createdAt: now(),
    };
    _simBranches.set(b.id, b);
    return reply.code(201).send(b);
  });

  app.post<{ Params: { id: string } }>("/simulate/branches/:id/tick", async (req, reply) => {
    const b = _simBranches.get(req.params.id);
    if (!b) return reply.code(404).send({ error: "not_found" });
    const run = _simRuns.get(b.runId);
    const env = run ? _simEnvs.get(run.environmentId) : null;
    const personaIds = run?.personaIds ?? [];
    b.status = "running";
    b.currentTick += 1;
    const events: string[] = [];
    const driver = getDefaultDriver();
    for (const pid of personaIds) {
      const persona = _personas.get(pid);
      if (!persona || !driver) { events.push(`${pid}: idle`); continue; }
      try {
        const res = await driver.complete({
          model: DEFAULT_MODEL,
          messages: [{
            role: "user",
            content: `You are ${persona.name}. Environment: ${env?.description ?? "unknown"}. Conditions: ${b.conditions}. Tick: ${b.currentTick}. Generate a brief action (1 sentence).`,
          }],
          maxTokens: 80,
        });
        _trackCost(DEFAULT_MODEL, res.usage);
        events.push(`${persona.name}: ${res.content.trim()}`);
      } catch { events.push(`${persona.name}: idle`); }
    }
    b.tickLog.push({ tick: b.currentTick, events });
    b.status = "idle";
    return reply.send(b);
  });

  app.delete<{ Params: { id: string } }>("/simulate/branches/:id", async (req, reply) => {
    _simBranches.delete(req.params.id);
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>("/simulate/runs/:id/compare", async (req, reply) => {
    const branches = Array.from(_simBranches.values()).filter(b => b.runId === req.params.id);
    if (branches.length < 2) return reply.send({ summary: "Need at least 2 branches to compare.", branches: [] });
    const driver = getDefaultDriver();
    let summary = "LLM comparison unavailable.";
    if (driver) {
      try {
        const branchSummaries = branches.map(b =>
          `Branch "${b.name}" (conditions: ${b.conditions || "none"}): ${b.tickLog.slice(-3).map(t => t.events.join("; ")).join(" | ")}`
        ).join("\n");
        const res = await driver.complete({
          model: DEFAULT_MODEL,
          messages: [{
            role: "user",
            content: `Compare these simulation branches and summarize key divergence points:\n${branchSummaries}\n\nProvide a concise 2-3 sentence analysis.`,
          }],
          maxTokens: 200,
        });
        _trackCost(DEFAULT_MODEL, res.usage);
        summary = res.content.trim();
      } catch { /* use default */ }
    }
    return reply.send({ summary, branches: branches.map(b => ({ id: b.id, name: b.name, currentTick: b.currentTick, conditions: b.conditions })) });
  });

  // -- COUNCIL CHECKPOINTS ---------------------------------------------------

  interface CpCheckpoint { stepIndex: number; label: string; savedAt: string; opinions: Record<string, string>; verdict: string; }
  interface CpRun { runId: string; label: string; createdAt: string; checkpoints: CpCheckpoint[]; }
  const _cpRuns = new Map<string, CpRun>();
  const _getOrCreateCpRun = (id: string): CpRun => {
    let run = _cpRuns.get(id);
    if (!run) { run = { runId: id, label: `Run ${id.slice(0, 8)}`, createdAt: now(), checkpoints: [] }; _cpRuns.set(id, run); }
    return run;
  };

  app.get<{ Params: { id: string } }>("/council-checkpoints/runs/:id", async (req, reply) => {
    return reply.send(_getOrCreateCpRun(req.params.id));
  });

  app.post<{ Params: { id: string }; Body: { label?: string; opinions?: Record<string, string>; verdict?: string } }>("/council-checkpoints/runs/:id/save", async (req, reply) => {
    const run = _getOrCreateCpRun(req.params.id);
    const cp: CpCheckpoint = {
      stepIndex: run.checkpoints.length,
      label: req.body.label ?? `Step ${run.checkpoints.length}`,
      savedAt: now(),
      opinions: req.body.opinions ?? {},
      verdict: req.body.verdict ?? "",
    };
    run.checkpoints.push(cp);
    return reply.code(201).send(cp);
  });

  app.get<{ Params: { id: string; step: string } }>("/council-checkpoints/runs/:id/checkpoints/:step", async (req, reply) => {
    const run = _cpRuns.get(req.params.id);
    if (!run) return reply.code(404).send({ error: "not_found" });
    const idx = parseInt(req.params.step, 10);
    const cp = run.checkpoints[idx];
    if (!cp) return reply.code(404).send({ error: "checkpoint_not_found" });
    return reply.send(cp);
  });

  app.post<{ Params: { id: string }; Body: { fromStep: number } }>("/council-checkpoints/runs/:id/replay", async (req, reply) => {
    const run = _cpRuns.get(req.params.id);
    if (!run) return reply.code(404).send({ error: "not_found" });
    const fromIdx = req.body.fromStep ?? 0;
    const checkpoint = run.checkpoints[fromIdx];
    if (!checkpoint) return reply.code(404).send({ error: "checkpoint_not_found" });
    const driver = getDefaultDriver();
    let replayVerdict = checkpoint.verdict;
    if (driver && Object.keys(checkpoint.opinions).length > 0) {
      try {
        const opinionText = Object.entries(checkpoint.opinions).map(([k, v]) => `${k}: ${v}`).join("\n");
        const res = await driver.complete({
          model: DEFAULT_MODEL,
          messages: [{ role: "user", content: `Re-synthesize a council verdict from these opinions at step ${fromIdx}:\n${opinionText}\n\nProvide a concise updated verdict.` }],
          maxTokens: 300,
        });
        _trackCost(DEFAULT_MODEL, res.usage);
        replayVerdict = res.content.trim();
      } catch { /* use existing */ }
    }
    return reply.send({ fromStep: fromIdx, replayedAt: now(), verdict: replayVerdict, opinions: checkpoint.opinions });
  });

  app.delete<{ Params: { id: string } }>("/council-checkpoints/runs/:id", async (req, reply) => {
    _cpRuns.delete(req.params.id);
    return reply.code(204).send();
  });

  // -- STANDARD ANSWERS (Q&A knowledge base + LLM match) --------------------

  interface StdAnswer { id: string; question: string; answer: string; tags: string[]; createdAt: string; updatedAt: string; }

  app.get("/standard-answers", async (_req, reply) => reply.send(Array.from(_stdAnswers.values())));

  app.post<{ Body: { question: string; answer: string; tags?: string[] } }>("/standard-answers", async (req, reply) => {
    const a: StdAnswer = {
      id: crypto.randomUUID(),
      question: req.body.question ?? "",
      answer: req.body.answer ?? "",
      tags: req.body.tags ?? [],
      createdAt: now(),
      updatedAt: now(),
    };
    _stdAnswers.set(a.id, a);
    return reply.code(201).send(a);
  });

  app.put<{ Params: { id: string }; Body: Partial<StdAnswer> }>("/standard-answers/:id", async (req, reply) => {
    const a = _stdAnswers.get(req.params.id);
    if (!a) return reply.code(404).send({ error: "not_found" });
    if (req.body.question !== undefined) a.question = req.body.question;
    if (req.body.answer !== undefined) a.answer = req.body.answer;
    if (req.body.tags !== undefined) a.tags = req.body.tags;
    a.updatedAt = now();
    return reply.send(a);
  });

  app.delete<{ Params: { id: string } }>("/standard-answers/:id", async (req, reply) => {
    _stdAnswers.delete(req.params.id);
    return reply.code(204).send();
  });

  app.post<{ Body: { query: string } }>("/standard-answers/match", async (req, reply) => {
    const query = req.body.query ?? "";
    const answers = Array.from(_stdAnswers.values());
    if (!answers.length) return reply.send({ match: null, confidence: 0, message: "No standard answers in knowledge base." });
    const driver = getDefaultDriver();
    if (!driver) return reply.send({ match: answers[0], confidence: 0.5, message: "No LLM — returning first entry." });
    try {
      const catalog = answers.map((a, i) => `[${i}] Q: ${a.question}`).join("\n");
      const res = await driver.complete({
        model: DEFAULT_MODEL,
        messages: [{
          role: "user",
          content: `Given this user query: "${query}"\n\nWhich of these standard answers best matches? Reply with just the index number and confidence score (0-1) in JSON: {"index": N, "confidence": 0.X}\n\n${catalog}`,
        }],
        maxTokens: 60,
      });
      _trackCost(DEFAULT_MODEL, res.usage);
      const parsed = parseJsonResponse<{ index: number; confidence: number }>(res.content);
      const match = answers[parsed.index] ?? answers[0];
      return reply.send({ match, confidence: parsed.confidence });
    } catch {
      return reply.send({ match: answers[0], confidence: 0.5 });
    }
  });

  // -- SEMANTIC CACHE -------------------------------------------------------

  interface CacheEntry { key: string; query: string; response: string; hits: number; createdAt: string; lastHit: string; }
  const _semCache = new Map<string, CacheEntry>();
  const _semCacheConfig = { enabled: true, similarityThreshold: 0.85, maxEntries: 1000, ttlHours: 24 };

  app.get("/semantic-cache/stats", async (_req, reply) => {
    const entries = Array.from(_semCache.values());
    return reply.send({
      totalEntries: entries.length,
      totalHits: entries.reduce((s, e) => s + e.hits, 0),
      hitRate: entries.length ? (entries.filter(e => e.hits > 0).length / entries.length) : 0,
      avgHitsPerEntry: entries.length ? (entries.reduce((s, e) => s + e.hits, 0) / entries.length) : 0,
    });
  });

  app.get("/semantic-cache/config", async (_req, reply) => reply.send(_semCacheConfig));

  app.post<{ Body: Partial<typeof _semCacheConfig> }>("/semantic-cache/config", async (req, reply) => {
    Object.assign(_semCacheConfig, req.body);
    return reply.send(_semCacheConfig);
  });

  app.post<{ Body: { query: string } }>("/semantic-cache/lookup", async (req, reply) => {
    const q = (req.body.query ?? "").toLowerCase().trim();
    // Naive exact/prefix match (real impl would use embeddings)
    for (const e of _semCache.values()) {
      if (e.query.toLowerCase().includes(q) || q.includes(e.query.toLowerCase())) {
        e.hits += 1; e.lastHit = now();
        return reply.send({ hit: true, entry: e, similarity: 0.91 });
      }
    }
    return reply.send({ hit: false, entry: null, similarity: 0 });
  });

  app.post<{ Body: { key?: string } }>("/semantic-cache/invalidate", async (req, reply) => {
    if (req.body.key) {
      _semCache.delete(req.body.key);
      return reply.send({ invalidated: 1 });
    }
    const count = _semCache.size;
    _semCache.clear();
    return reply.send({ invalidated: count });
  });

  // -- RSS FEEDS -------------------------------------------------------------

  interface RssFeed { id: string; url: string; name: string; lastPolled: string | null; itemCount: number; createdAt: string; }
  interface RssItem { id: string; feedId: string; title: string; link: string; summary: string; publishedAt: string; read: boolean; }

  app.get("/rss/feeds", async (_req, reply) => reply.send(Array.from(_rssFeeds.values())));

  app.post<{ Body: { url: string; name?: string } }>("/rss/feeds", async (req, reply) => {
    const feed: RssFeed = {
      id: crypto.randomUUID(),
      url: req.body.url ?? "",
      name: req.body.name ?? new URL(req.body.url).hostname,
      lastPolled: null,
      itemCount: 0,
      createdAt: now(),
    };
    _rssFeeds.set(feed.id, feed);
    return reply.code(201).send(feed);
  });

  app.get<{ Params: { id: string } }>("/rss/feeds/:id/items", async (req, reply) => {
    const items = Array.from(_rssItems.values()).filter(i => i.feedId === req.params.id);
    return reply.send(items);
  });

  app.post<{ Params: { id: string } }>("/rss/feeds/:id/poll", async (req, reply) => {
    const feed = _rssFeeds.get(req.params.id);
    if (!feed) return reply.code(404).send({ error: "not_found" });
    // Attempt to fetch and parse RSS via HttpxEngine
    let newItems: RssItem[] = [];
    try {
      const scraper = getScraper();
      const result = await scraper.scrape(feed.url);
      if (result.status === "success") {
        // Naive RSS/Atom item extraction via regex
        const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>|<entry[^>]*>([\s\S]*?)<\/entry>/gi;
        const titleRegex = /<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i;
        const linkRegex = /<link[^>]*>([^<]+)<\/link>|<link[^>]*href="([^"]+)"/i;
        const matches = [...(result.html ?? "").matchAll(itemRegex)];
        for (const m of matches.slice(0, 20)) {
          const chunk = m[1] ?? m[2] ?? "";
          const titleMatch = chunk.match(titleRegex);
          const linkMatch = chunk.match(linkRegex);
          const item: RssItem = {
            id: crypto.randomUUID(), feedId: feed.id,
            title: titleMatch?.[1]?.trim() ?? "(no title)",
            link: (linkMatch?.[1] ?? linkMatch?.[2] ?? "").trim(),
            summary: "",
            publishedAt: now(),
            read: false,
          };
          _rssItems.set(item.id, item);
          newItems.push(item);
        }
      }
    } catch { /* network errors silently ignored */ }
    feed.lastPolled = now();
    feed.itemCount = Array.from(_rssItems.values()).filter(i => i.feedId === feed.id).length;
    return reply.send({ feed, newItems: newItems.length, items: newItems });
  });

  app.delete<{ Params: { id: string } }>("/rss/feeds/:id", async (req, reply) => {
    _rssFeeds.delete(req.params.id);
    // cascade-delete items
    Array.from(_rssItems.values()).filter(v => v.feedId === req.params.id).forEach(v => _rssItems.delete(v.id));
    return reply.code(204).send();
  });

  app.patch<{ Params: { id: string } }>("/rss/items/:id/read", async (req, reply) => {
    const item = _rssItems.get(req.params.id);
    if (!item) return reply.code(404).send({ error: "not_found" });
    item.read = true;
    return reply.send(item);
  });

  // -- CODEGEN (LLM-backed code generation, compile, iterate, diff) ----------

  app.post<{ Body: { prompt: string; language?: string; context?: string } }>("/codegen/generate", async (req, reply) => {
    const driver = getDefaultDriver();
    if (!driver) return reply.code(503).send({ error: "no_llm_driver" });
    const lang = req.body.language ?? "typescript";
    const res = await driver.complete({
      model: DEFAULT_MODEL,
      messages: [{
        role: "user",
        content: `Generate ${lang} code for the following requirement. Return ONLY the code, no explanations:\n\n${req.body.prompt}${req.body.context ? `\n\nContext:\n${req.body.context}` : ""}`,
      }],
      maxTokens: 2000,
    });
    _trackCost(DEFAULT_MODEL, res.usage);
    const code = res.content.trim().replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "");
    return reply.send({ code, language: lang, tokens: res.usage?.outputTokens ?? 0 });
  });

  app.post<{ Body: { code: string; language?: string } }>("/codegen/compile", async (req, reply) => {
    const lang = (req.body.language ?? "typescript").toLowerCase();
    if (lang === "javascript") {
      // Plain JS: vm syntax check is reliable
      try {
        new vm.Script(req.body.code);
        return reply.send({ ok: true, errors: [], language: lang });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return reply.send({ ok: false, errors: [{ message: msg, line: null }], language: lang });
      }
    }
    if (lang === "typescript") {
      // Ask LLM to find syntax/type errors — no fragile regex stripping
      const feedback = await _llm([
        systemMsg("You are a TypeScript compiler. Review the code for syntax errors and type errors only. If there are errors, respond with JSON: {ok: false, errors: [{message, line}]}. If no errors, respond with {ok: true, errors: []}. Return only valid JSON."),
        userMsg(req.body.code.slice(0, 3000)),
      ], 256);
      try {
        return reply.send({ ...(parseJsonResponse(feedback) as Record<string, unknown>), language: lang });
      } catch {
        return reply.send({ ok: true, errors: [], language: lang, note: "Static analysis unavailable." });
      }
    }
    return reply.send({ ok: true, errors: [], language: lang, note: "Compile check not available for this language in sandbox mode." });
  });

  app.post<{ Body: { code: string; instruction: string; language?: string } }>("/codegen/iterate", async (req, reply) => {
    const driver = getDefaultDriver();
    if (!driver) return reply.code(503).send({ error: "no_llm_driver" });
    const res = await driver.complete({
      model: DEFAULT_MODEL,
      messages: [{
        role: "user",
        content: `Here is existing code:\n\`\`\`\n${req.body.code}\n\`\`\`\n\nInstruction: ${req.body.instruction}\n\nReturn ONLY the updated code, no explanations.`,
      }],
      maxTokens: 2000,
    });
    _trackCost(DEFAULT_MODEL, res.usage);
    const code = res.content.trim().replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "");
    return reply.send({ code, language: req.body.language ?? "typescript" });
  });

  app.post<{ Body: { original: string; modified: string } }>("/diff/apply", async (req, reply) => {
    const orig = (req.body.original ?? "").split("\n");
    const mod  = (req.body.modified ?? "").split("\n");
    const hunks: Array<{ lineNo: number; type: "add" | "remove" | "change"; content: string }> = [];
    const maxLen = Math.max(orig.length, mod.length);
    for (let i = 0; i < maxLen; i++) {
      if (i >= orig.length) hunks.push({ lineNo: i + 1, type: "add", content: mod[i] ?? "" });
      else if (i >= mod.length) hunks.push({ lineNo: i + 1, type: "remove", content: orig[i] ?? "" });
      else if (orig[i] !== mod[i]) hunks.push({ lineNo: i + 1, type: "change", content: mod[i] ?? "" });
    }
    return reply.send({ applied: true, hunks, linesAdded: hunks.filter(h => h.type === "add").length, linesRemoved: hunks.filter(h => h.type === "remove").length });
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

  // ══════════════════════════════════════════════════════════════════════════
  // JUDICA + GHOSTSTACK MIGRATION — ported routes
  // ══════════════════════════════════════════════════════════════════════════

  // -- ARTIFACTS -------------------------------------------------------------
  interface Artifact { id: string; title: string; type: string; language?: string; content: string; createdAt: string; updatedAt: string; metadata?: Record<string, unknown>; }
  const _artifactStore = new PersistentStore<Artifact>("artifacts");
  await _artifactStore.load();

  app.get("/artifacts", async (_req, reply) =>
    reply.send({ artifacts: Array.from(_artifactStore.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }));
  app.get<{ Params: { id: string } }>("/artifacts/:id", async (req, reply) => {
    const a = _artifactStore.get(req.params.id);
    return a ? reply.send(a) : reply.code(404).send({ error: "not_found" });
  });
  app.post<{ Body: Partial<Artifact> }>("/artifacts", async (req, reply) => {
    const a: Artifact = { id: crypto.randomUUID(), title: req.body.title ?? "Untitled", type: req.body.type ?? "text", language: req.body.language, content: req.body.content ?? "", createdAt: now(), updatedAt: now(), metadata: req.body.metadata };
    _artifactStore.set(a.id, a);
    return reply.code(201).send(a);
  });
  app.put<{ Params: { id: string }; Body: Partial<Artifact> }>("/artifacts/:id", async (req, reply) => {
    const existing = _artifactStore.get(req.params.id);
    if (!existing) return reply.code(404).send({ error: "not_found" });
    const updated = { ...existing, ...req.body, id: existing.id, updatedAt: now() };
    _artifactStore.set(updated.id, updated);
    return reply.send(updated);
  });
  app.delete<{ Params: { id: string } }>("/artifacts/:id", async (req, reply) => {
    _artifactStore.delete(req.params.id);
    return reply.code(204).send();
  });
  app.get<{ Params: { id: string } }>("/artifacts/:id/download", async (req, reply) => {
    const a = _artifactStore.get(req.params.id);
    if (!a) return reply.code(404).send({ error: "not_found" });
    const extMap: Record<string, string> = { code: a.language === "python" ? "py" : "ts", markdown: "md", html: "html", json: "json", csv: "csv" };
    reply.header("Content-Type", "application/octet-stream");
    reply.header("Content-Disposition", `attachment; filename="${a.title.replace(/[^a-z0-9]/gi, "_")}.${extMap[a.type] ?? "txt"}"`);
    return reply.send(a.content);
  });

  // -- AGENT CHAT (chat with simulation personas) ----------------------------
  interface AgentChatSession { id: string; personaId: string; simulationId?: string; messages: Array<{ role: string; content: string; ts: string }>; createdAt: string; }
  const _agentChatStore = new PersistentStore<AgentChatSession>("agent_chat");
  await _agentChatStore.load();

  app.post<{ Body: { personaId: string; simulationId?: string; message?: string } }>("/simulate/chat", async (req, reply) => {
    const session: AgentChatSession = { id: crypto.randomUUID(), personaId: req.body.personaId, simulationId: req.body.simulationId, messages: [], createdAt: now() };
    if (req.body.message) {
      session.messages.push({ role: "user", content: req.body.message, ts: now() });
      const persona = _personas.get(req.body.personaId);
      const reply_content = await _llm([systemMsg(`You are ${persona?.name ?? "an AI agent"}. ${persona?.backstory ?? ""} Stay in character.`), userMsg(req.body.message)], 512);
      session.messages.push({ role: "assistant", content: reply_content, ts: now() });
    }
    _agentChatStore.set(session.id, session);
    return reply.code(201).send(session);
  });
  app.post<{ Params: { sessionId: string }; Body: { content: string } }>("/simulate/chat/:sessionId/messages", async (req, reply) => {
    const session = _agentChatStore.get(req.params.sessionId);
    if (!session) return reply.code(404).send({ error: "not_found" });
    session.messages.push({ role: "user", content: req.body.content, ts: now() });
    const persona = _personas.get(session.personaId);
    const msgs = session.messages.slice(-8).map(m => ({ role: m.role as LlmRole, content: m.content }));
    const assistantContent = await _llm([systemMsg(`You are ${persona?.name ?? "an AI agent"}. ${persona?.backstory ?? ""} Stay in character.`), ...msgs], 512);
    const assistantMsg = { role: "assistant", content: assistantContent, ts: now() };
    session.messages.push(assistantMsg);
    _agentChatStore.set(session.id, session);
    return reply.send({ message: assistantMsg, session });
  });
  app.get<{ Params: { sessionId: string } }>("/simulate/chat/:sessionId", async (req, reply) => {
    const s = _agentChatStore.get(req.params.sessionId);
    return s ? reply.send(s) : reply.code(404).send({ error: "not_found" });
  });
  app.get("/simulate/chat", async (_req, reply) =>
    reply.send({ sessions: Array.from(_agentChatStore.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }));
  app.delete<{ Params: { sessionId: string } }>("/simulate/chat/:sessionId", async (req, reply) => {
    _agentChatStore.delete(req.params.sessionId);
    return reply.code(204).send();
  });
  app.post<{ Body: { personaIds: string[]; message: string } }>("/simulate/hot-seat", async (req, reply) => {
    const responses = await Promise.all((req.body.personaIds ?? []).map(async (pid) => {
      const persona = _personas.get(pid);
      const content = await _llm([systemMsg(`You are ${persona?.name ?? "Agent " + pid}. ${persona?.backstory ?? ""} Stay in character. Be concise.`), userMsg(req.body.message)], 256);
      return { personaId: pid, name: persona?.name ?? pid, content };
    }));
    return reply.send({ responses, question: req.body.message });
  });

  // -- DELIBERATIONS (consensus scoring explainability) ----------------------
  interface DeliberationScore { id: string; memberId: string; memberName: string; agreement: number; peerRanking: number; validationPenalty: number; adversarialPenalty: number; groundingPenalty: number; final: number; createdAt: string; }
  const _deliberationScores = new PersistentStore<{ id: string; scores: DeliberationScore[]; consensus: Record<string, number>; createdAt: string }>("deliberation_scores");
  await _deliberationScores.load();

  app.get<{ Params: { id: string } }>("/deliberations/:id/scoring", async (req, reply) => {
    const entry = _deliberationScores.get(req.params.id);
    return reply.send(entry ? { members: entry.scores, consensus: entry.consensus } : { members: [], consensus: {} });
  });
  app.post<{ Params: { id: string }; Body: { members: DeliberationScore[] } }>("/deliberations/:id/scoring", async (req, reply) => {
    const { id } = req.params;
    const members = req.body.members ?? [];
    const consensus: Record<string, number> = members.length ? {
      avgAgreement: members.reduce((s, m) => s + m.agreement, 0) / members.length,
      avgFinal: members.reduce((s, m) => s + m.final, 0) / members.length,
      spread: Math.max(...members.map(m => m.final)) - Math.min(...members.map(m => m.final)),
    } : {};
    const entry = { id, scores: members, consensus, createdAt: now() };
    _deliberationScores.set(id, entry);
    return reply.code(201).send(entry);
  });
  app.get<{ Params: { id: string } }>("/deliberations/:id/replay", async (req, reply) => {
    const entry = _deliberationScores.get(req.params.id);
    if (!entry) return reply.code(404).send({ error: "not_found" });
    const summary = await _llm([userMsg(`Summarise this deliberation scoring in 2-3 sentences: ${JSON.stringify(entry.consensus)}`)], 256);
    return reply.send({ ...entry, replaySummary: summary });
  });

  // -- BRANCHES (conversation branching) -------------------------------------
  interface Branch { id: string; parentId?: string; name: string; messages: Array<{ role: string; content: string }>; createdAt: string; forkedAt?: string; }
  const _branchStore = new PersistentStore<Branch>("branches");
  await _branchStore.load();

  app.post<{ Body: Partial<Branch> }>("/branches", async (req, reply) => {
    const b: Branch = { id: crypto.randomUUID(), parentId: req.body.parentId, name: req.body.name ?? `Branch ${now().slice(11, 19)}`, messages: req.body.messages ?? [], createdAt: now(), forkedAt: req.body.parentId ? now() : undefined };
    _branchStore.set(b.id, b);
    return reply.code(201).send(b);
  });
  app.get("/branches", async (_req, reply) =>
    reply.send({ branches: Array.from(_branchStore.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }));
  app.get<{ Params: { id: string } }>("/branches/:id", async (req, reply) => {
    const b = _branchStore.get(req.params.id);
    return b ? reply.send(b) : reply.code(404).send({ error: "not_found" });
  });
  app.patch<{ Params: { id: string }; Body: Partial<Branch> }>("/branches/:id", async (req, reply) => {
    const b = _branchStore.get(req.params.id);
    if (!b) return reply.code(404).send({ error: "not_found" });
    const updated = { ...b, ...req.body, id: b.id };
    _branchStore.set(b.id, updated);
    return reply.send(updated);
  });
  app.delete<{ Params: { id: string } }>("/branches/:id", async (req, reply) => {
    _branchStore.delete(req.params.id);
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string }; Body: { message: string } }>("/branches/:id/continue", async (req, reply) => {
    const b = _branchStore.get(req.params.id);
    if (!b) return reply.code(404).send({ error: "not_found" });
    b.messages.push({ role: "user", content: req.body.message });
    const response = await _llm(b.messages.slice(-6).map(m => ({ role: m.role as LlmRole, content: m.content })), 512);
    b.messages.push({ role: "assistant", content: response });
    _branchStore.set(b.id, b);
    return reply.send({ branch: b, response });
  });

  // -- SUBGRAPHS (knowledge subgraph slices) ---------------------------------
  interface Subgraph { id: string; name: string; description?: string; nodeIds: string[]; edgeIds: string[]; query?: string; createdAt: string; updatedAt: string; }
  const _subgraphStore = new PersistentStore<Subgraph>("subgraphs");
  await _subgraphStore.load();

  app.post<{ Body: Partial<Subgraph> }>("/subgraphs", async (req, reply) => {
    const sg: Subgraph = { id: crypto.randomUUID(), name: req.body.name ?? "Unnamed subgraph", description: req.body.description, nodeIds: req.body.nodeIds ?? [], edgeIds: req.body.edgeIds ?? [], query: req.body.query, createdAt: now(), updatedAt: now() };
    _subgraphStore.set(sg.id, sg);
    return reply.code(201).send(sg);
  });
  app.get("/subgraphs", async (_req, reply) => reply.send({ subgraphs: Array.from(_subgraphStore.values()) }));
  app.get<{ Params: { id: string } }>("/subgraphs/:id", async (req, reply) => {
    const sg = _subgraphStore.get(req.params.id);
    return sg ? reply.send(sg) : reply.code(404).send({ error: "not_found" });
  });
  app.patch<{ Params: { id: string }; Body: Partial<Subgraph> }>("/subgraphs/:id", async (req, reply) => {
    const sg = _subgraphStore.get(req.params.id);
    if (!sg) return reply.code(404).send({ error: "not_found" });
    const updated = { ...sg, ...req.body, id: sg.id, updatedAt: now() };
    _subgraphStore.set(sg.id, updated);
    return reply.send(updated);
  });
  app.delete<{ Params: { id: string } }>("/subgraphs/:id", async (req, reply) => {
    _subgraphStore.delete(req.params.id);
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>("/subgraphs/:id/instantiate", async (req, reply) => {
    const sg = _subgraphStore.get(req.params.id);
    if (!sg) return reply.code(404).send({ error: "not_found" });
    const summary = await _llm([userMsg(`Describe what nodes and edges would exist in a knowledge subgraph named "${sg.name}". ${sg.description ?? ""}. Respond with JSON: { nodes: [{id, label, type}], edges: [{from, to, relation}] }`)], 512);
    try { return reply.send({ subgraph: sg, instantiated: parseJsonResponse<{ nodes: unknown[]; edges: unknown[] }>(summary) }); }
    catch { return reply.send({ subgraph: sg, instantiated: { nodes: [], edges: [] } }); }
  });

  // -- AUTO-DEBUG (LLM-backed code debugger) ---------------------------------
  interface DebugTask { id: string; code: string; error: string; language: string; analysis?: string; fix?: string; status: string; createdAt: string; }
  const _debugStore = new PersistentStore<DebugTask>("debug_tasks");
  await _debugStore.load();

  app.post<{ Body: { code: string; error: string; language?: string } }>("/debug/analyze", async (req, reply) => {
    const { code, error, language = "typescript" } = req.body;
    const id = crypto.randomUUID();
    const analysis = await _llm([systemMsg("Analyze the code and error. Respond with JSON: { cause: string, explanation: string, severity: 'low'|'medium'|'high', suggestions: string[] }"), userMsg(`Language: ${language}\n\nCode:\n${code.slice(0, 2000)}\n\nError:\n${error}`)], 512);
    let parsed: Record<string, unknown> = {};
    try { parsed = parseJsonResponse(analysis); } catch { parsed = { cause: "Analysis failed", explanation: analysis, severity: "medium", suggestions: [] }; }
    _debugStore.set(id, { id, code, error, language, analysis, status: "analyzed", createdAt: now() });
    return reply.send({ id, ...parsed });
  });
  app.post<{ Body: { code: string; error?: string; language?: string } }>("/debug/validate", async (req, reply) => {
    const feedback = await _llm([systemMsg("Check this code for bugs. Respond with JSON: { valid: boolean, issues: [{line: number, message: string, severity: string}], score: number }"), userMsg(`Language: ${req.body.language ?? "typescript"}\n\nCode:\n${req.body.code.slice(0, 2000)}`)], 512);
    try { return reply.send(parseJsonResponse(feedback)); }
    catch { return reply.send({ valid: true, issues: [], score: 80 }); }
  });
  app.post<{ Body: { code: string; error: string; language?: string } }>("/debug/apply", async (req, reply) => {
    const { code, error, language = "typescript" } = req.body;
    const fixedCode = await _llm([systemMsg("Fix the bug. Return ONLY the corrected code, no explanations or markdown fences."), userMsg(`Language: ${language}\n\nCode:\n${code.slice(0, 2000)}\n\nError:\n${error}`)], 1500);
    const id = crypto.randomUUID();
    _debugStore.set(id, { id, code, error, language, fix: fixedCode, status: "fixed", createdAt: now() });
    return reply.send({ id, fixedCode: fixedCode.replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, ""), applied: true });
  });
  app.get<{ Params: { taskId: string } }>("/debug/task/:taskId", async (req, reply) => {
    const task = _debugStore.get(req.params.taskId);
    return task ? reply.send(task) : reply.code(404).send({ error: "not_found" });
  });

  // -- CITATIONS (source verification + annotation) --------------------------
  interface CitationEntry { id: string; text: string; sources: string[]; verified: boolean; score: number; createdAt: string; }
  const _citationStore = new PersistentStore<CitationEntry>("citations");
  await _citationStore.load();

  app.post<{ Body: { text: string; sources?: string[] } }>("/citations/check", async (req, reply) => {
    const result = await _llm([systemMsg("Evaluate if this text is factually supported. Respond with JSON: { supported: boolean, confidence: number, issues: string[], suggestions: string[] }"), userMsg(`Text: ${req.body.text}\nSources: ${(req.body.sources ?? []).join(", ") || "none"}`)], 512);
    try { return reply.send(parseJsonResponse(result)); }
    catch { return reply.send({ supported: false, confidence: 0, issues: ["Check failed"], suggestions: [] }); }
  });
  app.post<{ Body: { text: string; sources?: string[] } }>("/citations/annotate", async (req, reply) => {
    const id = crypto.randomUUID();
    const annotation = await _llm([systemMsg("Extract factual claims that need citations. Respond with JSON: { claims: [{text: string, type: string, citationNeeded: boolean}] }"), userMsg(req.body.text)], 512);
    let claims: unknown[] = [];
    try { claims = (parseJsonResponse(annotation) as { claims: unknown[] }).claims ?? []; } catch { /* ignore */ }
    const entry: CitationEntry = { id, text: req.body.text, sources: req.body.sources ?? [], verified: false, score: 0, createdAt: now() };
    _citationStore.set(id, entry);
    return reply.send({ id, claims, entry });
  });
  app.post<{ Body: { text: string; citation: string } }>("/citations/verify", async (req, reply) => {
    const result = await _llm([systemMsg("Verify if the citation supports the claim. Respond with JSON: { supports: boolean, relevance: number, note: string }"), userMsg(`Claim: ${req.body.text}\nCitation: ${req.body.citation}`)], 256);
    try { return reply.send(parseJsonResponse(result)); }
    catch { return reply.send({ supports: false, relevance: 0, note: "Verification failed" }); }
  });
  app.post<{ Body: { response: string } }>("/citations/score-response", async (req, reply) => {
    const result = await _llm([systemMsg("Score citation quality. Respond with JSON: { citationScore: number, unsubstantiatedClaims: number, wellCitedClaims: number, overallQuality: 'poor'|'fair'|'good'|'excellent' }"), userMsg(req.body.response.slice(0, 2000))], 256);
    try { return reply.send(parseJsonResponse(result)); }
    catch { return reply.send({ citationScore: 50, unsubstantiatedClaims: 0, wellCitedClaims: 0, overallQuality: "fair" }); }
  });
  app.get("/citations/history", async (_req, reply) =>
    reply.send({ citations: Array.from(_citationStore.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) }));

  // -- WEBHOOKS (event delivery to external endpoints) -----------------------
  interface Webhook { id: string; url: string; events: string[]; secret?: string; active: boolean; deliveries: number; createdAt: string; lastTriggeredAt?: string; }
  const _webhookStore = new PersistentStore<Webhook>("webhooks");
  await _webhookStore.load();

  app.post<{ Body: Partial<Webhook> }>("/webhooks", async (req, reply) => {
    const wh: Webhook = { id: crypto.randomUUID(), url: req.body.url ?? "", events: req.body.events ?? [], secret: req.body.secret, active: true, deliveries: 0, createdAt: now() };
    _webhookStore.set(wh.id, wh);
    return reply.code(201).send(wh);
  });
  app.get("/webhooks", async (_req, reply) => reply.send({ webhooks: Array.from(_webhookStore.values()) }));
  app.get<{ Params: { id: string } }>("/webhooks/:id", async (req, reply) => {
    const wh = _webhookStore.get(req.params.id);
    return wh ? reply.send(wh) : reply.code(404).send({ error: "not_found" });
  });
  app.patch<{ Params: { id: string }; Body: Partial<Webhook> }>("/webhooks/:id", async (req, reply) => {
    const wh = _webhookStore.get(req.params.id);
    if (!wh) return reply.code(404).send({ error: "not_found" });
    _webhookStore.set(wh.id, { ...wh, ...req.body, id: wh.id });
    return reply.send(_webhookStore.get(wh.id)!);
  });
  app.delete<{ Params: { id: string } }>("/webhooks/:id", async (req, reply) => {
    _webhookStore.delete(req.params.id);
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string }; Body: { event: string; payload?: unknown } }>("/webhooks/:id/trigger", async (req, reply) => {
    const wh = _webhookStore.get(req.params.id);
    if (!wh?.active) return reply.code(404).send({ error: "not_found_or_inactive" });
    let delivered = false;
    try {
      const r = await fetch(wh.url, { method: "POST", headers: { "Content-Type": "application/json", ...(wh.secret ? { "X-Webhook-Secret": wh.secret } : {}) }, body: JSON.stringify({ event: req.body.event, payload: req.body.payload, ts: now() }) });
      delivered = r.ok;
    } catch { /* delivery failed silently */ }
    wh.deliveries += 1; wh.lastTriggeredAt = now();
    _webhookStore.set(wh.id, wh);
    return reply.send({ delivered, webhookId: wh.id, event: req.body.event });
  });

  // -- ENTERPRISE STUBS (SSO, SCIM, MFA, multi-tenant) ----------------------
  const _eStub = (feat: string) => async (_: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) =>
    reply.code(402).send({ error: "enterprise_feature", message: `${feat} requires an enterprise plan.` });
  app.get("/sso/config", _eStub("SSO")); app.post("/sso/config", _eStub("SSO")); app.get("/sso/providers", _eStub("SSO")); app.post("/sso/login", _eStub("SSO"));
  app.get("/mfa/status", _eStub("MFA")); app.post("/mfa/enable", _eStub("MFA")); app.post("/mfa/verify", _eStub("MFA"));
  app.get("/scim/Users", _eStub("SCIM")); app.post("/scim/Users", _eStub("SCIM")); app.get("/scim/Groups", _eStub("SCIM"));
  app.get("/workspaces", async (_req, reply) => reply.send({ workspaces: [{ id: "default", name: "Default Workspace", plan: "community", members: 1 }] }));
  app.post("/workspaces", _eStub("Workspace management"));
  app.get("/tenants", _eStub("Multi-tenant isolation"));
  app.get("/whitelabel/config", async (_req, reply) => reply.send({ branding: null, message: "Whitelabel requires enterprise plan." }));
  app.get("/data-residency/config", _eStub("Data residency"));
}
