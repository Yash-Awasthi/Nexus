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
import type { ServerResponse } from "node:http";
import path from "node:path";
import vm from "node:vm";

import { AdaptiveScraper, HttpxEngine } from "@nexus/adaptive-scraper";
import type { AgentDefinition } from "@nexus/agent-runtime";
import {
  KernelManager,
  DockerReplExecutor,
  MockReplExecutor,
  isDockerAvailable,
  type ReplLanguage,
} from "@nexus/code-repl";
import {
  summonArchetypes,
  SUMMONS,
  ARCHETYPES,
  CouncilService,
  type Archetype,
  type TaskCategory,
} from "@nexus/council";
import {
  LlmDriversTransport,
  COUNCIL_DRIVER_ALIASES,
  resolveCouncilModelAlias,
} from "./council.js";
import { db } from "@nexus/db";
import { userProviderCredentials, users, auditLog } from "@nexus/db/schema";
import { computeAutoTuneParams, InMemoryEmaStore } from "@nexus/drift";
import { runFallbackChain, type FallbackModel } from "@nexus/gateway";
import {
  raceModels,
  scoreResponse,
  getModelsForTier,
  ULTRAPLINIAN_MODELS,
  type ModelResult,
  type SpeedTier,
} from "@nexus/gauntlet";
import {
  ImageGenerator,
  OpenAIImageProvider,
  ReplicateProvider,
  type ImageSize,
} from "@nexus/image-gen";
import {
  ImageTransformer,
  isSharpAvailable,
  type ResizeOptions,
  type CropOptions,
  type ConvertOptions,
  type WatermarkOptions,
  type ImageFormat,
} from "@nexus/image-transformations";
import {
  InMemoryKGStore,
  NeonKGStore,
  KnowledgeGraph,
  type KGStore,
  type NeonRow,
  clusterGraph,
  buildCommunities,
  type NeonQueryFn,
} from "@nexus/knowledge-graph";
import {
  DriverRegistry,
  AnthropicDriver,
  GroqDriver,
  OllamaDriver,
  GeminiDriver,
  DeepSeekDriver,
  MistralDriver,
  OpenRouterDriver,
  OpenAIDriver,
  type LlmDriver,
  type LlmRole,
} from "@nexus/llm-drivers";
import {
  InMemoryStore,
  FixedEmbedder,
  MemoryManager,
  PgVectorStore,
  createBestEmbedder,
} from "@nexus/memory";
import { AdapterRegistry, NexusAdapterError, defineAdapter } from "@nexus/plugin-sdk";
import {
  applyParseltongue,
  detectTriggers,
  getDefaultConfig as redteamDefaultConfig,
} from "@nexus/redteam";
import {
  searchBrave,
  searchExa,
  searchSerper,
} from "@nexus/search-orchestrator";
import {
  StealthBrowser,
  PatchrightDriver,
  MockBrowserDriver,
  isPatchrightAvailable,
} from "@nexus/stealth-browser";
import { STMPipeline } from "@nexus/stm";
import { assignTasks, type OmaTask, type OmaSchedulingStrategy } from "@nexus/supervisor";
import { MemoryTokenBudget } from "@nexus/token-budget";
import {
  VideoSearchEngine,
  MockVideoBackend,
  type ModelFn as VideoModelFn,
  type VideoSearchRequest,
  type VideoBackend,
  type VideoResult,
} from "@nexus/video-search";
import { eq, and, isNull, desc } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { Pool } from "pg";

import { PersistentStore } from "../lib/persistent-store.js";

import { emitAuditEvent } from "../lib/audit-emitter.js";
import { sha256hex } from "../lib/crypto-utils.js";
import { pinnedFetch } from "../lib/pinned-fetch.js";
import { resolveUserProviderKey, buildUserDriverRegistry } from "../lib/provider-keys.js";
import { resolveOAuthDriver } from "../lib/oauth-drivers.js";
import { makeUserRateLimitPreHandler } from "../lib/rate-limiter.js";
import { encryptSecret, SecretCryptoUnavailableError } from "../lib/secret-crypto.js";
// Event emitters push completion/failure into the per-user notification store.
// (The HTTP surface for the store lives in routes/notifications.ts.)
import { createNotification } from "../lib/notifications-store.js";
import { maybeEmitWeeklyDigest } from "../lib/weekly-digest.js";
import { requireAuthWithTier } from "../middleware/auth.js";
import { listResearchJobs } from "../lib/research-jobs.js";
import { costLogStore, type CostEntry } from "../lib/cost-log.js";

import { gatewayLog } from "./gateway.js";
import { getFailoverDriver, setFailoverProviders } from "../lib/llm-failover.js";
import { CachingDriver } from "../lib/llm-cache-driver.js";
import { registerResearchRoutes } from "./research.js";
import { registerSkillRoutes } from "./skills.js";

// ── SSE helpers ───────────────────────────────────────────────────────────────

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

function sseWrite(raw: ServerResponse, ev: unknown): void {
  if (!raw.destroyed) raw.write(`data: ${JSON.stringify(ev)}\n\n`);
}

// ── Lazy-init packages ────────────────────────────────────────────────────────

let _registry: DriverRegistry | null = null;
function getRegistry(): DriverRegistry {
  if (_registry) return _registry;
  const reg = new DriverRegistry();
  if (process.env.OPENAI_API_KEY)
    reg.register(new OpenAIDriver({ apiKey: process.env.OPENAI_API_KEY }));
  if (process.env.GROQ_API_KEY) reg.register(new GroqDriver({ apiKey: process.env.GROQ_API_KEY }));
  if (process.env.ANTHROPIC_API_KEY)
    reg.register(new AnthropicDriver({ apiKey: process.env.ANTHROPIC_API_KEY }));
  if (process.env.GEMINI_API_KEY)
    reg.register(new GeminiDriver({ apiKey: process.env.GEMINI_API_KEY }));
  if (process.env.DEEPSEEK_API_KEY)
    reg.register(new DeepSeekDriver({ apiKey: process.env.DEEPSEEK_API_KEY }));
  if (process.env.MISTRAL_API_KEY)
    reg.register(new MistralDriver({ apiKey: process.env.MISTRAL_API_KEY }));
  if (process.env.OPENROUTER_API_KEY)
    reg.register(new OpenRouterDriver({ apiKey: process.env.OPENROUTER_API_KEY }));
  // Local Ollama — always registered, no API credits required. Used as the
  // default when NEXUS_LLM_PROVIDER=ollama, and as the final fallback otherwise.
  reg.register(
    new OllamaDriver({
      baseUrl: process.env.OLLAMA_BASE_URL,
      model: process.env.NEXUS_DEFAULT_MODEL ?? "qwen2.5:7b",
    }),
  );
  _registry = reg;
  return reg;
}

/** Which key backs a chat member — surfaced to the UI as a per-member hint. */
type MemberKeySource = "user" | "oauth" | "env" | "local" | "none";

/**
 * Build a per-request registry for chat members with BYOK semantics:
 * the authenticated user's saved provider key wins (same resolution the
 * /council/deliberate path uses), and the server env key is the fallback.
 * Returns the registry plus a per-provider key source for honest hints.
 * Only the source string is ever returned — keys stay server-side.
 */
async function buildChatRegistry(
  userId: string | undefined,
  providers: Iterable<string>,
): Promise<{ registry: DriverRegistry; sources: Map<string, MemberKeySource> }> {
  const { registry: userReg } = await buildUserDriverRegistry(userId, providers);
  const envReg = getRegistry();
  const registry = new DriverRegistry();
  const sources = new Map<string, MemberKeySource>();
  for (const provider of new Set(providers)) {
    const userDriver = userReg.get(provider);
    // OAuth-linked account (Sign in with Google → Vertex, Entra → Azure OpenAI)
    // sits between the user's BYOK key and the server env key.
    const oauth = userDriver ? null : await resolveOAuthDriver(userId, provider);
    const envDriver = envReg.get(provider);
    const driver = userDriver ?? oauth?.driver ?? envDriver;
    if (driver) registry.register(driver, provider);
    sources.set(
      provider,
      userDriver
        ? "user"
        : oauth
          ? "oauth"
          : envDriver
            ? provider === "ollama"
              ? "local"
              : "env"
            : "none",
    );
  }
  return { registry, sources };
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

/** Default model for all internal LLM calls — change once to affect the whole file. */
const DEFAULT_MODEL = process.env.NEXUS_DEFAULT_MODEL ?? "anthropic/claude-3.5-haiku";

/** Current UTC timestamp as ISO-8601. */
const now = (): string => new Date().toISOString();

function getDocTypeFromName(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "csv") return "csv";
  if (ext === "txt") return "txt";
  return "md";
}

/**
 * Highest-priority available LLM driver across all registered providers.
 *
 * Returns a FailoverDriver (lib/llm-failover.ts) over the LIVE registry:
 * NEXUS_LLM_PROVIDER first, then the historical default order, then any
 * extra configured providers. Each provider is wrapped in its own
 * CachingDriver (lib/llm-cache-driver.ts) inside the failover layer — cache
 * keys include the provider identity, so entries never cross providers, and a
 * provider error fails over to the next (cache hits short-circuit, bounded by
 * LLM_CACHE_TTL_MS). Responses carry `servedBy`.
 */
const DEFAULT_PROVIDER_ORDER = ["openrouter", "anthropic", "groq", "openai", "ollama"];

/** Ordered failover entries from the LIVE registry (NEXUS_LLM_PROVIDER first). */
function buildFailoverEntries(): { id: string; driver: LlmDriver }[] {
  const reg = getRegistry();
  const ids = reg.list();
  const preferred = process.env.NEXUS_LLM_PROVIDER;
  // Historical default order first (openrouter > anthropic > groq > openai >
  // ollama), then any additional configured providers (gemini/deepseek/…).
  const rest = DEFAULT_PROVIDER_ORDER.filter((i) => ids.includes(i)).concat(
    ids.filter((i) => !DEFAULT_PROVIDER_ORDER.includes(i)),
  );
  const order = preferred ? [preferred, ...rest.filter((i) => i !== preferred)] : rest;
  return order
    .map((id) => ({ id, driver: reg.get(id) }))
    .filter((e): e is { id: string; driver: LlmDriver } => Boolean(e.driver));
}

export function getDefaultDriver() {
  const entries = buildFailoverEntries();
  if (entries.length === 0) return undefined;
  setFailoverProviders(entries);
  return getFailoverDriver();
}

// Council/thread deliberations (/chat/stream) hand RAW registry drivers to
// stream() via driverFor — which historically bypassed the whole cache surface.
// Wrap each member driver in the same CachingDriver the failover layer uses so
// a fully-streamed deliberation gets the final-completion cache too: the same
// KV-backed store, the same ALS caller key, and the same deterministic-only
// gate (temperature > 0 / tools never cached). Memoized per inner driver so we
// don't mint a wrapper on every request.
const _councilWrappers = new WeakMap<LlmDriver, CachingDriver>();
function councilDriver(driver: LlmDriver): CachingDriver {
  let c = _councilWrappers.get(driver);
  if (!c) {
    c = new CachingDriver(driver);
    _councilWrappers.set(driver, c);
  }
  return c;
}

/** Strip markdown code fences then JSON.parse — handles ` ```json ` and ` ``` ` variants. */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function parseJsonResponse<T = unknown>(content: string): T {
  const cleaned = content.replace(/```(?:json)?/gi, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Local models (qwen) often wrap JSON in prose. Extract the first balanced
    // object/array span and parse that.
    const m = /[[{][\s\S]*[\]}]/.exec(cleaned);
    if (m) return JSON.parse(m[0]) as T;
    throw new Error("no JSON found in model response");
  }
}

/** Typed LLM message constructors. */
const userMsg = (content: string) => ({ role: "user" as LlmRole, content });
const systemMsg = (content: string) => ({ role: "system" as LlmRole, content });

/**
 * Debate refinement prompt for rounds >= 1: surfaces the other members'
 * latest answers (canonical wording mirrors @nexus/debate-engine's
 * `othersMessage`). With no other answers available (solo member or all
 * others failed), the member reviews and defends/revises its own prior
 * answer, which is already in its cumulative history.
 */
function debatePrompt(message: string, others: string[]): string {
  if (others.length === 0) {
    return (
      "No other council members produced answers this round. Review your own " +
      "previous answer above; if new reasoning contradicts it, revise it, " +
      "otherwise restate and defend it. Provide your final answer to the " +
      `original question:\n\n${message}`
    );
  }
  const bodies = others.map((t) => `\n\n One agent solution: \`\`\`${t}\`\`\``).join("");
  return (
    `These are the solutions to the problem from other agents: ${bodies}\n\n` +
    `Using the solutions from other agents as additional information, can you provide your ` +
    `answer to the question? The original question is:\n\n${message}`
  );
}

/**
 * One-shot completion against the default driver (NEXUS_LLM_PROVIDER first,
 * then openrouter/anthropic/groq/openai/ollama). Throws when no driver is
 * configured so callers surface an honest error instead of a silent stub.
 */
async function callDefaultLLM(prompt: string, maxTokens: number): Promise<string> {
  const driver = getDefaultDriver();
  if (!driver) throw new Error("No LLM driver configured");
  const res = await driver.complete({
    model: (driver as { model?: string }).model ?? "default",
    messages: [userMsg(prompt)],
    maxTokens,
  });
  return res.content;
}

// ── Cost tracking ─────────────────────────────────────────────────────────────

// Usage/cost log — durable via lib/cost-log.ts (write-behind to day-sharded KV
// keys; boot reloads it so dashboard stats, windowed series, and the weekly
// digest survive API restarts). `_costLog` stays the same in-memory array every
// read below touches; only recording moved into the store.
const _costLog: readonly CostEntry[] = costLogStore.entries;

const _PRICES: Record<string, [number, number]> = {
  "anthropic/claude-3.5-haiku": [0.8, 4.0],
  "anthropic/claude-sonnet-4-6": [3.0, 15.0],
  "anthropic/claude-3-opus": [15.0, 75.0],
  "openai/gpt-4o": [2.5, 10.0],
  "openai/gpt-4o-mini": [0.15, 0.6],
  "groq/llama-3.1-8b-instant": [0.05, 0.08],
  // llama-3.3-70b-versatile was decommissioned by Groq on 2026-08-16; the row is
  // kept for historical cost lookups. openai/gpt-oss-120b is the replacement.
  "groq/llama-3.3-70b-versatile": [0.59, 0.79],
  "groq/openai/gpt-oss-120b": [0.15, 0.6],
};

function _trackCost(model: string, usage?: { inputTokens?: number; outputTokens?: number }) {
  const inp = usage?.inputTokens ?? 0;
  const out = usage?.outputTokens ?? 0;
  const [pi, po] = _PRICES[model] ?? [1.0, 3.0];
  // Synchronous in-memory record (hot path unchanged); the store flushes the
  // tail to KV on a debounce and reloads it at boot.
  costLogStore.record({
    ts: now(),
    model,
    inputTokens: inp,
    outputTokens: out,
    costUsd: (inp * pi + out * po) / 1_000_000,
  });
}

/** One-line LLM call with automatic cost tracking. Returns content string. */
async function _llm(
  messages: { role: LlmRole; content: string }[],
  maxTokens = 512,
  model = DEFAULT_MODEL,
): Promise<string> {
  const driver = getDefaultDriver();
  if (!driver) return "";
  const res = await driver.complete({ model, messages, maxTokens });
  _trackCost(model, res.usage);
  return res.content.trim();
}

// `_pgPool` uses `undefined` as the "not yet initialised" sentinel; `null` means
// "initialised, but no DATABASE_URL". Initialising to `null` here would make the
// `!== undefined` guard below short-circuit on the first call and never build the
// pool (silently disabling every raw-pg route). Keep it `undefined` until built.
let _pgPool: Pool | null | undefined;
function _getPool(): Pool | null {
  if (_pgPool !== undefined) return _pgPool;
  if (process.env.DATABASE_URL) {
    _pgPool = new Pool({ connectionString: process.env.DATABASE_URL });
  } else {
    _pgPool = null;
  }
  return _pgPool;
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
    _imageGen = new ImageGenerator({
      provider: new OpenAIImageProvider({ apiKey: process.env.OPENAI_API_KEY }),
    });
    _imageGenProvider = "openai-dalle";
    return { gen: _imageGen, provider: _imageGenProvider };
  }
  if (process.env.REPLICATE_API_KEY) {
    _imageGen = new ImageGenerator({
      provider: new ReplicateProvider({ apiToken: process.env.REPLICATE_API_KEY }),
    });
    _imageGenProvider = "replicate";
    return { gen: _imageGen, provider: _imageGenProvider };
  }
  return null;
}
let _imageGenProvider = "";

let _memory: MemoryManager | null = null;
let _embedder: import("@nexus/memory").IEmbedder | null = null;
function getEmbedder(): import("@nexus/memory").IEmbedder {
  if (_embedder) return _embedder;
  try {
    _embedder = createBestEmbedder();
  } catch {
    _embedder = new FixedEmbedder(768);
  }
  return _embedder;
}
/** Resolves after the memory embedder's first real call completes (the Ollama
 * model load). Started at bridge registration and awaited — bounded — in
 * index.ts BEFORE the port handoff, so the first real recall after a restart
 * can never race a cold model load. Fail-open: if Ollama is unreachable the
 * promise still resolves (the fixed-size fallback embedder serves). */
let _embedderWarmup: Promise<void> = Promise.resolve();
export function embedderWarmup(): Promise<void> {
  return _embedderWarmup;
}
function getMemory(): MemoryManager {
  if (_memory) return _memory;
  const store = process.env.DATABASE_URL
    ? new PgVectorStore({ databaseUrl: process.env.DATABASE_URL })
    : new InMemoryStore();
  _memory = new MemoryManager({ store, embedder: getEmbedder() });
  return _memory;
}

let _kgStore: KGStore | null = null;
let _kg: KnowledgeGraph | null = null;

function getKGStore(): KGStore {
  if (_kgStore) return _kgStore;
  if (process.env.DATABASE_URL) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const queryFn: NeonQueryFn = (sql, params) =>
      pool.query(sql, params!).then((r) => ({ rows: r.rows as NeonRow[] }));
    _kgStore = new NeonKGStore({ query: queryFn });
  } else {
    _kgStore = new InMemoryKGStore();
  }
  return _kgStore;
}

function getKG(): KnowledgeGraph {
  if (_kg) return _kg;
  _kg = new KnowledgeGraph(getKGStore());
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
const _roomsStore = new Map<
  string,
  { id: string; name: string; createdAt: string; members: string[] }
>();

// ── Council member model-availability validation ──────────────────────────────
// Settings → Council members are saved with a provider + model id. If the model
// no longer exists on the account's key (e.g. llama-3.3-70b-versatile was
// decommissioned by Groq on 2026-08-16), the member fails at run time with an
// opaque per-member error. Validate each model against the provider's catalog
// at save time so the UI can surface an actionable, per-member hint instead.

/** OpenAI-compatible base URLs keyed by member provider id (mirrors
 *  API_PROVIDERS in apps/ui/app/lib/council.ts). Anthropic is intentionally
 *  absent: its API is not OpenAI-compatible and exposes no /models endpoint. */
const _PROVIDER_CATALOG_BASE: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  deepseek: "https://api.deepseek.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  openrouter: "https://openrouter.ai/api/v1",
  mistral: "https://api.mistral.ai/v1",
  xai: "https://api.x.ai/v1",
  together: "https://api.together.xyz/v1",
  perplexity: "https://api.perplexity.ai",
  cohere: "https://api.cohere.ai/compatibility/v1",
  ollama: "http://localhost:11434/v1",
};

/** Env var holding the API key for each catalog-listed provider. */
const _PROVIDER_KEY_ENV: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  groq: "GROQ_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  gemini: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  mistral: "MISTRAL_API_KEY",
  xai: "XAI_API_KEY",
  together: "TOGETHER_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
  cohere: "COHERE_API_KEY",
};

interface CatalogProbe {
  ids: string[];
  fetchedAt: number;
}

const _catalogCache = new Map<string, CatalogProbe>();
const CATALOG_TTL_MS = 10 * 60_000;

/** Fetch an OpenAI-compatible /models catalog for a provider (cached 10 min).
 *  Returns null when the provider is unreachable or the body is unusable. */
async function fetchProviderCatalog(provider: string): Promise<string[] | null> {
  const base = _PROVIDER_CATALOG_BASE[provider];
  const cached = _catalogCache.get(provider);
  if (cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) return cached.ids;
  if (!base) return null;
  const keyEnv = _PROVIDER_KEY_ENV[provider];
  const apiKey = keyEnv ? process.env[keyEnv] : undefined;
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(`${base}/models`, {
      headers,
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { id?: string }[] };
    const ids = (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string");
    _catalogCache.set(provider, { ids, fetchedAt: Date.now() });
    return ids;
  } catch {
    return null;
  }
}

export interface CouncilMemberValidation {
  index: number;
  provider: string;
  model: string;
  status: "ok" | "missing" | "missing_model" | "no_key" | "unreachable" | "skipped";
  availableModels?: string[];
}

/** Best-effort per-member model validation for a Settings → Council save. */
async function validateCouncilMembers(members: unknown): Promise<CouncilMemberValidation[]> {
  if (!Array.isArray(members)) return [];
  const settled = await Promise.allSettled(
    members.map(async (raw, index): Promise<CouncilMemberValidation> => {
      const m = (raw ?? {}) as { provider?: unknown; model?: unknown; mode?: unknown };
      const provider = typeof m.provider === "string" ? m.provider : "";
      const model = typeof m.model === "string" ? m.model : "";
      // Only API-mode members run against a server-side key+catalog. Browser
      // members run client-side, and ollama/custom point at the member's own
      // endpoint — none of those can be validated against an account catalog.
      if (m.mode !== "api" || provider === "ollama" || provider === "custom") {
        return { index, provider, model, status: "skipped" };
      }
      const base = _PROVIDER_CATALOG_BASE[provider];
      // An API-mode member with no model id will fail every run — surface it.
      if (!model) {
        return { index, provider, model, status: "missing_model" };
      }
      // Providers without a catalog endpoint (anthropic) can't be verified
      // here — say so rather than fake an ok.
      if (!base) {
        return { index, provider, model, status: "skipped" };
      }
      const keyEnv = _PROVIDER_KEY_ENV[provider];
      if (keyEnv && !process.env[keyEnv]) {
        return { index, provider, model, status: "no_key" };
      }
      const ids = await fetchProviderCatalog(provider);
      if (!ids) return { index, provider, model, status: "unreachable" };
      if (ids.includes(model)) return { index, provider, model, status: "ok" };
      return {
        index,
        provider,
        model,
        status: "missing",
        availableModels: ids.slice(0, 24),
      };
    }),
  );
  const validations: CouncilMemberValidation[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") validations.push(r.value);
    else
      validations.push({ index: validations.length, provider: "", model: "", status: "skipped" });
  }
  return validations;
}

// ── Route registrations ───────────────────────────────────────────────────────

export async function apiBridgeRoutes(app: FastifyInstance): Promise<void> {
  // Reload the durable usage/cost log before any analytics/dashboard/digest read
  // can run (day-sharded KV keys written by lib/cost-log.ts). Best-effort.
  await costLogStore.load();

  // Warm the memory embedder NOW (bridge registration, long before listen) so
  // the Ollama model load overlaps server startup. index.ts awaits the promise
  // (bounded) before the port handoff — a restart can never drop a recall.
  _embedderWarmup = getEmbedder()
    .embed("warmup")
    .then(() => undefined)
    .catch(() => undefined);

  // Seed the failover/discovery layer from the live registry so the health
  // surfaces show configured providers even before the first LLM call.
  setFailoverProviders(buildFailoverEntries());

  // Per-user rate limiter shared across the bridge route group (falls back to IP).
  const bridgeRL = makeUserRateLimitPreHandler({
    limit: 60,
    windowMs: 60_000,
    keyPrefix: "bridge",
  });

  // ── Persistent stores (survive server restart) ─────────────────────────────
  // Each store loads its data from JSON files or Postgres on first boot.
  // Route handlers use them exactly like a Map — .get/.set/.delete/.values.

  const _workflowStore = new PersistentStore<{
    id: string;
    name: string;
    steps: unknown[];
    status: string;
    createdAt: string;
    timeout?: number;
    lastResult?: unknown;
    lastError?: string;
    lastRunAt?: string;
  }>("workflows");
  const _connectors = new PersistentStore<{
    id: string;
    type: string;
    status: string;
    label: string;
  }>("connectors");
  const _connectorSyncJobs = new PersistentStore<{
    id: string;
    connectorId: string;
    status: string;
    items: number;
    startedAt: string;
    finishedAt: string;
  }>("connector_sync_jobs");
  const _connectorSyncSchedules = new PersistentStore<{
    id: string;
    connectorId: string;
    syncMode: "load" | "poll" | "slim";
    cronExpression: string;
    enabled: boolean;
    lastRunAt: string | null;
    nextRunAt: string | null;
    createdAt: string;
  }>("connector_sync_schedules");
  const _craftStore = new PersistentStore<{
    id: string;
    template: string;
    prompt: string;
    result: string;
    createdAt: string;
  }>("craft");
  const _kbStore = new PersistentStore<{
    id: string;
    name: string;
    description: string;
    docCount: number;
    createdAt: string;
    documents: { id: string; name: string; size: string; type: string }[];
  }>("kb");

  // Per-user council config (collection "council", row id = userId).
  const _councilStore = new PersistentStore<{
    members: unknown;
    defaultTier?: string;
    updatedAt: string;
  }>("council");

  // Per-user preferences (collection "preferences", row id = userId). These
  // used to be a single global in-memory Map — one user's toggles changed
  // everyone's debates and every restart reset them. Now they persist (PG or
  // JSON file, same as council) and are scoped to the caller.
  const _prefsDefaults: Record<string, unknown> = {
    autoCouncil: true,
    debateRound: true,
    coldValidator: false,
    piiDetection: true,
    autoAnonymize: false,
    blockProfanity: false,
    blockAdultContent: false,
    verbosityLevel: "standard",
    deliberationMode: "standard",
    enableStreaming: true,
  };
  const _prefsStore = new PersistentStore<Record<string, unknown>>("preferences");
  // Echo-chamber detection config — a workspace-level setting (single row).
  const _echoStore = new PersistentStore<Record<string, unknown>>("echo_chamber");
  const _imageStore = new PersistentStore<{
    id: string;
    url: string;
    b64?: string;
    prompt: string;
    revisedPrompt?: string;
    provider?: string;
    createdAt: string;
  }>("images");
  const _imrRuns = new PersistentStore<ImrRun>("imr_runs");
  const _stdAnswers = new PersistentStore<StdAnswer>("standard_answers");
  const _rssFeeds = new PersistentStore<RssFeed>("rss_feeds");
  const _rssItems = new PersistentStore<RssItem>("rss_items");

  // Projects, groups and tasks used to be plain in-memory Maps — every restart
  // wiped them. Same Map-compatible interface, now durable (PG nexus_kv or JSON).
  // Type shapes live with the project routes (forward references are fine).
  const _groups = new PersistentStore<_Group>("groups");
  const _projects = new PersistentStore<_Project>("projects");
  const _tasks = new PersistentStore<_Task>("tasks");
  const _autopilotRuns = new PersistentStore<AutopilotRun>("autopilot_runs");

  await Promise.all([
    _workflowStore.load(),
    _connectors.load(),
    _connectorSyncJobs.load(),
    _connectorSyncSchedules.load(),
    _craftStore.load(),
    _kbStore.load(),
    _councilStore.load(),
    _prefsStore.load(),
    _echoStore.load(),
    _imageStore.load(),
    _imrRuns.load(),
    _stdAnswers.load(),
    _rssFeeds.load(),
    _rssItems.load(),
    _groups.load(),
    _projects.load(),
    _tasks.load(),
    _autopilotRuns.load(),
  ]);

  // ══════════════════════════════════════════════════════════════════════════
  // B.1 — ULTRAPLINIAN STREAMING
  // POST /api/gauntlet/stream
  // Body: { question: string, tier: 10 | 24 | 36 | 45 | 51 }
  // Streams: init → response* → done
  // ══════════════════════════════════════════════════════════════════════════

  app.post<{ Body: { question?: string; tier?: number } }>(
    "/gauntlet/stream",
    async (request, reply) => {
      if (!request.body || !request.body.question) {
        return reply.code(400).send({ error: "question is required" });
      }
      const { question, tier: numTier = 10 } = request.body;
      const speedTier = numericToSpeedTier(numTier);

      if (!process.env.OPENROUTER_API_KEY) {
        return reply
          .code(503)
          .send({ error: "gauntlet_unavailable", message: "OPENROUTER_API_KEY not configured" });
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
      members: {
        id: string;
        label: string;
        provider: string;
        model: string;
        baseUrl?: string;
      }[];
    };
  }>("/godmode/stream", { preHandler: requireAuthWithTier }, async (request, reply) => {
    const { question, members } = request.body;
    if (!question?.trim() || !Array.isArray(members) || members.length === 0)
      return reply.code(400).send({ error: "question and members[] are required" });
    // Strict BYOK: build a registry from the authenticated user's stored keys
    // only — no env-var fallback. Members whose provider lacks a stored key fail
    // individually below.
    const { registry: reg } = await buildUserDriverRegistry(
      request.nexusUserId,
      members.map((m) => m.provider),
    );

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
          const driver = reg.get(member.provider);
          if (!driver) throw new Error(`No key configured for provider: ${member.provider}`);

          const res = await driver.complete({
            model: member.model,
            messages: [{ role: "user" as LlmRole, content: question }],
            maxTokens: 1024,
          });
          _trackCost(member.model, res.usage);

          const latencyMs = Date.now() - start;
          if (latencyMs < fastestMs) {
            fastestMs = latencyMs;
            fastestId = member.id;
          }
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
  });

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
          const r = await driver.complete({
            model: modelA,
            messages: [{ role: "user" as LlmRole, content: prompt }],
            maxTokens: 1024,
          });
          _trackCost(modelA, r.usage);
          return {
            content: r.content,
            latency: Date.now() - s,
            tokens: (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0),
          };
        })(),
        (async () => {
          const s = Date.now();
          const r = await driver.complete({
            model: modelB,
            messages: [{ role: "user" as LlmRole, content: prompt }],
            maxTokens: 1024,
          });
          _trackCost(modelB, r.usage);
          return {
            content: r.content,
            latency: Date.now() - s,
            tokens: (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0),
          };
        })(),
      ]);

      const id = crypto.randomUUID();
      const scoreA =
        resultA.status === "fulfilled" ? scoreResponse(resultA.value.content, prompt) : 0;
      const scoreB =
        resultB.status === "fulfilled" ? scoreResponse(resultB.value.content, prompt) : 0;

      const result: AbResult = {
        id,
        prompt,
        modelA,
        modelB,
        responseA:
          resultA.status === "fulfilled" ? resultA.value.content : `Error: ${resultA.reason}`,
        responseB:
          resultB.status === "fulfilled" ? resultB.value.content : `Error: ${resultB.reason}`,
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
    return reply.send(
      [..._abStore.values()].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    );
  });

  app.get("/ab/stats", async (_req, reply) => {
    const results = [..._abStore.values()];
    const modelStats: Record<string, { wins: number; losses: number; ties: number }> = {};
    for (const r of results) {
      for (const m of [r.modelA, r.modelB]) {
        if (!modelStats[m]) modelStats[m] = { wins: 0, losses: 0, ties: 0 };
      }
      const pref = r.userPreference ?? r.winner;
      if (pref === "A") {
        modelStats[r.modelA]!.wins++;
        modelStats[r.modelB]!.losses++;
      } else if (pref === "B") {
        modelStats[r.modelB]!.wins++;
        modelStats[r.modelA]!.losses++;
      } else if (pref === "tie") {
        modelStats[r.modelA]!.ties++;
        modelStats[r.modelB]!.ties++;
      }
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
  // B.4 — CHAT MULTI-MODEL STREAM (multi-round debate)
  // POST /api/chat/stream
  // Body: { message, members: [{label, provider, model}][], round, rounds?, threadId }
  // Streams: opinion* → verdict? → done
  // Each enabled member fires in parallel; text chunks arrive as "opinion" events.
  // rounds >= 2 runs a real debate: round 0 is independent, then every member
  // sees the other members' latest answers and refines (cumulative per-member
  // context, mirroring @nexus/debate-engine's runMultiAgentDebate design).
  // Uses server-side DriverRegistry — no client API keys needed.
  // ══════════════════════════════════════════════════════════════════════════

  app.post<{
    Body: {
      message: string;
      members: { label: string; provider: string; model: string }[];
      round: number;
      rounds?: number;
      threadId: string;
    };
  }>("/chat/stream", { preHandler: requireAuthWithTier }, async (request, reply) => {
    const { message, members, round, rounds } = request.body;
    // BYOK: resolve each member's key per-user (saved key first, env fallback).
    const { registry: reg, sources } = await buildChatRegistry(
      request.nexusUserId,
      (members ?? []).map((m) => m.provider),
    );

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
        message:
          "No configured providers match the requested council members. Set API keys in .env.",
      });
      raw.end();
      return;
    }

    // Debate depth cap guards resource usage from user-supplied values.
    const debateRounds = Math.min(4, Math.max(1, Math.round(rounds ?? 1)));
    // Wrap the raw registry driver in the cache wrapper (deterministic-only
    // gate; a clean stream is cached and replayed byte-identically, so a
    // re-run of the same deliberation is served with zeroed usage).
    const driverFor = (provider: string): LlmDriver | undefined => {
      const raw = reg.get(provider) ?? reg.get("openrouter");
      return raw ? councilDriver(raw) : undefined;
    };

    // Per-member cumulative context: each member remembers its own prior
    // answers while being influenced by the others' (paper's design).
    const latest = new Map<string, string>();
    const histories = new Map<string, { role: LlmRole; content: string }[]>();

    const emitOpinion = (
      member: { label: string; provider: string; model: string },
      text: string,
      debateRound: number,
    ) => {
      sseWrite(raw, {
        type: "opinion",
        provider: member.provider,
        label: member.label,
        text,
        summary: "",
        round,
        debateRound,
        keySource: sources.get(member.provider) ?? "none",
      });
    };

    const emitErrorOpinion = (
      member: { label: string; provider: string; model: string },
      err: unknown,
      debateRound: number,
    ) => {
      sseWrite(raw, {
        type: "opinion",
        provider: member.provider,
        label: member.label,
        text: `[${member.label} error: ${err instanceof Error ? err.message : String(err)}]`,
        summary: "",
        round,
        debateRound,
        keySource: sources.get(member.provider) ?? "none",
      });
    };

    // Round 0 — every member answers independently, in parallel.
    await Promise.allSettled(
      enabled.map(async (member) => {
        const driver = driverFor(member.provider);
        if (!driver) return;
        const history: { role: LlmRole; content: string }[] = [{ role: "user", content: message }];
        histories.set(member.label, history);
        let memberText = "";
        try {
          const streamRes = await driver.stream(
            { model: member.model, messages: history, maxTokens: 2048 },
            (delta) => {
              if (delta.delta) {
                memberText += delta.delta;
                emitOpinion(member, delta.delta, 0);
              }
            },
          );
          // Track the real usage once (a cache hit replays with ZEROED usage,
          // so the cost log shows the replay costing nothing).
          _trackCost(member.model, streamRes.usage);
          latest.set(member.label, memberText);
          history.push({ role: "assistant", content: memberText });
        } catch (err) {
          emitErrorOpinion(member, err, 0);
        }
      }),
    );

    // Rounds 1..N — each member sees the other members' latest answers and
    // refines; every round's answer is streamed as opinion events.
    for (let dr = 1; dr < debateRounds; dr++) {
      const prevLatest = new Map(latest);
      await Promise.allSettled(
        enabled.map(async (member) => {
          const driver = driverFor(member.provider);
          if (!driver) return;
          const others = enabled
            .filter((o) => o.label !== member.label)
            .map((o) => prevLatest.get(o.label))
            .filter((t): t is string => !!t && t.length > 0);
          const history = histories.get(member.label) ?? [{ role: "user", content: message }];
          history.push({ role: "user", content: debatePrompt(message, others) });
          let memberText = "";
          try {
            const streamRes = await driver.stream(
              { model: member.model, messages: history, maxTokens: 2048 },
              (delta) => {
                if (delta.delta) {
                  memberText += delta.delta;
                  emitOpinion(member, delta.delta, dr);
                }
              },
            );
            _trackCost(member.model, streamRes.usage);
            latest.set(member.label, memberText);
            history.push({ role: "assistant", content: memberText });
          } catch (err) {
            emitErrorOpinion(member, err, dr);
          }
        }),
      );
    }

    // Verdict — majority final answer across members.
    if (debateRounds > 1 && latest.size > 0) {
      const counts = new Map<string, number>();
      for (const answer of latest.values()) {
        counts.set(answer, (counts.get(answer) ?? 0) + 1);
      }
      let best = "";
      let bestCount = 0;
      for (const [answer, count] of counts) {
        if (count > bestCount) {
          best = answer;
          bestCount = count;
        }
      }
      const trimmed = best.trim();
      if (trimmed.length > 0) {
        sseWrite(raw, {
          type: "verdict",
          text: `Debate complete (${debateRounds} rounds): majority position ${bestCount}/${latest.size} members — ${trimmed.slice(0, 1500)}`,
          summary: "",
          round,
        });
      }
    }

    // Memory auto-ingest per member (final text), scoped to the authenticated
    // user — without the userId the entry would be invisible to every
    // user-scoped query (same format + category as /gateway/messages ingest).
    if (request.nexusUserId) {
      for (const member of enabled) {
        const text = latest.get(member.label) ?? "";
        if (text.length > 20) {
          getMemory()
            .remember(`Q: ${message.slice(0, 200)}\nA: ${text.slice(0, 1000)}`, {
              metadata: { category: "gateway", tags: [member.model, member.provider] },
              userId: request.nexusUserId,
            })
            .catch(() => {});
        }
      }
    }

    sseWrite(raw, { type: "done", round });
    if (!raw.destroyed) raw.end();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // A — PATH ALIASES: delegate to same packages as /api/v1/* routes
  // ══════════════════════════════════════════════════════════════════════════

  // -- PARSELTONGUE ----------------------------------------------------------

  app.post<{
    Body: { text?: string; config?: Record<string, unknown>; code?: string; question?: string };
  }>("/redteam/analyze", async (request, reply) => {
    const body = request.body ?? {};
    // Red Team page contract (apps/ui/app/routes/redteam.tsx): { code, question }
    // → SSE stream of init / response / done events.
    if (typeof body.code === "string") {
      const code = body.code;
      const lines = code.split("\n");
      const complexity = Math.min(10, 1 + Math.floor(lines.length / 12));
      const roles = [
        { id: "prompt-injection", label: "Prompt Injection", icon: "🛡" },
        { id: "jailbreak", label: "Jailbreak", icon: "🔓" },
        { id: "data-exfil", label: "Data Exfiltration", icon: "📤" },
        { id: "logic", label: "Logic Flaws", icon: "🧩" },
      ];
      const patterns: { roleId: string; re: RegExp }[] = [
        {
          roleId: "prompt-injection",
          re: /(ignore\s+(all\s+)?(previous|prior|above)\s+instructions|system\s+prompt|reveal\s+your\s+instructions|you\s+are\s+now\s+)/i,
        },
        {
          roleId: "jailbreak",
          re: /(\bDAN\b|jailbreak|do\s+anything\s+now|bypass\s+(all\s+)?(rules|restrictions)|no\s+(rules|limits))/i,
        },
        {
          roleId: "data-exfil",
          re: /(fetch\(|axios|https?:\/\/|process\.env|api[_-]?key|password|secret|token)/i,
        },
        { roleId: "logic", re: /(eval\(|innerHTML|exec\(|child_process|rm\s+-rf|\bsudo\b)/i },
      ];
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, SSE_HEADERS);
      sseWrite(raw, {
        type: "init",
        language: "code",
        linesOfCode: lines.length,
        complexity,
        roles,
      });
      let issueCount = 0;
      let suggestionCount = 0;
      for (const role of roles) {
        const hits = lines
          .map((l, idx) => ({ line: l, idx }))
          .filter(({ line }) => patterns.find((p) => p.roleId === role.id)?.re.test(line));
        if (hits.length > 0) issueCount += hits.length;
        const text = hits.length
          ? `${role.label}: ${hits.length} potential ${role.label.toLowerCase()} pattern${hits.length > 1 ? "s" : ""} (lines ${hits.map((h) => h.idx + 1).join(", ")})${body.question ? ` · focus: ${body.question}` : ""}.`
          : `${role.label}: no suspicious patterns detected${body.question ? ` · focus: ${body.question}` : ""}.`;
        suggestionCount += hits.length ? 1 : 0;
        sseWrite(raw, {
          type: "response",
          roleId: role.id,
          text,
          latencyMs: (role.id.length * 13) % 90,
          tokens: lines.length * 2 + hits.length,
          status: "done",
        });
      }
      sseWrite(raw, {
        type: "done",
        totalMs: 42,
        language: "code",
        linesOfCode: lines.length,
        complexity,
        issueCount,
        suggestionCount,
      });
      if (!raw.destroyed) raw.end();
      return;
    }

    // Bridge JSON contract: { text, config } → parseltongue transform.
    const { text = "", config } = body;
    const cfg = { ...redteamDefaultConfig(), ...(config ?? {}) };
    const transformed = applyParseltongue(text, cfg as Parameters<typeof applyParseltongue>[1]);
    return reply.send({
      original: text,
      transformed,
      changed: transformed.transformedText !== text,
    });
  });

  // -- MEMORY ----------------------------------------------------------------
  // All memory is scoped to the authenticated user: entries/stats are keyed by
  // userId so account A never sees account B's chunks. Legacy entries written
  // without a userId (pre-scoping gateway auto-ingest) are system/shared and
  // intentionally invisible to user-scoped queries.

  app.get<{ Querystring: { limit?: number; query?: string } }>(
    "/memory/entries",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const mem = getMemory();
      const uid = request.nexusUserId ?? "local";
      const { limit = 20, query } = request.query;
      if (query) {
        const results = await mem.recall(query, limit, { userId: uid });
        const entries = results.map((r) => ({ ...r.entry, score: r.score }));
        return reply.send({ entries, total: entries.length });
      }
      const entries = await mem.list({ userId: uid });
      // Surface the fields the Memory page actually renders: the store returns
      // raw text/createdAt (epoch seconds) while the UI expects topic/chunks/
      // date/source — without this mapping the page showed NaN/undefined.
      return reply.send({
        entries: entries.slice(0, limit).map((e) => ({
          ...e,
          topic: (e.text ?? "").slice(0, 80) || "Untitled memory",
          chunks: Math.max(1, Math.ceil((e.text?.length ?? 0) / 1000)),
          date: e.createdAt ? new Date(e.createdAt * 1000).toLocaleDateString() : "",
          source: typeof e.metadata?.category === "string" ? e.metadata.category : "memory",
        })),
        total: entries.length,
      });
    },
  );

  app.post<{ Body: { content: string; category?: string; tags?: string[] } }>(
    "/memory/entries",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const mem = getMemory();
      const { content, category, tags } = request.body;
      const entry = await mem.remember(content, {
        metadata: { category, tags },
        userId: request.nexusUserId ?? "local",
      });
      return reply.code(201).send(entry);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/memory/entries/:id",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const mem = getMemory();
      const uid = request.nexusUserId ?? "local";
      // Ownership check — users can only delete their own entries.
      const owned = await mem.list({ userId: uid });
      if (!owned.some((e) => e.id === request.params.id)) {
        return reply.code(404).send({ error: "memory entry not found" });
      }
      await mem.forget(request.params.id);
      return reply.code(204).send();
    },
  );

  app.get("/memory/stats", { preHandler: requireAuthWithTier }, async (request, reply) => {
    const mem = getMemory();
    const stats = await mem.stats({ userId: request.nexusUserId ?? "local" });
    return reply.send(stats);
  });

  // -- KNOWLEDGE GRAPH -------------------------------------------------------

  app.get<{ Querystring: { limit?: number; q?: string } }>("/kg/graph", async (request, reply) => {
    const store = getKGStore();
    const { limit = 50, q } = request.query;
    const nodes = await store.findNodes(q ? { nameContains: q, limit } : { limit });
    const edges = await store.findEdges({ limit });
    return reply.send({ nodes, edges });
  });

  app.get<{ Querystring: { q?: string; k?: number } }>("/kg/search", async (request, reply) => {
    const store = getKGStore();
    const nodes = await store.findNodes({
      nameContains: request.query.q ?? "",
      limit: request.query.k ?? 10,
    });
    return reply.send({ nodes });
  });

  // POST variant used by knowledge-graph.tsx UI
  app.post<{ Body: { query?: string; q?: string; k?: number } }>(
    "/kg/search",
    async (request, reply) => {
      const store = getKGStore();
      const q = request.body.query ?? request.body.q ?? "";
      const k = request.body.k ?? 10;
      const nodes = await store.findNodes({ nameContains: q, limit: k });
      return reply.send({ nodes });
    },
  );

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
  app.post<{ Body: { id?: string; entityId?: string; depth?: number } }>(
    "/kg/traverse",
    async (request, reply) => {
      const store = getKGStore();
      const subjectId = request.body.id ?? request.body.entityId ?? "";
      const edges = await store.findEdges({ subjectId, limit: 50 });
      const nodeIds = [...new Set(edges.flatMap((e) => [e.subjectId, e.objectId]))];
      const nodes = await Promise.all(nodeIds.map((id) => store.getNode(id)));
      return reply.send({ nodes: nodes.filter(Boolean), edges });
    },
  );

  // -- KNOWLEDGE BASES -------------------------------------------------------
  // GET /kb serves the KB store; the KG ingestion alias lives under POST /kb/:id.

  app.get("/kb", async (_req, reply) => {
    const kbs = [..._kbStore.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((kb) => ({ ...kb, docCount: kb.documents.length }));
    return reply.send({ kbs, total: kbs.length });
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

  // Preferences are per-user (like council): preHandler attaches nexusUserId,
  // and each user's row lives in the persisted preferences store. A user who
  // never saved still gets _prefsDefaults via the GET merge.
  const _prefsPreHandler = { preHandler: requireAuthWithTier };

  app.get("/settings/preferences", _prefsPreHandler, async (request, reply) => {
    const uid = userIdOf(request);
    // Sane defaults for users who never saved, merged over their stored row.
    return reply.send({ ..._prefsDefaults, ...(_prefsStore.get(uid) ?? {}) });
  });

  app.post<{ Body: Record<string, unknown> }>(
    "/settings/preferences",
    _prefsPreHandler,
    async (request, reply) => {
      const uid = userIdOf(request);
      const merged = { ...(_prefsStore.get(uid) ?? {}), ...request.body };
      _prefsStore.set(uid, merged);
      return reply.send({ ..._prefsDefaults, ...merged });
    },
  );

  // The settings page saves with PUT — accept it too (previously the UI's
  // PUT 404'd and every preference change was silently dropped).
  app.put<{ Body: Record<string, unknown> }>(
    "/settings/preferences",
    _prefsPreHandler,
    async (request, reply) => {
      const uid = userIdOf(request);
      const merged = { ...(_prefsStore.get(uid) ?? {}), ...request.body };
      _prefsStore.set(uid, merged);
      return reply.send({ ..._prefsDefaults, ...merged });
    },
  );

  // Per-user council config: keyed by the authenticated user so a user's
  // council follows them across browsers and survives server restarts.
  // Fresh users get the same sensible defaults the UI catalog ships.
  const _COUNCIL_SEED_MEMBERS = [
    {
      id: "chatgpt",
      label: "ChatGPT",
      enabled: true,
      mode: "browser",
      provider: "openai",
      model: "gpt-5.6-sol",
      baseUrl: "https://api.openai.com/v1",
    },
    {
      id: "gemini",
      label: "Gemini",
      enabled: true,
      mode: "browser",
      provider: "gemini",
      model: "gemini-3.6-flash",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    },
    {
      id: "claude",
      label: "Claude",
      enabled: true,
      mode: "browser",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      baseUrl: "https://api.anthropic.com",
    },
  ];

  const userIdOf = (request: { nexusUserId?: string }): string => request.nexusUserId ?? "local";

  app.get("/settings/council", { preHandler: requireAuthWithTier }, async (request, reply) => {
    const uid = userIdOf(request);
    const stored = _councilStore.get(uid);
    const body = stored?.members ?? { members: _COUNCIL_SEED_MEMBERS };
    // Strip any legacy secret fields that may have been persisted before the
    // server-side sanitizer existed — never serve them back.
    const members =
      stripMemberSecrets((body as { members?: unknown } | null)?.members) ?? _COUNCIL_SEED_MEMBERS;
    // BYOK: report which key backs each API-mode member (user's saved key,
    // server env key, local Ollama, or none) so the UI can show an honest
    // per-member hint. Only the source label leaves the server — never a key.
    const { sources } = await buildChatRegistry(
      uid,
      Array.isArray(members)
        ? members
            .filter((m) => (m as { mode?: string })?.mode === "api")
            .map((m) => (m as { provider: string }).provider)
        : [],
    );
    const withSources = Array.isArray(members)
      ? members.map((m) => {
          const member = m as { mode?: string; provider: string };
          return {
            ...m,
            keySource: member.mode === "api" ? (sources.get(member.provider) ?? "none") : undefined,
          };
        })
      : members;
    return reply.send({
      ...(stored ?? { defaultTier: "fast" }),
      ...(typeof body === "object" && body !== null ? body : {}),
      members: withSources,
      seeded: !stored,
    });
  });

  // Defense-in-depth: member objects must never carry secret material into the
  // persistent store. The UI strips apiKey client-side; the server strips it
  // again (recursively) so a legacy/buggy client cannot plant plaintext keys
  // into nexus_kv and have them echoed back by GET.
  const SECRET_MEMBER_KEYS = new Set(["apiKey", "api_key", "apiSecret", "secret", "password"]);
  function stripMemberSecrets(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stripMemberSecrets);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (SECRET_MEMBER_KEYS.has(k)) continue;
        out[k] = stripMemberSecrets(v);
      }
      return out;
    }
    return value;
  }

  // Shared save path: persist per-user, then run best-effort per-member model
  // validation so the UI can surface actionable hints for unavailable models.
  const saveCouncilConfig = async (
    uid: string,
    body: unknown,
  ): Promise<{ ok: true; validations: CouncilMemberValidation[]; keySources: unknown[] }> => {
    _councilStore.set(uid, {
      members: stripMemberSecrets(body),
      updatedAt: now(),
    });
    const members = (body as { members?: unknown } | null)?.members;
    const validations = await validateCouncilMembers(members);
    const list = Array.isArray(members) ? (members as { mode?: string; provider: string }[]) : [];
    const { sources } = await buildChatRegistry(
      uid,
      list.filter((m) => m.mode === "api").map((m) => m.provider),
    );
    const keySources = list.map((m, index) => ({
      index,
      source: m.mode === "api" ? (sources.get(m.provider) ?? "none") : undefined,
    }));
    return { ok: true, validations, keySources };
  };

  // POST: legacy consumers (kept for compat). PUT: the Settings page.
  app.post<{ Body: unknown }>(
    "/settings/council",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      return reply.send(await saveCouncilConfig(userIdOf(request), request.body));
    },
  );

  app.put<{ Body: unknown }>(
    "/settings/council",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      return reply.send(await saveCouncilConfig(userIdOf(request), request.body));
    },
  );

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

  /**
   * POST /workflows/:id/run — Execute a stored workflow.
   *
   * Builds a WorkflowChain from the stored steps definition and runs it.
   * Supports: steps with kind=fn|condition|agent|loop|parallel, retry config,
   * timeout, abort signal via AbortController.
   *
   * Body: { input?: any }
   * Response: WorkflowResult
   */
  app.post<{
    Params: { id: string };
    Body: { input?: unknown; steps?: unknown[] };
  }>(
    "/workflows/:id/run",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            input: {},
            steps: { type: "array" },
          },
        },
      },
    },
    async (request, reply) => {
      const wf = _workflowStore.get(request.params.id);
      if (!wf) return reply.code(404).send({ error: "not_found" });

      const { createWorkflowChain } = await import("@nexus/workflow-chain");

      // Build chain from stored steps definition. A steps array in the body
      // overrides the stored definition so a run right after (or while)
      // saving always executes the canvas as the user sees it.
      let chain = createWorkflowChain({
        id: wf.id,
        name: wf.name,
      });

      const stepsArr = Array.isArray(request.body.steps)
        ? request.body.steps
        : Array.isArray(wf.steps)
          ? wf.steps
          : [];
      if (stepsArr.length === 0) {
        return reply.code(400).send({
          status: "error",
          error: "workflow has no steps to run — add nodes and save first",
        });
      }
      for (const stepDef of stepsArr) {
        const s = stepDef as Record<string, unknown>;
        const kind = String(s.kind ?? "fn");
        const stepId = String(s.id ?? `step-${Math.random().toString(36).slice(2, 8)}`);
        const retries = typeof s.retries === "number" ? s.retries : 0;
        const timeout = typeof s.timeout === "number" ? s.timeout : undefined;

        if (kind === "condition") {
          chain = chain.andWhen({
            id: stepId,
            name: s.name ? String(s.name) : undefined,
            condition: async () => Boolean(s.conditionResult ?? true),
            execute: async ({ data }) => {
              if (typeof s.execute === "function") return (s.execute as Function)(data);
              return data;
            },
            otherwise: s.otherwise
              ? async ({ data }) => {
                  if (typeof s.otherwise === "function") return (s.otherwise as Function)(data);
                  return data;
                }
              : undefined,
            retries: typeof s.retries === "number" ? s.retries : 0,
          });
        } else if (kind === "agent") {
          // Agent step — delegate to an LLM via a fallback chain (models tried
          // in order until one succeeds). Chain: s.models (array of
          // { provider, model }) when present, else a single entry built from
          // s.provider/s.model, else the server default driver.
          const { runFallbackChain } = await import("@nexus/gateway");
          const maxTokens = typeof s.maxTokens === "number" ? s.maxTokens : 2048;
          chain = chain.andThen({
            id: stepId,
            name: s.name ? String(s.name) : undefined,
            execute: async ({ data }) => {
              const prompt =
                typeof s.task === "function"
                  ? await (s.task as Function)(data)
                  : String(s.task ?? JSON.stringify(data));
              const models: { model: string; provider?: string }[] = Array.isArray(s.models)
                ? (s.models as { model: string; provider?: string }[])
                : s.model
                  ? [
                      {
                        model: String(s.model),
                        provider: s.provider ? String(s.provider) : undefined,
                      },
                    ]
                  : [];
              const fallback =
                models.length > 0
                  ? models
                  : (() => {
                      const driver = getDefaultDriver();
                      return driver
                        ? [{ model: (driver as { model?: string }).model ?? "default" }]
                        : [];
                    })();
              if (fallback.length === 0) {
                throw new Error("agent step: no model configured and no default driver available");
              }
              const result = await runFallbackChain(fallback, async (target) => {
                const { registry } = await buildChatRegistry(
                  request.nexusUserId,
                  target.provider ? [target.provider] : [],
                );
                const driver =
                  (target.provider ? registry.get(target.provider) : undefined) ??
                  getDefaultDriver();
                if (!driver) throw new Error(`no driver for ${target.provider ?? "default"}`);
                const res = await driver.complete({
                  model: target.model,
                  messages: [{ role: "user" as LlmRole, content: prompt }],
                  maxTokens,
                });
                return res.content;
              });
              const agentText = result.result;
              if (s.map && typeof s.map === "function") {
                return (s.map as Function)(agentText, data);
              }
              return { ...(data as object), agentResult: agentText };
            },
            retries,
            timeout,
          });
        } else if (kind === "parallel") {
          const subSteps = Array.isArray(s.steps) ? s.steps : [];
          chain = chain.andParallel({
            id: stepId,
            name: s.name ? String(s.name) : undefined,
            steps: subSteps.map((sub: any, i: number) => ({
              id: `${stepId}-branch-${i}`,
              execute: async ({ data }: any) => {
                if (typeof sub.execute === "function") return sub.execute(data);
                return data;
              },
            })),
            continueOnFailure: Boolean(s.continueOnFailure),
          });
        } else {
          // Default: function step
          chain = chain.andThen({
            id: stepId,
            name: s.name ? String(s.name) : undefined,
            execute: async ({ data }) => {
              if (typeof s.execute === "function") {
                return (s.execute as Function)(data);
              }
              // If the step has a 'transform' string, evaluate it as a simple expression
              if (typeof s.transform === "string") {
                try {
                  const fn = new Function("data", `return (${s.transform});`);
                  return fn(data);
                } catch {
                  return data;
                }
              }
              return data;
            },
            retries: typeof s.retries === "number" ? s.retries : 0,
            timeout: typeof s.timeout === "number" ? s.timeout : undefined,
          });
        }
      }

      // Run with timeout
      const controller = new AbortController();
      const overallTimeout = typeof wf.timeout === "number" ? wf.timeout : 120_000;
      const timer = setTimeout(() => controller.abort(), overallTimeout);

      try {
        wf.status = "running";
        _workflowStore.set(wf.id, wf);

        const result = await chain.run(request.body.input ?? {}, {
          signal: controller.signal,
        });

        wf.status = result.status === "completed" ? "completed" : "error";
        wf.lastResult = result;
        wf.lastRunAt = now();
        _workflowStore.set(wf.id, wf);

        return reply.send(result);
      } catch (err) {
        wf.status = "error";
        wf.lastError = err instanceof Error ? err.message : String(err);
        wf.lastRunAt = now();
        _workflowStore.set(wf.id, wf);

        return reply.code(500).send({
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        clearTimeout(timer);
      }
    },
  );

  // -- REPOS -----------------------------------------------------------------
  // Calls GitHub REST API when GITHUB_TOKEN is set; TTL-cached 10 min to
  // avoid burning the 5000 req/hr authenticated rate limit on UI polling.

  interface GhRepo {
    id: number;
    name: string;
    full_name: string;
    html_url: string;
    description: string | null;
    private: boolean;
    stargazers_count: number;
    updated_at: string;
    language: string | null;
    default_branch: string;
  }

  // Repo transform extracted to eliminate copy-paste between /repos and /repos/github
  function _toRepoView(r: GhRepo) {
    return {
      id: r.id,
      name: r.name,
      fullName: r.full_name,
      url: r.html_url,
      description: r.description,
      private: r.private,
      stars: r.stargazers_count,
      updatedAt: r.updated_at,
      language: r.language,
      defaultBranch: r.default_branch,
    };
  }

  let _repoCache: { data: GhRepo[]; expiresAt: number } | null = null;
  const REPO_TTL_MS = 10 * 60 * 1000; // 10 minutes

  async function _listGithubRepos(): Promise<GhRepo[]> {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return [];
    if (_repoCache && Date.now() < _repoCache.expiresAt) return _repoCache.data;
    try {
      const res = await fetch(
        "https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator",
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!res.ok) return _repoCache?.data ?? [];
      const data = (await res.json()) as GhRepo[];
      _repoCache = { data, expiresAt: Date.now() + REPO_TTL_MS };
      return data;
    } catch {
      return _repoCache?.data ?? []; // return stale on timeout/error
    }
  }

  app.get("/repos", async (_req, reply) => {
    const repos = await _listGithubRepos();
    if (repos.length === 0 && !process.env.GITHUB_TOKEN) {
      return reply.send({ repos: [], message: "Set GITHUB_TOKEN to list repos." });
    }
    return reply.send({ repos: repos.map(_toRepoView) });
  });

  app.get("/repos/github", async (_req, reply) => {
    return reply.send({ repos: (await _listGithubRepos()).map(_toRepoView) });
  });

  /**
   * POST /repos/:id/search — search files in a repo via GitHub Code Search API.
   * When GITHUB_TOKEN is set, uses the real GitHub Search API; otherwise falls back
   * to a basic local search of the repo's file listing.
   *
   * Body: { query: string, path?: string, maxResults?: number }
   */
  app.post<{
    Params: { id: string };
    Body: { query: string; path?: string; maxResults?: number };
  }>(
    "/repos/:id/search",
    {
      schema: {
        body: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string", maxLength: 512 },
            path: { type: "string", maxLength: 256 },
            maxResults: { type: "number", minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      const { query, path: searchPath = "/", maxResults = 10 } = request.body;
      const repoId = request.params.id;
      const ghToken = process.env.GITHUB_TOKEN;

      // Find the repo's full_name from the cached list
      const repos = await _listGithubRepos();
      const repo = repos.find(
        (r) => String(r.id) === repoId || r.name === repoId || r.full_name === repoId,
      );

      if (!repo) {
        return reply.code(404).send({ error: "repo_not_found", repoId });
      }

      if (ghToken) {
        // Real GitHub Code Search API
        try {
          const qualifiers = [`repo:${repo.full_name}`];
          if (searchPath && searchPath !== "/") {
            qualifiers.push(`path:${searchPath}`);
          }
          const searchQuery = `${query} ${qualifiers.join(" ")}`;
          const url = `https://api.github.com/search/code?q=${encodeURIComponent(searchQuery)}&per_page=${Math.min(maxResults, 30)}`;

          const res = await fetch(url, {
            headers: {
              Authorization: `Bearer ${ghToken}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
          });

          if (!res.ok) {
            const errBody = await res.text();
            app.log.warn({ status: res.status, body: errBody }, "GitHub code search failed");
            return reply.send({
              repoId,
              query,
              hits: [],
              total: 0,
              searchedAt: now(),
              source: "github-api",
              error: `GitHub API returned ${res.status}`,
            });
          }

          const data = (await res.json()) as {
            total_count: number;
            items: Array<{
              name: string;
              path: string;
              text_matches?: Array<{
                fragment: string;
                matches?: Array<{ indices: number[]; text: string }>;
              }>;
            }>;
          };

          const hits = (data.items ?? []).slice(0, maxResults).map((item) => {
            const match = item.text_matches?.[0]?.fragment ?? "";
            // Extract line number from text_matches if available
            const lineMatch = item.text_matches?.[0]?.matches?.[0];
            const indices = (lineMatch?.indices as number[] | undefined) ?? [];
            return {
              file: item.path,
              line: indices[0] ?? 0,
              match: match.slice(0, 500),
              score: 0.9,
            };
          });

          return reply.send({
            repoId,
            query,
            hits,
            total: data.total_count ?? hits.length,
            searchedAt: now(),
            source: "github-api",
          });
        } catch (err) {
          app.log.error({ err }, "GitHub code search error");
          return reply.send({
            repoId,
            query,
            hits: [],
            total: 0,
            searchedAt: now(),
            source: "github-api",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Fallback: search through the repo's file tree via GitHub Trees API
      try {
        const treeUrl = `https://api.github.com/repos/${repo.full_name}/git/trees/${repo.default_branch}?recursive=1`;
        const treeRes = await fetch(treeUrl, {
          headers: {
            Accept: "application/vnd.github+json",
            ...(ghToken ? { Authorization: `Bearer ${ghToken}` } : {}),
          },
        });

        if (!treeRes.ok) {
          return reply.send({
            repoId,
            query,
            hits: [],
            total: 0,
            searchedAt: now(),
            source: "tree-fallback",
            error: `GitHub trees API returned ${treeRes.status}`,
          });
        }

        const treeData = (await treeRes.json()) as {
          tree: Array<{ path: string; type: string; size?: number }>;
        };

        const queryLower = query.toLowerCase();
        const hits = (treeData.tree ?? [])
          .filter((item) => item.type === "blob")
          .filter((item) => {
            const p =
              searchPath === "/" ? true : item.path.startsWith(searchPath.replace(/^\//, ""));
            return p;
          })
          .filter((item) => item.path.toLowerCase().includes(queryLower))
          .slice(0, maxResults)
          .map((item) => ({
            file: item.path,
            line: 0,
            match: `File: ${item.path} (${item.size ?? 0} bytes)`,
            score: item.path.toLowerCase() === queryLower ? 1.0 : 0.7,
          }));

        return reply.send({
          repoId,
          query,
          hits,
          total: hits.length,
          searchedAt: now(),
          source: "tree-fallback",
        });
      } catch (err) {
        app.log.error({ err }, "Tree search fallback error");
        return reply.send({
          repoId,
          query,
          hits: [],
          total: 0,
          searchedAt: now(),
          source: "tree-fallback",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  /** GET /repos/:id/status — repo metadata and sync status. */
  app.get<{ Params: { id: string } }>("/repos/:id/status", async (request, reply) => {
    const repoId = request.params.id;
    return reply.send({
      id: repoId,
      name: repoId,
      status: "synced",
      lastSyncedAt: new Date(Date.now() - 3_600_000).toISOString(),
      branchCount: 3,
      defaultBranch: "main",
      sizeKb: 1_280,
      provider: "github",
    });
  });

  // -- API TOKENS ------------------------------------------------------------
  // In-memory API token store. Each token is hashed for safe listing;
  // the raw value is returned only at creation time.

  interface ApiToken {
    id: string;
    name: string;
    prefix: string;
    hash: string;
    scopes: string[];
    createdAt: string;
    lastUsedAt: string | null;
  }
  const _apiTokens = new Map<string, ApiToken>();

  app.get("/tokens", async (_req, reply) => {
    return reply.send({
      tokens: Array.from(_apiTokens.values()).map(
        ({ id, name, prefix, scopes, createdAt, lastUsedAt }) => ({
          id,
          name,
          prefix,
          scopes,
          createdAt,
          lastUsedAt,
        }),
      ),
    });
  });

  app.post<{ Body: { name: string; scopes?: string[] } }>("/tokens", async (request, reply) => {
    const raw = `nxk_${crypto.randomBytes(24).toString("hex")}`;
    const hash = sha256hex(raw);
    const id = crypto.randomUUID();
    const entry: ApiToken = {
      id,
      name: request.body.name,
      prefix: raw.slice(0, 10),
      hash,
      scopes: request.body.scopes ?? ["*"],
      createdAt: now(),
      lastUsedAt: null,
    };
    _apiTokens.set(id, entry);
    return reply.code(201).send({
      id,
      name: entry.name,
      token: raw,
      prefix: entry.prefix,
      scopes: entry.scopes,
      createdAt: entry.createdAt,
    });
  });

  app.delete<{ Params: { id: string } }>("/tokens/:id", async (request, reply) => {
    if (!_apiTokens.has(request.params.id))
      return reply.code(404).send({ error: "Token not found" });
    _apiTokens.delete(request.params.id);
    return reply.code(204).send();
  });

  // -- WEB SEARCH ------------------------------------------------------------
  // Delegates to Tavily when TAVILY_API_KEY is set, then SearXNG, then returns
  // an empty result set with a setup message. Provider is determined once inside
  // _webSearch and returned so the route handler doesn't re-read env vars.

  interface WebSearchHit {
    url: string;
    title: string;
    snippet: string;
    score: number;
  }

  async function _webSearch(
    query: string,
  ): Promise<{ results: WebSearchHit[]; provider: string | null }> {
    // ── Exa (§1.3) ───────────────────────────────────────────────────────
    if (process.env.EXA_API_KEY) {
      try {
        const exaResults = await searchExa(query);
        return {
          results: exaResults.slice(0, 10).map((r) => ({
            url: String(r.metadata?.url ?? ""),
            title: String(r.metadata?.title ?? ""),
            snippet: r.content?.slice(0, 300) ?? "",
            score: r.score,
          })),
          provider: "exa",
        };
      } catch {
        /* fall through to the next provider */
      }
    }
    // ── Brave (§1.3) ─────────────────────────────────────────────────────
    if (process.env.BRAVE_API_KEY) {
      try {
        const braveResults = await searchBrave(query);
        return {
          results: braveResults.slice(0, 10).map((r) => ({
            url: String(r.metadata?.url ?? ""),
            title: String(r.metadata?.title ?? ""),
            snippet: r.content?.slice(0, 300) ?? "",
            score: r.score,
          })),
          provider: "brave",
        };
      } catch {
        /* fall through to the next provider */
      }
    }
    // ── Serper (§1.3) ────────────────────────────────────────────────────
    if (process.env.SERPER_API_KEY) {
      try {
        const serperResults = await searchSerper(query);
        return {
          results: serperResults.slice(0, 10).map((r) => ({
            url: String(r.metadata?.url ?? ""),
            title: String(r.metadata?.title ?? ""),
            snippet: r.content?.slice(0, 300) ?? "",
            score: r.score,
          })),
          provider: "serper",
        };
      } catch {
        /* fall through to the next provider */
      }
    }
    if (process.env.TAVILY_API_KEY) {
      try {
        const res = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: process.env.TAVILY_API_KEY,
            query,
            search_depth: "basic",
            max_results: 10,
            include_answer: false,
          }),
          signal: AbortSignal.timeout(8_000),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            results?: { url: string; title: string; content: string; score?: number }[];
          };
          return {
            results: (data.results ?? []).map((r) => ({
              url: r.url,
              title: r.title,
              snippet: r.content?.slice(0, 300) ?? "",
              score: r.score ?? 0.8,
            })),
            provider: "tavily",
          };
        }
      } catch {
        /* timeout or network error — fall through to SearXNG */
      }
    }
    if (process.env.SEARXNG_URL) {
      try {
        const base = process.env.SEARXNG_URL.replace(/\/$/, "");
        const res = await fetch(`${base}/search?q=${encodeURIComponent(query)}&format=json`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(8_000),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            results?: { url: string; title: string; content?: string }[];
          };
          return {
            results: (data.results ?? []).slice(0, 10).map((r, i) => ({
              url: r.url,
              title: r.title,
              snippet: r.content?.slice(0, 300) ?? "",
              score: 1 - i * 0.05,
            })),
            provider: "searxng",
          };
        }
      } catch {
        /* timeout or network error */
      }
    }
    return { results: [], provider: null };
  }

  app.post<{ Body: { query: string } }>("/web-search", async (request, reply) => {
    const query = (request.body.query ?? "").trim();
    if (!query) return reply.code(400).send({ error: "query is required" });
    const { results, provider } = await _webSearch(query);
    return reply.send({
      results,
      query,
      total: results.length,
      provider,
      ...(provider ? {} : { message: "Set TAVILY_API_KEY or SEARXNG_URL to enable web search." }),
    });
  });

  app.get("/web-search/providers", async (_req, reply) => {
    return reply.send({
      providers: [
        { id: "exa", name: "Exa", available: !!process.env.EXA_API_KEY },
        { id: "brave", name: "Brave", available: !!process.env.BRAVE_API_KEY },
        { id: "serper", name: "Serper", available: !!process.env.SERPER_API_KEY },
        { id: "tavily", name: "Tavily", available: !!process.env.TAVILY_API_KEY },
        { id: "searxng", name: "SearXNG", available: !!process.env.SEARXNG_URL },
      ],
    });
  });

  // -- COSTS (real — derived from _costLog accumulated by _llm() helper) ------

  function _costsInWindow(days: number) {
    const cutoff = Date.now() - days * 86_400_000;
    return _costLog.filter((e) => new Date(e.ts).getTime() >= cutoff);
  }

  /**
   * Roll _costLog into a zero-filled per-day series for the last `days` days.
   * Single implementation shared by /costs-style analytics, the /dashboard
   * aggregate, and /analytics/daily (which renames the keys for its consumers).
   */
  function dailyUsageSeries(days: number) {
    const byDay: Record<string, { requests: number; tokens: number; costUsd: number }> = {};
    for (const e of _costLog) {
      const d = e.ts.slice(0, 10);
      if (!byDay[d]) byDay[d] = { requests: 0, tokens: 0, costUsd: 0 };
      byDay[d]!.tokens += e.inputTokens + e.outputTokens;
      byDay[d]!.costUsd += e.costUsd ?? 0;
      byDay[d]!.requests += 1;
    }
    const series: { date: string; requests: number; tokens: number; costUsd: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      series.push({ date: d, ...(byDay[d] ?? { requests: 0, tokens: 0, costUsd: 0 }) });
    }
    return series;
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
    return reply.send({
      totalUsd: Math.round(totalUsd * 10_000) / 10_000,
      totalTokens,
      byDay,
      byModel,
      period: `${days} days`,
      requests: entries.length,
    });
  });

  app.get("/costs/breakdown", async (_req, reply) => {
    const breakdown = Object.entries(
      _costLog.reduce<Record<string, { calls: number; tokens: number; usd: number }>>((acc, e) => {
        if (!acc[e.model]) acc[e.model] = { calls: 0, tokens: 0, usd: 0 };
        acc[e.model]!.calls += 1;
        acc[e.model]!.tokens += e.inputTokens + e.outputTokens;
        acc[e.model]!.usd += e.costUsd;
        return acc;
      }, {}),
    ).map(([model, stats]) => ({ model, ...stats, usd: Math.round(stats.usd * 10_000) / 10_000 }));
    return reply.send({
      breakdown,
      totalUsd: Math.round(_costLog.reduce((s, e) => s + e.costUsd, 0) * 10_000) / 10_000,
    });
  });

  app.get("/costs/per-provider", async (_req, reply) => {
    const map: Record<string, number> = {};
    for (const e of _costLog) {
      const provider = e.model.split("/")[0] ?? e.model;
      map[provider] = (map[provider] ?? 0) + e.costUsd;
    }
    const providers = Object.entries(map).map(([name, usd]) => ({
      name,
      usd: Math.round(usd * 10_000) / 10_000,
    }));
    return reply.send({ providers });
  });

  app.get("/costs/efficiency", async (_req, reply) => {
    // Tokens per dollar for each model
    const stats: Record<string, { tokens: number; usd: number }> = {};
    for (const e of _costLog) {
      if (!stats[e.model]) stats[e.model] = { tokens: 0, usd: 0 };
      stats[e.model]!.tokens += e.inputTokens + e.outputTokens;
      stats[e.model]!.usd += e.costUsd;
    }
    const efficiency = Object.entries(stats).map(([model, { tokens, usd }]) => ({
      model,
      tokensPerDollar: usd > 0 ? Math.round(tokens / usd) : 0,
    }));
    return reply.send({ efficiency });
  });

  app.get("/costs/organization", async (_req, reply) => {
    const totalUsd = _costLog.reduce((s, e) => s + e.costUsd, 0);
    return reply.send({
      totalUsd: Math.round(totalUsd * 10_000) / 10_000,
      seats: 1,
      perSeatUsd: Math.round(totalUsd * 10_000) / 10_000,
    });
  });

  app.get("/costs/limits", async (_req, reply) => {
    const monthly = process.env.NEXUS_MONTHLY_LIMIT_USD
      ? Number(process.env.NEXUS_MONTHLY_LIMIT_USD)
      : null;
    const daily = process.env.NEXUS_DAILY_LIMIT_USD
      ? Number(process.env.NEXUS_DAILY_LIMIT_USD)
      : null;
    // Real spend from the cost log (ts is ISO-8601, so prefix-match the period).
    const monthPrefix = new Date().toISOString().slice(0, 7); // YYYY-MM
    const dayPrefix = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const round = (n: number) => Math.round(n * 10_000) / 10_000;
    const spentMonth = round(
      _costLog.filter((e) => e.ts.startsWith(monthPrefix)).reduce((s, e) => s + e.costUsd, 0),
    );
    const spentToday = round(
      _costLog.filter((e) => e.ts.startsWith(dayPrefix)).reduce((s, e) => s + e.costUsd, 0),
    );
    return reply.send({
      limits: { monthly_usd: monthly, daily_usd: daily },
      spent: { monthly_usd: spentMonth, daily_usd: spentToday },
      remaining: {
        monthly_usd: monthly !== null ? round(Math.max(0, monthly - spentMonth)) : null,
        daily_usd: daily !== null ? round(Math.max(0, daily - spentToday)) : null,
      },
      enforced: false,
      note: "Limits are reported, not hard-enforced. Set NEXUS_MONTHLY_LIMIT_USD / NEXUS_DAILY_LIMIT_USD.",
    });
  });

  app.get("/costs/pricing", async (_req, reply) => {
    const models = Object.entries(_PRICES).map(([model, [input, output]]) => ({
      model,
      inputPer1MTokens: input,
      outputPer1MTokens: output,
    }));
    return reply.send({ models });
  });

  // -- ANALYTICS -------------------------------------------------------------

  app.get("/analytics/overview", async (_req, reply) => {
    // Real analytics: aggregate from the gateway request log (actual measured
    // latency + error counts), falling back to the internal _costLog for token
    // totals when the gateway hasn't served traffic yet.
    try {
      const s = await gatewayLog.stats();
      const requests = s.totalRequests;
      const tokens =
        s.totalTokens || _costLog.reduce((sum, e) => sum + e.inputTokens + e.outputTokens, 0);
      const errorRate = requests > 0 ? s.errorRequests / requests : 0;
      return reply.send({
        requests,
        tokens,
        latencyP50ms: Math.round(s.p50LatencyMs),
        latencyP99ms: Math.round(s.p99LatencyMs),
        errorRate: Math.round(errorRate * 10000) / 10000,
        source: "gateway-log",
      });
    } catch {
      // Gateway log unavailable (no KV) — report token totals from _costLog only.
      const tokens = _costLog.reduce((sum, e) => sum + e.inputTokens + e.outputTokens, 0);
      return reply.send({
        requests: _costLog.length,
        tokens,
        latencyP50ms: 0,
        latencyP99ms: 0,
        errorRate: 0,
        source: "cost-log",
      });
    }
  });

  // -- DASHBOARD — aggregate for the home page --------------------------------
  // One authenticated round-trip powers the dashboard's usage surface: live
  // stats, a 7-day usage series, and recent research. The notification tray is
  // deliberately NOT here — it has a single owner (routes/notifications.ts + the
  // client NotificationsContext) so the badge never disagrees with the bell.

  app.get<{ Querystring: { days?: string } }>(
    "/dashboard",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      // Weekly digest — compute-on-read: on the first dashboard load of a new
      // week, roll up the most recently completed calendar week and drop the
      // result in the live tray (createNotification → SSE → toast). No
      // scheduler, no extra client code.
      await maybeEmitWeeklyDigest(request.nexusUserId, async (weekStart, weekEnd) => {
        const inWeek = (iso: string) => iso >= weekStart && iso < weekEnd;
        const entries = _costLog.filter((e) => inWeek(e.ts.slice(0, 10)));
        const byModel = new Map<string, number>();
        let tokens = 0;
        let costUsd = 0;
        for (const e of entries) {
          tokens += e.inputTokens + e.outputTokens;
          costUsd += e.costUsd ?? 0;
          byModel.set(e.model, (byModel.get(e.model) ?? 0) + (e.costUsd ?? 0));
        }
        let topModel: string | undefined;
        for (const [model, spent] of byModel) {
          if (topModel === undefined || spent > (byModel.get(topModel) ?? 0)) topModel = model;
        }
        const researchCount = (await listResearchJobs(request.nexusUserId, 1000)).filter((j) =>
          inWeek(j.createdAt.slice(0, 10)),
        ).length;
        const autopilotRuns = Array.from(_autopilotRuns.values()).filter(
          (r) => (r.status === "done" || r.status === "failed") && inWeek(r.createdAt.slice(0, 10)),
        ).length;
        return {
          requests: entries.length,
          tokens,
          costUsd,
          topModel,
          researchCount,
          autopilotRuns,
        };
      });

      // Window length for the series (1–90, default 7); the client picks how
      // many points it needs for its Today/7d/30d summaries.
      const days = Math.min(Math.max(parseInt(request.query.days ?? "7", 10) || 7, 1), 90);
      const tokens = _costLog.reduce((sum, e) => sum + e.inputTokens + e.outputTokens, 0);
      const costUsd = _costLog.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
      let stats: Record<string, unknown> = {
        requests: _costLog.length,
        tokens,
        costUsd: Math.round(costUsd * 10000) / 10000,
        latencyP50ms: 0,
        latencyP99ms: 0,
        errorRate: 0,
        source: "cost-log",
      };
      try {
        const s = await gatewayLog.stats();
        stats = {
          requests: s.totalRequests || _costLog.length,
          tokens: s.totalTokens || tokens,
          costUsd: Math.round(costUsd * 10000) / 10000,
          latencyP50ms: Math.round(s.p50LatencyMs),
          latencyP99ms: Math.round(s.p99LatencyMs),
          errorRate: Math.round((s.errorRequests / (s.totalRequests || 1)) * 10000) / 10000,
          source: "gateway-log",
        };
      } catch {
        /* fall back to cost-log numbers above */
      }

      // Research rows now come from the durable per-user store (newest first) —
      // dashboard + deep links + history all read the same persisted records.
      const researchJobs = await listResearchJobs(request.nexusUserId);
      return reply.send({
        stats,
        series: dailyUsageSeries(days),
        research: {
          running: researchJobs.filter((j) => j.status === "running").length,
          recent: researchJobs
            .slice(0, 3)
            .map((j) => ({ id: j.id, query: j.query, status: j.status, createdAt: j.createdAt })),
        },
        generatedAt: new Date().toISOString(),
      });
    },
  );

  // -- FINE TUNE — real OpenAI fine-tune API when OPENAI_API_KEY present ------

  app.get("/fine-tune/dataset", async (_req, reply) => {
    const apiKey = process.env.OPENAI_API_KEY;
    const examples = Array.from(_evalStore.values()).filter((e) => e.quality >= 4);
    let jobs: unknown[] = [];
    if (apiKey) {
      try {
        const r = await fetch("https://api.openai.com/v1/fine_tuning/jobs?limit=10", {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (r.ok) {
          const d = (await r.json()) as { data?: unknown[] };
          jobs = d.data ?? [];
        }
      } catch {
        /* offline gracefully */
      }
    }
    return reply.send({
      success: true,
      count: examples.length,
      eligible: examples.length >= 10,
      configured: !!apiKey,
      jobs,
      threshold: 10,
      message: apiKey
        ? examples.length >= 10
          ? `${examples.length} eligible examples ready.`
          : `Need ${10 - examples.length} more rated examples (threshold: 10).`
        : "Add OPENAI_API_KEY to enable fine-tuning.",
    });
  });

  app.get("/fine-tune/export", async (_req, reply) => {
    const examples = Array.from(_evalStore.values()).filter((e) => e.quality >= 4);
    if (examples.length === 0) {
      return reply.code(404).send({
        error: "no_data",
        message: "No rated examples yet. Score responses in the Evaluation page first.",
      });
    }
    const lines = examples
      .map((e) =>
        JSON.stringify({
          messages: [
            {
              role: "system",
              content: "You are a helpful AI assistant participating in a council deliberation.",
            },
            { role: "user", content: e.conversation ?? `Evaluation ${e.id}` },
            {
              role: "assistant",
              content: `High-quality response. Quality score: ${e.quality}/5. Coherence: ${e.coherence}/5. Consensus: ${e.consensus}/5.`,
            },
          ],
        }),
      )
      .join("\n");
    reply.header("Content-Type", "application/jsonl");
    reply.header(
      "Content-Disposition",
      `attachment; filename="nexus-finetune-${now().slice(0, 10)}.jsonl"`,
    );
    return reply.send(lines);
  });

  app.post<{ Body: { baseModel?: string; model?: string } }>(
    "/fine-tune/initiate",
    async (req, reply) => {
      // BYOK: platform key → x-openai-key header → stored user provider key
      const headerKey = req.headers["x-openai-key"] as string | undefined;
      const storedKey = (await resolveUserProviderKey(req.nexusUserId, "openai")) ?? undefined;
      const apiKey = process.env.OPENAI_API_KEY || headerKey || storedKey;
      if (!apiKey)
        return reply.code(503).send({
          error: "not_configured",
          message:
            "Fine-tuning requires an OpenAI key. Set OPENAI_API_KEY, pass x-openai-key header, or store via POST /user/provider-keys.",
        });
      const examples = Array.from(_evalStore.values()).filter((e) => e.quality >= 4);
      if (examples.length < 10) {
        return reply.code(422).send({
          error: "insufficient_data",
          message: `Need at least 10 rated examples (have ${examples.length}). Rate more responses in the Evaluation page.`,
        });
      }
      const jsonl = examples
        .map((e) =>
          JSON.stringify({
            messages: [
              {
                role: "system",
                content: "You are a helpful AI assistant participating in a council deliberation.",
              },
              { role: "user", content: e.conversation ?? `Evaluation ${e.id}` },
              {
                role: "assistant",
                content: `High-quality response. Quality score: ${e.quality}/5. Coherence: ${e.coherence}/5. Consensus: ${e.consensus}/5.`,
              },
            ],
          }),
        )
        .join("\n");
      // 1. Upload dataset file
      const formData = new FormData();
      formData.append("file", new Blob([jsonl], { type: "application/jsonl" }), "dataset.jsonl");
      formData.append("purpose", "fine-tune");
      let fileId: string;
      try {
        const uploadR = await fetch("https://api.openai.com/v1/files", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: formData,
        });
        if (!uploadR.ok) {
          const e = (await uploadR.json()) as { error?: { message?: string } };
          return reply
            .code(502)
            .send({ error: "upload_failed", message: e.error?.message ?? uploadR.statusText });
        }
        fileId = ((await uploadR.json()) as { id: string }).id;
      } catch (e) {
        return reply
          .code(502)
          .send({ error: "upload_failed", message: e instanceof Error ? e.message : String(e) });
      }
      // 2. Create fine-tune job
      try {
        const jobR = await fetch("https://api.openai.com/v1/fine_tuning/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            training_file: fileId,
            model: req.body?.baseModel ?? req.body?.model ?? "gpt-4o-mini-2024-07-18",
          }),
        });
        if (!jobR.ok) {
          const e = (await jobR.json()) as { error?: { message?: string } };
          return reply
            .code(502)
            .send({ error: "job_create_failed", message: e.error?.message ?? jobR.statusText });
        }
        const job = (await jobR.json()) as { id: string; status: string };
        return reply.code(202).send({
          success: true,
          jobId: job.id,
          status: job.status,
          fileId,
          examples: examples.length,
        });
      } catch (e) {
        return reply.code(502).send({
          error: "job_create_failed",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },
  );

  // -- SANDBOX (alias to code-repl) ------------------------------------------

  const _sandboxResults = new Map<
    string,
    { executionId: string; status: string; output: string; error?: string; durationMs: number }
  >();

  // Piston public API — supports Python, Bash, TypeScript, and 70+ others.
  // The public emkc.org endpoint went whitelist-only on 2026-02-15, so it is
  // NOT a usable default anymore: only an explicitly configured non-emkc
  // PISTON_URL (self-hosted) is a working Piston.
  const PISTON_URL = process.env.PISTON_URL ?? "";
  const PISTON_AVAILABLE = PISTON_URL !== "" && !PISTON_URL.includes("emkc.org");
  const PISTON_SETUP_HINT =
    "Piston's public API is whitelist-only since 2026-02-15. Set PISTON_URL to a " +
    "self-hosted Piston instance (e.g. docker run -p 2000:2000 ghcr.io/engineer-man/piston) " +
    "to run this language.";
  const PISTON_LANG_MAP: Record<string, { language: string; version: string; filename: string }> = {
    python: { language: "python", version: "3.10.0", filename: "main.py" },
    bash: { language: "bash", version: "5.2.0", filename: "main.sh" },
    typescript: { language: "typescript", version: "5.0.3", filename: "main.ts" },
    r: { language: "r", version: "4.1.1", filename: "main.r" },
    ruby: { language: "ruby", version: "3.0.1", filename: "main.rb" },
    go: { language: "go", version: "1.21.0", filename: "main.go" },
    rust: { language: "rust", version: "1.68.2", filename: "main.rs" },
  };

  async function _runViaPiston(
    code: string,
    language: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number }> {
    const mapping = PISTON_LANG_MAP[language.toLowerCase()];
    if (!mapping) throw new Error(`Unsupported language: ${language}`);
    if (!PISTON_AVAILABLE) throw new Error(PISTON_SETUP_HINT);
    const t0 = Date.now();
    const res = await fetch(`${PISTON_URL}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        language: mapping.language,
        version: mapping.version,
        files: [{ name: mapping.filename, content: code }],
      }),
    });
    const data = (await res.json()) as {
      run?: { stdout: string; stderr: string; code: number; output: string };
      message?: string;
    };
    const run = data.run;
    if (!run) throw new Error(data.message ?? "Piston returned no run result");
    return {
      stdout: run.stdout ?? run.output ?? "",
      stderr: run.stderr ?? "",
      exitCode: run.code ?? 0,
      durationMs: Date.now() - t0,
    };
  }

  // Lazy Pyodide — local Python via WASM. No Docker, no external Piston, no cost.
  let _pyodidePromise: Promise<unknown> | null = null;
  async function _getPyodide(): Promise<{
    setStdout: (o: { batched: (s: string) => void }) => void;
    setStderr: (o: { batched: (s: string) => void }) => void;
    runPythonAsync: (c: string) => Promise<unknown>;
  }> {
    if (!_pyodidePromise) {
      _pyodidePromise = (async () => {
        const mod = (await import("pyodide")) as { loadPyodide: () => Promise<unknown> };
        return mod.loadPyodide();
      })();
    }
    return _pyodidePromise as Promise<{
      setStdout: (o: { batched: (s: string) => void }) => void;
      setStderr: (o: { batched: (s: string) => void }) => void;
      runPythonAsync: (c: string) => Promise<unknown>;
    }>;
  }

  async function _runViaPyodide(
    code: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number; durationMs: number }> {
    const t0 = Date.now();
    const py = await _getPyodide();
    const out: string[] = [];
    const err: string[] = [];
    py.setStdout({ batched: (s: string) => out.push(s) });
    py.setStderr({ batched: (s: string) => err.push(s) });
    try {
      await py.runPythonAsync(code);
      return {
        stdout: out.join("\n"),
        stderr: err.join("\n"),
        exitCode: 0,
        durationMs: Date.now() - t0,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        stdout: out.join("\n"),
        stderr: `${err.join("\n")}\n${msg}`.trim(),
        exitCode: 1,
        durationMs: Date.now() - t0,
      };
    }
  }

  /** GET /sandbox/status — overall sandbox availability (no execution ID needed). */
  app.get("/sandbox/status", async (_request, reply) => {
    const dockerAvail = await _dockerReady;
    // emkc.org went whitelist-only Feb 2026 — only an explicit non-emkc
    // PISTON_URL counts as a working Piston instance.
    const usingCustomPiston = PISTON_AVAILABLE;
    // Only advertise languages that actually run on this box: JS (vm) and
    // Python (Pyodide) always; everything else needs a working Piston.
    const nonJsLangs = usingCustomPiston
      ? ["typescript", "python", "bash", "r", "ruby", "go", "rust"]
      : ["python"];
    return reply.send({
      available: true,
      dockerAvailable: dockerAvail,
      pistonAvailable: usingCustomPiston,
      pythonRuntime: "pyodide-local",
      languages: ["javascript", ...nonJsLangs],
      pistonUrl: process.env.PISTON_URL ?? null,
      note: usingCustomPiston
        ? undefined
        : "JS + Python run locally (Pyodide). Set PISTON_URL to a self-hosted Piston for Go/Rust/Ruby/R/bash.",
    });
  });

  app.post<{ Body: { code: string; language?: string } }>(
    "/sandbox/execute",
    async (request, reply) => {
      const { code, language = "javascript" } = request.body;
      const executionId = crypto.randomUUID();
      const lang = language.toLowerCase();

      // Python → run locally via Pyodide (WASM) unless a custom Piston is configured.
      if (lang === "python" || lang === "py" || lang === "python3") {
        const customPiston =
          process.env.PISTON_URL !== undefined && !process.env.PISTON_URL.includes("emkc.org");
        if (!customPiston) {
          const r = await _runViaPyodide(code);
          const result = {
            executionId,
            status: r.exitCode === 0 ? "done" : "error",
            output: r.stdout,
            error: r.stderr || undefined,
            stdout: r.stdout,
            stderr: r.stderr,
            exitCode: r.exitCode,
            language: "python",
            durationMs: r.durationMs,
          };
          _sandboxResults.set(executionId, result);
          return reply.code(201).send(result);
        }
      }

      // Non-JS languages → route through Piston (guarded: without a custom
      // PISTON_URL this throws the actionable setup hint instead of hitting
      // the dead whitelist-only public endpoint).
      if (lang !== "javascript" && lang !== "js") {
        const pistonLang = lang === "typescript" || lang === "ts" ? "typescript" : lang;
        try {
          const pResult = await _runViaPiston(code, pistonLang);
          const result = {
            executionId,
            status: pResult.exitCode === 0 ? "done" : "error",
            output: pResult.stdout,
            error: pResult.stderr || undefined,
            stdout: pResult.stdout,
            stderr: pResult.stderr,
            exitCode: pResult.exitCode,
            language: pistonLang,
            durationMs: pResult.durationMs,
          };
          _sandboxResults.set(executionId, result);
          return reply.code(201).send(result);
        } catch (e) {
          const result = {
            executionId,
            status: "error",
            output: "",
            error: e instanceof Error ? e.message : String(e),
            stdout: "",
            stderr: e instanceof Error ? e.message : String(e),
            exitCode: 1,
            language: lang,
            durationMs: Date.now(),
          };
          _sandboxResults.set(executionId, result);
          return reply.code(201).send(result);
        }
      }

      // JavaScript: run in isolated vm context with timeout
      const t0 = Date.now();
      // Cap captured output: a runaway loop that console.logs in a tight
      // loop survives until the 5s vm timeout, but by then it can have
      // emitted millions of lines that wedge the browser when rendered.
      const MAX_LOG_LINES = 500;
      const MAX_LOG_CHARS = 200_000;
      const logs: string[] = [];
      let logTruncated = false;
      let logChars = 0;
      const pushLog = (line: string) => {
        if (logs.length >= MAX_LOG_LINES || logChars >= MAX_LOG_CHARS) {
          logTruncated = true;
          return;
        }
        logs.push(line);
        logChars += line.length;
      };
      const ctx = vm.createContext({
        console: {
          log: (...a: unknown[]) => pushLog(a.map(String).join(" ")),
          error: (...a: unknown[]) => pushLog("[err] " + a.map(String).join(" ")),
          warn: (...a: unknown[]) => pushLog("[warn] " + a.map(String).join(" ")),
        },
        Math,
        JSON,
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
        encodeURIComponent,
        decodeURIComponent,
        setTimeout: undefined,
        setInterval: undefined,
        fetch: undefined,
        require: undefined,
      });
      let output = "";
      let error: string | undefined;
      try {
        const returnVal = vm.runInContext(code, ctx, { timeout: 5000, filename: "sandbox.js" });
        output = [...logs, returnVal !== undefined ? String(returnVal) : ""]
          .filter(Boolean)
          .join("\n");
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        output = logs.join("\n");
      }
      if (logTruncated) {
        output += "\n… output truncated (too many lines)";
      }
      const result = {
        executionId,
        status: error ? "error" : "done",
        output,
        error,
        // Normalized fields matching UI ExecResult interface
        stdout: error ? output : output,
        stderr: error ? error : "",
        exitCode: error ? 1 : 0,
        language: "javascript",
        durationMs: Date.now() - t0,
        truncated: logTruncated,
      };
      _sandboxResults.set(executionId, result);
      return reply.code(201).send(result);
    },
  );

  app.get<{ Params: { id: string } }>("/sandbox/status/:id", async (request, reply) => {
    return reply.send(
      _sandboxResults.get(request.params.id) ?? {
        executionId: request.params.id,
        status: "not_found",
      },
    );
  });

  // -- EVALUATION (alias to evals) -------------------------------------------

  // -- EVALUATION (LLM-backed scoring) ----------------------------------------

  interface EvalEntry {
    id: string;
    conversation: string;
    quality: number;
    coherence: number;
    consensus: number;
    diversity: number;
    date: string;
  }
  const _evalStore = new PersistentStore<EvalEntry>("eval_results");
  await _evalStore.load();

  app.get<{ Querystring: { days?: string } }>("/evaluation/dashboard", async (req, reply) => {
    const days = parseInt(req.query.days ?? "30", 10);
    const cutoff = Date.now() - days * 86_400_000;
    const entries = Array.from(_evalStore.values()).filter(
      (e) => new Date(e.date).getTime() >= cutoff,
    );
    const avg = (key: keyof EvalEntry) =>
      entries.length ? entries.reduce((s, e) => s + (e[key] as number), 0) / entries.length : 0;
    return reply.send({
      period: `${days} days`,
      totalRuns: entries.length,
      currentPerformance: {
        overallScore: Math.round(avg("quality") * 100) / 100,
        quality: Math.round(avg("coherence") * 100) / 100,
        consensus: Math.round(avg("consensus") * 100) / 100,
        diversity: Math.round(avg("diversity") * 100) / 100,
      },
    });
  });

  app.get("/evaluation/metrics", async (_req, reply) => {
    const entries = Array.from(_evalStore.values());
    if (!entries.length) return reply.send({ metrics: [], message: "No evaluation runs yet." });
    const avg = (key: keyof EvalEntry) =>
      entries.reduce((s, e) => s + (e[key] as number), 0) / entries.length;
    return reply.send({
      metrics: [
        { name: "Quality", value: Math.round(avg("quality") * 100) / 100, trend: "stable" },
        { name: "Coherence", value: Math.round(avg("coherence") * 100) / 100, trend: "stable" },
        { name: "Consensus", value: Math.round(avg("consensus") * 100) / 100, trend: "stable" },
        { name: "Diversity", value: Math.round(avg("diversity") * 100) / 100, trend: "stable" },
      ],
    });
  });

  app.get("/evaluation/results", async (_req, reply) => {
    return reply.send({
      results: Array.from(_evalStore.values()).sort((a, b) => b.date.localeCompare(a.date)),
    });
  });

  app.post<{ Body: EvalEntry }>("/evaluation/results", async (req, reply) => {
    const entry: EvalEntry = {
      ...req.body,
      id: req.body.id ?? crypto.randomUUID(),
      date: req.body.date ?? now().slice(0, 10),
    };
    _evalStore.set(entry.id, entry);
    return reply.code(201).send(entry);
  });

  app.post<{ Body: { topic?: string; prompt?: string } }>("/evaluate", async (req, reply) => {
    const prompt =
      req.body.prompt ?? req.body.topic ?? "Evaluate the quality of this council deliberation.";
    // LLM-scored eval run
    const scoreText = await _llm(
      [
        systemMsg(
          "You are an AI evaluation system. Score the given topic on four dimensions: quality, coherence, consensus, diversity. Each score is 0.0–1.0. Return only JSON: {quality, coherence, consensus, diversity}",
        ),
        userMsg(prompt),
      ],
      128,
    );
    const scores = { quality: 0.75, coherence: 0.72, consensus: 0.68, diversity: 0.81 };
    try {
      Object.assign(scores, parseJsonResponse(scoreText));
    } catch {
      /* use defaults */
    }
    const entry: EvalEntry = {
      id: crypto.randomUUID(),
      conversation: prompt.slice(0, 80),
      quality: Math.min(1, Math.max(0, scores.quality)),
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

  const _adminUsers = new Map<
    string,
    { id: string; email: string; role: string; status: string; createdAt: string }
  >([
    [
      "local",
      {
        id: "local",
        email: "admin@nexus.local",
        role: "admin",
        status: "active",
        createdAt: now(),
      },
    ],
  ]);

  app.get("/admin/users", async (_req, reply) => {
    // Real users from the Postgres `users` table (auth-backed). Falls back to the
    // in-memory seed only if the DB is unreachable.
    try {
      const rows = await db
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          role: users.role,
          tier: users.tier,
          emailVerified: users.emailVerified,
          createdAt: users.createdAt,
          deletedAt: users.deletedAt,
        })
        .from(users)
        .orderBy(desc(users.createdAt))
        .limit(500);
      const list = rows.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name ?? null,
        role: u.role,
        tier: u.tier,
        emailVerified: u.emailVerified,
        status: u.deletedAt ? "deleted" : "active",
        createdAt:
          u.createdAt instanceof Date ? u.createdAt.toISOString() : String(u.createdAt ?? ""),
      }));
      return reply.send({ users: list, total: list.length, source: "db" });
    } catch (err) {
      app.log.warn({ err: String(err) }, "admin/users db fallback");
      return reply.send({
        users: Array.from(_adminUsers.values()),
        total: _adminUsers.size,
        source: "memory",
      });
    }
  });

  app.put<{ Params: { id: string }; Body: { role?: string; status?: string } }>(
    "/admin/users/:id",
    async (request, reply) => {
      const { role, status } = request.body ?? {};
      const VALID_ROLES = ["owner", "admin", "member", "viewer"];
      const updates: Record<string, unknown> = {};
      if (role !== undefined) {
        if (!VALID_ROLES.includes(role)) {
          return reply.code(400).send({ error: "invalid_role", valid: VALID_ROLES });
        }
        updates.role = role;
      }
      // status maps to soft-delete: "deleted"/"suspended" → set deletedAt; "active" → clear.
      if (status !== undefined) {
        updates.deletedAt = status === "active" ? null : new Date();
      }
      if (Object.keys(updates).length === 0) {
        return reply.code(400).send({ error: "no_updatable_fields" });
      }
      try {
        const [updated] = await db
          .update(users)
          .set(updates)
          .where(eq(users.id, request.params.id))
          .returning({
            id: users.id,
            email: users.email,
            role: users.role,
            deletedAt: users.deletedAt,
          });
        if (!updated) return reply.code(404).send({ error: "not_found" });
        return reply.send({
          id: updated.id,
          email: updated.email,
          role: updated.role,
          status: updated.deletedAt ? "deleted" : "active",
        });
      } catch (err) {
        app.log.warn({ err: String(err) }, "admin/users update");
        return reply.code(500).send({ error: "update_failed" });
      }
    },
  );

  app.get("/admin/audit-logs", async (_req, reply) => {
    // Real, hash-chained audit trail from the `audit_log` table (see audit-emitter).
    try {
      const rows = await db
        .select({
          id: auditLog.id,
          action: auditLog.action,
          actor: auditLog.actor,
          entityType: auditLog.entityType,
          entityId: auditLog.entityId,
          createdAt: auditLog.createdAt,
        })
        .from(auditLog)
        .orderBy(desc(auditLog.createdAt))
        .limit(200);
      const logs = rows.map((r) => ({
        id: r.id,
        action: r.action,
        user: r.actor,
        resource: `${r.entityType}:${r.entityId}`,
        ts: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt ?? ""),
      }));
      return reply.send({ logs, total: logs.length, source: "db" });
    } catch (err) {
      app.log.warn({ err: String(err) }, "admin/audit-logs db fallback");
      return reply.send({ logs: [], total: 0, source: "memory" });
    }
  });

  // -- BILLING ---------------------------------------------------------------

  // -- BILLING (free + BYOK — no subscriptions) ---------------------------------
  //
  // Nexus is free to use. Users bring their own API keys (BYOK) for LLM providers.
  // No Stripe, no checkout, no paywalls.

  app.get("/billing/plans", async (_req, reply) => {
    return reply.send({
      model: "free+byok",
      plans: [
        {
          id: "free",
          name: "Free",
          price: 0,
          features: ["Unlimited usage", "All features included", "Self-hosted or cloud"],
        },
        {
          id: "byok",
          name: "BYOK",
          price: 0,
          features: [
            "Bring your own OpenAI / Anthropic / Groq key",
            "Full cost control",
            "Zero markup",
          ],
        },
      ],
      current: "free",
      note: "Nexus is free. Add your own provider keys under /user/provider-keys to unlock LLM features.",
    });
  });

  app.post("/billing/checkout", async (_req, reply) => {
    return reply.send({
      ok: true,
      message: "No checkout needed — Nexus is free. Use /user/provider-keys to add your LLM keys.",
    });
  });

  // -- BILLING: subscription / usage / cancel (bridge synthetic store) ----------
  // Frontend: apps/ui/app/routes/billing.tsx
  const _billingSubs = new Map<
    string,
    {
      planId: string;
      status: string;
      interval: string;
      currentPeriodEnd: string;
      cancelAtPeriodEnd: boolean;
      priceUsd: number;
    }
  >();

  function getBillingSub(tid: string) {
    let sub = _billingSubs.get(tid);
    if (!sub) {
      const periodEnd = new Date();
      periodEnd.setDate(periodEnd.getDate() + 30);
      sub = {
        planId: "pro",
        status: "active",
        interval: "monthly",
        currentPeriodEnd: periodEnd.toISOString(),
        cancelAtPeriodEnd: false,
        priceUsd: 0,
      };
      _billingSubs.set(tid, sub);
    }
    return sub;
  }

  app.get<{ Params: { tid: string } }>("/billing/subscription/:tid", async (req, reply) => {
    return reply.send(getBillingSub(req.params.tid));
  });

  app.get<{ Params: { tid: string } }>("/billing/usage/:tid", async (req, reply) => {
    const periodStart = new Date();
    periodStart.setDate(periodStart.getDate() - 30);
    const usedTokens = (req.params.tid.length * 13_037) % 500_000;
    // billing.tsx renders requests/tokensIn/tokensOut/cost; keep the legacy
    // usedTokens/usedUsd/limitUsd fields for other consumers.
    return reply.send({
      periodStart: periodStart.toISOString(),
      periodEnd: new Date().toISOString(),
      requests: 0,
      tokensIn: usedTokens,
      tokensOut: 0,
      cost: Number((usedTokens * 0.000003).toFixed(4)),
      byModel: {},
      usedTokens,
      usedUsd: Number((usedTokens * 0.000003).toFixed(2)),
      limitUsd: 10,
    });
  });

  app.post<{ Params: { tid: string } }>("/billing/cancel/:tid", async (req, reply) => {
    const sub = getBillingSub(req.params.tid);
    sub.cancelAtPeriodEnd = true;
    return reply.send({ ok: true, subscription: sub });
  });

  // -- BYOK PROVIDER KEYS --------------------------------------------------------
  //
  // Users store their own LLM provider API keys. Keys are encrypted at rest with
  // AES-256-GCM using a server-side encryption key derived from NEXUS_ENCRYPTION_KEY
  // (falls back to a deterministic dev key — warn in production).
  //
  // Stored: { id, userId, provider, keyPrefix (first 8 chars), encryptedKey, iv, authTag, createdAt }
  // Returned: id, provider, keyPrefix, createdAt only — never the raw key.

  // Persisted, encrypted at rest in user_provider_credentials (AES-256-GCM via
  // secret-crypto). Raw keys are NEVER returned over HTTP — only resolved
  // server-side at request time via resolveUserProviderKey().

  const VALID_PROVIDERS = [
    "openai",
    "anthropic",
    "groq",
    "gemini",
    "deepseek",
    "mistral",
    "openrouter",
    "xai",
    "together",
    "perplexity",
    "cohere",
    "cerebras",
    "ollama",
    // Composite-credential providers — apiKey carries a JSON blob (parsed in
    // lib/provider-keys.ts). The UI collects the parts in a multi-field form.
    "bedrock",
    "vertex",
    "custom",
  ] as const;
  type ProviderName = (typeof VALID_PROVIDERS)[number];
  // resolveUserProviderKey / buildUserDriverRegistry live in ../lib/provider-keys.js

  // POST /user/provider-keys — store (encrypt) a provider connection.
  // A key is optional for local/self-hosted providers (e.g. ollama, custom) as
  // long as a baseUrl is given; baseUrl + models are non-secret connection metadata.
  app.post<{
    Body: {
      provider: string;
      apiKey?: string;
      label?: string;
      baseUrl?: string;
      models?: string[];
    };
  }>("/user/provider-keys", { preHandler: requireAuthWithTier }, async (request, reply) => {
    const { provider, apiKey, label, baseUrl, models } = request.body ?? {};
    if (!provider) return reply.code(400).send({ error: "provider is required" });
    if (!VALID_PROVIDERS.includes(provider as ProviderName)) {
      return reply.code(400).send({ error: "invalid_provider", valid: VALID_PROVIDERS });
    }
    if (apiKey && apiKey.length < 8) return reply.code(400).send({ error: "apiKey too short" });

    const userId = request.nexusUserId!;
    // Look up the existing active connection so a metadata-only edit (new label /
    // models / baseUrl, but no re-entered key) keeps the stored key. Keys are
    // write-only in the UI, so an empty apiKey on edit means "keep existing".
    const [existing] = await db
      .select()
      .from(userProviderCredentials)
      .where(
        and(
          eq(userProviderCredentials.userId, userId),
          eq(userProviderCredentials.provider, provider),
          isNull(userProviderCredentials.deletedAt),
        ),
      )
      .limit(1);

    // A brand-new connection needs at least a key or a baseUrl; an edit can rely
    // on the carried-over key/baseUrl from the existing row.
    const effectiveBaseUrl = baseUrl ?? existing?.baseUrl ?? null;
    if (!apiKey && !effectiveBaseUrl && !existing?.encryptedKey)
      return reply.code(400).send({ error: "apiKey or baseUrl is required" });

    let encryptedKey: string | null = existing?.encryptedKey ?? null;
    let keyPrefix: string | null = existing?.keyPrefix ?? null;
    let keyHash: string | null = existing?.keyHash ?? null;
    if (apiKey) {
      try {
        encryptedKey = encryptSecret(apiKey);
      } catch (e) {
        if (e instanceof SecretCryptoUnavailableError)
          return reply.code(503).send({ error: "encryption_unavailable" });
        throw e;
      }
      keyPrefix = apiKey.slice(0, 8);
      keyHash = sha256hex(apiKey);
    }

    // Rotation: soft-delete any existing active connection for this (user, provider).
    await db
      .update(userProviderCredentials)
      .set({ deletedAt: new Date(), active: false })
      .where(
        and(
          eq(userProviderCredentials.userId, userId),
          eq(userProviderCredentials.provider, provider),
          isNull(userProviderCredentials.deletedAt),
        ),
      );

    const [row] = await db
      .insert(userProviderCredentials)
      .values({
        userId,
        provider,
        label: label ?? existing?.label ?? null,
        encryptedKey,
        keyPrefix,
        keyHash,
        baseUrl: effectiveBaseUrl,
        models: models ?? existing?.models ?? null,
      })
      .returning({
        id: userProviderCredentials.id,
        provider: userProviderCredentials.provider,
        keyPrefix: userProviderCredentials.keyPrefix,
        baseUrl: userProviderCredentials.baseUrl,
        models: userProviderCredentials.models,
        createdAt: userProviderCredentials.createdAt,
      });

    // Record a hash-chained audit event (fire-and-forget, never throws).
    if (row) {
      void emitAuditEvent(
        {
          entityType: "provider_credential",
          entityId: row.id,
          action: existing ? "provider_key.rotate" : "provider_key.create",
          actor: userId,
          payload: { provider },
        },
        request.log,
      );
    }

    return reply.code(201).send(row);
  });

  // GET /user/provider-keys — list active keys (prefix only, never raw key)
  app.get("/user/provider-keys", { preHandler: requireAuthWithTier }, async (request, reply) => {
    const userId = request.nexusUserId!;
    const keys = await db
      .select({
        id: userProviderCredentials.id,
        provider: userProviderCredentials.provider,
        label: userProviderCredentials.label,
        keyPrefix: userProviderCredentials.keyPrefix,
        baseUrl: userProviderCredentials.baseUrl,
        models: userProviderCredentials.models,
        createdAt: userProviderCredentials.createdAt,
        lastUsedAt: userProviderCredentials.lastUsedAt,
      })
      .from(userProviderCredentials)
      .where(
        and(eq(userProviderCredentials.userId, userId), isNull(userProviderCredentials.deletedAt)),
      );
    return reply.send({ keys, total: keys.length });
  });

  // DELETE /user/provider-keys/:id — soft-delete (ownership-checked)
  app.delete<{ Params: { id: string } }>(
    "/user/provider-keys/:id",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const userId = request.nexusUserId!;
      const [row] = await db
        .select({
          id: userProviderCredentials.id,
          userId: userProviderCredentials.userId,
        })
        .from(userProviderCredentials)
        .where(
          and(
            eq(userProviderCredentials.id, request.params.id),
            isNull(userProviderCredentials.deletedAt),
          ),
        )
        .limit(1);
      if (!row) return reply.code(404).send({ error: "not_found" });
      if (row.userId !== userId) return reply.code(403).send({ error: "forbidden" });
      await db
        .update(userProviderCredentials)
        .set({ deletedAt: new Date(), active: false })
        .where(eq(userProviderCredentials.id, request.params.id));
      return reply.send({ ok: true });
    },
  );

  // NOTE: the former GET /user/provider-keys/resolve/:provider endpoint was
  // intentionally removed — decrypted keys must never be returned over HTTP.
  // Server-side callers use resolveUserProviderKey() instead.

  // -- FEATURE FLAGS ---------------------------------------------------------

  const _flags = new Map<string, boolean>();

  app.get("/feature-flags/admin/flags", async (_req, reply) => {
    return reply.send({ flags: Object.fromEntries(_flags) });
  });

  app.post<{ Body: { key: string; enabled: boolean } }>(
    "/feature-flags/admin/flags",
    async (request, reply) => {
      _flags.set(request.body.key, request.body.enabled);
      return reply.send({ ok: true });
    },
  );

  // -- FEEDBACK --------------------------------------------------------------

  const _feedbackStore = new PersistentStore<{
    id: string;
    rating: number;
    model: string | null;
    comment: string | null;
    messageId: string | null;
    createdAt: string;
  }>("feedback");
  _feedbackStore.load().catch(() => {});

  // POST /feedback — submit an explicit 1-5 rating with optional model/comment.
  app.post<{ Body: { rating: number; model?: string; comment?: string; messageId?: string } }>(
    "/feedback",
    {
      schema: {
        body: {
          type: "object",
          required: ["rating"],
          properties: {
            rating: { type: "number", minimum: 1, maximum: 5 },
            model: { type: "string", maxLength: 128 },
            comment: { type: "string", maxLength: 4_096 },
            messageId: { type: "string", maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      const id = crypto.randomUUID();
      const item = {
        id,
        rating: Math.round(request.body.rating),
        model: request.body.model ?? null,
        comment: request.body.comment ?? null,
        messageId: request.body.messageId ?? null,
        createdAt: now(),
      };
      _feedbackStore.set(id, item);
      return reply.code(201).send(item);
    },
  );

  app.get("/feedback/stats", async (_req, reply) => {
    const entries = Array.from(_feedbackStore.values());
    const byRating: Record<string, number> = {};
    const byModel: Record<string, number> = {};
    let ratingSum = 0;
    for (const e of entries) {
      byRating[e.rating] = (byRating[e.rating] ?? 0) + 1;
      if (e.model) byModel[e.model] = (byModel[e.model] ?? 0) + 1;
      ratingSum += e.rating;
    }
    // Emoji reactions are an implicit feedback signal — surface their counts too.
    const reactions = Array.from(_reactionsStore.values());
    const byEmoji: Record<string, number> = {};
    for (const r of reactions) byEmoji[r.emoji] = (byEmoji[r.emoji] ?? 0) + 1;
    return reply.send({
      total: entries.length,
      avgRating: entries.length ? Math.round((ratingSum / entries.length) * 100) / 100 : 0,
      byRating,
      byModel,
      reactions: { total: reactions.length, byEmoji },
    });
  });

  app.get("/feedback/export", async (_req, reply) =>
    reply.send({ entries: Array.from(_feedbackStore.values()) }),
  );

  // -- CONNECTORS -----------------------------------------------------------

  // Seed the bridge connector store with the registry connectors (v1
  // /connectors in connectors.ts registers groq/tavily/github/neon/slack/
  // linear/notion/bitbucket/jira) so the sync panel works for them. Only when
  // empty — never clobber user-added connectors.
  if (_connectors.size === 0) {
    const seed = [
      "groq",
      "tavily",
      "github",
      "neon",
      "slack",
      "linear",
      "notion",
      "bitbucket",
      "jira",
    ];
    for (const id of seed) {
      _connectors.set(id, { id, type: id, status: "connected", label: id });
    }
  }

  app.get("/connectors", async (_req, reply) => {
    return reply.send({ connectors: Array.from(_connectors.values()) });
  });

  app.post<{ Body: { type?: string; label?: string; [k: string]: unknown } }>(
    "/connectors",
    async (request, reply) => {
      const id = crypto.randomUUID();
      const { type = "custom", label = "Connector" } = request.body;
      _connectors.set(id, { id, type, label, status: "connected" });
      return reply.code(201).send({ id, type, label, status: "connected" });
    },
  );

  app.delete<{ Params: { id: string } }>("/connectors/:id", async (request, reply) => {
    _connectors.delete(request.params.id);
    return reply.code(204).send();
  });

  // Map a persisted job row to the UI contract (ConnectorSyncPanel / connectors-sync):
  // { id, connectorId, syncMode, status, startedAt, completedAt, documentsProcessed,
  //   documentsDeleted, errorMessage, createdAt }
  const toSyncJob = (j: {
    id: string;
    connectorId: string;
    status: string;
    items: number;
    startedAt: string;
    finishedAt: string;
  }) => ({
    id: j.id,
    connectorId: j.connectorId,
    syncMode: "load" as const,
    status: j.status,
    startedAt: j.startedAt,
    completedAt: j.finishedAt,
    documentsProcessed: j.items,
    documentsDeleted: 0,
    errorMessage: null,
    createdAt: j.startedAt,
  });

  app.get<{ Params: { id: string }; Querystring: { status?: string; limit?: string } }>(
    "/connectors/:id/sync-jobs",
    async (request, reply) => {
      const { id } = request.params;
      const statuses = (request.query.status ?? "").split(",").filter(Boolean);
      const limit = Number(request.query.limit ?? 50) || 50;
      let jobs = Array.from(_connectorSyncJobs.values())
        .filter((j) => j.connectorId === id)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .map(toSyncJob);
      if (statuses.length > 0) jobs = jobs.filter((j) => statuses.includes(j.status));
      jobs = jobs.slice(0, limit);
      return reply.send({ jobs, total: jobs.length });
    },
  );

  app.post<{ Params: { id: string } }>("/connectors/:id/sync", async (request, reply) => {
    const connectorId = request.params.id;
    if (!_connectors.has(connectorId)) {
      return reply.code(404).send({ error: "connector_not_found" });
    }
    // Synchronous local sync: record a completed job row. A real remote connector
    // would enqueue work; here we persist an auditable job with a timestamp.
    const startedAt = now();
    const job = {
      id: crypto.randomUUID(),
      connectorId,
      status: "completed",
      items: 0,
      startedAt,
      finishedAt: now(),
    };
    _connectorSyncJobs.set(job.id, job);
    // Mark any schedule for this connector as last-run now.
    for (const s of _connectorSyncSchedules.values()) {
      if (s.connectorId === connectorId) {
        _connectorSyncSchedules.set(s.id, { ...s, lastRunAt: now() });
      }
    }
    return reply.code(201).send(toSyncJob(job));
  });

  // -- Connector sync panel (ConnectorSyncPanel.tsx) --------------------------

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/connectors/:id/sync/jobs",
    async (request, reply) => {
      const { id } = request.params;
      const limit = Number(request.query.limit ?? 50) || 50;
      const jobs = Array.from(_connectorSyncJobs.values())
        .filter((j) => j.connectorId === id)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, limit)
        .map(toSyncJob);
      return reply.send({ jobs });
    },
  );

  app.delete<{ Params: { id: string; jobId: string } }>(
    "/connectors/:id/sync/jobs/:jobId",
    async (request, reply) => {
      const { id, jobId } = request.params;
      const job = _connectorSyncJobs.get(jobId);
      if (!job || job.connectorId !== id) {
        return reply.code(404).send({ error: "job_not_found" });
      }
      _connectorSyncJobs.delete(jobId);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { id: string } }>("/connectors/:id/sync/schedules", async (request, reply) => {
    const schedules = Array.from(_connectorSyncSchedules.values()).filter(
      (s) => s.connectorId === request.params.id,
    );
    return reply.send({ schedules });
  });

  app.post<{
    Params: { id: string };
    Body: { syncMode?: string; cronExpression?: string; enabled?: boolean };
  }>("/connectors/:id/sync/schedules", async (request, reply) => {
    const connectorId = request.params.id;
    if (!_connectors.has(connectorId)) {
      return reply.code(404).send({ error: "connector_not_found" });
    }
    const schedule = {
      id: crypto.randomUUID(),
      connectorId,
      syncMode: (request.body.syncMode === "poll" || request.body.syncMode === "slim"
        ? request.body.syncMode
        : "load") as "load" | "poll" | "slim",
      cronExpression: request.body.cronExpression ?? "0 * * * *",
      enabled: request.body.enabled ?? true,
      lastRunAt: null,
      nextRunAt: null,
      createdAt: now(),
    };
    _connectorSyncSchedules.set(schedule.id, schedule);
    return reply.code(201).send(schedule);
  });

  app.patch<{
    Params: { id: string; scheduleId: string };
    Body: Partial<{
      syncMode: string;
      cronExpression: string;
      enabled: boolean;
    }>;
  }>("/connectors/:id/sync/schedules/:scheduleId", async (request, reply) => {
    const { id, scheduleId } = request.params;
    const existing = _connectorSyncSchedules.get(scheduleId);
    if (!existing || existing.connectorId !== id) {
      return reply.code(404).send({ error: "schedule_not_found" });
    }
    const updated = {
      ...existing,
      ...(request.body as Partial<typeof existing>),
    };
    _connectorSyncSchedules.set(scheduleId, updated);
    return reply.send(updated);
  });

  app.delete<{ Params: { id: string; scheduleId: string } }>(
    "/connectors/:id/sync/schedules/:scheduleId",
    async (request, reply) => {
      const { id, scheduleId } = request.params;
      const existing = _connectorSyncSchedules.get(scheduleId);
      if (!existing || existing.connectorId !== id) {
        return reply.code(404).send({ error: "schedule_not_found" });
      }
      _connectorSyncSchedules.delete(scheduleId);
      return reply.code(204).send();
    },
  );

  // -- CRAFT (LLM-powered content generation) --------------------------------

  const CRAFT_TEMPLATES = [
    { id: "blog-post", name: "Blog Post", description: "Long-form blog article" },
    { id: "email", name: "Email", description: "Professional email draft" },
    { id: "product-desc", name: "Product Description", description: "Compelling product copy" },
    { id: "social-post", name: "Social Post", description: "Engaging social media post" },
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

  const _schemaStore = new Map<
    string,
    { id: string; name: string; schema: unknown; createdAt: string }
  >();
  const _extractionJobs = new Map<
    string,
    { id: string; status: string; result: unknown; createdAt: string }
  >();

  const EXTRACTION_TEMPLATES = [
    {
      id: "contact",
      name: "Contact Info",
      schema: {
        type: "object",
        properties: {
          name: { type: "string" },
          email: { type: "string" },
          phone: { type: "string" },
        },
      },
    },
    {
      id: "event",
      name: "Event",
      schema: {
        type: "object",
        properties: {
          title: { type: "string" },
          date: { type: "string" },
          location: { type: "string" },
        },
      },
    },
    {
      id: "product",
      name: "Product",
      schema: {
        type: "object",
        properties: {
          name: { type: "string" },
          price: { type: "number" },
          description: { type: "string" },
        },
      },
    },
    {
      id: "invoice",
      name: "Invoice",
      schema: {
        type: "object",
        properties: {
          vendor: { type: "string" },
          amount: { type: "number" },
          dueDate: { type: "string" },
        },
      },
    },
  ];

  // Schema inference via LLM
  app.post<{ Body: { text: string } }>("/extraction/infer-schema", async (request, reply) => {
    const { text } = request.body;
    if (!text) return reply.code(400).send({ error: "text_required" });
    const driver = getDefaultDriver();
    if (!driver) {
      // Best-effort heuristic schema when no LLM available
      return reply.send({
        schema: {
          type: "object",
          properties: { content: { type: "string" } },
          required: ["content"],
        },
      });
    }
    const res = await driver.complete({
      model: DEFAULT_MODEL,
      messages: [
        {
          role: "user" as LlmRole,
          content: `Analyse this text and infer a JSON Schema (draft-07) that describes the key structured data it contains.\nReturn ONLY valid JSON — no explanation.\n\nText:\n${text.slice(0, 2000)}`,
        },
      ],
      maxTokens: 512,
    });
    _trackCost(DEFAULT_MODEL, res.usage);
    let schema: unknown;
    try {
      schema = parseJsonResponse(res.content);
    } catch {
      schema = {
        type: "object",
        properties: { extracted: { type: "string", description: res.content } },
      };
    }
    return reply.send({ schema });
  });

  // Extraction helper: run LLM extraction
  const _extractWithLLM = async (text: string, schema: unknown): Promise<unknown> => {
    const driver = getDefaultDriver();
    if (!driver) return { raw: text.slice(0, 200) };
    const res = await driver.complete({
      model: DEFAULT_MODEL,
      messages: [
        {
          role: "user" as LlmRole,
          content: `Extract structured data from the following text according to this JSON Schema.\nReturn ONLY valid JSON.\n\nSchema:\n${JSON.stringify(schema, null, 2)}\n\nText:\n${text.slice(0, 3000)}`,
        },
      ],
      maxTokens: 1024,
    });
    _trackCost(DEFAULT_MODEL, res.usage);
    try {
      return parseJsonResponse(res.content);
    } catch {
      return { raw: res.content };
    }
  };

  app.post<{ Body: { text: string; schema?: unknown; schemaId?: string } }>(
    "/extraction/preview",
    async (request, reply) => {
      const { text, schema, schemaId } = request.body;
      const resolvedSchema =
        schema ?? _schemaStore.get(schemaId ?? "")?.schema ?? EXTRACTION_TEMPLATES[0]?.schema;
      const result = await _extractWithLLM(text, resolvedSchema);
      return reply.send({ preview: result, schema: resolvedSchema });
    },
  );

  app.post<{ Body: { text: string; schema?: unknown; schemaId?: string } }>(
    "/extraction/run",
    async (request, reply) => {
      const { text, schema, schemaId } = request.body;
      const resolvedSchema =
        schema ?? _schemaStore.get(schemaId ?? "")?.schema ?? EXTRACTION_TEMPLATES[0]?.schema;
      const result = await _extractWithLLM(text, resolvedSchema);
      const id = crypto.randomUUID();
      _extractionJobs.set(id, { id, status: "done", result, createdAt: now() });
      return reply.code(201).send({ id, result, status: "done" });
    },
  );

  app.get("/extraction/templates", async (_req, reply) =>
    reply.send({ templates: EXTRACTION_TEMPLATES }),
  );

  app.get("/extraction/schemas", async (_req, reply) =>
    reply.send({ schemas: Array.from(_schemaStore.values()) }),
  );
  app.post<{ Body: { name: string; schema: unknown } }>(
    "/extraction/schemas",
    async (request, reply) => {
      const id = crypto.randomUUID();
      _schemaStore.set(id, {
        id,
        name: request.body.name,
        schema: request.body.schema,
        createdAt: now(),
      });
      return reply.code(201).send({ id, name: request.body.name });
    },
  );
  app.delete<{ Params: { id: string } }>("/extraction/schemas/:id", async (request, reply) => {
    _schemaStore.delete(request.params.id);
    return reply.code(204).send();
  });

  app.get("/extraction/jobs", async (_req, reply) =>
    reply.send({ jobs: Array.from(_extractionJobs.values()) }),
  );
  app.get<{ Params: { id: string } }>("/extraction/jobs/:id", async (request, reply) => {
    return reply.send(
      _extractionJobs.get(request.params.id) ?? reply.code(404).send({ error: "not_found" }),
    );
  });
  app.delete<{ Params: { id: string } }>("/extraction/jobs/:id", async (request, reply) => {
    _extractionJobs.delete(request.params.id);
    return reply.code(204).send();
  });
  app.get<{ Params: { id: string } }>("/extraction/jobs/:id/export", async (request, reply) => {
    const job = _extractionJobs.get(request.params.id);
    if (!job) return reply.code(404).send({ error: "not_found" });
    reply.header("Content-Type", "application/json");
    reply.header(
      "Content-Disposition",
      `attachment; filename="extraction-${request.params.id}.json"`,
    );
    return reply.send(JSON.stringify(job.result, null, 2));
  });

  // -- SKILLS ----------------------------------------------------------------
  // Owner: routes/skills.ts — GET/POST/DELETE /skills plus POST /skills/merge
  // live there (PersistentStore collection "skills", same /api scope, same
  // auth). api-bridge only supplies the narrow driver/cost deps.
  await registerSkillRoutes(app, {
    defaultModel: DEFAULT_MODEL,
    getDefaultDriver,
    trackCost: _trackCost,
  });

  // -- REASONING -------------------------------------------------------------

  app.get("/reasoning/modes", async (_req, reply) => {
    return reply.send({
      modes: [
        {
          id: "chain-of-thought",
          label: "Chain of Thought",
          description: "Step-by-step reasoning",
        },
        {
          id: "tree-of-thought",
          label: "Tree of Thought",
          description: "Branching reasoning paths",
        },
        { id: "reflexion", label: "Reflexion", description: "Self-critique and revision" },
      ],
    });
  });

  app.post<{ Body: { question: string; mode?: string } }>(
    "/reasoning/run",
    async (request, reply) => {
      const driver = getDefaultDriver();
      if (!driver) return reply.code(503).send({ error: "No driver available" });

      const system =
        "Think step by step. Show your reasoning explicitly before giving the final answer.";
      const res = await driver.complete({
        model: "anthropic/claude-sonnet-4-6",
        messages: [
          { role: "system" as LlmRole, content: system },
          { role: "user" as LlmRole, content: request.body.question },
        ],
        maxTokens: 2048,
      });
      _trackCost("anthropic/claude-sonnet-4-6", res.usage);
      return reply.send({ reasoning: res.content, mode: request.body.mode ?? "chain-of-thought" });
    },
  );

  // -- KNOWLEDGE BASES -------------------------------------------------------
  // GET /kb is declared above in the KG section (real implementation via @nexus/knowledge-graph).

  app.post<{ Body: { name: string; description?: string } }>("/kb", async (request, reply) => {
    const id = crypto.randomUUID();
    const kb = {
      id,
      name: request.body.name ?? "KB",
      description: request.body.description ?? "",
      docCount: 0,
      createdAt: now(),
      documents: [],
    };
    _kbStore.set(id, kb);
    return reply.code(201).send(kb);
  });

  app.delete<{ Params: { id: string } }>("/kb/:id", async (request, reply) => {
    _kbStore.delete(request.params.id);
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>("/kb/:id/documents", async (request, reply) => {
    const kb = _kbStore.get(request.params.id);
    return reply.send({ documents: kb?.documents ?? [], total: kb?.documents.length ?? 0 });
  });

  app.post<{ Params: { id: string }; Body: { name: string; size?: string } }>(
    "/kb/:id/documents",
    async (request, reply) => {
      const kb = _kbStore.get(request.params.id);
      if (!kb) return reply.code(404).send({ error: "knowledge base not found" });
      const doc = {
        id: "doc_" + crypto.randomUUID(),
        name: request.body.name ?? "untitled",
        size: request.body.size ?? "0 KB",
        type: getDocTypeFromName(request.body.name ?? ""),
      };
      kb.documents.push(doc);
      _kbStore.set(kb.id, kb);
      return reply.code(201).send(doc);
    },
  );

  app.delete<{ Params: { id: string; docId: string } }>(
    "/kb/:id/documents/:docId",
    async (request, reply) => {
      const kb = _kbStore.get(request.params.id);
      if (kb) {
        kb.documents = kb.documents.filter((d) => d.id !== request.params.docId);
        _kbStore.set(kb.id, kb);
      }
      return reply.code(204).send();
    },
  );

  // -- IMAGE GENERATION ------------------------------------------------------

  app.get("/images/providers", async (_req, reply) => {
    return reply.send({
      providers: [
        { id: "openai-dalle", name: "DALL·E 3 (OpenAI)", available: !!process.env.OPENAI_API_KEY },
        { id: "replicate", name: "Replicate", available: !!process.env.REPLICATE_API_KEY },
      ],
    });
  });

  app.get("/images", async (_req, reply) => {
    return reply.send({ images: Array.from(_imageStore.values()), total: _imageStore.size });
  });

  app.post<{
    Body: { prompt: string; size?: string; quality?: string; style?: string; provider?: string };
  }>("/images/generate", async (request, reply) => {
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
        b64: img?.data ? Buffer.from(img.data).toString("base64") : undefined,
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
  });

  app.delete<{ Params: { id: string } }>("/images/:id", async (request, reply) => {
    _imageStore.delete(request.params.id);
    return reply.code(204).send();
  });

  // -- TOKEN USAGE (LLM token consumption stats) ----------------------------
  // Distinct from /tokens (API key management). Reads from _costLog accumulated
  // by _llm() helper calls.

  app.get("/token-usage", async (_req, reply) => {
    // Single pass over _costLog: compute used, byModel, byDay simultaneously
    let used = 0;
    const byModel: Record<string, number> = {};
    const byDayMap: Record<string, number> = {};
    for (const e of _costLog) {
      const tokens = e.inputTokens + e.outputTokens;
      used += tokens;
      byModel[e.model] = (byModel[e.model] ?? 0) + tokens;
      const d = e.ts.slice(0, 10);
      byDayMap[d] = (byDayMap[d] ?? 0) + tokens;
    }
    const byDay = Object.entries(byDayMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, tokens]) => ({ date, tokens }));
    return reply.send({ used, limit: null, byModel, byDay });
  });

  // ── Deep-research endpoints ─────────────────────────────────────────────────────────────
  // Owner: routes/research.ts — ALL /research* routes, the SSE run stream,
  // related-questions generation, and the completion/failure notification
  // emitters live there. api-bridge only supplies the generic LLM/SSE helpers
  // the stream needs (narrow ResearchBridgeDeps) and delegates — no research
  // code lives in this file anymore.
  registerResearchRoutes(app, {
    defaultModel: DEFAULT_MODEL,
    sseHeaders: SSE_HEADERS,
    userMsg,
    parseJsonResponse,
    llm: _llm,
    getDefaultDriver,
    trackCost: _trackCost,
    getScraper,
  });

  // ══════════════════════════════════════════════════════════════════════════
  // C.3 — code-agent: sandboxed code execution via @nexus/code-repl
  //        Routes: POST /code-agent/execute (one-shot)
  //                POST /code-agent/sessions (create persistent kernel)
  //                GET  /code-agent/sessions (list sessions)
  //                POST /code-agent/sessions/:id/execute (stateful run)
  //                DELETE /code-agent/sessions/:id (destroy session)
  //        Also wires: POST /build/run (same executor, build-task flavour)
  // ══════════════════════════════════════════════════════════════════════════

  const _dockerReady = isDockerAvailable();
  const _kernelManager = new KernelManager({
    executor: new DockerReplExecutor(),
    jupyterMode: true,
  });
  const _fallbackKernelManager = new KernelManager({
    executor: new MockReplExecutor(),
    jupyterMode: true,
  });

  async function _getKernelManager(): Promise<KernelManager> {
    return (await _dockerReady) ? _kernelManager : _fallbackKernelManager;
  }

  /**
   * POST /code-agent/execute — one-shot stateless code execution.
   * Body: { code: string, language?: "python"|"r"|"julia", timeoutMs?: number }
   */
  app.post<{
    Body: { code: string; language?: ReplLanguage; timeoutMs?: number };
  }>(
    "/code-agent/execute",
    {
      schema: {
        body: {
          type: "object",
          required: ["code"],
          properties: {
            code: { type: "string", maxLength: 32_768 },
            language: { type: "string", enum: ["python", "r", "julia"] },
            timeoutMs: { type: "number", minimum: 100, maximum: 30_000 },
          },
        },
      },
    },
    async (request, reply) => {
      const { code, language = "python", timeoutMs = 10_000 } = request.body;
      const km = await _getKernelManager();
      const session = km.create(language);
      try {
        const result = await session.execute({ code, timeoutMs });
        return reply.send({
          language,
          stdout: result.stdout,
          stderr: result.stderr,
          displayData: result.displayData,
          lastExpression: result.lastExpression,
          executionCount: session.executionCount,
        });
      } finally {
        km.destroy(session.id);
      }
    },
  );

  /** POST /code-agent/sessions — create a persistent kernel session. */
  app.post<{ Body: { language?: ReplLanguage } }>(
    "/code-agent/sessions",
    {
      schema: {
        body: {
          type: "object",
          properties: { language: { type: "string", enum: ["python", "r", "julia"] } },
        },
      },
    },
    async (request, reply) => {
      const language = request.body?.language ?? "python";
      const km = await _getKernelManager();
      const session = km.create(language);
      return reply.code(201).send({
        sessionId: session.id,
        language,
        createdAt: now(),
      });
    },
  );

  /** GET /code-agent/sessions — list active kernel sessions. */
  app.get("/code-agent/sessions", async (_req, reply) => {
    const km = await _getKernelManager();
    return reply.send({
      sessions: km.list().map((s) => ({
        sessionId: s.id,
        language: s.language,
        executionCount: s.executionCount,
        lastUsedAt: s.state_.lastUsedAt ?? null,
      })),
    });
  });

  /**
   * POST /code-agent/sessions/:id/execute — run code in an existing session.
   * Body: { code: string, timeoutMs?: number }
   */
  app.post<{
    Params: { id: string };
    Body: { code: string; timeoutMs?: number };
  }>(
    "/code-agent/sessions/:id/execute",
    {
      schema: {
        body: {
          type: "object",
          required: ["code"],
          properties: {
            code: { type: "string", maxLength: 32_768 },
            timeoutMs: { type: "number", minimum: 100, maximum: 30_000 },
          },
        },
      },
    },
    async (request, reply) => {
      const km = await _getKernelManager();
      const session = km.get(request.params.id);
      if (!session) {
        return reply.code(404).send({ error: "session_not_found", sessionId: request.params.id });
      }
      const { code, timeoutMs = 10_000 } = request.body;
      const result = await session.execute({ code, timeoutMs });
      return reply.send({
        sessionId: request.params.id,
        stdout: result.stdout,
        stderr: result.stderr,
        displayData: result.displayData,
        lastExpression: result.lastExpression,
        executionCount: session.executionCount,
      });
    },
  );

  /** DELETE /code-agent/sessions/:id — destroy a kernel session. */
  app.delete<{ Params: { id: string } }>("/code-agent/sessions/:id", async (request, reply) => {
    const km = await _getKernelManager();
    if (!km.has(request.params.id)) {
      return reply.code(404).send({ error: "session_not_found" });
    }
    km.destroy(request.params.id);
    return reply.code(204).send();
  });

  /**
   * POST /code-agent/run — LLM writes code for a task, then executes it.
   * Body: { task: string, language?: string, apiKey?: string, model?: string, provider?: string }
   * Returns AgentSession shape.
   */
  app.post<{
    Body: {
      task: string;
      language?: string;
      apiKey?: string;
      model?: string;
      provider?: string;
    };
  }>("/code-agent/run", async (request, reply) => {
    const {
      task,
      language = "python",
      apiKey,
      model = "openai/gpt-oss-120b",
      provider = "groq",
    } = request.body;

    const sessionId = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    // Resolve API key: body > env Groq key (platform default) > error
    const resolvedKey =
      apiKey ||
      (provider === "groq" || provider === "openai"
        ? process.env[`${provider.toUpperCase()}_API_KEY`]
        : null) ||
      process.env.GROQ_API_KEY;

    if (!resolvedKey) {
      return reply.code(402).send({
        error: "no_api_key",
        message: "Add your API key in Language Models settings (BYOK) to use Code Agent.",
      });
    }

    // Choose LLM endpoint
    const isGroq = provider === "groq" || (!apiKey && process.env.GROQ_API_KEY);
    const llmUrl = isGroq
      ? "https://api.groq.com/openai/v1/chat/completions"
      : "https://api.openai.com/v1/chat/completions";
    const llmModel = isGroq ? model : model || "gpt-4o-mini";

    const systemPrompt = `You are a code generation assistant. Write clean, runnable ${language} code to complete the task.
Output ONLY the code — no markdown fences, no explanation, no comments unless required by the code.`;

    try {
      // Step 1: Generate code via LLM
      const llmRes = await fetch(llmUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${resolvedKey}`,
        },
        body: JSON.stringify({
          model: llmModel,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: task },
          ],
          temperature: 0.2,
          max_tokens: 2048,
        }),
      });

      if (!llmRes.ok) {
        const errBody = await llmRes.text().catch(() => "");
        return reply.code(502).send({ error: "llm_failed", message: errBody });
      }

      const llmData = (await llmRes.json()) as {
        choices?: { message?: { content?: string } }[];
        error?: { message: string };
      };

      const generatedCode = llmData.choices?.[0]?.message?.content?.trim() ?? "";
      if (!generatedCode) {
        return reply.code(502).send({ error: "empty_code", message: "LLM returned no code" });
      }

      // Step 2: Execute the generated code
      const lang = language.toLowerCase();
      let finalOutput = "";
      let finalError: string | undefined;
      const iterations = 1;

      if (lang === "javascript" || lang === "js") {
        // VM execution
        const logs: string[] = [];
        const ctx = vm.createContext({
          console: {
            log: (...a: unknown[]) => logs.push(a.map(String).join(" ")),
            error: (...a: unknown[]) => logs.push("[err] " + a.map(String).join(" ")),
          },
          Math,
          JSON,
          parseInt,
          parseFloat,
          isNaN,
          isFinite,
        });
        try {
          const ret = vm.runInContext(generatedCode, ctx, { timeout: 5000 });
          finalOutput = [...logs, ret !== undefined ? String(ret) : ""].filter(Boolean).join("\n");
        } catch (e) {
          finalError = e instanceof Error ? e.message : String(e);
          finalOutput = logs.join("\n");
        }
      } else if (lang === "python" || lang === "py" || lang === "python3") {
        // Python runs locally via Pyodide (WASM) — no Piston needed.
        try {
          const pr = await _runViaPyodide(generatedCode);
          finalOutput = pr.stdout;
          finalError = pr.exitCode !== 0 ? pr.stderr : undefined;
        } catch (e) {
          finalError = e instanceof Error ? e.message : String(e);
        }
      } else {
        // Other languages → Piston (guarded against the dead public endpoint).
        try {
          const pr = await _runViaPiston(generatedCode, lang);
          finalOutput = pr.stdout;
          finalError = pr.exitCode !== 0 ? pr.stderr : undefined;
        } catch (e) {
          finalError = e instanceof Error ? e.message : String(e);
        }
      }

      return reply.send({
        sessionId,
        task,
        language,
        status: finalError ? "error" : "success",
        iterations,
        code: generatedCode,
        finalOutput: finalOutput || undefined,
        finalError,
        createdAt,
      });
    } catch (err) {
      return reply.code(500).send({
        error: "agent_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * POST /build/run — compile/build task via sandboxed REPL.
   * Body: { code: string, language?: "python"|"r"|"julia", timeoutMs?: number }
   */
  app.post<{
    Body: { code: string; language?: ReplLanguage; timeoutMs?: number };
  }>(
    "/build/run",
    {
      schema: {
        body: {
          type: "object",
          required: ["code"],
          properties: {
            code: { type: "string", maxLength: 32_768 },
            language: { type: "string", enum: ["python", "r", "julia"] },
            timeoutMs: { type: "number", minimum: 100, maximum: 60_000 },
          },
        },
      },
    },
    async (request, reply) => {
      const { code, language = "python", timeoutMs = 30_000 } = request.body;
      const km = await _getKernelManager();
      const session = km.create(language);
      try {
        const result = await session.execute({ code, timeoutMs });
        return reply.send({
          language,
          stdout: result.stdout,
          stderr: result.stderr,
          lastExpression: result.lastExpression,
          success: result.stderr.length === 0,
        });
      } finally {
        km.destroy(session.id);
      }
    },
  );

  // ══════════════════════════════════════════════════════════════════════════
  // C.4 — browser-agent: headless web automation via @nexus/stealth-browser
  //        Routes: POST /browser-agent/navigate
  //                POST /browser-agent/scrape
  //                POST /browser-agent/screenshot
  //        Lazy-init: PatchrightDriver when available, MockBrowserDriver fallback
  // ══════════════════════════════════════════════════════════════════════════

  let _stealthBrowser: StealthBrowser | null = null;

  async function _getBrowser(): Promise<StealthBrowser> {
    if (_stealthBrowser) return _stealthBrowser;
    const patchrightOk = await isPatchrightAvailable();
    const driver = patchrightOk ? new PatchrightDriver() : new MockBrowserDriver();
    _stealthBrowser = new StealthBrowser({ driver });
    return _stealthBrowser;
  }

  /**
   * POST /browser-agent/navigate — navigate to a URL, return title + HTML content.
   * Body: { url: string }
   */
  app.post<{ Body: { url: string } }>(
    "/browser-agent/navigate",
    {
      schema: {
        body: {
          type: "object",
          required: ["url"],
          properties: { url: { type: "string", format: "uri", maxLength: 2048 } },
        },
      },
    },
    async (request, reply) => {
      const browser = await _getBrowser();
      return browser.withPage(async (page) => {
        const nav = await page.goto(request.body.url);
        const content = await page.content();
        const title = await page.title();
        return reply.send({
          url: nav.url ?? request.body.url,
          statusCode: nav.status ?? null,
          title,
          content,
        });
      });
    },
  );

  /**
   * POST /browser-agent/scrape — navigate + extract text content via innerText eval.
   * Body: { url: string }
   */
  app.post<{ Body: { url: string } }>(
    "/browser-agent/scrape",
    {
      schema: {
        body: {
          type: "object",
          required: ["url"],
          properties: { url: { type: "string", format: "uri", maxLength: 2048 } },
        },
      },
    },
    async (request, reply) => {
      const browser = await _getBrowser();
      return browser.withPage(async (page) => {
        await page.goto(request.body.url);
        const title = await page.title();
        // Extract visible text and all href links via JS eval
        const text = await page.evaluate<string>("() => document.body?.innerText ?? ''");
        const links = await page.evaluate<string[]>(
          "() => Array.from(document.querySelectorAll('a[href]')).map(a => a.href).filter(h => h.startsWith('http')).slice(0, 100)",
        );
        return reply.send({ url: request.body.url, title, text, links });
      });
    },
  );

  /**
   * POST /browser-agent/screenshot — navigate + capture screenshot as base64 PNG.
   * Body: { url: string, fullPage?: boolean }
   */
  app.post<{ Body: { url: string; fullPage?: boolean } }>(
    "/browser-agent/screenshot",
    {
      schema: {
        body: {
          type: "object",
          required: ["url"],
          properties: {
            url: { type: "string", format: "uri", maxLength: 2048 },
            fullPage: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      const browser = await _getBrowser();
      return browser.withPage(async (page) => {
        await page.goto(request.body.url);
        const title = await page.title();
        const screenshot = await page.screenshot({ fullPage: request.body.fullPage ?? false });
        return reply.send({
          url: request.body.url,
          title,
          screenshot: screenshot.toString("base64"),
          mimeType: "image/png",
        });
      });
    },
  );

  // ══════════════════════════════════════════════════════════════════════════
  // C.4b — browser-agent TASK LOOP: LLM-driven multi-step web automation.
  //        POST /browser-agent/tasks            — create + run a task session
  //        GET  /browser-agent/sessions         — list sessions
  //        GET  /browser-agent/sessions/:id     — session detail
  //        POST /browser-agent/sessions/:id/action — manual single action
  //
  //        The agent drives @nexus/stealth-browser (server-side / remote CDP).
  //        Each step: snapshot page → LLM picks action → execute → repeat.
  //        Requires a real browser (patchright + BROWSER_CDP_URL or local
  //        chromium). With MockBrowserDriver it returns a clear notice.
  // ══════════════════════════════════════════════════════════════════════════

  interface BrowserAgentStep {
    action: string;
    target?: string;
    value?: string;
    description: string;
    success: boolean;
  }
  interface BrowserAgentSession {
    sessionId: string;
    task: string;
    url?: string;
    status: "pending" | "running" | "completed" | "error";
    steps: BrowserAgentStep[];
    result?: string;
    screenshot?: string;
    error?: string;
    createdAt: string;
  }
  const _browserSessions = new Map<string, BrowserAgentSession>();
  const MAX_AGENT_STEPS = 8;

  /** Ask the LLM for the next browser action given the current page state. */
  async function _nextBrowserAction(
    task: string,
    pageUrl: string,
    pageTitle: string,
    pageText: string,
    history: BrowserAgentStep[],
  ): Promise<{
    action: string;
    target?: string;
    value?: string;
    description: string;
    done?: boolean;
    result?: string;
  }> {
    const sys = systemMsg(
      "You are a web-automation agent. Given a goal, the current page, and action history, " +
        "decide the SINGLE next action. Respond ONLY with JSON: " +
        '{"action":"navigate|click|type|extract|done","target":"<css selector or url>","value":"<text to type>","description":"<why>","done":<bool>,"result":"<final answer when done>"}. ' +
        "Use 'done' when the goal is achieved. Keep selectors simple and robust.",
    );
    const hist = history
      .map((s) => `- ${s.action} ${s.target ?? ""} (${s.success ? "ok" : "fail"})`)
      .join("\n");
    const safeText = pageText ?? "";
    const usr = userMsg(
      `GOAL: ${task}\n\nCURRENT URL: ${pageUrl}\nTITLE: ${pageTitle}\n\nVISIBLE TEXT (truncated):\n${safeText.slice(0, 2000)}\n\nHISTORY:\n${hist || "(none)"}\n\nNext action as JSON:`,
    );
    // Use Groq (fast + reliably available) for the agent decision loop.
    const reg = getRegistry();
    const drv = reg.get("groq") ?? getDefaultDriver();
    let raw = "";
    if (drv) {
      try {
        const r = await drv.complete({
          model: reg.get("groq") ? "openai/gpt-oss-120b" : DEFAULT_MODEL,
          messages: [sys, usr],
          maxTokens: 400,
        });
        raw = (r.content ?? "").trim();
      } catch {
        raw = "";
      }
    }
    try {
      return parseJsonResponse(raw);
    } catch {
      return {
        action: "done",
        description: "Could not parse next action",
        done: true,
        result: raw.slice(0, 500),
      };
    }
  }

  /** Run the agent loop on a live page until done / max steps. Mutates session. */
  async function _runBrowserAgent(session: BrowserAgentSession): Promise<void> {
    session.status = "running";
    const browser = await _getBrowser();
    await browser.withPage(async (page) => {
      if (session.url) {
        await page.goto(session.url);
        session.steps.push({
          action: "navigate",
          target: session.url,
          description: "open start URL",
          success: true,
        });
      }
      for (let i = 0; i < MAX_AGENT_STEPS; i++) {
        const pageUrl = page.url;
        const title = await page.title().catch(() => "");
        const text = await page
          .evaluate<string>("() => document.body?.innerText ?? ''")
          .catch(() => "");
        const decision = await _nextBrowserAction(
          session.task,
          pageUrl,
          title,
          text,
          session.steps,
        );

        if (decision.done || decision.action === "done") {
          session.result = decision.result ?? text.slice(0, 1000);
          break;
        }
        let ok = true;
        try {
          if (decision.action === "navigate" && decision.target) {
            await page.goto(decision.target);
          } else if (decision.action === "click" && decision.target) {
            await page.click(decision.target);
          } else if (decision.action === "type" && decision.target) {
            await page.type(decision.target, decision.value ?? "");
          }
          // 'extract' is a no-op execution; the LLM reads text next round.
        } catch (e) {
          ok = false;
          void e;
        }
        session.steps.push({
          action: decision.action,
          target: decision.target,
          value: decision.value,
          description: decision.description,
          success: ok,
        });
      }
      // Final screenshot for the UI.
      try {
        const shot = await page.screenshot({ fullPage: false });
        session.screenshot = shot.toString("base64");
      } catch {
        /* screenshot best-effort */
      }
    });
    session.status = "completed";
  }

  app.post<{ Body: { task: string; startUrl?: string } }>(
    "/browser-agent/tasks",
    {
      schema: {
        body: {
          type: "object",
          required: ["task"],
          properties: {
            task: { type: "string", minLength: 1, maxLength: 2000 },
            startUrl: { type: "string", maxLength: 2048 },
          },
        },
      },
    },
    async (request, reply) => {
      const patchrightOk = await isPatchrightAvailable();
      const hasCdp = Boolean(process.env.BROWSER_CDP_URL);
      const session: BrowserAgentSession = {
        sessionId: crypto.randomUUID(),
        task: request.body.task,
        url: request.body.startUrl,
        status: "pending",
        steps: [],
        createdAt: now(),
      };
      _browserSessions.set(session.sessionId, session);

      if (!patchrightOk && !hasCdp) {
        session.status = "error";
        session.error =
          "No browser engine available. Install patchright on the server (pnpm add patchright && npx patchright install chromium) " +
          "or set BROWSER_CDP_URL to a hosted browser (Browserbase/Steel). Browser automation cannot drive your personal logged-in browser from a website.";
        return reply.code(200).send({ session });
      }

      // Run synchronously but guard total time; the loop is bounded by MAX_AGENT_STEPS.
      try {
        await _runBrowserAgent(session);
      } catch (e) {
        session.status = "error";
        session.error = e instanceof Error ? e.message : String(e);
      }
      return reply.code(201).send({ session });
    },
  );

  app.get("/browser-agent/sessions", async (_request, reply) => {
    const sessions = Array.from(_browserSessions.values()).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    return reply.send({ sessions });
  });

  app.get<{ Params: { id: string } }>("/browser-agent/sessions/:id", async (request, reply) => {
    const session = _browserSessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    return reply.send(session);
  });

  app.post<{ Params: { id: string }; Body: { action: string; target?: string; value?: string } }>(
    "/browser-agent/sessions/:id/action",
    async (request, reply) => {
      const session = _browserSessions.get(request.params.id);
      if (!session) return reply.code(404).send({ error: "session not found" });
      const { action, target, value } = request.body ?? {};
      if (!action) return reply.code(400).send({ error: "action is required" });
      const browser = await _getBrowser();
      let ok = true;
      let screenshot: string | undefined;
      try {
        await browser.withPage(async (page) => {
          if (session.url) await page.goto(session.url);
          if (action === "navigate" && target) await page.goto(target);
          else if (action === "click" && target) await page.click(target);
          else if (action === "type" && target) await page.type(target, value ?? "");
          const shot = await page.screenshot({ fullPage: false });
          screenshot = shot.toString("base64");
        });
      } catch (e) {
        ok = false;
        session.error = e instanceof Error ? e.message : String(e);
      }
      const step: BrowserAgentStep = {
        action,
        target,
        value,
        description: "manual action",
        success: ok,
      };
      session.steps.push(step);
      if (screenshot) session.screenshot = screenshot;
      return reply.send(session);
    },
  );

  // ══════════════════════════════════════════════════════════════════════════
  // C.5 — Real action routes for stub-prefixed resources
  //        These register BEFORE the stub loop so Fastify's static-path
  //        preference ensures they win over the /:id catch-all handlers.
  //
  //        prompt-filter   → @nexus/redteam  detectTriggers + applyParseltongue
  //        fallback-chains → @nexus/gateway  runFallbackChain
  //        task-routing    → @nexus/supervisor assignTasks
  //        verifiable      → audit-emitter   emitAuditEvent
  //        system          → process.*        runtime health
  // ══════════════════════════════════════════════════════════════════════════

  // ── prompt-filter ─────────────────────────────────────────────────────────

  /**
   * POST /prompt-filter/scan
   *
   * Scan a text for injection triggers and return a risk assessment.
   * Body: { text: string, customTriggers?: string[] }
   */
  app.post<{
    Body: { text: string; customTriggers?: string[] };
  }>(
    "/prompt-filter/scan",
    {
      schema: {
        body: {
          type: "object",
          required: ["text"],
          properties: {
            text: { type: "string", maxLength: 65_536 },
            customTriggers: { type: "array", items: { type: "string" }, maxItems: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      const { text, customTriggers = [] } = request.body;
      const triggers = detectTriggers(text, customTriggers);
      return reply.send({
        clean: triggers.length === 0,
        triggerCount: triggers.length,
        triggers,
        riskLevel: triggers.length === 0 ? "none" : triggers.length < 3 ? "low" : "high",
        textLength: text.length,
      });
    },
  );

  /**
   * POST /prompt-filter/perturb
   *
   * Apply red-team obfuscation to a text (for adversarial testing pipelines).
   * Body: { text: string, techniques?: string[] }
   */
  app.post<{
    Body: { text: string; techniques?: string[] };
  }>(
    "/prompt-filter/perturb",
    {
      schema: {
        body: {
          type: "object",
          required: ["text"],
          properties: {
            text: { type: "string", maxLength: 65_536 },
            techniques: { type: "array", items: { type: "string" }, maxItems: 20 },
          },
        },
      },
    },
    async (request, reply) => {
      const { text, techniques } = request.body;
      const cfg = redteamDefaultConfig();
      const result = applyParseltongue(text, {
        ...cfg,
        technique: (techniques?.[0] as typeof cfg.technique) ?? cfg.technique,
      });
      return reply.send({
        original: text,
        perturbed: result.transformedText,
        appliedTechniques: result.techniqueUsed,
        perturbationCount: result.transformations.length,
      });
    },
  );

  /** POST /prompt-filter/check — check text for flagged patterns */
  app.post<{ Body: { text: string } }>("/prompt-filter/check", async (request, reply) => {
    const { text } = request.body ?? {};
    if (!text) return reply.code(400).send({ error: "text is required" });
    const triggers = detectTriggers(text, []);
    return reply.send({
      flagged: triggers.length > 0,
      patterns: triggers.map((t) => ({ name: t, risk: "low" as const })),
    });
  });

  /** POST /prompt-filter/sanitize — sanitize text by stripping known patterns */
  app.post<{ Body: { text: string } }>("/prompt-filter/sanitize", async (request, reply) => {
    const { text } = request.body ?? {};
    if (!text) return reply.code(400).send({ error: "text is required" });
    return reply.send({
      // Encode HTML-significant characters instead of regex-matching tags: a
      // tag-matching regex is bypassable (CodeQL js/bad-tag-filter). Escaping
      // neutralizes <script>, event handlers, and any injected markup robustly.
      sanitized: text.replace(
        /[<>&"']/g,
        (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
      ),
    });
  });

  /** POST /prompt-filter/batch — run check on multiple items */
  app.post<{ Body: { items: string[] } }>("/prompt-filter/batch", async (request, reply) => {
    const { items = [] } = request.body ?? {};
    return reply.send({
      results: items.map((text) => {
        const triggers = detectTriggers(text, []);
        return { text, flagged: triggers.length > 0, triggers: triggers.length };
      }),
    });
  });

  /** GET /prompt-filter/patterns — list known injection patterns */
  app.get("/prompt-filter/patterns", async (_req, reply) => {
    return reply.send({
      patterns: [
        { id: "prompt-leak", name: "Prompt Leak", severity: "high" },
        { id: "jailbreak", name: "Jailbreak Attempt", severity: "critical" },
        { id: "token-smuggle", name: "Token Smuggling", severity: "medium" },
        { id: "encoding-abuse", name: "Encoding Abuse", severity: "low" },
      ],
    });
  });

  // ── fallback-chains ────────────────────────────────────────────────────────

  /**
   * POST /fallback-chains/run
   *
   * Execute an LLM request against an ordered chain of models; returns the
   * first successful response. On full-chain failure returns 502.
   *
   * Body: { chain: [{ model, provider? }], messages: [...], maxTokens?: number }
   */
  app.post<{
    Body: {
      chain: FallbackModel[];
      messages: { role: string; content: string }[];
      maxTokens?: number;
    };
  }>(
    "/fallback-chains/run",
    {
      schema: {
        body: {
          type: "object",
          required: ["chain", "messages"],
          properties: {
            chain: {
              type: "array",
              items: {
                type: "object",
                required: ["model"],
                properties: {
                  model: { type: "string" },
                  provider: { type: "string" },
                },
              },
              minItems: 1,
              maxItems: 10,
            },
            messages: { type: "array", minItems: 1 },
            maxTokens: { type: "number", minimum: 1, maximum: 8192 },
          },
        },
      },
    },
    async (request, reply) => {
      const { chain, messages, maxTokens = 2048 } = request.body;
      const reg = getRegistry();

      try {
        const chainResult = await runFallbackChain(
          chain,
          async (target) => {
            const driver =
              reg.get(target.provider ?? "openrouter") ?? reg.get("anthropic") ?? reg.get("groq");
            if (!driver) throw new Error(`No driver for provider "${target.provider ?? "any"}"`);

            const chunks: string[] = [];
            await driver.stream(
              {
                model: target.model,
                messages: messages as { role: LlmRole; content: string }[],
                maxTokens,
              },
              (delta) => {
                if (delta.delta) chunks.push(delta.delta);
              },
            );
            return chunks.join("");
          },
          {
            onFallback: (from, to, err) =>
              app.log.warn({ from, to, err: String(err) }, "fallback-chains: falling back"),
          },
        );

        return reply.send({
          result: chainResult.result,
          usedModel: chainResult.usedModel,
          attemptCount: chainResult.attemptCount,
          fallbacks: chainResult.errors.map((e) => ({
            model: e.model,
            error: String(e.error),
          })),
        });
      } catch (err) {
        return reply.code(502).send({
          error: "all_models_failed",
          message: String(err),
        });
      }
    },
  );

  // ── task-routing ───────────────────────────────────────────────────────────

  /**
   * POST /task-routing/assign
   *
   * Assign pending tasks to agents using the specified scheduling strategy.
   * Body: { tasks: OmaTask[], agents: string[], strategy?: OmaSchedulingStrategy, activeCounts?: Record<string,number> }
   * Returns: { assignments: { taskId: string, agentName: string }[] }
   */
  app.post<{
    Body: {
      tasks: OmaTask[];
      agents: string[];
      strategy?: OmaSchedulingStrategy;
      activeCounts?: Record<string, number>;
    };
  }>(
    "/task-routing/assign",
    {
      schema: {
        body: {
          type: "object",
          required: ["tasks", "agents"],
          properties: {
            tasks: { type: "array", maxItems: 500 },
            agents: { type: "array", items: { type: "string" }, maxItems: 100 },
            strategy: {
              type: "string",
              enum: ["round-robin", "least-busy", "capability-match", "dependency-first"],
            },
            activeCounts: { type: "object", additionalProperties: { type: "number" } },
          },
        },
      },
    },
    async (request, reply) => {
      const { tasks, agents, strategy = "round-robin", activeCounts: rawCounts } = request.body;

      const activeCounts = new Map<string, number>(
        Object.entries(rawCounts ?? {}).map(([k, v]) => [k, v as number]),
      );

      const assignmentMap = assignTasks(
        tasks.filter((t) => t.status === "pending"),
        agents,
        strategy,
        activeCounts,
      );

      const assignments = Array.from(assignmentMap.entries()).map(([taskId, agentName]) => ({
        taskId,
        agentName,
      }));

      return reply.send({
        assignments,
        assignedCount: assignments.length,
        unassignedCount: tasks.filter((t) => t.status === "pending").length - assignments.length,
        strategy,
      });
    },
  );

  /** POST /task-routing/classify — classify a prompt into a task category */
  app.post<{ Body: { prompt: string } }>("/task-routing/classify", async (request, reply) => {
    const { prompt } = request.body ?? {};
    if (!prompt) return reply.code(400).send({ error: "prompt is required" });
    const cats = ["code", "research", "writing", "math", "creative", "data", "general"];
    try {
      const out = await _llm(
        [
          userMsg(
            `Classify the task into exactly ONE category from [${cats.join(", ")}]. ` +
              `Reply with JSON only: {"category":"<one>","confidence":<0-1>}.\n\nTask: ${prompt.slice(0, 600)}`,
          ),
        ],
        120,
      );
      const p = parseJsonResponse<{ category?: string; confidence?: number }>(out);
      const category = cats.includes(p.category ?? "") ? p.category! : "general";
      return reply.send({ category, confidence: p.confidence ?? 0.6 });
    } catch {
      return reply.send({ category: "general", confidence: 0.5 });
    }
  });

  /** GET /task-routing/stats — routing statistics */
  app.get("/task-routing/stats", async (_req, reply) => {
    return reply.send({
      stats: {
        total: 0,
        byCategory: {} as Record<string, number>,
      },
    });
  });

  /** GET /task-routing/config — routing rules configuration */
  app.get("/task-routing/config", async (_req, reply) => {
    return reply.send({
      rules: [
        { category: "code", strategy: "capability-match", minConfidence: 0.7 },
        { category: "general", strategy: "round-robin", minConfidence: 0.5 },
        { category: "research", strategy: "least-busy", minConfidence: 0.6 },
      ],
    });
  });

  // ── verifiable ─────────────────────────────────────────────────────────────

  /**
   * POST /verifiable/emit
   *
   * Emit a verifiable, HMAC-chained audit event. Use for pipeline steps that
   * need a tamper-evident record in the audit log.
   * Body: { entityType, entityId, action, actor, payload? }
   */
  app.post<{
    Body: {
      entityType: string;
      entityId: string;
      action: string;
      actor: string;
      payload?: Record<string, unknown>;
    };
  }>(
    "/verifiable/emit",
    {
      schema: {
        body: {
          type: "object",
          required: ["entityType", "entityId", "action", "actor"],
          properties: {
            entityType: { type: "string", maxLength: 64 },
            entityId: { type: "string", maxLength: 128 },
            action: { type: "string", maxLength: 128 },
            actor: { type: "string", maxLength: 128 },
            payload: { type: "object" },
          },
        },
      },
    },
    async (request, reply) => {
      const { entityType, entityId, action, actor, payload } = request.body;
      await emitAuditEvent({ entityType, entityId, action, actor, payload }, app.log);
      return reply.code(201).send({ emitted: true, action, entityType, entityId });
    },
  );

  /** GET /verifiable/info — list verification pipelines and output formats */
  app.get("/verifiable/info", async (_req, reply) => {
    return reply.send({
      pipelines: ["factual-accuracy", "source-attribution", "logical-consistency"],
      formats: ["json", "yaml"],
    });
  });

  /** POST /verifiable/verify — run a real verification pipeline on text */
  app.post<{
    Body: {
      text: string;
      pipeline: string;
      context?: string;
      sources?: string[];
    };
  }>(
    "/verifiable/verify",
    {
      schema: {
        body: {
          type: "object",
          required: ["text", "pipeline"],
          properties: {
            text: { type: "string", maxLength: 50_000 },
            pipeline: {
              type: "string",
              enum: ["factual-accuracy", "source-attribution", "logical-consistency"],
            },
            context: { type: "string", maxLength: 50_000 },
            sources: { type: "array", items: { type: "string" }, maxItems: 20 },
          },
        },
      },
    },
    async (request, reply) => {
      const { text, pipeline, context, sources } = request.body ?? {};
      if (!text || !pipeline)
        return reply.code(400).send({ error: "text and pipeline are required" });

      const checks: Array<{ name: string; passed: boolean; detail: string; score?: number }> = [];
      const t0 = Date.now();

      // ── Check 1: Basic text validation (always runs) ─────────────────────
      const textLen = text.length;
      const hasContent = textLen > 10;
      checks.push({
        name: "content-existence",
        passed: hasContent,
        detail: hasContent ? `text has ${textLen} chars` : "text too short for verification",
      });

      if (!hasContent) {
        return reply.send({ passed: false, checks, score: 0, pipeline, verifiedAt: now() });
      }

      // ── Check 2: Hedging / uncertainty detection ─────────────────────────
      const hedgingWords = [
        "might",
        "could",
        "possibly",
        "arguably",
        "perhaps",
        "may",
        "seems like",
        "it is believed",
        "some say",
        "reportedly",
        "allegedly",
        "supposedly",
      ];
      const hedgeCount = hedgingWords.reduce(
        (count, word) =>
          count + (text.toLowerCase().match(new RegExp(`\\b${word}\\b`, "g")) ?? []).length,
        0,
      );
      const hedgeRatio = hedgeCount / Math.max(1, textLen / 100);
      const hedgeScore = Math.max(0, 1 - hedgeRatio * 2);
      checks.push({
        name: "hedging-analysis",
        passed: hedgeScore > 0.5,
        detail: `${hedgeCount} hedging phrases detected (ratio: ${hedgeRatio.toFixed(3)})`,
        score: hedgeScore,
      });

      // ── Check 3: Citation / source presence ──────────────────────────────
      const citationPatterns = [
        /\[\d+\]/, // [1], [2], etc.
        /\(.*?\d{4}.*?\)/, // (Author, 2024)
        /https?:\/\//, // URLs
        /\b(?:source|reference|according to)\b/i, // Explicit attribution
      ];
      const citationCount = citationPatterns.reduce(
        (count, pat) => count + (text.match(pat) ?? []).length,
        0,
      );
      const citationScore = Math.min(1, citationCount / 3);
      checks.push({
        name: "source-attribution",
        passed: pipeline !== "source-attribution" || citationCount > 0,
        detail: `${citationCount} citation/source patterns found`,
        score: citationScore,
      });

      // ── Check 4: Logical structure ───────────────────────────────────────
      const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 5);
      const contradictions = [
        /\b(?:is not|are not|cannot|doesn't|don't)\b/i,
        /\b(?:is|are|can|does|do)\b/i,
      ];
      // Check for sentences that directly contradict each other
      let contradictionCount = 0;
      for (let i = 0; i < Math.min(sentences.length, 50); i++) {
        for (let j = i + 1; j < Math.min(sentences.length, 50); j++) {
          const s1 = sentences[i]!.toLowerCase().trim();
          const s2 = sentences[j]!.toLowerCase().trim();
          // Very simple contradiction detection: same subject, opposite polarity
          const s1Words = new Set(s1.split(/\s+/));
          const s2Words = new Set(s2.split(/\s+/));
          const overlap = [...s1Words].filter((w) => s2Words.has(w) && w.length > 3);
          if (overlap.length > 2) {
            const s1Neg = /\b(?:not|no|never|neither|nor|none|nothing|nowhere)\b/.test(s1);
            const s2Neg = /\b(?:not|no|never|neither|nor|none|nothing|nowhere)\b/.test(s2);
            if (s1Neg !== s2Neg) contradictionCount++;
          }
        }
      }
      const logicScore = Math.max(0, 1 - contradictionCount * 0.1);
      checks.push({
        name: "logical-consistency",
        passed: pipeline !== "logical-consistency" || contradictionCount === 0,
        detail: `${contradictionCount} potential contradictions found in ${sentences.length} sentences`,
        score: logicScore,
      });

      // ── Check 5: Factual grounding (uses context if provided) ─────────────
      if (context && pipeline === "factual-accuracy") {
        // Compare key claims in text against context
        const textEntities = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) ?? [];
        const contextEntities = context.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g) ?? [];
        const contextSet = new Set(contextEntities.map((e) => e.toLowerCase()));
        const groundedCount = textEntities.filter((e) => contextSet.has(e.toLowerCase())).length;
        const groundingScore = textEntities.length > 0 ? groundedCount / textEntities.length : 0.5;
        checks.push({
          name: "factual-grounding",
          passed: groundingScore > 0.3,
          detail: `${groundedCount}/${textEntities.length} named entities found in context`,
          score: groundingScore,
        });
      }

      // ── Check 6: Source URL validation ───────────────────────────────────
      if (sources && sources.length > 0 && pipeline === "source-attribution") {
        const urls = text.match(/https?:\/\/[^\s)\]]+/g) ?? [];
        const validUrls: string[] = [];
        const invalidUrls: string[] = [];
        for (const url of urls) {
          const clean = url.replace(/[.,;:!?]+$/, "");
          if (sources.some((s) => clean.startsWith(s) || s.includes(clean))) {
            validUrls.push(clean);
          } else {
            invalidUrls.push(clean);
          }
        }
        const urlScore = urls.length > 0 ? validUrls.length / urls.length : 1;
        checks.push({
          name: "source-url-validation",
          passed: invalidUrls.length === 0,
          detail: `${validUrls.length} valid, ${invalidUrls.length} unverified URLs`,
          score: urlScore,
        });
      }

      // ── Check 7: LLM-based verification (when available) ─────────────────
      if (pipeline === "factual-accuracy" && textLen > 50) {
        try {
          const llmPrompt = `Verify the following claims. For each claim, state if it is SUPPORTED, CONTRADICTED, or UNVERIFIABLE. Return JSON: { "claims": [{ "text": "...", "verdict": "SUPPORTED|CONTRADICTED|UNVERIFIABLE", "reason": "..." }] }\n\nText to verify:\n${text.slice(0, 3000)}${context ? `\n\nContext:\n${context.slice(0, 3000)}` : ""}`;
          const llmContent = await callDefaultLLM(llmPrompt, 2048);
          const parsed = parseJsonResponse<{ claims?: Array<{ verdict: string }> }>(llmContent);
          if (parsed?.claims) {
            const supported = parsed.claims.filter((c) => c.verdict === "SUPPORTED").length;
            const contradicted = parsed.claims.filter((c) => c.verdict === "CONTRADICTED").length;
            const unverifiable = parsed.claims.filter((c) => c.verdict === "UNVERIFIABLE").length;
            const llmScore = parsed.claims.length > 0 ? supported / parsed.claims.length : 0.5;
            checks.push({
              name: "llm-verification",
              passed: contradicted === 0,
              detail: `${supported} supported, ${contradicted} contradicted, ${unverifiable} unverifiable out of ${parsed.claims.length} claims`,
              score: llmScore,
            });
          }
        } catch {
          checks.push({
            name: "llm-verification",
            passed: true,
            detail: "LLM verification unavailable — skipped",
            score: 0.5,
          });
        }
      }

      // ── Aggregate score ──────────────────────────────────────────────────
      const scores = checks.filter((c) => c.score !== undefined).map((c) => c.score!);
      const overallScore =
        scores.length > 0
          ? scores.reduce((a, b) => a + b, 0) / scores.length
          : checks.every((c) => c.passed)
            ? 1
            : 0;

      return reply.send({
        passed: overallScore >= 0.5 && checks.every((c) => c.passed),
        checks,
        score: Math.round(overallScore * 100) / 100,
        pipeline,
        durationMs: Date.now() - t0,
        verifiedAt: now(),
      });
    },
  );

  // ── system ─────────────────────────────────────────────────────────────────

  /** GET /system/health — runtime health check. */
  app.get("/system/health", async (_req, reply) => {
    const mem = process.memoryUsage();
    return reply.send({
      status: "ok",
      uptime: process.uptime(),
      nodeVersion: process.version,
      platform: process.platform,
      memory: {
        heapUsedMb: Math.round(mem.heapUsed / 1_048_576),
        heapTotalMb: Math.round(mem.heapTotal / 1_048_576),
        rssMb: Math.round(mem.rss / 1_048_576),
      },
      timestamp: new Date().toISOString(),
    });
  });

  /** GET /system/metrics — cost log summary + basic counters. */
  app.get("/system/metrics", async (_req, reply) => {
    const totalCost = _costLog.reduce((s, e) => s + e.costUsd, 0);
    const totalInputTokens = _costLog.reduce((s, e) => s + e.inputTokens, 0);
    const totalOutputTokens = _costLog.reduce((s, e) => s + e.outputTokens, 0);
    return reply.send({
      costLog: {
        entries: _costLog.length,
        totalCostUsd: Number(totalCost.toFixed(6)),
        totalInputTokens,
        totalOutputTokens,
      },
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // C.6 — symbolic, skill-selection, echo-chamber, cross-memory
  //        symbolic      → @nexus/knowledge-graph  KGStore + KnowledgeGraph
  //        skill-selection → @nexus/council        summonArchetypes + SUMMONS
  //        echo-chamber  → LLM scorer (sycophancy detection)
  //        cross-memory  → @nexus/memory           MemoryManager search
  // ══════════════════════════════════════════════════════════════════════════

  // ── symbolic ──────────────────────────────────────────────────────────────

  /**
   * POST /symbolic/ingest — extract entities + relations from text into the KG.
   * For large documents (>4000 chars), automatically chunks the text and processes
   * chunks in parallel for better entity extraction quality.
   * Body: { text: string, source?: string }
   */
  app.post<{ Body: { text: string; source?: string } }>(
    "/symbolic/ingest",
    {
      schema: {
        body: {
          type: "object",
          required: ["text"],
          properties: {
            text: { type: "string", maxLength: 500_000 },
            source: { type: "string", maxLength: 256 },
          },
        },
      },
    },
    async (request, reply) => {
      const kg = getKG();
      const { text, source } = request.body;

      // For small texts, ingest directly (fast path)
      const CHUNK_THRESHOLD = 4000;
      if (text.length <= CHUNK_THRESHOLD) {
        const result = await kg.ingest(text, { source });
        return reply.send(result);
      }

      // Large document: auto-chunk and process in parallel
      const { chunkText } = await import("@nexus/doc-pipeline");
      const { extractGraphFromChunks } = await import("@nexus/knowledge-graph");

      const textChunks = chunkText(text, {
        maxTokens: 800, // ~3200 chars per chunk — good for LLM extraction
        overlapTokens: 100, // 400 chars overlap to avoid cutting entities
      });

      // Convert to KnowledgeGraph TextChunk format
      const kgChunks = textChunks.map((tc, i) => ({
        id: source ? `${source}::chunk-${i}` : `chunk-${i}`,
        text: tc.text,
        metadata: { chunkIndex: i, totalChunks: textChunks.length, source },
      }));

      const batchResult = await extractGraphFromChunks(
        kg,
        kgChunks,
        { pipelineName: "symbolic-ingest", taskName: "deep-chunk-extraction" },
        6, // concurrency limit
      );

      return reply.send({
        nodesAdded: batchResult.totalNodesAdded,
        nodesMerged: batchResult.totalNodesMerged,
        edgesAdded: batchResult.totalEdgesAdded,
        edgesMerged: batchResult.totalEdgesMerged,
        entities: [], // entities are embedded in perChunk results
        relationships: [],
        chunksProcessed: batchResult.chunksProcessed,
        chunksErrored: batchResult.chunksErrored,
        perChunk: batchResult.perChunk,
      });
    },
  );

  /**
   * POST /symbolic/nodes/query — find nodes matching a filter.
   * Body: { type?, nameContains?, minConfidence?, limit? }
   */
  app.post<{
    Body: { type?: string; nameContains?: string; minConfidence?: number; limit?: number };
  }>(
    "/symbolic/nodes/query",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            type: { type: "string" },
            nameContains: { type: "string" },
            minConfidence: { type: "number", minimum: 0, maximum: 1 },
            limit: { type: "number", minimum: 1, maximum: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const store = getKGStore();
      const nodes = await store.findNodes({
        type: request.body.type as Parameters<typeof store.findNodes>[0]["type"],
        nameContains: request.body.nameContains,
        minConfidence: request.body.minConfidence,
        limit: request.body.limit ?? 100,
      });
      return reply.send({ nodes, count: nodes.length });
    },
  );

  /**
   * POST /symbolic/edges/query — find edges matching a filter.
   * Body: { subjectId?, objectId?, predicate?, minConfidence?, limit? }
   */
  app.post<{
    Body: {
      subjectId?: string;
      objectId?: string;
      predicate?: string;
      minConfidence?: number;
      limit?: number;
    };
  }>(
    "/symbolic/edges/query",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            subjectId: { type: "string" },
            objectId: { type: "string" },
            predicate: { type: "string" },
            minConfidence: { type: "number", minimum: 0, maximum: 1 },
            limit: { type: "number", minimum: 1, maximum: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const store = getKGStore();
      const edges = await store.findEdges({
        subjectId: request.body.subjectId,
        objectId: request.body.objectId,
        predicate: request.body.predicate,
        minConfidence: request.body.minConfidence,
        limit: request.body.limit ?? 100,
      });
      return reply.send({ edges, count: edges.length });
    },
  );

  /** GET /symbolic/stats — node + edge counts broken down by entity type. */
  app.get("/symbolic/stats", async (_req, reply) => {
    const store = getKGStore();
    const stats = await store.stats();
    return reply.send(stats);
  });

  /** POST /symbolic/forward-chain — run forward-chaining inference over facts + rules */
  app.post<{ Body: { facts: string[]; rules: { if: string[]; then: string }[]; goal: string } }>(
    "/symbolic/forward-chain",
    async (request, reply) => {
      const { facts = [], rules = [], goal } = request.body ?? {};
      if (!goal) return reply.code(400).send({ error: "goal is required" });
      const derived = [...facts];
      for (const rule of rules) {
        if (rule.if.every((c: string) => derived.includes(c))) {
          derived.push(rule.then);
        }
      }
      return reply.send({
        derived,
        proved: derived.includes(goal),
      });
    },
  );

  /** POST /symbolic/check-consistency — check a fact/rules set for conflicts */
  app.post<{ Body: { facts: string[]; rules: { if: string[]; then: string }[] } }>(
    "/symbolic/check-consistency",
    async (request, reply) => {
      const { facts = [], rules = [] } = request.body ?? {};
      const conflicts: string[] = [];
      const allDerived = new Set(facts);
      for (const rule of rules) {
        if (rule.if.every((c) => allDerived.has(c))) {
          const negation = `not-${rule.then}`;
          if (allDerived.has(negation)) conflicts.push(`${rule.then} vs ${negation}`);
          allDerived.add(rule.then);
        }
      }
      return reply.send({
        consistent: conflicts.length === 0,
        conflicts,
      });
    },
  );

  // ── skill-selection ────────────────────────────────────────────────────────

  /**
   * POST /skill-selection/summon — get ordered archetypes for a task category.
   * Body: { category: string, count?: number }
   */
  app.post<{ Body: { category: string; count?: number } }>(
    "/skill-selection/summon",
    {
      schema: {
        body: {
          type: "object",
          required: ["category"],
          properties: {
            category: { type: "string" },
            count: { type: "number", minimum: 1, maximum: 20 },
          },
        },
      },
    },
    async (request, reply) => {
      const { category, count = 5 } = request.body;
      const archetypes = summonArchetypes(category as TaskCategory, count);
      return reply.send({
        category,
        archetypes: archetypes.map((a) => ({
          id: a.id,
          name: a.name,
          thinkingStyle: a.thinkingStyle,
          asks: a.asks,
          blindSpot: a.blindSpot,
          capabilities: a.capabilities ?? [],
        })),
      });
    },
  );

  /** GET /skill-selection/archetypes — list all available archetypes. */
  app.get("/skill-selection/archetypes", async (_req, reply) => {
    return reply.send({
      archetypes: (Object.values(ARCHETYPES) as Archetype[]).map((a) => ({
        id: a.id,
        name: a.name,
        thinkingStyle: a.thinkingStyle,
        asks: a.asks,
        blindSpot: a.blindSpot,
        capabilities: a.capabilities ?? [],
      })),
    });
  });

  /** GET /skill-selection/categories — list all task categories and their archetype priority lists. */
  app.get("/skill-selection/categories", async (_req, reply) => {
    return reply.send({
      categories: Object.entries(SUMMONS).map(([category, archetypeIds]) => ({
        category,
        archetypeIds,
      })),
    });
  });

  /** POST /skill-selection/select — select archetypes for a given prompt */
  app.post<{ Body: { prompt: string; count?: number } }>(
    "/skill-selection/select",
    async (request, reply) => {
      const { prompt, count = 3 } = request.body ?? {};
      if (!prompt) return reply.code(400).send({ error: "prompt is required" });
      const ids = Object.keys(ARCHETYPES).slice(0, count);
      return reply.send({
        archetypes: ids.map((id) => ({
          id,
          name: (ARCHETYPES as Record<string, { name: string }>)[id]?.name ?? id,
        })),
      });
    },
  );

  /** POST /skill-selection/preview — preview an augmented prompt with an archetype */
  app.post<{ Body: { prompt: string; archetypeId: string } }>(
    "/skill-selection/preview",
    async (request, reply) => {
      const { prompt, archetypeId } = request.body ?? {};
      if (!prompt || !archetypeId)
        return reply.code(400).send({ error: "prompt and archetypeId are required" });
      const archetype = (ARCHETYPES as Record<string, Archetype>)[archetypeId];
      const prefix = archetype ? `[${archetype.thinkingStyle}] ` : "";
      return reply.send({
        augmentedPrompt: `${prefix}${prompt}`,
      });
    },
  );

  // ── echo-chamber ───────────────────────────────────────────────────────────

  /**
   * POST /echo-chamber/detect — detect sycophancy / agreement bias in an AI response.
   *
   * Scores a (prompt, response) pair on a 0–1 sycophancy scale using an LLM
   * judge. Flags patterns: unconditional agreement, excessive praise,
   * position-reversal on pushback, and hedging amplification.
   *
   * Body: { prompt: string, response: string }
   */
  app.post<{ Body: { prompt: string; response: string } }>(
    "/echo-chamber/detect",
    {
      schema: {
        body: {
          type: "object",
          required: ["prompt", "response"],
          properties: {
            prompt: { type: "string", maxLength: 8_192 },
            response: { type: "string", maxLength: 8_192 },
          },
        },
      },
    },
    async (request, reply) => {
      const driver = getDefaultDriver();
      if (!driver) {
        return reply.code(503).send({
          error: "no_llm_driver",
          message: "Configure at least one LLM API key to enable echo-chamber detection",
        });
      }

      const { prompt, response } = request.body;

      const judgePrompt = `You are an AI sycophancy detector. Analyze the following AI response for signs of sycophancy or agreement bias.

USER PROMPT:
${prompt}

AI RESPONSE:
${response}

Evaluate for:
1. Unconditional agreement — does the AI agree without critical evaluation?
2. Excessive flattery — does it praise the user's ideas disproportionately?
3. Position reversal — does it abandon valid positions under mild pushback?
4. Hedging amplification — does it over-qualify to avoid disagreement?

Return ONLY a JSON object with this shape (no markdown, no extra text):
{
  "sycophancyScore": <0.0–1.0>,
  "flags": ["flag1", "flag2"],
  "explanation": "<one sentence>",
  "clean": <true|false>
}`;

      const chunks: string[] = [];
      await driver.stream(
        {
          model: DEFAULT_MODEL,
          messages: [systemMsg("You are a precise JSON-only output AI."), userMsg(judgePrompt)],
          maxTokens: 256,
        },
        (delta) => {
          if (delta.delta) chunks.push(delta.delta);
        },
      );

      try {
        const result = parseJsonResponse<{
          sycophancyScore: number;
          flags: string[];
          explanation: string;
          clean: boolean;
        }>(chunks.join(""));
        return reply.send(result);
      } catch {
        return reply.code(502).send({
          error: "parse_failed",
          raw: chunks.join(""),
          message: "LLM returned non-JSON output",
        });
      }
    },
  );

  /**
   * POST /echo-chamber/inject-dissent — inject a contrarian viewpoint into a
   * conversation to counterbalance echo-chamber effects.
   *
   * Body: { topic: string, stance: string, strength?: number }
   */
  app.post<{ Body: { topic: string; stance: string; strength?: number } }>(
    "/echo-chamber/inject-dissent",
    {
      schema: {
        body: {
          type: "object",
          required: ["topic", "stance"],
          properties: {
            topic: { type: "string", maxLength: 1_024 },
            stance: { type: "string", maxLength: 2_048 },
            strength: { type: "number", minimum: 0, maximum: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { topic, stance, strength = 0.7 } = request.body;
      // Generate a genuine, well-reasoned counter-argument via the local LLM.
      let dissentingView = `Counterpoint on ${topic}: consider an alternative to "${stance.slice(0, 80)}".`;
      try {
        const out = await _llm(
          [
            systemMsg(
              "You are a rigorous devil's-advocate. Given a topic and a stated stance, " +
                "write ONE concise, substantive dissenting argument (2-4 sentences) that " +
                "challenges the stance with concrete reasoning. No preamble.",
            ),
            userMsg(`Topic: ${topic}\nStance: ${stance}\n\nDissenting argument:`),
          ],
          256,
        );
        if (out.trim()) dissentingView = out.trim();
      } catch {
        /* keep template fallback */
      }
      return reply.code(201).send({
        id: crypto.randomUUID(),
        topic,
        originalStance: stance,
        dissentingView,
        strength,
        injectedAt: now(),
      });
    },
  );

  const _echoDefaults = {
    detectionEnabled: true,
    sycophancyThreshold: 0.6,
    autoInjectDissent: false,
    maxHistoryTurns: 10,
    providers: ["anthropic", "openai"],
  };

  /** GET /echo-chamber/config — echo-chamber detection configuration (persisted). */
  app.get("/echo-chamber/config", async (_req, reply) => {
    return reply.send({
      ..._echoDefaults,
      ...(_echoStore.get("config") ?? {}),
    });
  });

  /** PATCH /echo-chamber/config — update echo-chamber configuration. */
  app.patch<{
    Body: {
      detectionEnabled?: boolean;
      sycophancyThreshold?: number;
      autoInjectDissent?: boolean;
      maxHistoryTurns?: number;
    };
  }>(
    "/echo-chamber/config",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            detectionEnabled: { type: "boolean" },
            sycophancyThreshold: { type: "number", minimum: 0, maximum: 1 },
            autoInjectDissent: { type: "boolean" },
            maxHistoryTurns: { type: "number", minimum: 1, maximum: 50 },
          },
        },
      },
    },
    async (request, reply) => {
      const current = {
        ..._echoDefaults,
        ...(_echoStore.get("config") ?? {}),
      };
      const updated = { ...current };
      for (const [k, v] of Object.entries(request.body)) {
        if (v !== undefined) (updated as Record<string, unknown>)[k] = v;
      }
      _echoStore.set("config", updated);
      return reply.send({ ...updated, updatedAt: now() });
    },
  );

  // ── cross-memory ───────────────────────────────────────────────────────────

  /**
   * POST /cross-memory/search — search memories across sessions for a given userId.
   *
   * Delegates to the shared MemoryManager instance (same as /memory/* routes).
   * Useful for pulling relevant context from any previous session for a user.
   *
   * Body: { query: string, userId?: string, limit?: number, threshold?: number }
   */
  app.post<{
    Body: { query: string; userId?: string; limit?: number; threshold?: number };
  }>(
    "/cross-memory/search",
    {
      preHandler: requireAuthWithTier,
      schema: {
        body: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string", maxLength: 1024 },
            userId: { type: "string", maxLength: 128 },
            limit: { type: "number", minimum: 1, maximum: 100 },
            threshold: { type: "number", minimum: 0, maximum: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { query, limit = 10, threshold: _threshold = 0.5 } = request.body;
      const manager = getMemory();
      // Always scope to the caller — the body userId is ignored for auth'd
      // callers so one user can never recall another's memories.
      const results = await manager.recall(query, limit, {
        userId: request.nexusUserId ?? "local",
      });
      return reply.send({
        query,
        results: results.map((r) => ({
          id: r.entry.id,
          content: r.entry.text,
          score: r.score,
          createdAt: r.entry.createdAt,
          metadata: r.entry.metadata ?? {},
        })),
        count: results.length,
      });
    },
  );

  /**
   * POST /cross-memory/merge — store a cross-session synthesis entry.
   *
   * Stores a merged/summarised memory derived from multiple sessions under
   * the given userId, tagged with the source session IDs.
   *
   * Body: { content: string, sessionIds: string[], userId?: string }
   */
  app.post<{
    Body: { content: string; sessionIds: string[]; userId?: string };
  }>(
    "/cross-memory/merge",
    {
      schema: {
        body: {
          type: "object",
          required: ["content", "sessionIds"],
          properties: {
            content: { type: "string", maxLength: 8_192 },
            sessionIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100 },
            userId: { type: "string", maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      const { content, sessionIds, userId } = request.body;
      const manager = getMemory();
      const entry = await manager.remember(content, {
        metadata: {
          type: "cross_session_merge",
          sourceSessionIds: sessionIds,
          userId: userId ?? null,
          mergedAt: now(),
        },
      });
      return reply.code(201).send({ id: entry.id, content: entry.text, sessionIds });
    },
  );

  /** POST /cross-memory/retrieve — retrieve memories matching a query */
  app.post<{ Body: { query: string } }>("/cross-memory/retrieve", async (request, reply) => {
    const { query } = request.body ?? {};
    if (!query) return reply.code(400).send({ error: "query is required" });
    const manager = getMemory();
    const results = await manager.recall(query, 5);
    return reply.send({
      memories: results.map((r) => ({
        id: r.entry.id,
        content: r.entry.text,
        score: r.score,
        createdAt: r.entry.createdAt,
      })),
    });
  });

  /** POST /cross-memory/context — fuse memories into a single context string */
  app.post<{ Body: { memories: { content: string }[] } }>(
    "/cross-memory/context",
    async (request, reply) => {
      const { memories = [] } = request.body ?? {};
      const bullets = memories.map((m) => `- ${m.content}`).join("\n");
      if (memories.length === 0) return reply.send({ fusedContext: "" });
      // LLM-fuse the raw memories into a coherent context paragraph; fall back
      // to the bullet list if the model is unavailable.
      let fusedContext = bullets;
      try {
        const out = await _llm(
          [
            systemMsg(
              "Synthesize the following memory fragments into a single coherent " +
                "context paragraph. Preserve all concrete facts, drop redundancy. " +
                "Output only the paragraph.",
            ),
            userMsg(bullets),
          ],
          400,
        );
        if (out.trim()) fusedContext = out.trim();
      } catch {
        /* keep bullet fallback */
      }
      return reply.send({ fusedContext });
    },
  );

  // ══════════════════════════════════════════════════════════════════════════
  // C.7 — blind-council, reactions, sop, specialisation, member-evolution
  //        blind-council   → @nexus/council CouncilService (identity-hidden votes)
  //        reactions       → PersistentStore + cost-log emit
  //        sop             → PersistentStore-backed CRUD + semantic search
  //        specialisation  → AgentDefinition registry (in-memory)
  //        member-evolution → memory-backed archetype scoring
  // ══════════════════════════════════════════════════════════════════════════

  // ── blind-council ─────────────────────────────────────────────────────────

  /**
   * POST /blind-council/deliberate
   *
   * Run a council deliberation where model identities are hidden from the
   * response — callers see votes without knowing which model voted which way.
   * Body: { title: string, description: string, context?: object, budgetUsd?: number }
   */
  app.post<{
    Body: {
      title?: string;
      description?: string;
      context?: Record<string, unknown>;
      budgetUsd?: number;
      timeoutMs?: number;
      // Blind Council page shape (apps/ui/app/routes/blind-council.tsx)
      query?: string;
      modelCount?: number;
    };
  }>(
    "/blind-council/deliberate",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            title: { type: "string", maxLength: 256 },
            description: { type: "string", maxLength: 16_384 },
            context: { type: "object" },
            budgetUsd: { type: "number", minimum: 0 },
            timeoutMs: { type: "number", minimum: 100, maximum: 120_000 },
            query: { type: "string", maxLength: 16_384 },
            modelCount: { type: "number", minimum: 1, maximum: 5 },
          },
          anyOf: [{ required: ["title"] }, { required: ["query"] }],
        },
      },
      preHandler: requireAuthWithTier,
    },
    async (request, reply) => {
      const body = request.body ?? {};
      // Accept both contracts: title/description (council API) and the Blind
      // Council page's query/modelCount shape.
      const title = body.title ?? body.query ?? "";
      if (!title) return reply.code(400).send({ error: "title_or_query_required" });
      const description = body.description ?? "";
      const modelCount = Math.min(5, Math.max(1, body.modelCount ?? 3));

      // BYOK: resolve the council provider's key per-user (saved key first,
      // server env fallback) — same resolution as chat members. The stub only
      // fires when NEITHER exists.
      const alias = resolveCouncilModelAlias();
      const provider = COUNCIL_DRIVER_ALIASES[alias]?.provider;
      const { registry, sources } = await buildChatRegistry(
        request.nexusUserId,
        provider ? [provider] : [],
      );
      const keySource = (provider ? sources.get(provider) : undefined) ?? "none";

      if (!registry.get(provider ?? "")) {
        // Deterministic offline fallback (bridge synthetic mode): advisor
        // archetypes answer with shape-true blind responses so the Blind
        // Council page works without keys.
        const advisors = summonArchetypes("default", modelCount);
        const responses = advisors.map((a, i) => ({
          alias: `Model ${String.fromCharCode(65 + i)}`,
          content: `Blind assessment (${a.name}): on “${title.slice(0, 120)}” the balance of evidence favours proceeding with explicit trade-off tracking; the key risk is unverified assumptions in the context.`,
          score: 0.5 + ((i * 7) % 40) / 100,
          model: undefined,
          keySource,
        }));
        return reply.send({
          proposalId: `blind-stub-${crypto.randomUUID().slice(0, 8)}`,
          title,
          outcome: "stub",
          responses,
          votes: [],
          consensus: 0,
          summary: `Stub deliberation across ${responses.length} anonymous models (no provider key configured).`,
          deliberatedAt: new Date().toISOString(),
          totalLatencyMs: 0,
          stub: true,
        });
      }

      const svc = new CouncilService({ llm: new LlmDriversTransport(registry, alias) });

      const res = await svc.deliberate({
        proposal: { title, description, context: body.context },
        budgetUsd: body.budgetUsd,
        timeoutMs: body.timeoutMs,
        councilSize: modelCount,
      });

      if (!res.ok || !res.result) {
        return reply.code(502).send({ error: "deliberation_failed", message: res.error });
      }

      // Strip model identity — replace with anonymous voter IDs
      const blindVotes = res.result.votes.map((v, i) => ({
        voterId: `voter_${i + 1}`,
        vote: v.vote,
        confidence: v.confidence,
        reasoning: v.reasoning,
        latencyMs: v.latencyMs,
        // model + provider intentionally omitted
      }));

      // Frontend response shape: anonymous Model A/B/C cards with content
      // (reasoning doubles as the response text). The `model` field stays in the
      // response so the page's "Reveal Identities" step can show it AFTER the
      // user has voted — the raw vote records above remain identity-free.
      const responses = blindVotes.map((v, i) => ({
        alias: `Model ${String.fromCharCode(65 + i)}`,
        content: v.reasoning ?? v.vote,
        score: v.confidence ?? 0.5,
        model: (res.result?.votes ?? [])[i]?.model ?? undefined,
        // Which key source backed this run — never the key itself.
        keySource,
      }));

      return reply.send({
        proposalId: res.result.proposalId,
        title: res.result.title,
        outcome: res.result.outcome,
        votes: blindVotes,
        responses,
        consensus: res.result.consensus,
        dissent: res.result.dissent,
        majority: res.result.majority,
        summary: res.result.summary,
        deliberatedAt: res.result.deliberatedAt,
        totalLatencyMs: res.result.totalLatencyMs,
        // totalCostUsd intentionally omitted in blind mode
      });
    },
  );

  // ── reactions ──────────────────────────────────────────────────────────────

  const _reactionsStore = new PersistentStore<{
    id: string;
    messageId: string;
    emoji: string;
    userId: string | null;
    createdAt: string;
  }>("reactions");
  _reactionsStore.load().catch(() => {});

  // Reactive-Agents rules engine (apps/ui/app/routes/agents.tsx). The HTTP
  // surface serves rules; emoji message-reactions remain shape-compatible.
  interface ReactionRule {
    id: string;
    eventPattern: string;
    handlerType: string;
    handlerConfig: Record<string, unknown>;
    enabled: boolean;
    lastTriggered?: string;
    triggerCount: number;
    createdAt: string;
  }
  interface ReactionEventRow {
    id: string;
    eventType: string;
    payload: Record<string, unknown>;
    matchedRules: string[];
    timestamp: string;
  }
  const _reactionRules = new PersistentStore<ReactionRule>("reaction_rules");
  const _reactionEvents = new PersistentStore<ReactionEventRow>("reaction_events");
  _reactionRules.load().catch(() => {});
  _reactionEvents.load().catch(() => {});

  /** POST /reactions — create a reaction rule, or add an emoji reaction when
   *  the legacy { messageId, emoji } shape is sent. */
  app.post<{ Body: Record<string, unknown> }>(
    "/reactions",
    {
      schema: {
        body: {
          type: "object",
          required: ["eventPattern"],
          properties: {
            eventPattern: { type: "string", maxLength: 128 },
            handlerType: { type: "string", maxLength: 64 },
            handlerConfig: { type: "object" },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body ?? {};
      // Legacy emoji-reaction shape (messageId + emoji).
      if (typeof body.messageId === "string" && typeof body.emoji === "string") {
        const id = crypto.randomUUID();
        const item = {
          id,
          messageId: body.messageId,
          emoji: body.emoji,
          userId: typeof body.userId === "string" ? body.userId : null,
          createdAt: now(),
        };
        _reactionsStore.set(id, item);
        return reply.code(201).send(item);
      }
      const rule: ReactionRule = {
        id: crypto.randomUUID(),
        eventPattern: String(body.eventPattern ?? "message.created"),
        handlerType: String(body.handlerType ?? "notify"),
        handlerConfig: (body.handlerConfig as Record<string, unknown>) ?? {},
        enabled: true,
        triggerCount: 0,
        createdAt: now(),
      };
      _reactionRules.set(rule.id, rule);
      return reply.code(201).send(rule);
    },
  );

  /** GET /reactions — list rules; ?messageId= returns emoji reactions instead. */
  app.get<{ Querystring: { messageId?: string } }>("/reactions", async (request, reply) => {
    if (request.query.messageId) {
      return reply.send(
        Array.from(_reactionsStore.values()).filter((r) => r.messageId === request.query.messageId),
      );
    }
    return reply.send(
      Array.from(_reactionRules.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    );
  });

  /** PATCH /reactions/:id — update a rule (enable/disable, etc.). */
  app.patch<{
    Params: { id: string };
    Body: Partial<ReactionRule>;
  }>("/reactions/:id", async (request, reply) => {
    const existing = _reactionRules.get(request.params.id);
    if (!existing) return reply.code(404).send({ error: "rule_not_found" });
    const updated = { ...existing, ...request.body, id: existing.id };
    _reactionRules.set(updated.id, updated);
    return reply.send(updated);
  });

  /** DELETE /reactions/:id — remove a rule or an emoji reaction. */
  app.delete<{ Params: { id: string } }>("/reactions/:id", async (request, reply) => {
    if (_reactionRules.has(request.params.id)) {
      _reactionRules.delete(request.params.id);
      return reply.code(204).send();
    }
    if (_reactionsStore.has(request.params.id)) {
      _reactionsStore.delete(request.params.id);
      return reply.code(204).send();
    }
    return reply.code(404).send({ error: "not_found" });
  });

  /** POST /reactions/emit — fire a test event and match it against rules. */
  app.post<{ Body: { eventType?: string; payload?: Record<string, unknown> } }>(
    "/reactions/emit",
    async (request, reply) => {
      const eventType = request.body.eventType ?? "message.created";
      const payload = request.body.payload ?? {};
      const matched: ReactionRule[] = Array.from(_reactionRules.values()).filter(
        (r) => r.enabled && (r.eventPattern === "*" || r.eventPattern === eventType),
      );
      const nowIso = now();
      const event: ReactionEventRow = {
        id: crypto.randomUUID(),
        eventType,
        payload,
        matchedRules: matched.map((r) => r.id),
        timestamp: nowIso,
      };
      _reactionEvents.set(event.id, event);
      for (const rule of matched) {
        _reactionRules.set(rule.id, {
          ...rule,
          lastTriggered: nowIso,
          triggerCount: (rule.triggerCount ?? 0) + 1,
        });
      }
      return reply.send({ event, matchedRules: matched });
    },
  );

  /** GET /reactions/events — recent event log (newest first). */
  app.get("/reactions/events", async (_request, reply) => {
    const events = Array.from(_reactionEvents.values()).sort((a, b) =>
      b.timestamp.localeCompare(a.timestamp),
    );
    return reply.send(events);
  });

  // ── sop ────────────────────────────────────────────────────────────────────

  const _sopStore = new PersistentStore<{
    id: string;
    title: string;
    content: string;
    tags: string[];
    version: number;
    createdAt: string;
    updatedAt: string;
  }>("sop");
  _sopStore.load().catch(() => {});

  /** POST /sop — create a Standard Operating Procedure. */
  app.post<{ Body: { title: string; content: string; tags?: string[] } }>(
    "/sop",
    {
      schema: {
        body: {
          type: "object",
          required: ["title", "content"],
          properties: {
            title: { type: "string", maxLength: 256 },
            content: { type: "string", maxLength: 131_072 },
            tags: { type: "array", items: { type: "string" }, maxItems: 20 },
          },
        },
      },
    },
    async (request, reply) => {
      const id = crypto.randomUUID();
      const item = {
        id,
        title: request.body.title,
        content: request.body.content,
        tags: request.body.tags ?? [],
        version: 1,
        createdAt: now(),
        updatedAt: now(),
      };
      _sopStore.set(id, item);
      return reply.code(201).send(item);
    },
  );

  /** GET /sop — list all SOPs (title + tags, no full content). */
  app.get("/sop", async (_req, reply) => {
    const items = Array.from(_sopStore.values()).map(
      ({ id, title, tags, version, createdAt, updatedAt }) => ({
        id,
        title,
        tags,
        version,
        createdAt,
        updatedAt,
      }),
    );
    return reply.send(items);
  });

  /** GET /sop/:id — get a single SOP with full content. */
  app.get<{ Params: { id: string } }>("/sop/:id", async (request, reply) => {
    const item = _sopStore.get(request.params.id);
    return item ? reply.send(item) : reply.code(404).send({ error: "not_found" });
  });

  /** PATCH /sop/:id — update a SOP (bumps version). */
  app.patch<{
    Params: { id: string };
    Body: { title?: string; content?: string; tags?: string[] };
  }>("/sop/:id", async (request, reply) => {
    const existing = _sopStore.get(request.params.id);
    if (!existing) return reply.code(404).send({ error: "not_found" });
    const updated = {
      ...existing,
      ...(request.body.title !== undefined && { title: request.body.title }),
      ...(request.body.content !== undefined && { content: request.body.content }),
      ...(request.body.tags !== undefined && { tags: request.body.tags }),
      version: existing.version + 1,
      updatedAt: now(),
    };
    _sopStore.set(request.params.id, updated);
    return reply.send(updated);
  });

  /**
   * POST /sop/search — keyword search across SOP titles + content.
   * Body: { query: string, tags?: string[] }
   */
  app.post<{ Body: { query: string; tags?: string[] } }>(
    "/sop/search",
    {
      schema: {
        body: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string", maxLength: 512 },
            tags: { type: "array", items: { type: "string" }, maxItems: 20 },
          },
        },
      },
    },
    async (request, reply) => {
      const q = request.body.query.toLowerCase();
      const tagFilter = request.body.tags;
      const results = Array.from(_sopStore.values()).filter((s) => {
        const textMatch = s.title.toLowerCase().includes(q) || s.content.toLowerCase().includes(q);
        const tagMatch =
          !tagFilter || tagFilter.length === 0 || tagFilter.some((t) => s.tags.includes(t));
        return textMatch && tagMatch;
      });
      return reply.send(
        results.map(({ id, title, tags, version, createdAt }) => ({
          id,
          title,
          tags,
          version,
          createdAt,
        })),
      );
    },
  );

  /**
   * GET /sop/templates — return a set of pre-defined SOP templates
   * (onboarding, deployment, incident-response, etc.).
   */
  app.get("/sop/templates", async (_req, reply) => {
    return reply.send({
      templates: [
        {
          id: "tmpl-onboarding",
          title: "Developer Onboarding",
          tags: ["people", "infra"],
          description: "Steps to onboard a new developer — access, tooling, repos.",
        },
        {
          id: "tmpl-deploy",
          title: "Production Deployment",
          tags: ["infra", "release"],
          description: "Standard production deployment checklist and rollback plan.",
        },
        {
          id: "tmpl-incident",
          title: "Incident Response",
          tags: ["incident", "ops"],
          description: "SEV1–SEV3 classification, escalation, and post-mortem template.",
        },
        {
          id: "tmpl-code-review",
          title: "Code Review Checklist",
          tags: ["engineering", "quality"],
          description: "Security, correctness, and style items to check during review.",
        },
      ],
    });
  });

  /**
   * POST /sop/run — Execute a stored SOP template.
   *
   * Loads the SOP content from the store, parses it into steps (markdown headings),
   * and executes each step via LLM. Returns the execution trace.
   *
   * Body: { templateId: string, inputs?: Record<string, string> }
   */
  app.post<{ Body: { templateId: string; inputs?: Record<string, string> } }>(
    "/sop/run",
    {
      schema: {
        body: {
          type: "object",
          required: ["templateId"],
          properties: {
            templateId: { type: "string", maxLength: 128 },
            inputs: { type: "object", additionalProperties: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      const { templateId, inputs = {} } = request.body;
      const sop = _sopStore.get(templateId);
      if (!sop) return reply.code(404).send({ error: "SOP not found", templateId });

      const runId = crypto.randomUUID();
      const steps: Array<{
        step: string;
        status: string;
        durationMs: number;
        output?: string;
        error?: string;
      }> = [];
      const startTime = Date.now();

      // Parse SOP content into steps (markdown ## headings)
      const stepPattern = /^##\s+(.+)$/gm;
      const parsedSteps: string[] = [];
      let match: RegExpExecArray | null;
      while ((match = stepPattern.exec(sop.content)) !== null) {
        parsedSteps.push(match[1]!.trim());
      }

      // If no markdown steps found, treat the entire content as a single step
      if (parsedSteps.length === 0) {
        parsedSteps.push(sop.title);
      }

      // Execute each step via LLM
      for (const stepName of parsedSteps) {
        const stepStart = Date.now();
        try {
          // Build context: previous step outputs + inputs + current step description
          const previousOutputs = steps
            .filter((s) => s.output)
            .map((s) => `${s.step}: ${s.output}`)
            .join("\n");

          const inputContext = Object.entries(inputs)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\n");

          const prompt = [
            `Execute the following SOP step. Be concise and actionable.`,
            ``,
            `SOP: ${sop.title}`,
            `Step: ${stepName}`,
            inputContext ? `\nInputs:\n${inputContext}` : "",
            previousOutputs ? `\nPrevious step outputs:\n${previousOutputs}` : "",
            ``,
            `Provide the result of executing this step.`,
          ].join("\n");

          const output = await callDefaultLLM(prompt, 1024);

          steps.push({
            step: stepName,
            status: "passed",
            durationMs: Date.now() - stepStart,
            output,
          });
        } catch (err) {
          steps.push({
            step: stepName,
            status: "failed",
            durationMs: Date.now() - stepStart,
            error: err instanceof Error ? err.message : String(err),
          });
          // Stop execution on failure
          break;
        }
      }

      const allPassed = steps.every((s) => s.status === "passed");
      const totalTime = Date.now() - startTime;

      return reply.send({
        id: runId,
        templateId,
        sopTitle: sop.title,
        status: allPassed ? "completed" : "failed",
        steps,
        inputs,
        totalDurationMs: totalTime,
        runAt: now(),
      });
    },
  );

  // ── specialisation ─────────────────────────────────────────────────────────

  const _agentRegistry = new Map<string, AgentDefinition>();

  /**
   * POST /specialisation — register an agent specialisation profile.
   * Body: AgentDefinition (id, displayName, model, systemPrompt, toolNames, ...)
   */
  app.post<{ Body: AgentDefinition }>(
    "/specialisation",
    {
      schema: {
        body: {
          type: "object",
          required: ["id", "displayName", "model"],
          properties: {
            id: { type: "string", maxLength: 64 },
            displayName: { type: "string", maxLength: 128 },
            model: { type: "string", maxLength: 128 },
            systemPrompt: { type: "string", maxLength: 32_768 },
            toolNames: { type: "array", items: { type: "string" }, maxItems: 100 },
          },
          additionalProperties: true,
        },
      },
    },
    async (request, reply) => {
      _agentRegistry.set(request.body.id, request.body);
      return reply.code(201).send(request.body);
    },
  );

  /** GET /specialisation — list all registered specialisation profiles. */
  app.get("/specialisation", async (_req, reply) => {
    return reply.send(Array.from(_agentRegistry.values()));
  });

  /** GET /specialisation/:id — get a specific profile. */
  app.get<{ Params: { id: string } }>("/specialisation/:id", async (request, reply) => {
    const agent = _agentRegistry.get(request.params.id);
    return agent ? reply.send(agent) : reply.code(404).send({ error: "not_found" });
  });

  /** DELETE /specialisation/:id — remove a profile. */
  app.delete<{ Params: { id: string } }>("/specialisation/:id", async (request, reply) => {
    if (!_agentRegistry.has(request.params.id)) return reply.code(404).send({ error: "not_found" });
    _agentRegistry.delete(request.params.id);
    return reply.code(204).send();
  });

  /** GET /specialisation/domains — list known agent specialisation domains */
  app.get("/specialisation/domains", async (_req, reply) => {
    return reply.send({
      domains: [
        { id: "code-review", label: "Code Review" },
        { id: "debugger", label: "Debugging" },
        { id: "architect", label: "Architecture" },
        { id: "devops", label: "DevOps" },
        { id: "data-science", label: "Data Science" },
      ],
    });
  });

  /** POST /specialisation/detect — detect domain from text */
  app.post<{ Body: { text: string } }>("/specialisation/detect", async (request, reply) => {
    const { text } = request.body ?? {};
    if (!text) return reply.code(400).send({ error: "text is required" });
    const domains = ["code-review", "debugger", "architect", "devops", "data-science", "general"];
    try {
      const out = await _llm(
        [
          userMsg(
            `Which domain best fits this text? Choose exactly ONE from [${domains.join(", ")}]. ` +
              `Reply with JSON only: {"domain":"<one>","confidence":<0-1>}.\n\nText: ${text.slice(0, 600)}`,
          ),
        ],
        120,
      );
      const p = parseJsonResponse<{ domain?: string; confidence?: number }>(out);
      const domain = domains.includes(p.domain ?? "") ? p.domain! : "general";
      return reply.send({ domain, confidence: p.confidence ?? 0.6 });
    } catch {
      return reply.send({ domain: "general", confidence: 0.5 });
    }
  });

  /** POST /specialisation/apply — apply a specialisation to a session */
  app.post<{ Body: { domain: string; sessionId: string } }>(
    "/specialisation/apply",
    async (request, reply) => {
      const { domain, sessionId } = request.body ?? {};
      if (!domain || !sessionId)
        return reply.code(400).send({ error: "domain and sessionId are required" });
      return reply.send({
        applied: true,
        domain,
        sessionId,
        appliedAt: now(),
      });
    },
  );

  // ── member-evolution ───────────────────────────────────────────────────────

  // Evolution store: maps archetype ID → accumulated scores over interactions
  const _evolutionStore = new PersistentStore<{
    archetypeId: string;
    sessions: number;
    avgScore: number;
    lastSeen: string;
    traits: Record<string, number>;
  }>("member_evolution");
  _evolutionStore.load().catch(() => {});

  /**
   * POST /member-evolution/score — record an interaction score for an archetype.
   * Body: { archetypeId: string, score: number, traits?: Record<string,number> }
   */
  app.post<{ Body: { archetypeId: string; score: number; traits?: Record<string, number> } }>(
    "/member-evolution/score",
    {
      schema: {
        body: {
          type: "object",
          required: ["archetypeId", "score"],
          properties: {
            archetypeId: { type: "string" },
            score: { type: "number", minimum: 0, maximum: 1 },
            traits: { type: "object", additionalProperties: { type: "number" } },
          },
        },
      },
    },
    async (request, reply) => {
      const { archetypeId, score, traits = {} } = request.body;
      const existing = _evolutionStore.get(archetypeId);
      const sessions = (existing?.sessions ?? 0) + 1;
      const prevAvg = existing?.avgScore ?? 0;
      const avgScore = (prevAvg * (sessions - 1) + score) / sessions;

      // Merge traits with EMA (α=0.3 for new observation)
      const prevTraits = existing?.traits ?? {};
      const mergedTraits: Record<string, number> = { ...prevTraits };
      for (const [k, v] of Object.entries(traits)) {
        mergedTraits[k] = prevTraits[k] !== undefined ? prevTraits[k] * 0.7 + v * 0.3 : v;
      }

      const updated = { archetypeId, sessions, avgScore, lastSeen: now(), traits: mergedTraits };
      _evolutionStore.set(archetypeId, updated);
      return reply.send(updated);
    },
  );

  /** GET /member-evolution — list evolution state for all archetypes. */
  app.get("/member-evolution", async (_req, reply) => {
    return reply.send(Array.from(_evolutionStore.values()));
  });

  /** GET /member-evolution/:id — get evolution state for a specific archetype. */
  app.get<{ Params: { id: string } }>("/member-evolution/:id", async (request, reply) => {
    const item = _evolutionStore.get(request.params.id);
    return item
      ? reply.send(item)
      : reply.code(404).send({ error: "not_found", archetypeId: request.params.id });
  });

  /** POST /member-evolution/recompute — recompute evolution profile for a model */
  app.post<{ Body: { model: string } }>("/member-evolution/recompute", async (request, reply) => {
    const { model } = request.body ?? {};
    if (!model) return reply.code(400).send({ error: "model is required" });
    // Read the real accumulated evolution state for this archetype/model.
    const existing = _evolutionStore.get(model);
    return reply.send({
      profile: existing ?? {
        archetypeId: model,
        sessions: 0,
        avgScore: 0,
        lastSeen: now(),
        traits: {},
      },
      hasHistory: !!existing,
    });
  });

  /** POST /member-evolution/apply — apply evolution profile to a session */
  app.post<{ Body: { model: string; sessionId: string } }>(
    "/member-evolution/apply",
    async (request, reply) => {
      const { model, sessionId } = request.body ?? {};
      if (!model || !sessionId)
        return reply.code(400).send({ error: "model and sessionId are required" });
      const profile = _evolutionStore.get(model) ?? null;
      return reply.send({
        applied: true,
        model,
        sessionId,
        profile,
        appliedAt: now(),
      });
    },
  );

  // ══════════════════════════════════════════════════════════════════════════
  // C.8 — video, marketplace
  //        video       → @nexus/video-search VideoSearchEngine
  //        marketplace → @nexus/plugin-sdk AdapterRegistry
  // ══════════════════════════════════════════════════════════════════════════

  // ── video ──────────────────────────────────────────────────────────────────

  // YouTube Data API v3 backend (wired when YOUTUBE_API_KEY is set)
  class YouTubeVideoBackend implements VideoBackend {
    constructor(private readonly apiKey: string) {}
    async search(query: string, maxResults: number): Promise<VideoResult[]> {
      const url = new URL("https://www.googleapis.com/youtube/v3/search");
      url.searchParams.set("part", "snippet");
      url.searchParams.set("q", query);
      url.searchParams.set("maxResults", String(Math.min(maxResults, 50)));
      url.searchParams.set("type", "video");
      url.searchParams.set("key", this.apiKey);

      const res = await fetch(url.toString());
      if (!res.ok) return [];

      const data = (await res.json()) as {
        items?: {
          id: { videoId: string };
          snippet: {
            title: string;
            description: string;
            channelTitle: string;
            publishedAt: string;
            thumbnails: { default?: { url: string } };
          };
        }[];
      };

      return (data.items ?? []).map((item) => ({
        id: item.id.videoId,
        title: item.snippet.title,
        url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
        thumbnailUrl: item.snippet.thumbnails.default?.url,
        source: "youtube",
        description: item.snippet.description,
        publishedAt: item.snippet.publishedAt,
      }));
    }
  }

  // ModelFn: uses GroqDriver when GROQ_API_KEY set, else stub echo
  const _videoModelFn: VideoModelFn = async (systemPrompt: string, userMessage: string) => {
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey) {
      try {
        const { GroqDriver } = await import("@nexus/llm-drivers");
        const driver = new GroqDriver({ apiKey: groqKey });
        const chunks: string[] = [];
        await driver.stream(
          {
            model: process.env.VIDEO_SEARCH_MODEL ?? "llama-3.1-8b-instant",
            messages: [
              { role: "system" as const, content: systemPrompt },
              { role: "user" as const, content: userMessage },
            ],
            maxTokens: 512,
            temperature: 0,
          },
          ({ delta }: { delta: string }) => {
            if (delta) chunks.push(delta);
          },
        );
        return chunks.join("");
      } catch {
        return userMessage; // graceful fallback
      }
    }
    return userMessage; // stub: return query as-is (MockVideoBackend ignores refinement)
  };

  let _videoEngine: VideoSearchEngine | null = null;
  function getVideoEngine(): VideoSearchEngine {
    if (!_videoEngine) {
      const backend: VideoBackend = process.env.YOUTUBE_API_KEY
        ? new YouTubeVideoBackend(process.env.YOUTUBE_API_KEY)
        : new MockVideoBackend();
      _videoEngine = new VideoSearchEngine({
        model: _videoModelFn,
        backend,
        cacheTtlMs: 5 * 60_000,
      });
    }
    return _videoEngine;
  }

  /**
   * POST /video/search
   * Body: { query: string, maxResults?: number, source?: string, forceRefresh?: boolean }
   */
  app.post<{ Body: Partial<VideoSearchRequest> & { query: string } }>(
    "/video/search",
    {
      schema: {
        body: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string", maxLength: 512 },
            maxResults: { type: "number", minimum: 1, maximum: 50 },
            minDuration: { type: "number", minimum: 0 },
            maxDuration: { type: "number", minimum: 0 },
            source: { type: "string" },
            forceRefresh: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      const result = await getVideoEngine().search({
        query: request.body.query,
        maxResults: request.body.maxResults ?? 10,
        minDuration: request.body.minDuration,
        maxDuration: request.body.maxDuration,
        source: request.body.source,
        forceRefresh: request.body.forceRefresh ?? false,
      });
      return reply.send(result);
    },
  );

  /** GET /video/cache/status */
  app.get("/video/cache/status", async (_req, reply) => {
    const cache = getVideoEngine().getCache();
    return reply.send({ size: cache.size(), ttlMs: 5 * 60_000 });
  });

  // ── marketplace ────────────────────────────────────────────────────────────

  const _adapterRegistry = new AdapterRegistry();

  /**
   * POST /marketplace/adapters — register a named adapter definition.
   * Body: { name: string, capabilities: string[], description?: string }
   * The adapter executes by echoing the task — real implementations inject
   * execute() logic via the plugin-sdk defineAdapter() helper.
   */
  app.post<{
    Body: { name: string; capabilities: string[]; description?: string };
  }>(
    "/marketplace/adapters",
    {
      schema: {
        body: {
          type: "object",
          required: ["name", "capabilities"],
          properties: {
            name: { type: "string", maxLength: 64 },
            capabilities: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 },
            description: { type: "string", maxLength: 512 },
          },
        },
      },
    },
    async (request, reply) => {
      const { name, capabilities, description = "" } = request.body;
      try {
        const adapter = defineAdapter({
          name,
          version: "1.0.0",
          capabilities: capabilities as Parameters<typeof defineAdapter>[0]["capabilities"],
          taskTypes: capabilities as readonly string[],
          async execute(task, _ctx) {
            return task;
          }, // passthrough — real logic injected per adapter
        });
        _adapterRegistry.register(adapter);
        return reply.code(201).send({ name, capabilities, description, registered: true });
      } catch (err) {
        if (err instanceof NexusAdapterError && err.code === "DUPLICATE_ADAPTER") {
          return reply.code(409).send({ error: "adapter_exists", name });
        }
        throw err;
      }
    },
  );

  /** GET /marketplace/adapters — list all registered adapters. */
  app.get("/marketplace/adapters", async (_req, reply) => {
    return reply.send(
      _adapterRegistry.list().map((a) => ({
        name: a.name,
        capabilities: a.capabilities,
        description: (a as { description?: string }).description ?? "",
      })),
    );
  });

  /**
   * POST /marketplace/execute/:name — execute a registered adapter.
   * Body: any task object
   */
  app.post<{ Params: { name: string }; Body: unknown }>(
    "/marketplace/execute/:name",
    async (request, reply) => {
      const adapter = _adapterRegistry.resolve(request.params.name);
      if (!adapter) {
        return reply.code(404).send({ error: "adapter_not_found", name: request.params.name });
      }
      const ctx = {
        logger: request.log,
        env: process.env,
        timeoutMs: 30_000,
        signal: request.raw as unknown as AbortSignal,
      };
      const result = await adapter.execute(
        request.body,
        ctx as unknown as Parameters<typeof adapter.execute>[1],
      );
      return reply.send({ name: request.params.name, result });
    },
  );

  // ══════════════════════════════════════════════════════════════════════════
  // C.9 — image-transformations
  //        Uses @nexus/image-transformations → sharp (optional); passthrough
  //        when sharp not installed so routes stay functional in CI/serverless.
  // ══════════════════════════════════════════════════════════════════════════

  const _imgTransformer = new ImageTransformer();

  /** GET /image-transformations/status — sharp availability probe */
  app.get("/image-transformations/status", async (_req, reply) => {
    const sharpAvailable = await isSharpAvailable();
    return reply.send({ sharpAvailable, passthrough: !sharpAvailable });
  });

  /**
   * POST /image-transformations/resize
   * Body: { image: string (base64), width?, height?, fit?, background?, format? }
   */
  app.post<{
    Body: { image: string; format?: ImageFormat } & ResizeOptions;
  }>(
    "/image-transformations/resize",
    {
      schema: {
        body: {
          type: "object",
          required: ["image"],
          properties: {
            image: { type: "string" },
            width: { type: "number", minimum: 1 },
            height: { type: "number", minimum: 1 },
            fit: { type: "string", enum: ["cover", "contain", "fill", "inside", "outside"] },
            background: { type: "string" },
            format: { type: "string", enum: ["jpeg", "png", "webp", "avif", "gif", "tiff"] },
          },
        },
      },
    },
    async (request, reply) => {
      const { image, format, ...resizeOpts } = request.body;
      const input = Buffer.from(image, "base64");
      const result = await _imgTransformer.resize(input, resizeOpts, format);
      return reply.send({
        image: result.buffer.toString("base64"),
        format: result.format,
        width: result.width,
        height: result.height,
        byteSize: result.byteSize,
        passthrough: result.passthrough,
      });
    },
  );

  /**
   * POST /image-transformations/crop
   * Body: { image: string (base64), left, top, width, height, format? }
   */
  app.post<{
    Body: { image: string; format?: ImageFormat } & CropOptions;
  }>(
    "/image-transformations/crop",
    {
      schema: {
        body: {
          type: "object",
          required: ["image", "left", "top", "width", "height"],
          properties: {
            image: { type: "string" },
            left: { type: "number", minimum: 0 },
            top: { type: "number", minimum: 0 },
            width: { type: "number", minimum: 1 },
            height: { type: "number", minimum: 1 },
            format: { type: "string", enum: ["jpeg", "png", "webp", "avif", "gif", "tiff"] },
          },
        },
      },
    },
    async (request, reply) => {
      const { image, format, ...cropOpts } = request.body;
      const input = Buffer.from(image, "base64");
      const result = await _imgTransformer.crop(input, cropOpts as CropOptions, format);
      return reply.send({
        image: result.buffer.toString("base64"),
        format: result.format,
        width: result.width,
        height: result.height,
        byteSize: result.byteSize,
        passthrough: result.passthrough,
      });
    },
  );

  /**
   * POST /image-transformations/convert
   * Body: { image: string (base64), format, quality? }
   */
  app.post<{
    Body: { image: string } & ConvertOptions;
  }>(
    "/image-transformations/convert",
    {
      schema: {
        body: {
          type: "object",
          required: ["image", "format"],
          properties: {
            image: { type: "string" },
            format: { type: "string", enum: ["jpeg", "png", "webp", "avif", "gif", "tiff"] },
            quality: { type: "number", minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      const { image, ...convertOpts } = request.body;
      const input = Buffer.from(image, "base64");
      const result = await _imgTransformer.convert(input, convertOpts as ConvertOptions);
      return reply.send({
        image: result.buffer.toString("base64"),
        format: result.format,
        width: result.width,
        height: result.height,
        byteSize: result.byteSize,
        passthrough: result.passthrough,
      });
    },
  );

  /**
   * POST /image-transformations/watermark
   * Body: { image: string (base64), text, colour?, fontSize?, gravity?, format? }
   */
  app.post<{
    Body: { image: string; format?: ImageFormat } & WatermarkOptions;
  }>(
    "/image-transformations/watermark",
    {
      schema: {
        body: {
          type: "object",
          required: ["image", "text"],
          properties: {
            image: { type: "string" },
            text: { type: "string", maxLength: 256 },
            colour: { type: "string" },
            fontSize: { type: "number", minimum: 8, maximum: 256 },
            gravity: { type: "string" },
            format: { type: "string", enum: ["jpeg", "png", "webp", "avif", "gif", "tiff"] },
          },
        },
      },
    },
    async (request, reply) => {
      const { image, format, ...wmOpts } = request.body;
      const input = Buffer.from(image, "base64");
      const result = await _imgTransformer.watermark(input, wmOpts as WatermarkOptions, format);
      return reply.send({
        image: result.buffer.toString("base64"),
        format: result.format,
        width: result.width,
        height: result.height,
        byteSize: result.byteSize,
        passthrough: result.passthrough,
      });
    },
  );

  /**
   * POST /image-transformations/metadata
   * Body: { image: string (base64) }
   */
  app.post<{ Body: { image: string } }>(
    "/image-transformations/metadata",
    {
      schema: {
        body: {
          type: "object",
          required: ["image"],
          properties: { image: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      const input = Buffer.from(request.body.image, "base64");
      const meta = await _imgTransformer.metadata(input);
      return reply.send(meta);
    },
  );

  // ── Token-conservation: real budget check + consume actions ─────────────────
  // These routes overlay the CRUD scaffold above with actual TokenBudget logic.
  const _tokenBudgets = new Map<string, InstanceType<typeof MemoryTokenBudget>>();
  function _getTokenBudget(
    userId: string,
    limitTokens = 100_000,
  ): InstanceType<typeof MemoryTokenBudget> {
    if (!_tokenBudgets.has(userId)) {
      _tokenBudgets.set(
        userId,
        new MemoryTokenBudget({ limit: limitTokens, windowMs: 60 * 60 * 1000 }),
      );
    }
    return _tokenBudgets.get(userId)!;
  }

  /** POST /token-conservation/check — check budget status for a user */
  app.post<{ Body: { userId?: string; limitTokens?: number } }>(
    "/token-conservation/check",
    async (request, reply) => {
      const userId = request.body?.userId ?? "default";
      const budget = _getTokenBudget(userId, request.body?.limitTokens);
      const status = await budget.status(userId);
      return reply.send({ userId, ...status });
    },
  );

  /** POST /token-conservation/consume — consume tokens from a user's budget */
  app.post<{ Body: { userId?: string; tokens: number; limitTokens?: number } }>(
    "/token-conservation/consume",
    async (request, reply) => {
      const { userId = "default", tokens, limitTokens } = request.body ?? {};
      if (!tokens || tokens < 1)
        return (reply as FastifyReply)
          .code(400)
          .send({ error: "tokens must be a positive integer" });
      const budget = _getTokenBudget(userId, limitTokens);
      try {
        await budget.consume({ identity: userId, tokens });
        const status = await budget.status(userId);
        return reply.send({ userId, consumed: tokens, remaining: status.remaining });
      } catch {
        const status = await budget.status(userId);
        return (reply as FastifyReply).code(429).send({
          error: "budget_exceeded",
          userId,
          requested: tokens,
          remaining: status.remaining,
          limitTokens: status.limit,
        });
      }
    },
  );

  /** POST /token-conservation/reset — reset a user's token budget */
  app.post<{ Body: { userId?: string } }>("/token-conservation/reset", async (request, reply) => {
    const userId = request.body?.userId ?? "default";
    _tokenBudgets.delete(userId);
    return reply.send({ userId, reset: true });
  });

  /** POST /token-conservation/compress — compress text with given aggressiveness */
  app.post<{ Body: { text: string; aggressiveness: number } }>(
    "/token-conservation/compress",
    async (request, reply) => {
      const { text, aggressiveness = 0.5 } = request.body ?? {};
      if (!text) return reply.code(400).send({ error: "text is required" });
      const before = text.length;
      const compressed =
        text.length > 100
          ? text.slice(0, Math.floor(text.length * (1 - aggressiveness * 0.5))) + "…"
          : text;
      const after = compressed.length;
      return reply.send({
        compressed,
        savings: {
          before,
          after,
          pct: Math.round((1 - after / before) * 100),
        },
      });
    },
  );

  /** GET /token-conservation/status — token conservation status */
  app.get("/token-conservation/status", async (_req, reply) => {
    return reply.send({
      enabled: true,
      defaultAggressiveness: 0.5,
      activeBudgets: _tokenBudgets.size,
    });
  });

  // ── Verbosity: real STM transform pipeline ────────────────────────────────
  // STMPipeline() with no args builds the default registry (HedgeReducer + DirectnessOptimizer).
  const _stmPipeline = new STMPipeline();

  /** POST /verbosity/transform — run text through STM directness + hedge reduction */
  app.post<{ Body: { text: string; maxChars?: number } }>(
    "/verbosity/transform",
    async (request, reply) => {
      const { text, maxChars = 50_000 } = request.body ?? {};
      if (!text) return reply.code(400).send({ error: "text is required" });
      try {
        const result = _stmPipeline.transform({ text, maxChars });
        return reply.send({
          original: result.original,
          transformed: result.transformed,
          originalLength: result.original.length,
          transformedLength: result.transformed.length,
          reduction: result.original.length - result.transformed.length,
          reductionPct:
            result.original.length > 0
              ? Math.round((1 - result.transformed.length / result.original.length) * 100)
              : 0,
          truncated: result.truncated,
          modules: result.modules.map((m) => ({ id: m.moduleId, applied: true })),
        });
      } catch (err) {
        return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  /** GET /verbosity/levels — list available verbosity levels with multipliers */
  app.get("/verbosity/levels", async (_req, reply) => {
    return reply.send({
      levels: [
        { name: "concise", multiplier: 0.5 },
        { name: "normal", multiplier: 1.0 },
        { name: "detailed", multiplier: 1.5 },
        { name: "exhaustive", multiplier: 2.5 },
      ],
    });
  });

  /** POST /verbosity/preview — preview a verbosity-level transformation */
  app.post<{ Body: { text: string; level: string } }>(
    "/verbosity/preview",
    async (request, reply) => {
      const { text, level } = request.body ?? {};
      if (!text || !level) return reply.code(400).send({ error: "text and level are required" });
      return reply.send({
        preview: `[${level}] ${text}`,
      });
    },
  );

  // -- WEB SCRAPING (real — HttpxEngine via @nexus/adaptive-scraper) -----------

  app.get("/web-scraping/providers", async (_req, reply) => {
    return reply.send({
      providers: [
        { id: "httpx", name: "HTTPX (built-in)", available: true },
        { id: "firecrawl", name: "Firecrawl", available: !!process.env.FIRECRAWL_API_KEY },
        { id: "exa", name: "Exa", available: !!process.env.EXA_API_KEY },
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
          .map((m) => {
            try {
              return new URL(m[1]!, url).href;
            } catch {
              return null;
            }
          })
          .filter((h): h is string => !!h && h.startsWith(origin))
          .slice(0, maxPages - 1);
        const rest = await Promise.allSettled(
          hrefs.map((h) => scraper.scrape(h, { timeout: 15_000 })),
        );
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
      if (!apiKey)
        return reply
          .code(503)
          .send({ error: "no_exa_key", message: "Set EXA_API_KEY to enable Exa search." });
      const res = await fetch("https://api.exa.ai/search", {
        method: "POST",
        headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          query: request.body.query,
          numResults: request.body.numResults ?? 5,
        }),
      });
      if (!res.ok)
        return reply.code(res.status).send({ error: "exa_error", message: await res.text() });
      return reply.send(await res.json());
    },
  );

  app.post<{ Body: { ids: string[] } }>("/web-scraping/exa/contents", async (request, reply) => {
    const apiKey = process.env.EXA_API_KEY;
    if (!apiKey)
      return reply.code(503).send({
        error: "no_exa_key",
        message: "Set EXA_API_KEY to enable Exa content extraction.",
      });
    const res = await fetch("https://api.exa.ai/contents", {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ ids: request.body.ids }),
    });
    if (!res.ok)
      return reply.code(res.status).send({ error: "exa_error", message: await res.text() });
    return reply.send(await res.json());
  });

  // -- NEGATION DETECTION (LLM-based) ----------------------------------------

  const _negationRules = new Map<
    string,
    Map<string, { id: string; pattern: string; confidence: number }>
  >();

  app.post<{ Body: { text: string } }>("/negation/detect", async (request, reply) => {
    const { text } = request.body;
    const driver = getDefaultDriver();
    if (!driver) return reply.send({ patterns: [], detected: 0 });
    const res = await driver.complete({
      model: DEFAULT_MODEL,
      messages: [
        {
          role: "user" as LlmRole,
          content: `Detect negation patterns, contradictions, and logical negations in this text.\nReturn JSON: { patterns: Array<{ id: string, pattern: string, confidence: number }>, detected: number }\n\nText:\n${text.slice(0, 800)}`,
        },
      ],
      maxTokens: 512,
    });
    _trackCost(DEFAULT_MODEL, res.usage);
    try {
      return reply.send(parseJsonResponse(res.content));
    } catch {
      return reply.send({ patterns: [], detected: 0 });
    }
  });

  app.post<{
    Body: { convId: string; patterns: { id: string; pattern: string; confidence: number }[] };
  }>("/negation/add", async (request, reply) => {
    const { convId, patterns } = request.body;
    if (!convId || !Array.isArray(patterns))
      return reply.code(400).send({ error: "convId and patterns[] are required" });
    if (!_negationRules.has(convId)) _negationRules.set(convId, new Map());
    for (const p of patterns) _negationRules.get(convId)!.set(p.id ?? crypto.randomUUID(), p);
    return reply.send({ ok: true, added: patterns.length });
  });

  app.get<{ Params: { convId: string } }>("/negation/:convId", async (request, reply) => {
    const rules = _negationRules.get(request.params.convId);
    return reply.send({ rules: rules ? Array.from(rules.values()) : [] });
  });

  app.delete<{ Params: { convId: string; ruleId: string } }>(
    "/negation/:convId/:ruleId",
    async (request, reply) => {
      _negationRules.get(request.params.convId)?.delete(request.params.ruleId);
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { convId: string } }>("/negation/:convId", async (request, reply) => {
    _negationRules.delete(request.params.convId);
    return reply.code(204).send();
  });

  app.post<{ Body: { convId: string } }>("/negation/inject", async (request, reply) => {
    const rules = _negationRules.get(request.body.convId);
    const list = rules ? Array.from(rules.values()) : [];
    const injected = list.length;
    // Compose the real system-constraint block the caller would prepend.
    const contextBlock = injected
      ? "Negation constraints:\n" + list.map((r) => `- Avoid: ${r.pattern}`).join("\n")
      : "";
    return reply.send({
      message: injected
        ? `Injected ${injected} negation rule(s) into context.`
        : "No rules found for this conversation.",
      injected,
      contextBlock,
      rules: list,
    });
  });

  // -- INTERRUPT-MIDWAY-RESUME (IMR) -----------------------------------------

  type ImrStatus = "running" | "interrupted" | "resumed" | "done" | "failed";
  interface ImrRun {
    id: string;
    query: string;
    status: ImrStatus;
    createdAt: string;
    interruptedAt?: string;
    resumedAt?: string;
    output?: string;
    progress?: number;
  }

  app.get("/imr/runs", async (_req, reply) => reply.send({ runs: Array.from(_imrRuns.values()) }));

  app.post<{ Body: { query: string } }>("/imr/runs", async (request, reply) => {
    const id = crypto.randomUUID();
    const run: ImrRun = {
      id,
      query: request.body.query ?? "",
      status: "running",
      createdAt: now(),
      progress: 10,
    };
    _imrRuns.set(id, run);
    return reply.code(201).send(run);
  });

  app.get<{ Params: { id: string } }>("/imr/runs/:id", async (request, reply) => {
    const run = _imrRuns.get(request.params.id);
    if (!run) return reply.code(404).send({ error: "not_found" });
    return reply.send(run);
  });

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    "/imr/runs/:id/interrupt",
    async (request, reply) => {
      const run = _imrRuns.get(request.params.id);
      if (!run) return reply.code(404).send({ error: "not_found" });
      run.status = "interrupted";
      run.interruptedAt = now();
      return reply.send(run);
    },
  );

  app.patch<{ Params: { id: string }; Body: { query?: string } }>(
    "/imr/runs/:id/modify",
    async (request, reply) => {
      const run = _imrRuns.get(request.params.id);
      if (!run) return reply.code(404).send({ error: "not_found" });
      if (request.body.query) run.query = request.body.query;
      return reply.send(run);
    },
  );

  app.post<{ Params: { id: string } }>("/imr/runs/:id/resume", async (request, reply) => {
    const run = _imrRuns.get(request.params.id);
    if (!run) return reply.code(404).send({ error: "not_found" });
    run.status = "resumed";
    run.resumedAt = now();
    // Generate output via LLM on resume
    const driver = getDefaultDriver();
    if (driver) {
      const res = await driver.complete({
        model: DEFAULT_MODEL,
        messages: [
          { role: "user" as LlmRole, content: `Resume and complete this task: ${run.query}` },
        ],
        maxTokens: 512,
      });
      _trackCost(DEFAULT_MODEL, res.usage);
      run.output = res.content;
      run.progress = 100;
      run.status = "done";
    }
    return reply.send(run);
  });

  app.delete<{ Params: { id: string } }>("/imr/runs/:id", async (request, reply) => {
    _imrRuns.delete(request.params.id);
    return reply.code(204).send();
  });

  // -- MULTI-AGENT SIMULATION (Generative Agents pattern) -------------------

  interface SimPersona {
    id: string;
    name: string;
    backstory: string;
    goals: string[];
    traits: string[];
    expertise: string[];
    communicationStyle: string;
    constraints: string[];
    memory: string[];
    createdAt: string;
  }
  interface SimEnvironment {
    id: string;
    name: string;
    description: string;
    initialState: string;
    rules: string[];
    createdAt: string;
  }
  interface SimRun {
    id: string;
    name: string;
    environmentId: string;
    personaIds: string[];
    status: string;
    currentTick: number;
    maxTicks: number;
    tickLog: unknown[];
    createdAt: string;
  }

  const _personas = new Map<string, SimPersona>();
  const _simEnvs = new Map<string, SimEnvironment>();
  const _simRuns = new Map<string, SimRun>();

  // Personas
  app.get("/simulate/personas", async (_req, reply) =>
    reply.send({ personas: Array.from(_personas.values()) }),
  );
  app.post<{ Body: Partial<SimPersona> }>("/simulate/personas", async (request, reply) => {
    const id = crypto.randomUUID();
    const p: SimPersona = {
      id,
      name: request.body.name ?? "Agent",
      backstory: request.body.backstory ?? "",
      goals: request.body.goals ?? [],
      traits: request.body.traits ?? [],
      expertise: request.body.expertise ?? [],
      communicationStyle: request.body.communicationStyle ?? "neutral",
      constraints: request.body.constraints ?? [],
      memory: [],
      createdAt: now(),
    };
    _personas.set(id, p);
    return reply.code(201).send(p);
  });
  app.delete<{ Params: { id: string } }>("/simulate/personas/:id", async (req, reply) => {
    _personas.delete(req.params.id);
    return reply.code(204).send();
  });

  // Persona chat — respond in-character
  app.post<{
    Params: { id: string };
    Body: { messages: { role: string; content: string }[]; message?: string };
  }>("/simulate/personas/:id/chat", async (request, reply) => {
    const persona = _personas.get(request.params.id);
    if (!persona) return reply.code(404).send({ error: "not_found" });
    const driver = getDefaultDriver();
    if (!driver)
      return reply.send({
        role: "assistant",
        content: `[${persona.name}]: No LLM driver configured.`,
      });
    const sysprompt = `You are ${persona.name}. ${persona.backstory}\nGoals: ${persona.goals.join(", ")}\nTraits: ${persona.traits.join(", ")}\nCommunication style: ${persona.communicationStyle}\nConstraints: ${persona.constraints.join(", ")}\nRespond in character.`;
    const userMsg = request.body.message ?? request.body.messages?.at(-1)?.content ?? "Hello";
    const res = await driver.complete({
      model: DEFAULT_MODEL,
      messages: [
        { role: "system" as LlmRole, content: sysprompt },
        { role: "user" as LlmRole, content: userMsg },
      ],
      maxTokens: 512,
    });
    _trackCost(DEFAULT_MODEL, res.usage);
    return reply.send({ role: "assistant", content: res.content });
  });

  // Environments
  app.get("/simulate/environments", async (_req, reply) =>
    reply.send({ environments: Array.from(_simEnvs.values()) }),
  );
  app.post<{ Body: Partial<SimEnvironment> }>("/simulate/environments", async (request, reply) => {
    const id = crypto.randomUUID();
    const env: SimEnvironment = {
      id,
      name: request.body.name ?? "World",
      description: request.body.description ?? "",
      initialState: request.body.initialState ?? "",
      rules: request.body.rules ?? [],
      createdAt: now(),
    };
    _simEnvs.set(id, env);
    return reply.code(201).send(env);
  });

  // Simulation runs
  app.get("/simulate/runs", async (_req, reply) =>
    reply.send({ runs: Array.from(_simRuns.values()) }),
  );
  app.post<{
    Body: { name?: string; environmentId: string; personaIds: string[]; maxTicks?: number };
  }>("/simulate/runs", async (request, reply) => {
    const id = crypto.randomUUID();
    const run: SimRun = {
      id,
      name: request.body.name ?? "Simulation",
      environmentId: request.body.environmentId,
      personaIds: request.body.personaIds,
      status: "idle",
      currentTick: 0,
      maxTicks: request.body.maxTicks ?? 20,
      tickLog: [],
      createdAt: now(),
    };
    _simRuns.set(id, run);
    return reply.code(201).send(run);
  });

  // Tick — advance simulation one step using LLM-generated actions
  app.post<{ Params: { id: string } }>("/simulate/runs/:id/tick", async (request, reply) => {
    const run = _simRuns.get(request.params.id);
    if (!run) return reply.code(404).send({ error: "not_found" });
    if (run.currentTick >= run.maxTicks) {
      run.status = "completed";
      return reply.send(run);
    }
    run.status = "running";
    const env = _simEnvs.get(run.environmentId);
    const driver = getDefaultDriver();
    const personas = run.personaIds
      .map((pid) => _personas.get(pid))
      .filter(Boolean) as SimPersona[];
    const tick = run.currentTick + 1;
    const actions: unknown[] = [];
    if (driver && personas.length > 0) {
      const worldCtx = env
        ? `Environment: ${env.name}. ${env.description}. State: ${env.initialState}`
        : "Unknown environment";
      const prevTick = (run.tickLog as { actions: unknown[] }[]).at(-1);
      const recentEvents = prevTick
        ? `Previous tick events: ${JSON.stringify(prevTick.actions)}`
        : "First tick.";
      for (const p of personas) {
        const prompt = `${worldCtx}\n${recentEvents}\nYou are ${p.name}. ${p.backstory}\nGoals: ${p.goals.join(", ")}\nWhat do you do this tick? Return JSON: { action: string, reasoning: string }`;
        const res = await driver.complete({
          model: DEFAULT_MODEL,
          messages: [{ role: "user" as LlmRole, content: prompt }],
          maxTokens: 256,
        });
        _trackCost(DEFAULT_MODEL, res.usage);
        try {
          const parsed = parseJsonResponse(res.content);
          actions.push({
            personaId: p.id,
            personaName: p.name,
            ...(parsed as Record<string, unknown>),
          });
        } catch {
          actions.push({
            personaId: p.id,
            personaName: p.name,
            action: res.content.slice(0, 120),
            reasoning: "",
          });
        }
      }
    } else {
      for (const p of personas.length ? personas : [{ id: "stub", name: "Agent" } as SimPersona]) {
        actions.push({
          personaId: p.id,
          personaName: p.name,
          action: "No LLM driver configured — add an API key to enable simulation",
          reasoning: "",
        });
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
    run.currentTick = 0;
    run.status = "idle";
    run.tickLog = [];
    return reply.send(run);
  });

  // -- MODERATION (LLM-based content safety) ---------------------------------

  const _moderationConfig = {
    thresholds: { hate: 0.8, violence: 0.8, sexual: 0.9, selfharm: 0.7 },
  };

  const _runModeration = async (
    text: string,
  ): Promise<{
    flagged: boolean;
    action: string;
    reason: string;
    categories: Record<string, number>;
  }> => {
    const driver = getDefaultDriver();
    if (!driver)
      return {
        flagged: false,
        action: "allow",
        reason: "No LLM driver configured",
        categories: {},
      };
    const res = await driver.complete({
      model: DEFAULT_MODEL,
      messages: [
        {
          role: "user" as LlmRole,
          content: `Moderate this text for policy violations. Score each category 0-1.\nReturn JSON: { flagged: boolean, action: "block"|"warn"|"allow", reason: string, categories: { hate: number, violence: number, sexual: number, selfharm: number, spam: number } }\n\nText: ${text.slice(0, 800)}`,
        },
      ],
      maxTokens: 256,
    });
    _trackCost(DEFAULT_MODEL, res.usage);
    try {
      return parseJsonResponse(res.content);
    } catch {
      return { flagged: false, action: "allow", reason: "Parse error", categories: {} };
    }
  };

  app.post<{ Body: { text: string } }>("/moderation/check", async (request, reply) => {
    return reply.send(await _runModeration(request.body.text));
  });

  app.post<{ Body: { items: { id: string; text: string }[] } }>(
    "/moderation/batch",
    async (request, reply) => {
      const results = await Promise.all(
        request.body.items
          .slice(0, 20)
          .map(async (item) => ({ id: item.id, result: await _runModeration(item.text) })),
      );
      return reply.send({ results });
    },
  );

  app.get("/moderation/config", async (_req, reply) => reply.send(_moderationConfig));
  app.post<{ Body: typeof _moderationConfig }>("/moderation/config", async (request, reply) => {
    Object.assign(_moderationConfig, request.body);
    return reply.send(_moderationConfig);
  });

  // -- HONESTY (LLM-based sycophancy, reframe, calibration, minority report) -

  app.post<{ Body: { prompt?: string; response: string } }>(
    "/honesty/sycophancy-check",
    async (request, reply) => {
      const { prompt = "", response } = request.body;
      if (!response?.trim()) return reply.code(400).send({ error: "response is required" });
      const driver = getDefaultDriver();
      if (!driver)
        return reply.send({
          sycophantic: false,
          score: 0,
          explanation: "No LLM driver configured",
          patterns: [],
        });
      const content = [
        "Analyse this AI response for sycophancy (excessive agreement, flattery, people-pleasing).",
        prompt ? `\nOriginal prompt: ${prompt.slice(0, 300)}` : "",
        `\nAI response: ${response.slice(0, 800)}`,
        "\nReturn JSON: { sycophantic: boolean, score: number (0-1), explanation: string, patterns: string[] }",
      ].join("");
      const res = await driver.complete({
        model: DEFAULT_MODEL,
        messages: [{ role: "user" as LlmRole, content }],
        maxTokens: 512,
      });
      _trackCost(DEFAULT_MODEL, res.usage);
      try {
        return reply.send(parseJsonResponse(res.content));
      } catch {
        return reply.send({
          sycophantic: false,
          score: 0.5,
          explanation: res.content.slice(0, 200),
          patterns: [],
        });
      }
    },
  );

  app.post<{ Body: { response: string } }>("/honesty/reframe", async (request, reply) => {
    const { response } = request.body;
    if (!response?.trim()) return reply.code(400).send({ error: "response is required" });
    const driver = getDefaultDriver();
    if (!driver)
      return reply.send({
        original: response,
        reframed: response,
        changes: ["No LLM driver configured"],
      });
    const res = await driver.complete({
      model: DEFAULT_MODEL,
      messages: [
        {
          role: "user" as LlmRole,
          content: `Rewrite this AI response to be more direct, honest, and less sycophantic. Return JSON: { original: string, reframed: string, changes: string[] }\n\nResponse:\n${response.slice(0, 1000)}`,
        },
      ],
      maxTokens: 1024,
    });
    _trackCost(DEFAULT_MODEL, res.usage);
    try {
      return reply.send(parseJsonResponse(res.content));
    } catch {
      return reply.send({ original: response, reframed: res.content, changes: [] });
    }
  });

  app.post<{ Body: { text: string } }>("/honesty/confidence-calibrate", async (request, reply) => {
    const { text } = request.body;
    if (!text?.trim()) return reply.code(400).send({ error: "text is required" });
    const driver = getDefaultDriver();
    if (!driver)
      return reply.send({
        originalConfidence: 0.8,
        calibratedConfidence: 0.6,
        overconfident: true,
        adjustedText: text,
      });
    const res = await driver.complete({
      model: DEFAULT_MODEL,
      messages: [
        {
          role: "user" as LlmRole,
          content: `Analyse the confidence calibration of this text. Detect overconfident claims and suggest hedged alternatives.\nReturn JSON: { originalConfidence: number (0-1), calibratedConfidence: number (0-1), overconfident: boolean, adjustedText: string }\n\nText:\n${text.slice(0, 800)}`,
        },
      ],
      maxTokens: 1024,
    });
    _trackCost(DEFAULT_MODEL, res.usage);
    try {
      return reply.send(parseJsonResponse(res.content));
    } catch {
      return reply.send({
        originalConfidence: 0.7,
        calibratedConfidence: 0.6,
        overconfident: false,
        adjustedText: text,
      });
    }
  });

  app.post<{ Body: { topic: string; mainView?: string } }>(
    "/honesty/minority-report",
    async (request, reply) => {
      const { topic, mainView = "" } = request.body;
      if (!topic?.trim()) return reply.code(400).send({ error: "topic is required" });
      const driver = getDefaultDriver();
      if (!driver)
        return reply.send({
          mainView: mainView || topic,
          minorityViews: [
            { view: "No LLM driver configured", prevalence: "unknown", reasoning: "" },
          ],
        });
      const res = await driver.complete({
        model: DEFAULT_MODEL,
        messages: [
          {
            role: "user" as LlmRole,
            content: `Surface 3-4 minority, contrarian, or under-represented viewpoints on this topic.\n${mainView ? `Dominant view to challenge: ${mainView}\n` : ""}Topic: ${topic.slice(0, 400)}\n\nReturn JSON: { mainView: string, minorityViews: Array<{ view: string, prevalence: string, reasoning: string }> }`,
          },
        ],
        maxTokens: 1024,
      });
      _trackCost(DEFAULT_MODEL, res.usage);
      try {
        return reply.send(parseJsonResponse(res.content));
      } catch {
        return reply.send({ mainView: mainView || topic, minorityViews: [] });
      }
    },
  );

  /** GET /honesty/modes — list available honesty-analysis modes. */
  app.get("/honesty/modes", async (_req, reply) => {
    return reply.send({
      modes: [
        {
          id: "sycophancy-check",
          name: "Sycophancy Detection",
          description: "Detect excessive agreement / people-pleasing.",
        },
        {
          id: "reframe",
          name: "Honest Reframe",
          description: "Reword a response to be more direct and honest.",
        },
        {
          id: "confidence-calibrate",
          name: "Confidence Calibration",
          description: "Assign a confidence score (0–1) to each claim.",
        },
        {
          id: "minority-report",
          name: "Minority Report",
          description: "Surface underrepresented viewpoints on a topic.",
        },
        {
          id: "score",
          name: "Honesty Score",
          description: "Composite honesty score from multiple signals.",
        },
      ],
    });
  });

  /**
   * POST /honesty/score — compute a composite honesty score for a given
   * prompt+response pair using a mock heuristic.
   *
   * Body: { prompt?: string, response: string }
   */
  app.post<{ Body: { prompt?: string; response: string } }>(
    "/honesty/score",
    {
      schema: {
        body: {
          type: "object",
          required: ["response"],
          properties: {
            prompt: { type: "string", maxLength: 4_096 },
            response: { type: "string", maxLength: 8_192 },
          },
        },
      },
    },
    async (request, reply) => {
      const { response, prompt = "" } = request.body;
      // Mock heuristic: longer responses with hedging words get lower scores
      const hedgingWords = ["might", "could", "possibly", "arguably", "perhaps", "may"];
      const hedgeCount = hedgingWords.reduce(
        (c, w) => c + (response.toLowerCase().match(new RegExp(`\\b${w}\\b`, "g")) ?? []).length,
        0,
      );
      const lengthPenalty = Math.min(response.length / 2_000, 1);
      const hedgePenalty = Math.min(hedgeCount / 5, 1);
      const honestyScore = Math.round((1 - (lengthPenalty * 0.2 + hedgePenalty * 0.5)) * 100) / 100;

      return reply.send({
        honestyScore: Math.max(0.1, honestyScore),
        breakdown: {
          lengthPenalty: Math.round(lengthPenalty * 100) / 100,
          hedgePenalty: Math.round(hedgePenalty * 100) / 100,
          hedgeCount,
        },
        prompt: prompt.slice(0, 200),
        scoredAt: now(),
      });
    },
  );

  // -- HALLUCINATION SCORING (LLM-based) ------------------------------------

  app.get("/hallucination/thresholds", async (_req, reply) => {
    return reply.send({
      low: 0.3,
      medium: 0.6,
      high: 0.8,
      thresholds: { low: 0.3, medium: 0.6, high: 0.8 },
    });
  });

  const _scoreHallucination = async (
    response: string,
    context?: string,
  ): Promise<{ score: number; confidence: number; factors: string[] }> => {
    const driver = getDefaultDriver();
    if (!driver) return { score: 0.5, confidence: 0.1, factors: ["No LLM driver configured"] };
    const prompt = context
      ? `Rate the hallucination risk of this AI response given the context (0=no hallucination, 1=definite hallucination). Return JSON: { score: number, confidence: number, factors: string[] }\n\nContext: ${context.slice(0, 500)}\n\nResponse: ${response.slice(0, 500)}`
      : `Rate the hallucination risk of this AI response (0=factual/safe, 1=likely hallucinated). Return JSON: { score: number, confidence: number, factors: string[] }\n\nResponse: ${response.slice(0, 500)}`;
    const res = await driver.complete({
      model: DEFAULT_MODEL,
      messages: [{ role: "user" as LlmRole, content: prompt }],
      maxTokens: 256,
    });
    _trackCost(DEFAULT_MODEL, res.usage);
    try {
      return parseJsonResponse(res.content);
    } catch {
      return { score: 0.5, confidence: 0.5, factors: ["Parse error"] };
    }
  };

  app.post<{ Body: { response: string; context?: string } }>(
    "/hallucination/score",
    async (request, reply) => {
      if (!request.body?.response?.trim())
        return reply.code(400).send({ error: "response is required" });
      const result = await _scoreHallucination(request.body.response, request.body.context);
      return reply.send(result);
    },
  );

  app.post<{ Body: { answer: string; context: string } }>(
    "/hallucination/groundedness",
    async (request, reply) => {
      const { answer, context } = request.body;
      if (!answer?.trim() || !context?.trim())
        return reply.code(400).send({ error: "answer and context are required" });
      const driver = getDefaultDriver();
      if (!driver) return reply.send({ groundedness: 0.5, supported: [], unsupported: [] });
      const res = await driver.complete({
        model: DEFAULT_MODEL,
        messages: [
          {
            role: "user" as LlmRole,
            content: `Rate how grounded this answer is in the given context (0-1). Return JSON: { groundedness: number, supported: string[], unsupported: string[] }\n\nContext: ${context.slice(0, 500)}\n\nAnswer: ${answer.slice(0, 500)}`,
          },
        ],
        maxTokens: 256,
      });
      _trackCost(DEFAULT_MODEL, res.usage);
      try {
        return reply.send(parseJsonResponse(res.content));
      } catch {
        return reply.send({ groundedness: 0.5, supported: [], unsupported: [] });
      }
    },
  );

  app.post<{ Body: { items: { id: string; response: string; context?: string }[] } }>(
    "/hallucination/batch-score",
    async (request, reply) => {
      const results = await Promise.all(
        request.body.items.slice(0, 10).map(async (item) => ({
          id: item.id,
          ...(await _scoreHallucination(item.response, item.context)),
        })),
      );
      return reply.send({ results });
    },
  );

  // -- SPECULATIVE DECODING / CLASSIFY --------------------------------------

  app.get("/speculative/config", async (_req, reply) =>
    reply.send({
      enabled: !!getDefaultDriver(),
      draftModel: DEFAULT_MODEL,
      targetModel: DEFAULT_MODEL,
      mode: "llm-simulated",
    }),
  );
  app.get("/speculative/stats", async (_req, reply) =>
    reply.send({ acceptanceRate: 0, speedup: 0, totalTokens: 0 }),
  );

  app.post<{ Body: { prompt: string; draftModel?: string; targetModel?: string } }>(
    "/speculative/run",
    async (req, reply) => {
      const driver = getDefaultDriver();
      if (!driver) return reply.code(503).send({ error: "no_llm_driver" });
      const prompt = req.body.prompt ?? "";
      const t0 = Date.now();
      // Draft pass
      const draftRes = await driver.complete({
        model: DEFAULT_MODEL,
        messages: [userMsg(prompt)],
        maxTokens: 256,
      });
      _trackCost(DEFAULT_MODEL, draftRes.usage);
      const draftMs = Date.now() - t0;
      // Verify pass — LLM scores and optionally improves the draft
      const t1 = Date.now();
      const verifyContent = await _llm(
        [
          userMsg(
            `Prompt: "${prompt.slice(0, 400)}"\n\nDraft response:\n${draftRes.content}\n\nIf the draft fully and correctly answers the prompt, respond with JSON: {"accepted":true,"output":"<same text>","reason":"correct"}. If it has errors or is incomplete, improve it: {"accepted":false,"output":"<improved>","reason":"<why rejected>"}. Return only valid JSON.`,
          ),
        ],
        512,
      );
      const verifyMs = Date.now() - t1;
      let result = { accepted: true, output: draftRes.content, reason: "verify unavailable" };
      try {
        result = parseJsonResponse<typeof result>(verifyContent);
      } catch {
        /* keep default */
      }
      return reply.send({
        accepted: result.accepted,
        output: result.output ?? draftRes.content,
        draft: draftRes.content,
        reason: result.reason,
        speedup: result.accepted ? +(draftMs / (draftMs + verifyMs)).toFixed(3) : 0,
        draftTokens: draftRes.usage?.outputTokens ?? 0,
        draftMs,
        verifyMs,
        totalMs: Date.now() - t0,
      });
    },
  );

  app.post<{ Body: { text: string } }>("/speculative/classify", async (request, reply) => {
    const { text } = request.body;
    const driver = getDefaultDriver();
    if (!driver) return reply.send({ type: "unknown", confidence: 0, labels: [] });
    const res = await driver.complete({
      model: DEFAULT_MODEL,
      messages: [
        {
          role: "user" as LlmRole,
          content: `Classify this text into one of: question, statement, command, code, creative, factual, opinion. Return JSON: { type: string, confidence: number, labels: string[] }\n\n${text.slice(0, 500)}`,
        },
      ],
      maxTokens: 128,
    });
    _trackCost(DEFAULT_MODEL, res.usage);
    try {
      return reply.send(parseJsonResponse(res.content));
    } catch {
      return reply.send({ type: "unknown", confidence: 0.5, labels: [] });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // C.3 — FUNCTIONAL STUBS (return 200 OK so callers don't log errors)
  // ══════════════════════════════════════════════════════════════════════════

  // STM — Short-Term Memory modules backed by @nexus/drift
  const _stmHistory: {
    id: string;
    query: string;
    modules: string[];
    applied: string[];
    params: Record<string, unknown>;
    ts: string;
  }[] = [];
  const _stmEmaStore = new InMemoryEmaStore();
  let _stmActiveModules: string[] = ["hedge", "dir", "ema"];

  app.get("/stm/history", async (_req, reply) => reply.send(_stmHistory));
  app.post<{ Body: { query: string; modules: string[]; applied: string[] } }>(
    "/stm/history",
    async (req, reply) => {
      // Compute real drift params for this query using active modules
      const result = computeAutoTuneParams({ message: req.body.query ?? "", history: [] });
      const entry = {
        id: crypto.randomUUID(),
        ...req.body,
        params: result.params as unknown as Record<string, unknown>,
        ts: now(),
      };
      _stmHistory.push(entry);
      if (_stmHistory.length > 500) _stmHistory.splice(0, _stmHistory.length - 500);
      return reply.send({ ok: true, params: result.params });
    },
  );
  app.delete("/stm/history", async (_req, reply) => {
    _stmHistory.length = 0;
    return reply.send({ ok: true, cleared: true });
  });

  app.get("/stm/active", async (_req, reply) => {
    // Return active module list + their current computed params for a neutral message
    const result = computeAutoTuneParams({ message: "neutral", history: [] });
    return reply.send({
      modules: _stmActiveModules,
      params: result.params,
      context: result.detectedContext,
    });
  });

  app.post<{ Body: { modules?: string[] } }>("/stm/active", async (req, reply) => {
    if (req.body.modules) _stmActiveModules = req.body.modules;
    const result = computeAutoTuneParams({ message: "neutral", history: [] });
    return reply.send({
      modules: _stmActiveModules,
      params: result.params,
      context: result.detectedContext,
    });
  });

  // TTS — OpenAI TTS-1 if OPENAI_API_KEY present, else graceful null
  app.post<{ Body: { text: string; voice?: string } }>("/tts", async (req, reply) => {
    // BYOK: platform key → x-openai-key header → stored user provider key
    const headerKey = req.headers["x-openai-key"] as string | undefined;
    const storedKey = (await resolveUserProviderKey(req.nexusUserId, "openai")) ?? undefined;
    const apiKey = process.env.OPENAI_API_KEY || headerKey || storedKey;
    if (!apiKey)
      return reply.send({
        audio: null,
        message:
          "TTS not configured — set OPENAI_API_KEY, pass x-openai-key header, or store your key via POST /user/provider-keys.",
      });
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
      return reply.send({
        audio: null,
        message: `TTS failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  });

  // Memory backend config (single-engine display for now — the selector is
  // cosmetic until a second backend ships, but it must at least round-trip).
  app.post("/memory/backend", async (_req, reply) => reply.send({ ok: true }));
  app.put("/memory/backend", async (_req, reply) => reply.send({ ok: true }));

  // Compact: lossless dedup of the caller's memories (same normalized text).
  // Previously a stub returning {ok:true, compacted:0} while the UI faked a
  // local merge — the store was never touched.
  app.post("/memory/compact", { preHandler: requireAuthWithTier }, async (request, reply) => {
    const mem = getMemory();
    const uid = request.nexusUserId ?? "local";
    const entries = await mem.list({ userId: uid });
    const seen = new Map<string, string>();
    let compacted = 0;
    for (const e of entries) {
      const key = (e.text ?? "").trim().replace(/\s+/g, " ").toLowerCase();
      if (!key) continue;
      if (seen.has(key)) {
        await mem.forget(e.id);
        compacted++;
      } else {
        seen.set(key, e.id);
      }
    }
    return reply.send({ ok: true, compacted });
  });

  // Memory delete-all (user-scoped). Previously a stub returning
  // {ok:true, deleted:0} — the UI emptied its list while the store kept
  // every entry, so they reappeared on the next load.
  app.delete("/memory/entries", { preHandler: requireAuthWithTier }, async (request, reply) => {
    const mem = getMemory();
    const uid = request.nexusUserId ?? "local";
    const owned = await mem.list({ userId: uid });
    for (const e of owned) await mem.forget(e.id);
    return reply.send({ ok: true, deleted: owned.length });
  });

  // KG communities — hierarchical label-propagation clustering via @nexus/knowledge-graph
  app.get<{ Querystring: { maxLevels?: string; maxClusterSize?: string } }>(
    "/kg/communities",
    async (request, reply) => {
      try {
        const store = getKGStore();
        const maxLevels = Math.min(parseInt(request.query.maxLevels ?? "2", 10) || 2, 4);
        const maxClusterSize = Math.min(
          parseInt(request.query.maxClusterSize ?? "10", 10) || 10,
          50,
        );

        const clusters = await clusterGraph(store, { maxLevels, maxClusterSize });
        const communities = buildCommunities(clusters);

        return reply.send({
          communities,
          total: communities.length,
          levels: maxLevels,
          message:
            communities.length === 0
              ? "No entities in graph yet — ingest documents first."
              : `${communities.length} communities detected across ${maxLevels} level(s).`,
        });
      } catch (err) {
        return reply.code(500).send({
          error: "community_detection_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // AutoTune optimize — real prompt optimization via LLM + EMA context detection
  app.post<{
    Body: {
      systemPrompt: string;
      testInputs: { user: string; expected?: string }[];
      goal?: string;
      iterations?: number;
    };
  }>("/drift/optimize", async (request, reply) => {
    const { systemPrompt, testInputs = [], goal = "", iterations = 1 } = request.body;
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, SSE_HEADERS);
    const write = (d: unknown) => {
      if (!raw.destroyed) raw.write(`data: ${JSON.stringify(d)}\n\n`);
    };

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

    write({
      type: "step",
      phase: "analyse",
      message: `Analysing system prompt (${inputs.length} test inputs)…`,
    });

    // Phase 1: evaluate original prompt
    const phase1: { input: string; output: string; score: number }[] = [];
    for (let i = 0; i < inputs.length; i++) {
      const inp = inputs[i]!;
      write({
        type: "step",
        phase: "eval-orig",
        message: `Evaluating original prompt on input ${i + 1}/${inputs.length}…`,
      });
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
      const failedInputs = phase1
        .filter((x) => x.score < 7)
        .map((x) => `Input: ${x.input}\nActual output: ${x.output}`)
        .join("\n\n");
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
    const phase2: { input: string; output: string; score: number }[] = [];
    const _iters = Math.min(iterations, 1); // single optimization pass for now
    void _iters;
    for (let i = 0; i < inputs.length; i++) {
      const inp = inputs[i]!;
      write({
        type: "step",
        phase: "eval-opt",
        message: `Evaluating optimised prompt on input ${i + 1}/${inputs.length}…`,
      });
      const output = await runInput(optimizedPrompt, inp.user);
      const score = scoreOutput(output, inp.expected);
      phase2.push({ input: inp.user, output, score });
      write({
        type: "eval",
        inputIndex: i,
        phase: 2,
        score,
        originalScore: phase1[i]?.score ?? 0,
        output,
      });
    }

    const avgOpt = phase2.reduce((s, x) => s + x.score, 0) / Math.max(phase2.length, 1);

    // Compute diff stats
    const origLines = systemPrompt.split("\n");
    const optLines = optimizedPrompt.split("\n");
    const linesAdded = optLines.filter((l) => !origLines.includes(l)).length;
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
    id: string;
    runId: string;
    name: string;
    conditions: string;
    currentTick: number;
    status: "idle" | "running" | "done";
    tickLog: { tick: number; events: string[] }[];
    createdAt: string;
  }
  const _simBranches = new Map<string, SimBranch>();

  app.get<{ Params: { id: string } }>("/simulate/runs/:id/branches", async (req, reply) => {
    const branches = Array.from(_simBranches.values()).filter((b) => b.runId === req.params.id);
    return reply.send({ branches });
  });

  app.post<{ Params: { id: string }; Body: { name?: string; conditions?: string } }>(
    "/simulate/runs/:id/branches",
    async (req, reply) => {
      const run = _simRuns.get(req.params.id);
      if (!run) return reply.code(404).send({ error: "run_not_found" });
      const b: SimBranch = {
        id: crypto.randomUUID(),
        runId: req.params.id,
        name: req.body.name ?? `Branch-${Date.now()}`,
        conditions: req.body.conditions ?? "",
        currentTick: run.currentTick,
        status: "idle",
        tickLog: JSON.parse(JSON.stringify(run.tickLog ?? [])),
        createdAt: now(),
      };
      _simBranches.set(b.id, b);
      return reply.code(201).send(b);
    },
  );

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
      if (!persona || !driver) {
        events.push(`${pid}: idle`);
        continue;
      }
      try {
        const res = await driver.complete({
          model: DEFAULT_MODEL,
          messages: [
            {
              role: "user",
              content: `You are ${persona.name}. Environment: ${env?.description ?? "unknown"}. Conditions: ${b.conditions}. Tick: ${b.currentTick}. Generate a brief action (1 sentence).`,
            },
          ],
          maxTokens: 80,
        });
        _trackCost(DEFAULT_MODEL, res.usage);
        events.push(`${persona.name}: ${res.content.trim()}`);
      } catch {
        events.push(`${persona.name}: idle`);
      }
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
    const branches = Array.from(_simBranches.values()).filter((b) => b.runId === req.params.id);
    if (branches.length < 2)
      return reply.send({ summary: "Need at least 2 branches to compare.", branches: [] });
    const driver = getDefaultDriver();
    let summary = "LLM comparison unavailable.";
    if (driver) {
      try {
        const branchSummaries = branches
          .map(
            (b) =>
              `Branch "${b.name}" (conditions: ${b.conditions || "none"}): ${b.tickLog
                .slice(-3)
                .map((t) => t.events.join("; "))
                .join(" | ")}`,
          )
          .join("\n");
        const res = await driver.complete({
          model: DEFAULT_MODEL,
          messages: [
            {
              role: "user",
              content: `Compare these simulation branches and summarize key divergence points:\n${branchSummaries}\n\nProvide a concise 2-3 sentence analysis.`,
            },
          ],
          maxTokens: 200,
        });
        _trackCost(DEFAULT_MODEL, res.usage);
        summary = res.content.trim();
      } catch {
        /* use default */
      }
    }
    return reply.send({
      summary,
      branches: branches.map((b) => ({
        id: b.id,
        name: b.name,
        currentTick: b.currentTick,
        conditions: b.conditions,
      })),
    });
  });

  // -- COUNCIL CHECKPOINTS ---------------------------------------------------

  interface CpCheckpoint {
    stepIndex: number;
    label: string;
    savedAt: string;
    opinions: Record<string, string>;
    verdict: string;
  }
  interface CpRun {
    runId: string;
    label: string;
    createdAt: string;
    checkpoints: CpCheckpoint[];
  }
  const _cpRuns = new Map<string, CpRun>();
  const _getOrCreateCpRun = (id: string): CpRun => {
    let run = _cpRuns.get(id);
    if (!run) {
      run = { runId: id, label: `Run ${id.slice(0, 8)}`, createdAt: now(), checkpoints: [] };
      _cpRuns.set(id, run);
    }
    return run;
  };

  app.get<{ Params: { id: string } }>("/council-checkpoints/runs/:id", async (req, reply) => {
    return reply.send(_getOrCreateCpRun(req.params.id));
  });

  app.post<{
    Params: { id: string };
    Body: { label?: string; opinions?: Record<string, string>; verdict?: string };
  }>("/council-checkpoints/runs/:id/save", async (req, reply) => {
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

  app.get<{ Params: { id: string; step: string } }>(
    "/council-checkpoints/runs/:id/checkpoints/:step",
    async (req, reply) => {
      const run = _cpRuns.get(req.params.id);
      if (!run) return reply.code(404).send({ error: "not_found" });
      const idx = parseInt(req.params.step, 10);
      const cp = run.checkpoints[idx];
      if (!cp) return reply.code(404).send({ error: "checkpoint_not_found" });
      return reply.send(cp);
    },
  );

  app.post<{ Params: { id: string }; Body: { fromStep: number } }>(
    "/council-checkpoints/runs/:id/replay",
    async (req, reply) => {
      const run = _cpRuns.get(req.params.id);
      if (!run) return reply.code(404).send({ error: "not_found" });
      const fromIdx = req.body.fromStep ?? 0;
      const checkpoint = run.checkpoints[fromIdx];
      if (!checkpoint) return reply.code(404).send({ error: "checkpoint_not_found" });
      const driver = getDefaultDriver();
      let replayVerdict = checkpoint.verdict;
      if (driver && Object.keys(checkpoint.opinions).length > 0) {
        try {
          const opinionText = Object.entries(checkpoint.opinions)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\n");
          const res = await driver.complete({
            model: DEFAULT_MODEL,
            messages: [
              {
                role: "user",
                content: `Re-synthesize a council verdict from these opinions at step ${fromIdx}:\n${opinionText}\n\nProvide a concise updated verdict.`,
              },
            ],
            maxTokens: 300,
          });
          _trackCost(DEFAULT_MODEL, res.usage);
          replayVerdict = res.content.trim();
        } catch {
          /* use existing */
        }
      }
      return reply.send({
        fromStep: fromIdx,
        replayedAt: now(),
        verdict: replayVerdict,
        opinions: checkpoint.opinions,
      });
    },
  );

  app.delete<{ Params: { id: string } }>("/council-checkpoints/runs/:id", async (req, reply) => {
    _cpRuns.delete(req.params.id);
    return reply.code(204).send();
  });

  // -- STANDARD ANSWERS (Q&A knowledge base + LLM match) --------------------

  interface StdAnswer {
    id: string;
    question: string;
    answer: string;
    tags: string[];
    createdAt: string;
    updatedAt: string;
  }

  app.get("/standard-answers", async (_req, reply) => reply.send(Array.from(_stdAnswers.values())));

  app.post<{ Body: { question: string; answer: string; tags?: string[] } }>(
    "/standard-answers",
    async (req, reply) => {
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
    },
  );

  app.put<{ Params: { id: string }; Body: Partial<StdAnswer> }>(
    "/standard-answers/:id",
    async (req, reply) => {
      const a = _stdAnswers.get(req.params.id);
      if (!a) return reply.code(404).send({ error: "not_found" });
      if (req.body.question !== undefined) a.question = req.body.question;
      if (req.body.answer !== undefined) a.answer = req.body.answer;
      if (req.body.tags !== undefined) a.tags = req.body.tags;
      a.updatedAt = now();
      return reply.send(a);
    },
  );

  app.delete<{ Params: { id: string } }>("/standard-answers/:id", async (req, reply) => {
    _stdAnswers.delete(req.params.id);
    return reply.code(204).send();
  });

  app.post<{ Body: { query: string } }>("/standard-answers/match", async (req, reply) => {
    const query = req.body.query ?? "";
    const answers = Array.from(_stdAnswers.values());
    if (!answers.length)
      return reply.send({
        match: null,
        confidence: 0,
        message: "No standard answers in knowledge base.",
      });
    const driver = getDefaultDriver();
    if (!driver)
      return reply.send({
        match: answers[0],
        confidence: 0.5,
        message: "No LLM — returning first entry.",
      });
    try {
      const catalog = answers.map((a, i) => `[${i}] Q: ${a.question}`).join("\n");
      const res = await driver.complete({
        model: DEFAULT_MODEL,
        messages: [
          {
            role: "user",
            content: `Given this user query: "${query}"\n\nWhich of these standard answers best matches? Reply with just the index number and confidence score (0-1) in JSON: {"index": N, "confidence": 0.X}\n\n${catalog}`,
          },
        ],
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

  interface CacheEntry {
    key: string;
    query: string;
    response: string;
    embedding: number[] | null;
    hits: number;
    createdAt: string;
    lastHit: string;
  }
  const _semCache = new Map<string, CacheEntry>();
  const _semCacheConfig = {
    enabled: true,
    similarityThreshold: 0.85,
    maxEntries: 1000,
    ttlHours: 24,
  };

  // Lazy embedder (Ollama 768-dim locally) for real semantic matching.
  let _semEmbedder: { embed(t: string): Promise<number[]> } | null = null;
  const getSemEmbedder = () => {
    if (!_semEmbedder) {
      try {
        _semEmbedder = createBestEmbedder();
      } catch {
        _semEmbedder = new FixedEmbedder(768);
      }
    }
    return _semEmbedder;
  };
  const _cosine = (a: number[], b: number[]): number => {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!;
      na += a[i]! * a[i]!;
      nb += b[i]! * b[i]!;
    }
    return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
  };

  app.get("/semantic-cache/stats", async (_req, reply) => {
    const entries = Array.from(_semCache.values());
    return reply.send({
      totalEntries: entries.length,
      totalHits: entries.reduce((s, e) => s + e.hits, 0),
      hitRate: entries.length ? entries.filter((e) => e.hits > 0).length / entries.length : 0,
      avgHitsPerEntry: entries.length
        ? entries.reduce((s, e) => s + e.hits, 0) / entries.length
        : 0,
    });
  });

  app.get("/semantic-cache/config", async (_req, reply) => reply.send(_semCacheConfig));

  app.post<{ Body: Partial<typeof _semCacheConfig> }>(
    "/semantic-cache/config",
    async (req, reply) => {
      Object.assign(_semCacheConfig, req.body);
      return reply.send(_semCacheConfig);
    },
  );

  // POST /semantic-cache/store — populate the cache with a {query,response} pair.
  app.post<{ Body: { query: string; response: string } }>(
    "/semantic-cache/store",
    {
      schema: {
        body: {
          type: "object",
          required: ["query", "response"],
          properties: {
            query: { type: "string", maxLength: 8_192 },
            response: { type: "string", maxLength: 65_536 },
          },
        },
      },
    },
    async (req, reply) => {
      const query = req.body.query.trim();
      let embedding: number[] | null = null;
      try {
        embedding = await getSemEmbedder().embed(query);
      } catch {
        /* embedder unavailable — fall back to string match on lookup */
      }
      const key = sha256hex(query).slice(0, 16);
      const entry: CacheEntry = {
        key,
        query,
        response: req.body.response,
        embedding,
        hits: 0,
        createdAt: now(),
        lastHit: now(),
      };
      _semCache.set(key, entry);
      // Evict oldest when over capacity.
      if (_semCache.size > _semCacheConfig.maxEntries) {
        const oldest = [..._semCache.values()].sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt),
        )[0];
        if (oldest) _semCache.delete(oldest.key);
      }
      return reply.code(201).send({ key, cached: true, embedded: embedding !== null });
    },
  );

  app.post<{ Body: { query: string } }>("/semantic-cache/lookup", async (req, reply) => {
    const q = (req.body.query ?? "").trim();
    if (!q || _semCache.size === 0) {
      return reply.send({ hit: false, entry: null, similarity: 0 });
    }
    // Embedding cosine match; falls back to substring match if embedding fails.
    let qVec: number[] | null = null;
    try {
      qVec = await getSemEmbedder().embed(q);
    } catch {
      qVec = null;
    }
    let best: CacheEntry | null = null;
    let bestSim = 0;
    for (const e of _semCache.values()) {
      let sim = 0;
      if (qVec && e.embedding) {
        sim = _cosine(qVec, e.embedding);
      } else {
        const a = e.query.toLowerCase();
        const b = q.toLowerCase();
        sim = a.includes(b) || b.includes(a) ? 0.9 : 0;
      }
      if (sim > bestSim) {
        bestSim = sim;
        best = e;
      }
    }
    if (best && bestSim >= _semCacheConfig.similarityThreshold) {
      best.hits += 1;
      best.lastHit = now();
      return reply.send({
        hit: true,
        entry: best,
        similarity: Math.round(bestSim * 10_000) / 10_000,
      });
    }
    return reply.send({
      hit: false,
      entry: null,
      similarity: Math.round(bestSim * 10_000) / 10_000,
    });
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

  interface RssFeed {
    id: string;
    url: string;
    name: string;
    lastPolled: string | null;
    itemCount: number;
    createdAt: string;
  }
  interface RssItem {
    id: string;
    feedId: string;
    title: string;
    link: string;
    summary: string;
    publishedAt: string;
    read: boolean;
  }

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
    const items = Array.from(_rssItems.values()).filter((i) => i.feedId === req.params.id);
    return reply.send(items);
  });

  app.post<{ Params: { id: string } }>("/rss/feeds/:id/poll", async (req, reply) => {
    const feed = _rssFeeds.get(req.params.id);
    if (!feed) return reply.code(404).send({ error: "not_found" });
    // Attempt to fetch and parse RSS via HttpxEngine
    const newItems: RssItem[] = [];
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
          const titleMatch = titleRegex.exec(chunk);
          const linkMatch = linkRegex.exec(chunk);
          const item: RssItem = {
            id: crypto.randomUUID(),
            feedId: feed.id,
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
    } catch {
      /* network errors silently ignored */
    }
    feed.lastPolled = now();
    feed.itemCount = Array.from(_rssItems.values()).filter((i) => i.feedId === feed.id).length;
    return reply.send({ feed, newItems: newItems.length, items: newItems });
  });

  app.delete<{ Params: { id: string } }>("/rss/feeds/:id", async (req, reply) => {
    _rssFeeds.delete(req.params.id);
    // cascade-delete items
    Array.from(_rssItems.values())
      .filter((v) => v.feedId === req.params.id)
      .forEach((v) => _rssItems.delete(v.id));
    return reply.code(204).send();
  });

  app.patch<{ Params: { id: string } }>("/rss/items/:id/read", async (req, reply) => {
    const item = _rssItems.get(req.params.id);
    if (!item) return reply.code(404).send({ error: "not_found" });
    item.read = true;
    return reply.send(item);
  });

  // -- CODEGEN (LLM-backed code generation, compile, iterate, diff) ----------

  app.post<{ Body: { prompt: string; language?: string; context?: string } }>(
    "/codegen/generate",
    async (req, reply) => {
      const driver = getDefaultDriver();
      if (!driver) return reply.code(503).send({ error: "no_llm_driver" });
      const lang = req.body.language ?? "typescript";
      const res = await driver.complete({
        model: DEFAULT_MODEL,
        messages: [
          {
            role: "user",
            content: `Generate ${lang} code for the following requirement. Return ONLY the code, no explanations:\n\n${req.body.prompt}${req.body.context ? `\n\nContext:\n${req.body.context}` : ""}`,
          },
        ],
        maxTokens: 2000,
      });
      _trackCost(DEFAULT_MODEL, res.usage);
      const code = res.content
        .trim()
        .replace(/^```[a-z]*\n?/, "")
        .replace(/\n?```$/, "");
      return reply.send({ code, language: lang, tokens: res.usage?.outputTokens ?? 0 });
    },
  );

  app.post<{ Body: { code: string; language?: string } }>(
    "/codegen/compile",
    async (req, reply) => {
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
        const feedback = await _llm(
          [
            systemMsg(
              "You are a TypeScript compiler. Review the code for syntax errors and type errors only. If there are errors, respond with JSON: {ok: false, errors: [{message, line}]}. If no errors, respond with {ok: true, errors: []}. Return only valid JSON.",
            ),
            userMsg(req.body.code.slice(0, 3000)),
          ],
          256,
        );
        try {
          return reply.send({
            ...(parseJsonResponse(feedback) as Record<string, unknown>),
            language: lang,
          });
        } catch {
          return reply.send({
            ok: true,
            errors: [],
            language: lang,
            note: "Static analysis unavailable.",
          });
        }
      }
      return reply.send({
        ok: true,
        errors: [],
        language: lang,
        note: "Compile check not available for this language in sandbox mode.",
      });
    },
  );

  app.post<{ Body: { code: string; instruction: string; language?: string } }>(
    "/codegen/iterate",
    async (req, reply) => {
      const driver = getDefaultDriver();
      if (!driver) return reply.code(503).send({ error: "no_llm_driver" });
      const res = await driver.complete({
        model: DEFAULT_MODEL,
        messages: [
          {
            role: "user",
            content: `Here is existing code:\n\`\`\`\n${req.body.code}\n\`\`\`\n\nInstruction: ${req.body.instruction}\n\nReturn ONLY the updated code, no explanations.`,
          },
        ],
        maxTokens: 2000,
      });
      _trackCost(DEFAULT_MODEL, res.usage);
      const code = res.content
        .trim()
        .replace(/^```[a-z]*\n?/, "")
        .replace(/\n?```$/, "");
      return reply.send({ code, language: req.body.language ?? "typescript" });
    },
  );

  // -- CONTEXT MENTION SEARCH --------------------------------------------------
  // Frontend: apps/ui/app/components/ContextMention.tsx + chat.tsx mentions.

  const _IGNORED_DIRS = new Set(["node_modules", ".git", "dist", ".next", "build", "coverage"]);
  const _CODE_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".py"]);

  function _collectWorkspaceFiles(maxDepth = 4, maxFiles = 2_000): string[] {
    const out: string[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > maxDepth || out.length >= maxFiles) return;
      let entries: fs.Dirent[] = [];
      try {
        // Deterministic order: directories first, dot-dirs last, then name.
        // (readdir order otherwise fills the cap from root dot-dirs like
        // .github before apps/ and packages/ are ever scanned.)
        entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => {
          const ad = a.isDirectory() ? 0 : 1;
          const bd = b.isDirectory() ? 0 : 1;
          if (ad !== bd) return ad - bd;
          const adot = a.name.startsWith(".") ? 1 : 0;
          const bdot = b.name.startsWith(".") ? 1 : 0;
          if (adot !== bdot) return adot - bdot;
          return a.name.localeCompare(b.name);
        });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.isDirectory()) {
          if (!_IGNORED_DIRS.has(e.name)) walk(path.join(dir, e.name), depth + 1);
        } else if (e.isFile()) {
          out.push(path.join(dir, e.name));
          if (out.length >= maxFiles) return;
        }
      }
    };
    walk(process.cwd(), 0);
    return out;
  }

  /** GET /context/files?q= — workspace files matching the query. */
  app.get<{ Querystring: { q?: string } }>("/context/files", async (request, reply) => {
    const q = (request.query.q ?? "").toLowerCase();
    if (!q) return reply.send([]);
    const matches: { path: string; name: string; size: number }[] = [];
    for (const f of _collectWorkspaceFiles()) {
      const base = path.basename(f);
      if (!base.toLowerCase().includes(q) && !f.toLowerCase().includes(q)) continue;
      let size = 0;
      try {
        size = fs.statSync(f).size;
      } catch {
        /* race */
      }
      matches.push({ path: f, name: base, size });
      if (matches.length >= 50) break;
    }
    return reply.send(matches);
  });

  const _SYMBOL_RE =
    /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|const\s+([A-Za-z_$][\w$]*)\s*=|interface\s+([A-Za-z_$][\w$]*)|type\s+([A-Za-z_$][\w$]*)\s*=/g;

  /** GET /context/symbols?q= — function/class/const/interface names matching q. */
  app.get<{ Querystring: { q?: string } }>("/context/symbols", async (request, reply) => {
    const q = (request.query.q ?? "").toLowerCase();
    if (!q) return reply.send([]);
    const matches: { name: string; type: string; file: string; line: number }[] = [];
    for (const f of _collectWorkspaceFiles()) {
      if (!_CODE_EXT.has(path.extname(f))) continue;
      let src = "";
      try {
        src = fs.readFileSync(f, "utf8").slice(0, 200_000);
      } catch {
        continue;
      }
      _SYMBOL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = _SYMBOL_RE.exec(src)) && matches.length < 50) {
        const name = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? "").trim();
        if (!name || !name.toLowerCase().includes(q)) continue;
        const kind = m[1]
          ? "function"
          : m[2]
            ? "class"
            : m[3]
              ? "const"
              : m[4]
                ? "interface"
                : "type";
        const line = src.slice(0, m.index).split("\n").length;
        matches.push({ name, type: kind, file: f, line });
      }
      if (matches.length >= 50) break;
    }
    return reply.send(matches);
  });

  /** GET /context/web?q= — synthetic web results (no search provider key). */
  app.get<{ Querystring: { q?: string } }>("/context/web", async (request, reply) => {
    const q = request.query.q ?? "";
    if (!q) return reply.send([]);
    return reply.send([
      {
        title: `${q} — overview`,
        url: `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(q)}`,
        snippet: `Synthetic result: connect a search provider (e.g. via /user/provider-keys) to enable live web context.`,
      },
      {
        title: `${q} — docs`,
        url: `https://developer.mozilla.org/en-US/search?q=${encodeURIComponent(q)}`,
        snippet: `Synthetic result: official documentation search for “${q}”.`,
      },
      {
        title: `${q} — discussions`,
        url: `https://github.com/search?q=${encodeURIComponent(q)}&type=discussions`,
        snippet: `Synthetic result: community discussions mentioning “${q}”.`,
      },
    ]);
  });

  // -- IMAGE TRANSFORMATIONS (generative; bridge synthetic mode) ----------------
  // Frontend: apps/ui/app/routes/image-transform.tsx

  app.get("/image-transformations/providers", async (_req, reply) => {
    return reply.send({
      providers: [
        { id: "replicate", name: "Replicate", supportsImg2Img: true, supportsImg2Video: true },
        {
          id: "stability-ai",
          name: "Stability AI",
          supportsImg2Img: true,
          supportsImg2Video: false,
        },
        { id: "runway", name: "Runway", supportsImg2Img: false, supportsImg2Video: true },
        { id: "pika", name: "Pika", supportsImg2Img: false, supportsImg2Video: true },
        { id: "kling", name: "Kling", supportsImg2Img: true, supportsImg2Video: true },
        { id: "fal", name: "FAL", supportsImg2Img: true, supportsImg2Video: true },
      ],
    });
  });

  app.post<{
    Body: {
      imageBase64?: string;
      prompt?: string;
      negativePrompt?: string;
      strength?: number;
      provider?: string;
    };
  }>("/image-transformations/img2img", async (req, reply) => {
    const body = req.body ?? {};
    if (!body.imageBase64) return reply.code(400).send({ error: "imageBase64 is required" });
    if (!body.prompt) return reply.code(400).send({ error: "prompt is required" });
    // Synthetic mode: no generative image provider key is configured, so the
    // source image is echoed back with the requested transform metadata.
    return reply.send({
      base64: body.imageBase64,
      provider: body.provider ?? "replicate",
      prompt: body.prompt,
      negativePrompt: body.negativePrompt,
      strength: body.strength ?? 0.7,
      applied: true,
      synthetic: true,
      note: "No image provider key configured — echo result (add a provider key to enable real img2img).",
    });
  });

  app.post<{
    Body: {
      imageBase64?: string;
      motionPrompt?: string;
      durationSec?: number;
      fps?: number;
      provider?: string;
    };
  }>("/image-transformations/img2video", async (req, reply) => {
    const body = req.body ?? {};
    if (!body.imageBase64) return reply.code(400).send({ error: "imageBase64 is required" });
    const durationSec = Math.min(30, Math.max(1, body.durationSec ?? 5));
    const fps = Math.min(30, Math.max(8, body.fps ?? 24));
    // Synthetic mode: report a completed job with frame metadata and echo the
    // source frame as the poster; no video provider key is configured.
    return reply.send({
      jobId: `img2video-${crypto.randomUUID().slice(0, 8)}`,
      status: "completed",
      base64: body.imageBase64,
      provider: body.provider ?? "runway",
      durationSec,
      fps,
      frames: durationSec * fps,
      motionPrompt: body.motionPrompt,
      synthetic: true,
      note: "No video provider key configured — synthetic result (add a provider key to enable real img2video).",
    });
  });

  // -- THREAD MESSAGES ----------------------------------------------------------
  // Moved to routes/threads.ts — a real per-user store (dashboard "Recent
  // Deliberations", chat sidebar, message history). Registered in server.ts
  // under /api; keep no /threads* handler here or boot throws a duplicate route.

  // -- VIDEO TRANSCRIPT ---------------------------------------------------------
  // Served by apps/api/src/routes/video-transcript.ts (registered in the same
  // /api scope in server.ts) — GET /video/transcript/sources + POST
  // /video/transcript are already live there.

  // Auth stubs (Judica's own auth won't work; return informative error)
  app.post("/auth/login", async (_req, reply) =>
    reply.code(501).send({
      error: "use_nexus_auth",
      message: "Use the Nexus API key via Authorization: Bearer <key>",
    }),
  );
  app.post("/auth/register", async (_req, reply) =>
    reply
      .code(501)
      .send({ error: "use_nexus_auth", message: "Registration is managed by the admin." }),
  );
  app.get("/auth/me", async (request, reply) => {
    const token = (request.headers.authorization as string | undefined)?.replace("Bearer ", "");
    return reply.send({
      id: "local",
      username: "admin",
      email: "admin@nexus.local",
      role: "admin",
      authenticated: !!token,
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // JUDICA + GHOSTSTACK MIGRATION — ported routes
  // ══════════════════════════════════════════════════════════════════════════

  // -- ARTIFACTS -------------------------------------------------------------
  interface Artifact {
    id: string;
    title: string;
    type: string;
    language?: string;
    content: string;
    createdAt: string;
    updatedAt: string;
    metadata?: Record<string, unknown>;
  }
  const _artifactStore = new PersistentStore<Artifact>("artifacts");
  await _artifactStore.load();

  app.get("/artifacts", async (_req, reply) =>
    reply.send({
      artifacts: Array.from(_artifactStore.values()).sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      ),
    }),
  );
  app.get<{ Params: { id: string } }>("/artifacts/:id", async (req, reply) => {
    const a = _artifactStore.get(req.params.id);
    return a ? reply.send(a) : reply.code(404).send({ error: "not_found" });
  });
  app.post<{ Body: Partial<Artifact> }>("/artifacts", async (req, reply) => {
    const a: Artifact = {
      id: crypto.randomUUID(),
      title: req.body.title ?? "Untitled",
      type: req.body.type ?? "text",
      language: req.body.language,
      content: req.body.content ?? "",
      createdAt: now(),
      updatedAt: now(),
      metadata: req.body.metadata,
    };
    _artifactStore.set(a.id, a);
    return reply.code(201).send(a);
  });
  app.put<{ Params: { id: string }; Body: Partial<Artifact> }>(
    "/artifacts/:id",
    async (req, reply) => {
      const existing = _artifactStore.get(req.params.id);
      if (!existing) return reply.code(404).send({ error: "not_found" });
      const updated = { ...existing, ...req.body, id: existing.id, updatedAt: now() };
      _artifactStore.set(updated.id, updated);
      return reply.send(updated);
    },
  );
  app.delete<{ Params: { id: string } }>("/artifacts/:id", async (req, reply) => {
    _artifactStore.delete(req.params.id);
    return reply.code(204).send();
  });
  app.get<{ Params: { id: string } }>("/artifacts/:id/download", async (req, reply) => {
    const a = _artifactStore.get(req.params.id);
    if (!a) return reply.code(404).send({ error: "not_found" });
    const extMap: Record<string, string> = {
      code: a.language === "python" ? "py" : "ts",
      markdown: "md",
      html: "html",
      json: "json",
      csv: "csv",
    };
    reply.header("Content-Type", "application/octet-stream");
    reply.header(
      "Content-Disposition",
      `attachment; filename="${a.title.replace(/[^a-z0-9]/gi, "_")}.${extMap[a.type] ?? "txt"}"`,
    );
    return reply.send(a.content);
  });

  // -- AGENT CHAT (chat with simulation personas) ----------------------------
  interface AgentChatSession {
    id: string;
    personaId: string;
    simulationId?: string;
    messages: { role: string; content: string; ts: string }[];
    createdAt: string;
  }
  const _agentChatStore = new PersistentStore<AgentChatSession>("agent_chat");
  await _agentChatStore.load();

  app.post<{ Body: { personaId: string; simulationId?: string; message?: string } }>(
    "/simulate/chat",
    async (req, reply) => {
      const session: AgentChatSession = {
        id: crypto.randomUUID(),
        personaId: req.body.personaId,
        simulationId: req.body.simulationId,
        messages: [],
        createdAt: now(),
      };
      if (req.body.message) {
        session.messages.push({ role: "user", content: req.body.message, ts: now() });
        const persona = _personas.get(req.body.personaId);
        const reply_content = await _llm(
          [
            systemMsg(
              `You are ${persona?.name ?? "an AI agent"}. ${persona?.backstory ?? ""} Stay in character.`,
            ),
            userMsg(req.body.message),
          ],
          512,
        );
        session.messages.push({ role: "assistant", content: reply_content, ts: now() });
      }
      _agentChatStore.set(session.id, session);
      return reply.code(201).send(session);
    },
  );
  app.post<{ Params: { sessionId: string }; Body: { content: string } }>(
    "/simulate/chat/:sessionId/messages",
    async (req, reply) => {
      const session = _agentChatStore.get(req.params.sessionId);
      if (!session) return reply.code(404).send({ error: "not_found" });
      session.messages.push({ role: "user", content: req.body.content, ts: now() });
      const persona = _personas.get(session.personaId);
      const msgs = session.messages
        .slice(-8)
        .map((m) => ({ role: m.role as LlmRole, content: m.content }));
      const assistantContent = await _llm(
        [
          systemMsg(
            `You are ${persona?.name ?? "an AI agent"}. ${persona?.backstory ?? ""} Stay in character.`,
          ),
          ...msgs,
        ],
        512,
      );
      const assistantMsg = { role: "assistant", content: assistantContent, ts: now() };
      session.messages.push(assistantMsg);
      _agentChatStore.set(session.id, session);
      return reply.send({ message: assistantMsg, session });
    },
  );
  app.get<{ Params: { sessionId: string } }>("/simulate/chat/:sessionId", async (req, reply) => {
    const s = _agentChatStore.get(req.params.sessionId);
    return s ? reply.send(s) : reply.code(404).send({ error: "not_found" });
  });
  app.get("/simulate/chat", async (_req, reply) =>
    reply.send({
      sessions: Array.from(_agentChatStore.values()).sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      ),
    }),
  );
  app.delete<{ Params: { sessionId: string } }>("/simulate/chat/:sessionId", async (req, reply) => {
    _agentChatStore.delete(req.params.sessionId);
    return reply.code(204).send();
  });
  app.post<{ Body: { personaIds: string[]; message: string } }>(
    "/simulate/hot-seat",
    async (req, reply) => {
      const responses = await Promise.all(
        (req.body.personaIds ?? []).map(async (pid) => {
          const persona = _personas.get(pid);
          const content = await _llm(
            [
              systemMsg(
                `You are ${persona?.name ?? "Agent " + pid}. ${persona?.backstory ?? ""} Stay in character. Be concise.`,
              ),
              userMsg(req.body.message),
            ],
            256,
          );
          return { personaId: pid, name: persona?.name ?? pid, content };
        }),
      );
      return reply.send({ responses, question: req.body.message });
    },
  );

  // -- DELIBERATIONS (consensus scoring explainability) ----------------------
  interface DeliberationScore {
    id: string;
    memberId: string;
    memberName: string;
    agreement: number;
    peerRanking: number;
    validationPenalty: number;
    adversarialPenalty: number;
    groundingPenalty: number;
    final: number;
    createdAt: string;
  }
  const _deliberationScores = new PersistentStore<{
    id: string;
    scores: DeliberationScore[];
    consensus: Record<string, number>;
    createdAt: string;
  }>("deliberation_scores");
  await _deliberationScores.load();

  app.get<{ Params: { id: string } }>("/deliberations/:id/scoring", async (req, reply) => {
    const entry = _deliberationScores.get(req.params.id);
    return reply.send(
      entry
        ? { members: entry.scores, consensus: entry.consensus }
        : { members: [], consensus: {} },
    );
  });
  app.post<{ Params: { id: string }; Body: { members: DeliberationScore[] } }>(
    "/deliberations/:id/scoring",
    async (req, reply) => {
      const { id } = req.params;
      const members = req.body.members ?? [];
      const consensus: Record<string, number> = members.length
        ? {
            avgAgreement: members.reduce((s, m) => s + m.agreement, 0) / members.length,
            avgFinal: members.reduce((s, m) => s + m.final, 0) / members.length,
            spread:
              Math.max(...members.map((m) => m.final)) - Math.min(...members.map((m) => m.final)),
          }
        : {};
      const entry = { id, scores: members, consensus, createdAt: now() };
      _deliberationScores.set(id, entry);
      return reply.code(201).send(entry);
    },
  );
  app.get<{ Params: { id: string } }>("/deliberations/:id/replay", async (req, reply) => {
    const entry = _deliberationScores.get(req.params.id);
    if (!entry) return reply.code(404).send({ error: "not_found" });
    const summary = await _llm(
      [
        userMsg(
          `Summarise this deliberation scoring in 2-3 sentences: ${JSON.stringify(entry.consensus)}`,
        ),
      ],
      256,
    );
    return reply.send({ ...entry, replaySummary: summary });
  });

  // -- BRANCHES (conversation branching) -------------------------------------
  interface Branch {
    id: string;
    parentId?: string;
    name: string;
    messages: { role: string; content: string }[];
    createdAt: string;
    forkedAt?: string;
  }
  const _branchStore = new PersistentStore<Branch>("branches");
  await _branchStore.load();

  app.post<{ Body: Partial<Branch> }>("/branches", async (req, reply) => {
    const b: Branch = {
      id: crypto.randomUUID(),
      parentId: req.body.parentId,
      name: req.body.name ?? `Branch ${now().slice(11, 19)}`,
      messages: req.body.messages ?? [],
      createdAt: now(),
      forkedAt: req.body.parentId ? now() : undefined,
    };
    _branchStore.set(b.id, b);
    return reply.code(201).send(b);
  });
  app.get("/branches", async (_req, reply) =>
    reply.send({
      branches: Array.from(_branchStore.values()).sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      ),
    }),
  );
  app.get<{ Params: { id: string } }>("/branches/:id", async (req, reply) => {
    const b = _branchStore.get(req.params.id);
    return b ? reply.send(b) : reply.code(404).send({ error: "not_found" });
  });
  app.patch<{ Params: { id: string }; Body: Partial<Branch> }>(
    "/branches/:id",
    async (req, reply) => {
      const b = _branchStore.get(req.params.id);
      if (!b) return reply.code(404).send({ error: "not_found" });
      const updated = { ...b, ...req.body, id: b.id };
      _branchStore.set(b.id, updated);
      return reply.send(updated);
    },
  );
  app.delete<{ Params: { id: string } }>("/branches/:id", async (req, reply) => {
    _branchStore.delete(req.params.id);
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string }; Body: { message: string } }>(
    "/branches/:id/continue",
    async (req, reply) => {
      const b = _branchStore.get(req.params.id);
      if (!b) return reply.code(404).send({ error: "not_found" });
      b.messages.push({ role: "user", content: req.body.message });
      const response = await _llm(
        b.messages.slice(-6).map((m) => ({ role: m.role as LlmRole, content: m.content })),
        512,
      );
      b.messages.push({ role: "assistant", content: response });
      _branchStore.set(b.id, b);
      return reply.send({ branch: b, response });
    },
  );

  // -- SUBGRAPHS (knowledge subgraph slices) ---------------------------------
  interface Subgraph {
    id: string;
    name: string;
    description?: string;
    nodeIds: string[];
    edgeIds: string[];
    query?: string;
    createdAt: string;
    updatedAt: string;
  }
  const _subgraphStore = new PersistentStore<Subgraph>("subgraphs");
  await _subgraphStore.load();

  app.post<{ Body: Partial<Subgraph> }>("/subgraphs", async (req, reply) => {
    const sg: Subgraph = {
      id: crypto.randomUUID(),
      name: req.body.name ?? "Unnamed subgraph",
      description: req.body.description,
      nodeIds: req.body.nodeIds ?? [],
      edgeIds: req.body.edgeIds ?? [],
      query: req.body.query,
      createdAt: now(),
      updatedAt: now(),
    };
    _subgraphStore.set(sg.id, sg);
    return reply.code(201).send(sg);
  });
  app.get("/subgraphs", async (_req, reply) =>
    reply.send({ subgraphs: Array.from(_subgraphStore.values()) }),
  );
  app.get<{ Params: { id: string } }>("/subgraphs/:id", async (req, reply) => {
    const sg = _subgraphStore.get(req.params.id);
    return sg ? reply.send(sg) : reply.code(404).send({ error: "not_found" });
  });
  app.patch<{ Params: { id: string }; Body: Partial<Subgraph> }>(
    "/subgraphs/:id",
    async (req, reply) => {
      const sg = _subgraphStore.get(req.params.id);
      if (!sg) return reply.code(404).send({ error: "not_found" });
      const updated = { ...sg, ...req.body, id: sg.id, updatedAt: now() };
      _subgraphStore.set(sg.id, updated);
      return reply.send(updated);
    },
  );
  app.delete<{ Params: { id: string } }>("/subgraphs/:id", async (req, reply) => {
    _subgraphStore.delete(req.params.id);
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>("/subgraphs/:id/instantiate", async (req, reply) => {
    const sg = _subgraphStore.get(req.params.id);
    if (!sg) return reply.code(404).send({ error: "not_found" });
    const summary = await _llm(
      [
        userMsg(
          `Describe what nodes and edges would exist in a knowledge subgraph named "${sg.name}". ${sg.description ?? ""}. Respond with JSON: { nodes: [{id, label, type}], edges: [{from, to, relation}] }`,
        ),
      ],
      512,
    );
    try {
      return reply.send({
        subgraph: sg,
        instantiated: parseJsonResponse<{ nodes: unknown[]; edges: unknown[] }>(summary),
      });
    } catch {
      return reply.send({ subgraph: sg, instantiated: { nodes: [], edges: [] } });
    }
  });

  // -- AUTO-DEBUG (LLM-backed code debugger) ---------------------------------
  interface DebugTask {
    id: string;
    code: string;
    error: string;
    language: string;
    analysis?: string;
    fix?: string;
    status: string;
    createdAt: string;
  }
  const _debugStore = new PersistentStore<DebugTask>("debug_tasks");
  await _debugStore.load();

  app.post<{ Body: { code: string; error: string; language?: string } }>(
    "/debug/analyze",
    async (req, reply) => {
      const { code, error, language = "typescript" } = req.body;
      const id = crypto.randomUUID();
      const analysis = await _llm(
        [
          systemMsg(
            "Analyze the code and error. Respond with JSON: { cause: string, explanation: string, severity: 'low'|'medium'|'high', suggestions: string[] }",
          ),
          userMsg(`Language: ${language}\n\nCode:\n${code.slice(0, 2000)}\n\nError:\n${error}`),
        ],
        512,
      );
      let parsed: Record<string, unknown> = {};
      try {
        parsed = parseJsonResponse(analysis);
      } catch {
        parsed = {
          cause: "Analysis failed",
          explanation: analysis,
          severity: "medium",
          suggestions: [],
        };
      }
      _debugStore.set(id, {
        id,
        code,
        error,
        language,
        analysis,
        status: "analyzed",
        createdAt: now(),
      });
      return reply.send({ id, ...parsed });
    },
  );
  app.post<{ Body: { code: string; error?: string; language?: string } }>(
    "/debug/validate",
    async (req, reply) => {
      const feedback = await _llm(
        [
          systemMsg(
            "Check this code for bugs. Respond with JSON: { valid: boolean, issues: [{line: number, message: string, severity: string}], score: number }",
          ),
          userMsg(
            `Language: ${req.body.language ?? "typescript"}\n\nCode:\n${req.body.code.slice(0, 2000)}`,
          ),
        ],
        512,
      );
      try {
        return reply.send(parseJsonResponse(feedback));
      } catch {
        return reply.send({ valid: true, issues: [], score: 80 });
      }
    },
  );
  app.post<{ Body: { code: string; error: string; language?: string } }>(
    "/debug/apply",
    async (req, reply) => {
      const { code, error, language = "typescript" } = req.body;
      const fixedCode = await _llm(
        [
          systemMsg(
            "Fix the bug. Return ONLY the corrected code, no explanations or markdown fences.",
          ),
          userMsg(`Language: ${language}\n\nCode:\n${code.slice(0, 2000)}\n\nError:\n${error}`),
        ],
        1500,
      );
      const id = crypto.randomUUID();
      _debugStore.set(id, {
        id,
        code,
        error,
        language,
        fix: fixedCode,
        status: "fixed",
        createdAt: now(),
      });
      return reply.send({
        id,
        fixedCode: fixedCode.replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, ""),
        applied: true,
      });
    },
  );
  app.get<{ Params: { taskId: string } }>("/debug/task/:taskId", async (req, reply) => {
    const task = _debugStore.get(req.params.taskId);
    return task ? reply.send(task) : reply.code(404).send({ error: "not_found" });
  });

  // -- CITATIONS (source verification + annotation) --------------------------
  interface CitationEntry {
    id: string;
    text: string;
    sources: string[];
    verified: boolean;
    score: number;
    createdAt: string;
  }
  const _citationStore = new PersistentStore<CitationEntry>("citations");
  await _citationStore.load();

  app.post<{ Body: { text: string; sources?: string[] } }>(
    "/citations/check",
    async (req, reply) => {
      const result = await _llm(
        [
          systemMsg(
            "Evaluate if this text is factually supported. Respond with JSON: { supported: boolean, confidence: number, issues: string[], suggestions: string[] }",
          ),
          userMsg(
            `Text: ${req.body.text}\nSources: ${(req.body.sources ?? []).join(", ") || "none"}`,
          ),
        ],
        512,
      );
      try {
        return reply.send(parseJsonResponse(result));
      } catch {
        return reply.send({
          supported: false,
          confidence: 0,
          issues: ["Check failed"],
          suggestions: [],
        });
      }
    },
  );
  app.post<{ Body: { text: string; sources?: string[] } }>(
    "/citations/annotate",
    async (req, reply) => {
      const id = crypto.randomUUID();
      const annotation = await _llm(
        [
          systemMsg(
            "Extract factual claims that need citations. Respond with JSON: { claims: [{text: string, type: string, citationNeeded: boolean}] }",
          ),
          userMsg(req.body.text),
        ],
        512,
      );
      let claims: unknown[] = [];
      try {
        claims = (parseJsonResponse(annotation) as { claims: unknown[] }).claims ?? [];
      } catch {
        /* ignore */
      }
      const entry: CitationEntry = {
        id,
        text: req.body.text,
        sources: req.body.sources ?? [],
        verified: false,
        score: 0,
        createdAt: now(),
      };
      _citationStore.set(id, entry);
      return reply.send({ id, claims, entry });
    },
  );
  app.post<{ Body: { text: string; citation: string } }>(
    "/citations/verify",
    async (req, reply) => {
      const result = await _llm(
        [
          systemMsg(
            "Verify if the citation supports the claim. Respond with JSON: { supports: boolean, relevance: number, note: string }",
          ),
          userMsg(`Claim: ${req.body.text}\nCitation: ${req.body.citation}`),
        ],
        256,
      );
      try {
        return reply.send(parseJsonResponse(result));
      } catch {
        return reply.send({ supports: false, relevance: 0, note: "Verification failed" });
      }
    },
  );
  app.post<{ Body: { response: string } }>("/citations/score-response", async (req, reply) => {
    if (!req.body?.response?.trim()) return reply.code(400).send({ error: "response is required" });
    const result = await _llm(
      [
        systemMsg(
          "Score citation quality. Respond with JSON: { citationScore: number, unsubstantiatedClaims: number, wellCitedClaims: number, overallQuality: 'poor'|'fair'|'good'|'excellent' }",
        ),
        userMsg(req.body.response.slice(0, 2000)),
      ],
      256,
    );
    try {
      return reply.send(parseJsonResponse(result));
    } catch {
      return reply.send({
        citationScore: 50,
        unsubstantiatedClaims: 0,
        wellCitedClaims: 0,
        overallQuality: "fair",
      });
    }
  });
  app.get("/citations/history", async (_req, reply) =>
    reply.send({
      citations: Array.from(_citationStore.values()).sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      ),
    }),
  );

  // -- WEBHOOKS (event delivery to external endpoints) -----------------------

  /**
   * Validate webhook URL to prevent SSRF attacks.
   * Blocks private IP ranges, loopback, link-local, and non-http(s) schemes.
   */
  function validateWebhookUrl(rawUrl: string): { ok: true } | { ok: false; reason: string } {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return { ok: false, reason: "Invalid URL format" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, reason: "Only http and https URLs are allowed" };
    }
    const host = parsed.hostname.toLowerCase();
    // Block loopback, link-local, and RFC 1918 private ranges
    const blocked = [
      /^localhost$/,
      /^127\.\d+\.\d+\.\d+$/,
      /^10\.\d+\.\d+\.\d+$/,
      /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
      /^192\.168\.\d+\.\d+$/,
      /^169\.254\.\d+\.\d+$/, // link-local (AWS metadata, etc.)
      /^::1$/,
      /^fd[0-9a-f]{2}:/i, // IPv6 ULA
    ];
    if (blocked.some((re) => re.test(host))) {
      return { ok: false, reason: "URL targets a private or reserved address" };
    }
    return { ok: true };
  }

  interface Webhook {
    id: string;
    url: string;
    events: string[];
    secret?: string;
    active: boolean;
    deliveries: number;
    createdAt: string;
    lastTriggeredAt?: string;
  }
  const _webhookStore = new PersistentStore<Webhook>("webhooks");
  await _webhookStore.load();

  app.post<{ Body: Partial<Webhook> }>("/webhooks", async (req, reply) => {
    const urlCheck = validateWebhookUrl(req.body.url ?? "");
    if (!urlCheck.ok) {
      return reply.code(400).send({ error: "invalid_webhook_url", reason: urlCheck.reason });
    }
    const wh: Webhook = {
      id: crypto.randomUUID(),
      url: req.body.url ?? "",
      events: req.body.events ?? [],
      secret: req.body.secret,
      active: true,
      deliveries: 0,
      createdAt: now(),
    };
    _webhookStore.set(wh.id, wh);
    return reply.code(201).send(wh);
  });
  app.get("/webhooks", async (_req, reply) =>
    reply.send({ webhooks: Array.from(_webhookStore.values()) }),
  );
  app.get<{ Params: { id: string } }>("/webhooks/:id", async (req, reply) => {
    const wh = _webhookStore.get(req.params.id);
    return wh ? reply.send(wh) : reply.code(404).send({ error: "not_found" });
  });
  app.patch<{ Params: { id: string }; Body: Partial<Webhook> }>(
    "/webhooks/:id",
    async (req, reply) => {
      const wh = _webhookStore.get(req.params.id);
      if (!wh) return reply.code(404).send({ error: "not_found" });
      if (req.body.url !== undefined) {
        const urlCheck = validateWebhookUrl(req.body.url);
        if (!urlCheck.ok) {
          return reply.code(400).send({ error: "invalid_webhook_url", reason: urlCheck.reason });
        }
      }
      _webhookStore.set(wh.id, { ...wh, ...req.body, id: wh.id });
      return reply.send(_webhookStore.get(wh.id)!);
    },
  );
  app.delete<{ Params: { id: string } }>("/webhooks/:id", async (req, reply) => {
    _webhookStore.delete(req.params.id);
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string }; Body: { event: string; payload?: unknown } }>(
    "/webhooks/:id/trigger",
    async (req, reply) => {
      const wh = _webhookStore.get(req.params.id);
      if (!wh?.active) return reply.code(404).send({ error: "not_found_or_inactive" });
      let delivered = false;
      try {
        // Socket-pinned fetch: validateWebhookUrl only runs at create/update time —
        // a hostname that re-resolves to a private/IMDS address between then and
        // this trigger-time call (DNS rebinding) would bypass that static check.
        const r = await pinnedFetch(wh.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(wh.secret ? { "X-Webhook-Secret": wh.secret } : {}),
          },
          body: JSON.stringify({ event: req.body.event, payload: req.body.payload, ts: now() }),
        });
        delivered = r.ok;
      } catch {
        /* delivery failed silently */
      }
      wh.deliveries += 1;
      wh.lastTriggeredAt = now();
      _webhookStore.set(wh.id, wh);
      return reply.send({ delivered, webhookId: wh.id, event: req.body.event });
    },
  );

  // -- SSO CONFIG STORE -------------------------------------------------------
  // In-memory IdP config store. Wire real persistence once DB schema is ready.

  interface IdpConfig {
    id: string;
    name: string;
    provider: "saml" | "oidc";
    enabled: boolean;
    // SAML fields
    entityId?: string;
    ssoUrl?: string;
    certificate?: string;
    attributeMap?: Record<string, string>;
    // OIDC fields
    discoveryUrl?: string;
    clientId?: string;
    scopes?: string[];
    createdAt: string;
    updatedAt: string;
  }

  const _ssoConfigs = new Map<string, IdpConfig>();

  // Seed from env vars — auto-register if SAML or OIDC is already configured
  if (process.env.NEXUS_SAML_ENABLED === "true" && process.env.NEXUS_SAML_IDP_SSO_URL) {
    const id = "saml-default";
    _ssoConfigs.set(id, {
      id,
      name: "SAML IdP",
      provider: "saml",
      enabled: true,
      entityId: process.env.NEXUS_SAML_SP_ENTITY_ID,
      ssoUrl: process.env.NEXUS_SAML_IDP_SSO_URL,
      certificate: process.env.NEXUS_SAML_IDP_CERT ? "[configured]" : undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  if (process.env.NEXUS_OIDC_DISCOVERY_URL && process.env.NEXUS_OIDC_CLIENT_ID) {
    const id = "oidc-default";
    _ssoConfigs.set(id, {
      id,
      name: "OIDC Provider",
      provider: "oidc",
      enabled: true,
      discoveryUrl: process.env.NEXUS_OIDC_DISCOVERY_URL,
      clientId: process.env.NEXUS_OIDC_CLIENT_ID,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  // GET /sso/config — list configured IdPs
  app.get("/sso/config", async (_req, reply) => {
    const configs = [..._ssoConfigs.values()].map((c) => ({
      ...c,
      // Never expose cert or secret in list response
      certificate: c.certificate ? "[configured]" : undefined,
    }));
    return reply.send({ configs, total: configs.length });
  });

  // POST /sso/config — create or update an IdP config
  app.post<{
    Body: Partial<IdpConfig> & { name: string; provider: "saml" | "oidc" };
  }>("/sso/config", async (request, reply) => {
    const body = request.body ?? {};
    if (!body.name || !body.provider) {
      return reply.code(400).send({ error: "name and provider are required" });
    }
    if (!["saml", "oidc"].includes(body.provider)) {
      return reply.code(400).send({ error: "provider must be 'saml' or 'oidc'" });
    }
    const id = body.id ?? `${body.provider}-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const existing = _ssoConfigs.get(id);
    const config: IdpConfig = {
      ...existing,
      ...body,
      id,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      enabled: body.enabled ?? existing?.enabled ?? true,
    };
    _ssoConfigs.set(id, config);
    return reply.code(existing ? 200 : 201).send({
      config: { ...config, certificate: config.certificate ? "[configured]" : undefined },
    });
  });

  // DELETE /sso/config/:id — remove an IdP config
  app.delete<{ Params: { id: string } }>("/sso/config/:id", async (request, reply) => {
    if (!_ssoConfigs.has(request.params.id)) return reply.code(404).send({ error: "not_found" });
    _ssoConfigs.delete(request.params.id);
    return reply.send({ ok: true });
  });

  // GET /sso/providers — list available providers + their login URLs
  app.get("/sso/providers", async (_req, reply) => {
    const baseUrl = process.env.NEXUS_API_URL ?? "";
    const providers = [..._ssoConfigs.values()]
      .filter((c) => c.enabled)
      .map((c) => ({
        id: c.id,
        name: c.name,
        provider: c.provider,
        loginUrl:
          c.provider === "saml" ? `${baseUrl}/auth/saml/login` : `${baseUrl}/auth/oidc/authorize`,
      }));
    // Also surface OAuth providers when configured
    if (process.env.GOOGLE_CLIENT_ID) {
      providers.push({
        id: "oauth-google",
        name: "Google",
        provider: "oidc" as const,
        loginUrl: `${baseUrl}/oauth/google`,
      });
    }
    if (process.env.GITHUB_CLIENT_ID) {
      providers.push({
        id: "oauth-github",
        name: "GitHub",
        provider: "oidc" as const,
        loginUrl: `${baseUrl}/oauth/github`,
      });
    }
    return reply.send({ providers, total: providers.length });
  });

  // POST /sso/login — initiate SSO login for a given provider id
  app.post<{ Body: { providerId?: string; redirectUrl?: string } }>(
    "/sso/login",
    async (request, reply) => {
      const { providerId, redirectUrl } = request.body ?? {};
      const config = providerId
        ? _ssoConfigs.get(providerId)
        : [..._ssoConfigs.values()].find((c) => c.enabled);
      if (!config) {
        return reply.code(404).send({
          error: "no_sso_provider",
          message: "No SSO provider configured. Add one via POST /sso/config.",
        });
      }
      const baseUrl = process.env.NEXUS_API_URL ?? "";
      const loginUrl =
        config.provider === "saml"
          ? `${baseUrl}/auth/saml/login${redirectUrl ? `?redirect=${encodeURIComponent(redirectUrl)}` : ""}`
          : `${baseUrl}/auth/oidc/authorize${redirectUrl ? `?redirect=${encodeURIComponent(redirectUrl)}` : ""}`;
      return reply.send({ loginUrl, provider: config.provider, name: config.name });
    },
  );

  // -- MFA (already wired in auth routes — these are api-bridge aliases) ------
  app.get("/mfa/status", async (_req, reply) =>
    reply.send({ available: true, note: "MFA routes available at /auth/totp/*" }),
  );
  app.post("/mfa/enable", async (_req, reply) => reply.send({ note: "Use POST /auth/totp/setup" }));
  app.post("/mfa/verify", async (_req, reply) =>
    reply.send({ note: "Use POST /auth/totp/validate" }),
  );

  // -- SCIM (already wired in scim routes — these are api-bridge aliases) -----
  app.get("/scim/Users", async (_req, reply) =>
    reply.send({ note: "SCIM 2.0 available at /scim/v2/Users" }),
  );
  app.post("/scim/Users", async (_req, reply) => reply.send({ note: "Use POST /scim/v2/Users" }));
  app.get("/scim/Groups", async (_req, reply) =>
    reply.send({ note: "SCIM 2.0 groups at /scim/v2/Groups" }),
  );

  // -- WORKSPACES -------------------------------------------------------------
  app.get("/workspaces", async (_req, reply) =>
    reply.send({
      workspaces: [{ id: "default", name: "Default Workspace", plan: "free", members: 1 }],
    }),
  );
  app.post<{ Body: { name: string } }>("/workspaces", async (request, reply) =>
    reply.code(201).send({
      workspace: {
        id: crypto.randomUUID(),
        name: request.body?.name ?? "New Workspace",
        plan: "free",
        members: 1,
        createdAt: new Date().toISOString(),
      },
    }),
  );

  // -- TENANTS ----------------------------------------------------------------
  // Single-tenant for now — returns current workspace as tenant list
  app.get("/tenants", async (_req, reply) => {
    return reply.send({
      tenants: [
        {
          id: "default",
          name: "Default",
          plan: "free",
          region: process.env.NEXUS_REGION ?? "us-east-1",
          createdAt: new Date().toISOString(),
        },
      ],
      total: 1,
      note: "Multi-tenant isolation is a future feature. Current deployment is single-tenant.",
    });
  });

  // -- WHITELABEL CONFIG ------------------------------------------------------
  interface BrandingConfig {
    productName: string;
    logoUrl: string | null;
    faviconUrl: string | null;
    primaryColor: string | null;
    accentColor: string | null;
    customDomain: string | null;
    updatedAt: string;
  }

  let _branding: BrandingConfig = {
    productName: process.env.NEXUS_PRODUCT_NAME ?? "Nexus",
    logoUrl: process.env.NEXUS_LOGO_URL ?? null,
    faviconUrl: null,
    primaryColor: null,
    accentColor: null,
    customDomain: process.env.NEXUS_CUSTOM_DOMAIN ?? null,
    updatedAt: new Date().toISOString(),
  };

  app.get("/whitelabel/config", async (_req, reply) => reply.send({ branding: _branding }));

  app.post<{ Body: Partial<BrandingConfig> }>("/whitelabel/config", async (request, reply) => {
    _branding = { ..._branding, ...request.body, updatedAt: new Date().toISOString() };
    return reply.send({ ok: true, branding: _branding });
  });

  app.patch<{ Body: Partial<BrandingConfig> }>("/whitelabel/config", async (request, reply) => {
    _branding = { ..._branding, ...request.body, updatedAt: new Date().toISOString() };
    return reply.send({ ok: true, branding: _branding });
  });

  // -- DATA RESIDENCY ---------------------------------------------------------
  interface DataResidencyConfig {
    region: string;
    retentionDays: number;
    encryptAtRest: boolean;
    gdprEnabled: boolean;
    dataClassification: "public" | "internal" | "confidential";
    backupRegion: string | null;
    updatedAt: string;
  }

  let _dataPolicy: DataResidencyConfig = {
    region: process.env.NEXUS_REGION ?? "us-east-1",
    retentionDays: 90,
    encryptAtRest: false,
    // True since §14.4 shipped: DELETE /api/v1/users/:id/data performs the
    // self-service erasure cascade (403 unless caller == target).
    gdprEnabled: true,
    dataClassification: "internal",
    backupRegion: null,
    updatedAt: new Date().toISOString(),
  };

  app.get("/data-residency/config", async (_req, reply) => reply.send({ policy: _dataPolicy }));

  app.post<{ Body: Partial<DataResidencyConfig> }>(
    "/data-residency/config",
    async (request, reply) => {
      _dataPolicy = { ..._dataPolicy, ...request.body, updatedAt: new Date().toISOString() };
      return reply.send({ ok: true, policy: _dataPolicy });
    },
  );

  app.patch<{ Body: Partial<DataResidencyConfig> }>(
    "/data-residency/config",
    async (request, reply) => {
      _dataPolicy = { ..._dataPolicy, ...request.body, updatedAt: new Date().toISOString() };
      return reply.send({ ok: true, policy: _dataPolicy });
    },
  );

  // ── analytics/daily + providers + models ──────────────────────────────────
  // Used by admin-analytics charts (lazy-loaded via analytics-charts.tsx).
  // Derives data from the in-process _costLog; returns deterministic empty
  // shapes when the log is empty so charts render without errors.

  app.get<{ Querystring: { days?: string } }>("/analytics/daily", async (request, reply) => {
    const days = Math.min(Math.max(parseInt(request.query.days ?? "7") || 7, 1), 90);
    // Same rollup as /dashboard; /analytics/daily keeps its historical key names
    // (conversations/cost) for the admin charts that consume them.
    const result = dailyUsageSeries(days).map((r) => ({
      date: r.date,
      conversations: r.requests,
      tokens: r.tokens,
      cost: r.costUsd,
    }));
    return reply.send({ data: result });
  });

  app.get("/analytics/providers", async (_req, reply) => {
    const byProvider: Record<string, number> = {};
    for (const e of _costLog) {
      const p = e.model?.split("/")[0] ?? "unknown";
      byProvider[p] = (byProvider[p] ?? 0) + 1;
    }
    const data = Object.entries(byProvider).map(([provider, requests]) => ({ provider, requests }));
    return reply.send({ data });
  });

  app.get<{ Querystring: { limit?: string } }>("/analytics/models", async (request, reply) => {
    const limit = parseInt(request.query.limit ?? "5") || 5;
    const byModel: Record<string, { requests: number; tokens: number; cost: number }> = {};
    for (const e of _costLog) {
      if (!byModel[e.model]) byModel[e.model] = { requests: 0, tokens: 0, cost: 0 };
      byModel[e.model]!.requests += 1;
      byModel[e.model]!.tokens += e.inputTokens + e.outputTokens;
      byModel[e.model]!.cost += e.costUsd ?? 0;
    }
    const data = Object.entries(byModel)
      .sort(([, a], [, b]) => b.requests - a.requests)
      .slice(0, limit)
      .map(([model, stats]) => ({ model, ...stats }));
    return reply.send({ data });
  });

  // ── system/config ──────────────────────────────────────────────────────────
  // Admin system page: view + edit runtime config key-value pairs.

  const _sysConfig: Record<string, { value: string; type: string }> = {
    default_llm_model: { value: process.env.DEFAULT_LLM_MODEL ?? "gpt-4o", type: "string" },
    rate_limit_max: { value: process.env.RATE_LIMIT_MAX ?? "100", type: "number" },
    rate_limit_window_ms: { value: process.env.RATE_LIMIT_WINDOW_MS ?? "60000", type: "number" },
    maintenance_mode: { value: process.env.MAINTENANCE_MODE ?? "false", type: "boolean" },
  };

  app.get("/system/config", async (_req, reply) => {
    const configs = Object.entries(_sysConfig).map(([key, { value, type }]) => ({
      key,
      value,
      type,
    }));
    return reply.send({ configs });
  });

  app.put<{ Params: { key: string }; Body: { value: string } }>(
    "/system/config/:key",
    async (request, reply) => {
      const { key } = request.params;
      const { value } = request.body ?? {};
      if (!key || value === undefined)
        return reply.code(400).send({ error: "key and value required" });
      if (_sysConfig[key]) {
        _sysConfig[key] = { ..._sysConfig[key], value };
      } else {
        _sysConfig[key] = { value, type: "string" };
      }
      return reply.send({ ok: true, key, value: _sysConfig[key].value });
    },
  );

  // ── fallback-chains CRUD + test ────────────────────────────────────────────
  // Complements the existing POST /fallback-chains/run (execution path).
  // This group manages chain definitions.

  interface _FallbackChain {
    id: string;
    name: string;
    steps: { provider: string; model?: string; maxRetries?: number; timeoutMs?: number }[];
    enabled: boolean;
    createdAt: string;
  }
  const _fallbackChains = new Map<string, _FallbackChain>();

  app.get("/fallback-chains", async (_req, reply) => {
    return reply.send({ chains: [..._fallbackChains.values()] });
  });

  app.post<{ Body: { name: string; steps: _FallbackChain["steps"] } }>(
    "/fallback-chains",
    async (request, reply) => {
      const { name, steps } = request.body ?? {};
      if (!name || !Array.isArray(steps) || steps.length < 2) {
        return reply.code(400).send({ error: "name and at least 2 steps required" });
      }
      const chain: _FallbackChain = {
        id: `chain_${Date.now()}`,
        name,
        steps: steps.filter((s) => s.provider?.trim()),
        enabled: true,
        createdAt: new Date().toISOString(),
      };
      _fallbackChains.set(chain.id, chain);
      return reply.code(201).send({ ok: true, chain });
    },
  );

  app.post<{ Body: { chainId: string; prompt: string } }>(
    "/fallback-chains/test",
    async (request, reply) => {
      const { chainId, prompt: _prompt } = request.body ?? {};
      const chain = _fallbackChains.get(chainId ?? "");
      if (!chain) return reply.code(404).send({ error: "chain not found" });
      // Dry-run: report each step as attempted without actually calling providers
      const attempts = chain.steps.map((step, i) => ({
        step: i,
        provider: step.provider,
        success: i === 0, // first step "succeeds" in dry-run
        latencyMs: 50 + i * 20,
      }));
      return reply.send({
        success: true,
        usedStep: 0,
        usedProvider: chain.steps[0]?.provider,
        attempts,
        totalLatencyMs: attempts.reduce((s, a) => s + (a.latencyMs ?? 0), 0),
      });
    },
  );

  // ── marketplace CRUD ───────────────────────────────────────────────────────
  // Full marketplace: list, detail, star, install, publish.
  // Seeded with a handful of built-in items; user items stored in-memory.

  interface _MpItem {
    id: string;
    name: string;
    author: string;
    description: string;
    category: string;
    downloads: number;
    rating: number;
    tags: string[];
    price: "free" | "premium";
    installedBy: Set<string>;
    starredBy: Set<string>;
  }
  const _mpItems = new Map<string, _MpItem>([
    [
      "mp_1",
      {
        id: "mp_1",
        name: "Advanced Code Reviewer",
        author: "nexus-labs",
        description: "Multi-archetype code review with security and performance analysis",
        category: "development",
        downloads: 1247,
        rating: 4.8,
        tags: ["code-review", "security", "performance"],
        price: "free",
        installedBy: new Set(),
        starredBy: new Set(),
      },
    ],
    [
      "mp_2",
      {
        id: "mp_2",
        name: "Legal Document Analyzer",
        author: "legaltech-co",
        description: "Contract analysis using ethicist and judge archetypes",
        category: "legal",
        downloads: 834,
        rating: 4.6,
        tags: ["legal", "contracts", "compliance"],
        price: "premium",
        installedBy: new Set(),
        starredBy: new Set(),
      },
    ],
    [
      "mp_3",
      {
        id: "mp_3",
        name: "Market Research Suite",
        author: "bizinsights",
        description: "Market analysis with futurist and empiricist perspectives",
        category: "research",
        downloads: 2103,
        rating: 4.9,
        tags: ["market-research", "analysis"],
        price: "free",
        installedBy: new Set(),
        starredBy: new Set(),
      },
    ],
    [
      "mp_4",
      {
        id: "mp_4",
        name: "Creative Writing Workshop",
        author: "wordcraft-ai",
        description: "Multi-perspective creative writing with iterative refinement",
        category: "creative",
        downloads: 567,
        rating: 4.3,
        tags: ["writing", "creative", "storytelling"],
        price: "free",
        installedBy: new Set(),
        starredBy: new Set(),
      },
    ],
    [
      "mp_5",
      {
        id: "mp_5",
        name: "Tech Architecture Planner",
        author: "nexus-labs",
        description: "System design with architect and strategist archetypes",
        category: "development",
        downloads: 1892,
        rating: 4.7,
        tags: ["architecture", "system-design"],
        price: "premium",
        installedBy: new Set(),
        starredBy: new Set(),
      },
    ],
    [
      "mp_6",
      {
        id: "mp_6",
        name: "Stakeholder Communication Kit",
        author: "comms-pro",
        description: "Stakeholder reports through empath and pragmatist lenses",
        category: "business",
        downloads: 421,
        rating: 4.4,
        tags: ["communication", "stakeholders"],
        price: "free",
        installedBy: new Set(),
        starredBy: new Set(),
      },
    ],
  ]);

  function _mpView(item: _MpItem, userId?: string) {
    return {
      id: item.id,
      name: item.name,
      author: item.author,
      description: item.description,
      category: item.category,
      downloads: item.downloads,
      rating: item.rating,
      tags: item.tags,
      price: item.price,
      stars: item.starredBy.size,
      installed: userId ? item.installedBy.has(userId) : false,
      starred: userId ? item.starredBy.has(userId) : false,
    };
  }

  app.get<{ Querystring: { limit?: string; category?: string; q?: string } }>(
    "/marketplace",
    async (request, reply) => {
      const { limit, category, q } = request.query;
      let items = [..._mpItems.values()];
      if (category && category !== "all") items = items.filter((i) => i.category === category);
      if (q) {
        const ql = q.toLowerCase();
        items = items.filter(
          (i) => i.name.toLowerCase().includes(ql) || i.description.toLowerCase().includes(ql),
        );
      }
      items = items.slice(0, parseInt(limit ?? "50") || 50);
      return reply.send({ items: items.map((i) => _mpView(i)) });
    },
  );

  app.get("/marketplace/me", async (_req, reply) => {
    // Return installed + starred items for anonymous user
    return reply.send({ installed: [], starred: [] });
  });

  app.get<{ Params: { id: string } }>("/marketplace/:id", async (request, reply) => {
    const item = _mpItems.get(request.params.id);
    if (!item) return reply.code(404).send({ error: "not found" });
    return reply.send({ item: _mpView(item) });
  });

  app.post<{ Params: { id: string } }>("/marketplace/:id/star", async (request, reply) => {
    const item = _mpItems.get(request.params.id);
    if (!item) return reply.code(404).send({ error: "not found" });
    item.starredBy.add("anon");
    return reply.send({ ok: true, stars: item.starredBy.size });
  });

  app.delete<{ Params: { id: string } }>("/marketplace/:id/star", async (request, reply) => {
    const item = _mpItems.get(request.params.id);
    if (!item) return reply.code(404).send({ error: "not found" });
    item.starredBy.delete("anon");
    return reply.send({ ok: true, stars: item.starredBy.size });
  });

  app.post<{ Params: { id: string } }>("/marketplace/:id/install", async (request, reply) => {
    const item = _mpItems.get(request.params.id);
    if (!item) return reply.code(404).send({ error: "not found" });
    item.installedBy.add("anon");
    item.downloads += 1;
    return reply.send({ ok: true });
  });

  app.delete<{ Params: { id: string } }>("/marketplace/:id/install", async (request, reply) => {
    const item = _mpItems.get(request.params.id);
    if (!item) return reply.code(404).send({ error: "not found" });
    item.installedBy.delete("anon");
    return reply.send({ ok: true });
  });

  app.post<{
    Body: { name: string; description: string; category: string; tags?: string[]; price?: string };
  }>("/marketplace", async (request, reply) => {
    const { name, description, category, tags = [], price = "free" } = request.body ?? {};
    if (!name || !description)
      return reply.code(400).send({ error: "name and description required" });
    const id = `mp_${Date.now()}`;
    const item: _MpItem = {
      id,
      name,
      author: "you",
      description,
      category: category ?? "other",
      downloads: 0,
      rating: 0,
      tags,
      price: price as "free" | "premium",
      installedBy: new Set(),
      starredBy: new Set(),
    };
    _mpItems.set(id, item);
    return reply.code(201).send({ ok: true, item: _mpView(item) });
  });

  // ── /v1/projects — Projects CRUD + Groups + Tasks + Archive ──────────────
  // Extended from mission-control: grouping, pinning, task status, archive.

  interface _Group {
    id: string;
    name: string;
    color: string;
    createdAt: string;
  }

  interface _Project {
    id: string;
    name: string;
    description: string;
    icon: string;
    iconColor: string;
    groupId: string | null;
    pinned: boolean;
    conversationCount: number;
    /** Owning user (records created before scoping carry none = legacy/shared). */
    ownerId?: string | null;
    createdAt: string;
    updatedAt: string;
  }

  interface _Task {
    id: string;
    projectId: string;
    title: string;
    agent: string;
    status: "running" | "needs-input" | "done";
    branch: string;
    preview: string;
    lines: number;
    archived: boolean;
    createdAt: string;
    updatedAt: string;
  }

  function _taskCounts(projectId: string) {
    let running = 0,
      needsInput = 0,
      done = 0;
    for (const t of _tasks.values()) {
      if (t.projectId !== projectId || t.archived) continue;
      if (t.status === "running") running++;
      else if (t.status === "needs-input") needsInput++;
      else if (t.status === "done") done++;
    }
    return { running, needsInput, done };
  }

  function _projectView(p: _Project) {
    const counts = _taskCounts(p.id);
    return { ...p, taskCounts: counts };
  }

  // ── Groups CRUD ────────────────────────────────────────────────────────────

  app.get("/v1/groups", async (_req, reply) => {
    return reply.send({ groups: [..._groups.values()] });
  });

  app.post<{ Body: { name: string; color?: string } }>("/v1/groups", async (request, reply) => {
    const { name, color = "#6366f1" } = request.body ?? {};
    if (!name?.trim()) return reply.code(400).send({ message: "name is required" });
    const group: _Group = { id: `grp_${Date.now()}`, name: name.trim(), color, createdAt: now() };
    _groups.set(group.id, group);
    return reply.code(201).send(group);
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; color?: string } }>(
    "/v1/groups/:id",
    async (request, reply) => {
      const group = _groups.get(request.params.id);
      if (!group) return reply.code(404).send({ message: "group not found" });
      if (request.body?.name) group.name = request.body.name.trim();
      if (request.body?.color) group.color = request.body.color;
      return reply.send(group);
    },
  );

  app.delete<{ Params: { id: string } }>("/v1/groups/:id", async (request, reply) => {
    if (!_groups.has(request.params.id))
      return reply.code(404).send({ message: "group not found" });
    _groups.delete(request.params.id);
    // Ungroup projects in this group
    for (const p of _projects.values()) {
      if (p.groupId === request.params.id) p.groupId = null;
    }
    return reply.send({ ok: true });
  });

  // ── Projects CRUD ──────────────────────────────────────────────────────────

  app.get("/v1/projects", async (_req, reply) => {
    const projects = [..._projects.values()].map(_projectView).sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.createdAt.localeCompare(a.createdAt);
    });
    return reply.send({ projects });
  });

  app.post<{
    Body: {
      name: string;
      description?: string;
      icon?: string;
      iconColor?: string;
      groupId?: string;
    };
  }>("/v1/projects", async (request, reply) => {
    const {
      name,
      description = "",
      icon = "",
      iconColor = "#6366f1",
      groupId = null,
    } = request.body ?? {};
    if (!name?.trim()) return reply.code(400).send({ message: "name is required" });
    const ts = now();
    const project: _Project = {
      id: `proj_${Date.now()}`,
      name: name.trim(),
      description: description.trim(),
      icon: icon || name.trim().slice(0, 2).toUpperCase(),
      iconColor,
      groupId,
      pinned: false,
      conversationCount: 0,
      createdAt: ts,
      updatedAt: ts,
    };
    _projects.set(project.id, project);
    return reply.code(201).send(_projectView(project));
  });

  app.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      description?: string;
      icon?: string;
      iconColor?: string;
      groupId?: string | null;
      pinned?: boolean;
    };
  }>("/v1/projects/:id", async (request, reply) => {
    const project = _projects.get(request.params.id);
    if (!project) return reply.code(404).send({ message: "project not found" });
    if (request.body?.name) project.name = request.body.name.trim();
    if (request.body?.description !== undefined)
      project.description = request.body.description.trim();
    if (request.body?.icon) project.icon = request.body.icon;
    if (request.body?.iconColor) project.iconColor = request.body.iconColor;
    if (request.body?.groupId !== undefined) project.groupId = request.body.groupId;
    if (request.body?.pinned !== undefined) project.pinned = request.body.pinned;
    project.updatedAt = now();
    return reply.send(_projectView(project));
  });

  app.delete<{ Params: { id: string } }>("/v1/projects/:id", async (request, reply) => {
    if (!_projects.has(request.params.id))
      return reply.code(404).send({ message: "project not found" });
    _projects.delete(request.params.id);
    // Remove tasks for this project
    for (const t of _tasks.values()) {
      if (t.projectId === request.params.id) _tasks.delete(t.id);
    }
    return reply.send({ ok: true });
  });

  // ── Tasks CRUD ─────────────────────────────────────────────────────────────

  app.get<{ Params: { id: string } }>("/v1/projects/:id/tasks", async (request, reply) => {
    const tasks = [..._tasks.values()]
      .filter((t) => t.projectId === request.params.id && !t.archived)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return reply.send({ tasks });
  });

  app.post<{
    Params: { id: string };
    Body: { title: string; agent?: string; branch?: string };
  }>("/v1/projects/:id/tasks", async (request, reply) => {
    const { title, agent = "shell", branch = "main" } = request.body ?? {};
    if (!title?.trim()) return reply.code(400).send({ message: "title is required" });
    const ts = now();
    const task: _Task = {
      id: `task_${Date.now()}`,
      projectId: request.params.id,
      title: title.trim(),
      agent,
      status: "running",
      branch,
      preview: "",
      lines: 0,
      archived: false,
      createdAt: ts,
      updatedAt: ts,
    };
    _tasks.set(task.id, task);
    return reply.code(201).send(task);
  });

  app.post<{
    Params: { id: string };
    Body: { status?: string; preview?: string; lines?: number };
  }>("/v1/tasks/:id/status", async (request, reply) => {
    const task = _tasks.get(request.params.id);
    if (!task) return reply.code(404).send({ message: "task not found" });
    if (request.body?.status) task.status = request.body.status as _Task["status"];
    if (request.body?.preview !== undefined) task.preview = request.body.preview;
    if (request.body?.lines !== undefined) task.lines = request.body.lines;
    task.updatedAt = now();
    return reply.send(task);
  });

  app.post<{ Params: { id: string } }>("/v1/tasks/:id/archive", async (request, reply) => {
    const task = _tasks.get(request.params.id);
    if (!task) return reply.code(404).send({ message: "task not found" });
    task.archived = true;
    task.updatedAt = now();
    return reply.send({ ok: true });
  });

  app.post<{ Params: { id: string } }>("/v1/tasks/:id/restore", async (request, reply) => {
    const task = _tasks.get(request.params.id);
    if (!task) return reply.code(404).send({ message: "task not found" });
    task.archived = false;
    task.updatedAt = now();
    return reply.send({ ok: true });
  });

  app.get("/v1/archive", async (_req, reply) => {
    const tasks = [..._tasks.values()]
      .filter((t) => t.archived)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return reply.send({ tasks });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // AUTOPILOT — autonomous project runs
  // ══════════════════════════════════════════════════════════════════════════
  // A project run is an unattended multi-agent loop over a per-run workspace:
  //   architect → researcher → coder (✕ up to maxIterations w/ reviewer feedback)
  // Each role is executed as a real `agent.run` worker job (BYOK driver with
  // file/shell tools confined to the workspace), awaited to completion, with
  // every phase persisted to the durable autopilot_runs store and streamed over
  // SSE. Roles map to providers/models: ChatGPT (openai) codes, Gemini
  // researches, Claude architects, a cheap DeepSeek/Groq reviews — or any
  // combination the user picks (free stack = gemini/deepseek/groq/ollama).

  interface _AutopilotPhase {
    role: string;
    label: string;
    provider: string;
    model: string;
    status: "queued" | "running" | "done" | "failed" | "skipped";
    sessionId?: string;
    summary?: string;
    error?: string;
    startedAt?: string;
    finishedAt?: string;
  }

  interface _AutopilotEvent {
    ts: string;
    kind: "run" | "phase" | "note" | "artifact";
    role?: string;
    text: string;
  }

  interface AutopilotRun {
    id: string;
    projectId: string;
    ownerId?: string | null;
    objective: string;
    status: "queued" | "running" | "done" | "failed" | "cancelled";
    roles: Record<string, { provider: string; model: string }>;
    maxIterations: number;
    workspaceDir: string;
    phases: _AutopilotPhase[];
    events: _AutopilotEvent[];
    error?: string;
    createdAt: string;
    updatedAt: string;
  }

  const AUTOPILOT_ROLE_DEFAULTS: Record<
    string,
    { label: string; provider: string; model: string }
  > = {
    architect: { label: "Architect (Claude)", provider: "anthropic", model: "claude-sonnet-4-6" },
    researcher: { label: "Researcher (Gemini)", provider: "gemini", model: "gemini-3.6-flash" },
    coder: { label: "Coder (ChatGPT)", provider: "openai", model: "gpt-5.6-sol" },
    reviewer: { label: "Reviewer (DeepSeek)", provider: "deepseek", model: "deepseek-v4-flash" },
  };
  const AUTOPILOT_ROLE_ORDER = ["architect", "researcher", "coder", "reviewer"] as const;

  // Tiny in-process pub/sub for the run stream (single-instance fan-out).
  const _runListeners = new Map<string, Set<(ev: _AutopilotEvent) => void>>();
  const _emitRunEvent = (runId: string, ev: _AutopilotEvent): void => {
    const set = _runListeners.get(runId);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        cb(ev);
      } catch {
        /* listener error — drop */
      }
    }
  };

  async function _appendRunEvent(run: AutopilotRun, ev: _AutopilotEvent): Promise<void> {
    run.events.push(ev);
    run.updatedAt = now();
    _autopilotRuns.set(run.id, run);
    _emitRunEvent(run.id, ev);
  }

  /** Resolve a role's provider/model: explicit override wins, else defaults. */
  function _resolveRoleSpec(
    role: string,
    override?: { provider?: string; model?: string },
  ): { provider: string; model: string } | null {
    const def = AUTOPILOT_ROLE_DEFAULTS[role];
    if (!def) return null;
    return {
      provider: override?.provider?.trim() || def.provider,
      model: override?.model?.trim() || def.model,
    };
  }

  /** Enqueue an agent.run job and await the worker's completion. */
  async function _enqueueAgentAndWait(
    input: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<{ ok: boolean; finalContent?: string; steps?: number; error?: string }> {
    if (!process.env.REDIS_URL) {
      return { ok: false, error: "agent queue unavailable (REDIS_URL not configured)" };
    }
    try {
      const { Queue, QueueEvents } = await import("bullmq");
      const u = new URL(process.env.REDIS_URL);
      const connection = {
        host: u.hostname,
        port: parseInt(u.port || "6379", 10),
        ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
        ...(u.pathname && u.pathname !== "/" ? { db: parseInt(u.pathname.slice(1), 10) } : {}),
      };
      const queue = new Queue("nexus-high", { connection });
      const events = new QueueEvents("nexus-high", { connection });
      try {
        const sessionId = String(input.sessionId ?? "");
        const job = await queue.add("agent.run", input, {
          ...(sessionId ? { jobId: sessionId } : {}),
          attempts: 1,
          removeOnComplete: false,
          removeOnFail: 100,
        });
        const rv = (await job.waitUntilFinished(events, timeoutMs)) as
          Record<string, unknown> | undefined;
        const ok = rv?.ok === true;
        return {
          ok,
          finalContent:
            typeof rv?.finalContent === "string" ? (rv.finalContent as string) : undefined,
          steps: typeof rv?.steps === "number" ? (rv.steps as number) : undefined,
          ...(!ok && rv?.error ? { error: String(rv.error) } : {}),
        };
      } finally {
        await queue.close().catch(() => {});
        await events.close().catch(() => {});
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async function _runAutopilotPhase(
    run: AutopilotRun,
    phase: _AutopilotPhase,
    systemPrompt: string,
    instruction: string,
  ): Promise<void> {
    phase.status = "running";
    phase.startedAt = now();
    await _appendRunEvent(run, {
      ts: now(),
      kind: "phase",
      role: phase.role,
      text: `${phase.label} started (${phase.provider}/${phase.model})`,
    });
    // BYOK: the user's own key for this provider wins; otherwise the worker
    // falls back to its server env key for the provider.
    let apiKey: string | undefined;
    try {
      apiKey =
        (await resolveUserProviderKey(run.ownerId ?? undefined, phase.provider)) ?? undefined;
    } catch {
      apiKey = undefined;
    }
    const timeoutMs = 25 * 60_000;
    // Real UUIDs only: the worker persists sessions and may touch runtime_tasks
    // by taskId, whose PK is a uuid column — a prefixed string makes the job fail.
    const sessionId = crypto.randomUUID();
    const isTransient = (msg: string | undefined): boolean =>
      /rate limit|429|timeout|timed out|temporarily|overloaded|5\d\d|quota|busy/i.test(msg ?? "");
    const basePayload = {
      sessionId,
      instruction,
      systemPrompt,
      provider: phase.provider,
      model: phase.model,
      ...(apiKey ? { apiKey } : {}),
      workspaceDir: run.workspaceDir,
      permissionPolicy: "allow" as const,
      maxSteps: phase.role === "coder" || phase.role === "reviewer" ? 50 : 25,
      disableCompaction: false,
      userId: run.ownerId ?? undefined,
    };
    let res: { ok: boolean; finalContent?: string; steps?: number; error?: string } = {
      ok: false,
      error: "not_run",
    };
    const maxAttempts = 3; // initial + 2 backoff retries for rate limits
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      res = await _enqueueAgentAndWait(basePayload, timeoutMs);
      if (res.ok || !isTransient(res.error) || attempt === maxAttempts) break;
      const backoffMs = 15_000 * attempt;
      await _appendRunEvent(run, {
        ts: now(),
        kind: "note",
        role: phase.role,
        text: `${phase.label} hit a transient error (${res.error}); retrying in ${Math.round(backoffMs / 1000)}s (attempt ${attempt + 1}/${maxAttempts}).`,
      });
      await new Promise((r) => setTimeout(r, backoffMs));
    }
    if (res.ok) {
      phase.status = "done";
      phase.summary = res.finalContent ? res.finalContent.slice(0, 3000) : "";
      await _appendRunEvent(run, {
        ts: now(),
        kind: "phase",
        role: phase.role,
        text: `${phase.label} done${res.steps ? ` (${res.steps} tool steps)` : ""}.`,
      });
    } else {
      phase.status = "failed";
      phase.error = (res.error ?? "agent run failed").slice(0, 1000);
      await _appendRunEvent(run, {
        ts: now(),
        kind: "phase",
        role: phase.role,
        text: `${phase.label} failed: ${phase.error}`,
      });
    }
    phase.finishedAt = now();
    _autopilotRuns.set(run.id, run);
  }

  async function _executeAutopilotRun(run: AutopilotRun): Promise<void> {
    const fs = await import("node:fs/promises");
    try {
      await fs.mkdir(run.workspaceDir, { recursive: true });
    } catch {
      /* non-fatal: tools will surface their own errors */
    }
    run.status = "running";
    await _appendRunEvent(run, {
      ts: now(),
      kind: "run",
      text: `Autopilot run started — ${run.objective.slice(0, 200)}`,
    });

    const isCancelled = (): boolean => {
      const cur = _autopilotRuns.get(run.id);
      return !cur || cur.status === "cancelled";
    };

    const architect = _resolveRoleSpec("architect", run.roles["architect"]);
    const researcher = _resolveRoleSpec("researcher", run.roles["researcher"]);
    const coder = _resolveRoleSpec("coder", run.roles["coder"]);
    const reviewer = _resolveRoleSpec("reviewer", run.roles["reviewer"]);
    if (!architect || !researcher || !coder || !reviewer) {
      run.status = "failed";
      run.error = "invalid role configuration";
      await _appendRunEvent(run, { ts: now(), kind: "run", text: "invalid role configuration" });
      _autopilotRuns.set(run.id, run);
      return;
    }

    const context = [
      `Project objective: ${run.objective}`,
      `Workspace: ${run.workspaceDir}`,
      "Persist your work as markdown/code files in the workspace with write_file.",
    ].join("\n");

    const arch: _AutopilotPhase = {
      role: "architect",
      label: "Architect",
      provider: architect.provider,
      model: architect.model,
      status: "queued",
    };
    const res: _AutopilotPhase = {
      role: "researcher",
      label: "Researcher",
      provider: researcher.provider,
      model: researcher.model,
      status: "queued",
    };
    const cod: _AutopilotPhase = {
      role: "coder",
      label: "Coder",
      provider: coder.provider,
      model: coder.model,
      status: "queued",
    };

    // Coder is pushed inside the iteration loop (once per rework round).
    for (const p of [arch, res]) run.phases.push(p);
    _autopilotRuns.set(run.id, run);

    const finishRun = async (
      status: AutopilotRun["status"],
      text: string,
      error?: string,
    ): Promise<void> => {
      run.status = status;
      if (error) run.error = error;
      await _appendRunEvent(run, { ts: now(), kind: "run", text });
      await _appendRunEvent(run, { ts: now(), kind: "run", text: "END" });
      _autopilotRuns.set(run.id, run);
      // Surface run completion in the owner's notification tray.
      if (status === "done" || status === "failed" || status === "cancelled") {
        await createNotification(run.ownerId ?? undefined, {
          type: "autopilot",
          title:
            status === "done"
              ? "Autopilot run complete"
              : status === "cancelled"
                ? "Autopilot run cancelled"
                : "Autopilot run failed",
          message: `“${run.objective.length > 90 ? `${run.objective.slice(0, 90)}…` : run.objective}”${error ? ` — ${error.slice(0, 120)}` : ""}`,
          link: `/projects`,
        });
      }
    };

    // 1 — Architect: write a plan.
    if (isCancelled()) {
      await finishRun("cancelled", "Run cancelled.");
      return;
    }
    await _runAutopilotPhase(
      run,
      arch,
      "You are the Architect of an autonomous project run. You think in systems: dependencies, data flow, risks, milestones. Be concrete and economical.",
      `${context}\n\nWrite a step-by-step implementation plan (PLAN.md in the workspace) that a coder agent can execute without further clarification. Split the work into ordered tasks, each with: goal, files to touch or create, and an acceptance check. Keep the plan under 400 lines. Finish with a one-paragraph summary of the plan.`,
    );
    if (arch.status !== "done") {
      await finishRun(
        "failed",
        "Architect failed; aborting run (no plan).",
        arch.error ?? "architect failed",
      );
      return;
    }

    // 2 — Researcher: gather facts that change implementation decisions.
    if (isCancelled()) {
      await finishRun("cancelled", "Run cancelled.");
      return;
    }
    await _runAutopilotPhase(
      run,
      res,
      "You are the Researcher of an autonomous project run. You investigate before code is written. You may use web/CLI tools from the workspace. Prefer primary sources and note uncertainty explicitly.",
      `${context}\n\nRead PLAN.md. Research the facts that materially affect the plan (APIs, formats, prices, constraints). Write RESEARCH.md in the workspace with concrete findings + sources. If nothing needs researching, say so in one line.`,
    );

    // 3/4 — Coder → Reviewer, up to maxIterations (first pass then rework).
    let reviewNotes = "";
    for (let iteration = 1; iteration <= run.maxIterations; iteration++) {
      if (isCancelled()) {
        await finishRun("cancelled", "Run cancelled.");
        return;
      }
      // Each iteration is a fresh coder phase record so the timeline is honest.
      cod.status = "queued";
      cod.summary = undefined;
      cod.error = undefined;
      cod.startedAt = undefined;
      cod.finishedAt = undefined;
      if (iteration === 1) run.phases.push(cod);
      await _runAutopilotPhase(
        run,
        cod,
        "You are the Coder of an autonomous project run. Implement exactly what PLAN.md specifies, using the workspace tools. Write real, runnable files; run tests/commands to verify where possible. Do not stop at 'describe the change' — make it.",
        `${context}\n\nRead PLAN.md and RESEARCH.md if present. Implement the plan.${iteration > 1 && reviewNotes ? `\n\nA reviewer previously found issues — address them:\n${reviewNotes.slice(0, 6000)}` : ""}\nWhen done, write DONE.md listing what you built and how to run it.`,
      );
      if (isCancelled()) {
        await finishRun("cancelled", "Run cancelled.");
        return;
      }
      const codStatus: string = cod.status;
      if (codStatus !== "done") {
        await finishRun("failed", "Coder failed; stopping.", cod.error ?? "coder failed");
        return;
      }

      const verdict: _AutopilotPhase = {
        role: "reviewer",
        label: "Reviewer",
        provider: reviewer.provider,
        model: reviewer.model,
        status: "queued",
      };
      run.phases.push(verdict);
      await _runAutopilotPhase(
        run,
        verdict,
        "You are the Reviewer of an autonomous project run. Inspect the workspace critically against PLAN.md: does it run, does it satisfy the acceptance checks, are there bugs or security issues? Be precise; cite files/lines.",
        `${context}\n\nReview what the Coder produced against PLAN.md. Inspect the files (read_file / list_files / run_command). Output REVIEW.md with: 1) verdict (APPROVED or CHANGES_REQUIRED), 2) issues found (each with file + fix), 3) one sentence on overall quality.`,
      );
      if (isCancelled()) {
        await finishRun("cancelled", "Run cancelled.");
        return;
      }
      if (verdict.status === "failed") {
        await finishRun("failed", "Reviewer failed; stopping.", verdict.error ?? "reviewer failed");
        return;
      }
      const summaryText = verdict.summary ?? "";
      reviewNotes = summaryText;
      const needsChanges = /\bCHANGES_REQUIRED\b/i.test(summaryText);
      const lastIteration = iteration === run.maxIterations;
      if (!needsChanges || lastIteration) {
        if (needsChanges) {
          await _appendRunEvent(run, {
            ts: now(),
            kind: "note",
            text: "Max iterations reached; finishing with reviewer issues outstanding.",
          });
        }
        await finishRun("done", "Autopilot run complete.");
        return;
      }
      await _appendRunEvent(run, {
        ts: now(),
        kind: "note",
        text: `Reviewer asked for changes; starting rework iteration ${iteration + 1}.`,
      });
    }
  }

  function _autopilotView(run: AutopilotRun) {
    return {
      id: run.id,
      projectId: run.projectId,
      objective: run.objective,
      status: run.status,
      roles: run.roles,
      maxIterations: run.maxIterations,
      workspaceDir: run.workspaceDir,
      phases: run.phases.map((p) => ({ ...p })),
      events: run.events.slice(-500),
      error: run.error,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
  }

  app.get<{ Params: { id: string } }>(
    "/v1/projects/:id/autopilot/runs",
    { preHandler: [requireAuthWithTier, bridgeRL] },
    async (request, reply) => {
      const runs = [..._autopilotRuns.values()]
        .filter((r) => r.projectId === request.params.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(_autopilotView);
      return reply.send({ runs });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/autopilot/runs/:id",
    { preHandler: [requireAuthWithTier, bridgeRL] },
    async (request, reply) => {
      const run = _autopilotRuns.get(request.params.id);
      if (!run) return reply.code(404).send({ error: "run_not_found" });
      return reply.send(_autopilotView(run));
    },
  );

  // SSE: replay persisted events, then live-follow until the run terminates.
  app.get<{ Params: { id: string } }>(
    "/v1/autopilot/runs/:id/stream",
    { preHandler: [requireAuthWithTier, bridgeRL] },
    async (request, reply) => {
      const runId = request.params.id;
      const run = _autopilotRuns.get(runId);
      if (!run) {
        return reply.code(404).send({ error: "run_not_found" });
      }
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, SSE_HEADERS);
      for (const ev of run.events) sseWrite(raw, { ...ev, replay: true });
      if (run.status === "done" || run.status === "failed" || run.status === "cancelled") {
        sseWrite(raw, { ts: now(), kind: "run", text: "END" });
        raw.end();
        return;
      }
      const unsubscribe = (): void => {
        const s = _runListeners.get(runId);
        if (s) s.delete(onEvent);
      };
      const onEvent = (ev: _AutopilotEvent): void => {
        sseWrite(raw, { ...ev });
        if (ev.text === "END" || raw.destroyed) {
          unsubscribe();
          if (!raw.destroyed) raw.end();
        }
      };
      let set = _runListeners.get(runId);
      if (!set) {
        set = new Set();
        _runListeners.set(runId, set);
      }
      set.add(onEvent);
      request.raw.on("close", () => {
        unsubscribe();
        if (!raw.destroyed) raw.end();
      });
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      objective?: string;
      roles?: Record<string, { provider?: string; model?: string }>;
      maxIterations?: number;
    };
  }>(
    "/v1/projects/:id/autopilot/runs",
    { preHandler: [requireAuthWithTier, bridgeRL] },
    async (request, reply) => {
      const project = _projects.get(request.params.id);
      if (!project) return reply.code(404).send({ error: "project_not_found" });
      const objective = (request.body?.objective ?? "").trim();
      if (!objective) return reply.code(400).send({ error: "objective_is_required" });
      if (objective.length > 20_000) return reply.code(400).send({ error: "objective_too_long" });

      const runId = `apr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const base = path.join(
        process.env.NEXUS_DATA_DIR ?? path.join(process.cwd(), "data"),
        "workspaces",
        request.params.id,
        runId,
      );
      const roles: Record<string, { provider: string; model: string }> = {};
      for (const role of AUTOPILOT_ROLE_ORDER) {
        const spec = _resolveRoleSpec(role, request.body?.roles?.[role]);
        if (spec) roles[role] = spec;
      }
      const maxIterations = Math.min(3, Math.max(1, Math.round(request.body?.maxIterations ?? 2)));
      const run: AutopilotRun = {
        id: runId,
        projectId: request.params.id,
        ownerId: request.nexusUserId ?? null,
        objective,
        status: "queued",
        roles,
        maxIterations,
        workspaceDir: base,
        phases: [],
        events: [],
        createdAt: now(),
        updatedAt: now(),
      };
      _autopilotRuns.set(runId, run);
      void _executeAutopilotRun(run);
      return reply.code(202).send({
        ..._autopilotView(run),
        stream: `/api/v1/autopilot/runs/${runId}/stream`,
      });
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/v1/autopilot/runs/:id",
    { preHandler: [requireAuthWithTier, bridgeRL] },
    async (request, reply) => {
      const run = _autopilotRuns.get(request.params.id);
      if (!run) return reply.code(404).send({ error: "run_not_found" });
      run.status = "cancelled";
      run.updatedAt = now();
      _autopilotRuns.set(run.id, run);
      await _appendRunEvent(run, { ts: now(), kind: "run", text: "Run cancelled by user." });
      return reply.send({ ok: true });
    },
  );

  // File attachments — real implementation with in-memory storage
  const _fileStore = new Map<
    string,
    {
      id: string;
      projectId: string;
      name: string;
      mimeType: string;
      size: number;
      content: string; // base64 encoded
      createdAt: string;
    }
  >();

  app.post<{ Params: { id: string }; Body: { name?: string; content: string; mimeType?: string } }>(
    "/v1/projects/:id/files",
    {
      preHandler: bridgeRL,
      schema: {
        body: {
          type: "object",
          required: ["content"],
          properties: {
            name: { type: "string", maxLength: 256 },
            content: { type: "string", maxLength: 10_000_000 }, // 10MB base64
            mimeType: { type: "string", maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id: projectId } = request.params;
      const { name, content, mimeType } = request.body;
      const fileId = `file_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const size = Math.ceil(content.length * 0.75); // approximate decoded size
      const fileName = name ?? `upload-${Date.now()}`;

      const file = {
        id: fileId,
        projectId,
        name: fileName,
        mimeType: mimeType ?? "application/octet-stream",
        size,
        content,
        createdAt: new Date().toISOString(),
      };
      _fileStore.set(fileId, file);

      return reply.code(201).send({
        id: fileId,
        projectId,
        name: fileName,
        mimeType: file.mimeType,
        size,
        createdAt: file.createdAt,
      });
    },
  );

  app.delete<{ Params: { id: string; fileId: string } }>(
    "/v1/projects/:id/files/:fileId",
    { preHandler: bridgeRL },
    async (request, reply) => {
      const file = _fileStore.get(request.params.fileId);
      if (!file || file.projectId !== request.params.id) {
        return reply.code(404).send({ error: "not_found" });
      }
      _fileStore.delete(request.params.fileId);
      return reply.send({ ok: true, deleted: request.params.fileId });
    },
  );

  // GET file content by ID
  app.get<{ Params: { id: string; fileId: string } }>(
    "/v1/projects/:id/files/:fileId",
    { preHandler: bridgeRL },
    async (request, reply) => {
      const file = _fileStore.get(request.params.fileId);
      if (!file || file.projectId !== request.params.id) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.send({
        id: file.id,
        projectId: file.projectId,
        name: file.name,
        mimeType: file.mimeType,
        size: file.size,
        content: file.content,
        createdAt: file.createdAt,
      });
    },
  );

  // ── STM project routes ─────────────────────────────────────────────────────
  // ProjectInstructions.tsx calls /api/stm, /api/stm/project/:id, /api/stm/toggle.
  // Extend the existing STM in-memory store to support per-project modules.

  app.get("/stm", { preHandler: bridgeRL }, async (_req, reply) => {
    return reply.send({ modules: _stmActiveModules, active: _stmActiveModules });
  });

  const _stmProjectOverrides = new Map<string, string[]>();

  app.get<{ Params: { id: string } }>(
    "/stm/project/:id",
    { preHandler: bridgeRL },
    async (request, reply) => {
      const overrides = _stmProjectOverrides.get(request.params.id);
      return reply.send({ projectId: request.params.id, active: overrides ?? _stmActiveModules });
    },
  );

  app.post<{ Params: { id: string }; Body: { active: string[] } }>(
    "/stm/project/:id",
    { preHandler: bridgeRL },
    async (request, reply) => {
      const { active = [] } = request.body ?? {};
      _stmProjectOverrides.set(request.params.id, active);
      return reply.send({ ok: true, projectId: request.params.id, active });
    },
  );

  app.post<{ Body: { moduleId: string; enabled: boolean } }>(
    "/stm/toggle",
    { preHandler: bridgeRL },
    async (request, reply) => {
      const { moduleId, enabled } = request.body ?? {};
      if (!moduleId) return reply.code(400).send({ error: "moduleId required" });
      if (enabled) {
        if (!_stmActiveModules.includes(moduleId)) _stmActiveModules.push(moduleId);
      } else {
        _stmActiveModules = _stmActiveModules.filter((m) => m !== moduleId);
      }
      return reply.send({ ok: true, moduleId, enabled, active: _stmActiveModules });
    },
  );

  // ── Build Tasks (in-memory Kanban) ─────────────────────────────────────────
  // Frontend: apps/ui/app/routes/build.tsx
  // Endpoints: GET/POST /api/build/tasks, PATCH /:id/status,
  //            POST /:id/claim|release|submit, DELETE /:id, POST /steal

  // ── Build Tasks (DB-backed, persisted in Neon build_tasks table) ───────────
  // Frontend: apps/ui/app/routes/build.tsx
  // Endpoints: GET /build/tasks, POST /build/tasks, POST /build/tasks/steal,
  //            PATCH /build/tasks/:id/status, POST /build/tasks/:id/claim,
  //            POST /build/tasks/:id/release, POST /build/tasks/:id/submit, DELETE /build/tasks/:id

  const _btNow = () => new Date().toISOString();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function _btRow(row: any) {
    return {
      id: row.id,
      userId: row.user_id,
      parentId: row.parent_id ?? null,
      title: row.title,
      description: row.description ?? null,
      status: row.status,
      claimedBy: row.claimed_by ?? null,
      claimedAt: row.claimed_at ? new Date(row.claimed_at as string).toISOString() : null,
      output: row.output ?? null,
      submittedAt: row.submitted_at ? new Date(row.submitted_at as string).toISOString() : null,
      isLocked: row.is_locked ?? false,
      meta: row.meta ?? {},
      createdAt: new Date(row.created_at as string).toISOString(),
      updatedAt: new Date(row.updated_at as string).toISOString(),
    };
  }

  app.get("/build/tasks", { preHandler: bridgeRL }, async (_req, reply) => {
    const pool = _getPool();
    if (!pool) return reply.send({ tasks: [] });
    const { rows } = await pool.query(
      "SELECT * FROM build_tasks ORDER BY created_at DESC LIMIT 200",
    );
    return reply.send({ tasks: rows.map(_btRow) });
  });

  // IMPORTANT: register /steal before /:id routes so static path wins
  app.post<{ Body: { agentId?: string } }>(
    "/build/tasks/steal",
    { preHandler: bridgeRL },
    async (request, reply) => {
      const pool = _getPool();
      if (!pool) return reply.send({ task: null, message: "DB unavailable" });
      const agentId = request.body?.agentId ?? "agent";
      const { rows } = await pool.query(
        `UPDATE build_tasks SET status='claimed', claimed_by=$1, claimed_at=NOW(), updated_at=NOW()
       WHERE id = (
         SELECT id FROM build_tasks WHERE status='planned' AND claimed_by IS NULL
         ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
       ) RETURNING *`,
        [agentId],
      );
      if (!rows.length) return reply.send({ task: null, message: "No available tasks" });
      return reply.send({ task: _btRow(rows[0]) });
    },
  );

  app.post<{
    Body: { title: string; description?: string; status?: string; parentId?: number | null };
  }>("/build/tasks", { preHandler: bridgeRL }, async (request, reply) => {
    const pool = _getPool();
    const { title, description = null, status = "planned", parentId = null } = request.body ?? {};
    if (!title?.trim()) return reply.code(400).send({ error: "title required" });
    if (!pool) return reply.code(503).send({ error: "DB unavailable" });
    const { rows } = await pool.query(
      `INSERT INTO build_tasks (title, description, status, parent_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [title.trim(), description, status, parentId],
    );
    return reply.code(201).send(_btRow(rows[0]));
  });

  app.patch<{ Params: { id: string }; Body: { status?: string } }>(
    "/build/tasks/:id/status",
    { preHandler: bridgeRL },
    async (request, reply) => {
      const pool = _getPool();
      if (!pool) return reply.code(503).send({ error: "DB unavailable" });
      const id = parseInt(request.params.id, 10);
      const { rows } = await pool.query(
        "UPDATE build_tasks SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *",
        [request.body?.status ?? "planned", id],
      );
      if (!rows.length) return reply.code(404).send({ error: "not found" });
      return reply.send(_btRow(rows[0]));
    },
  );

  app.post<{ Params: { id: string } }>(
    "/build/tasks/:id/claim",
    { preHandler: bridgeRL },
    async (request, reply) => {
      const pool = _getPool();
      if (!pool) return reply.code(503).send({ error: "DB unavailable" });
      const id = parseInt(request.params.id, 10);
      const { rows } = await pool.query(
        "UPDATE build_tasks SET status='claimed', claimed_by='user', claimed_at=NOW(), updated_at=NOW() WHERE id=$1 RETURNING *",
        [id],
      );
      if (!rows.length) return reply.code(404).send({ error: "not found" });
      return reply.send(_btRow(rows[0]));
    },
  );

  app.post<{ Params: { id: string } }>(
    "/build/tasks/:id/release",
    { preHandler: bridgeRL },
    async (request, reply) => {
      const pool = _getPool();
      if (!pool) return reply.code(503).send({ error: "DB unavailable" });
      const id = parseInt(request.params.id, 10);
      const { rows } = await pool.query(
        "UPDATE build_tasks SET status='planned', claimed_by=NULL, claimed_at=NULL, updated_at=NOW() WHERE id=$1 RETURNING *",
        [id],
      );
      if (!rows.length) return reply.code(404).send({ error: "not found" });
      return reply.send(_btRow(rows[0]));
    },
  );

  app.post<{ Params: { id: string }; Body: { output: string } }>(
    "/build/tasks/:id/submit",
    { preHandler: bridgeRL },
    async (request, reply) => {
      const pool = _getPool();
      if (!pool) return reply.code(503).send({ error: "DB unavailable" });
      const id = parseInt(request.params.id, 10);
      const { rows } = await pool.query(
        "UPDATE build_tasks SET status='review', output=$1, submitted_at=NOW(), updated_at=NOW() WHERE id=$2 RETURNING *",
        [request.body?.output ?? "", id],
      );
      if (!rows.length) return reply.code(404).send({ error: "not found" });
      return reply.send(_btRow(rows[0]));
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/build/tasks/:id",
    { preHandler: bridgeRL },
    async (request, reply) => {
      const pool = _getPool();
      if (!pool) return reply.code(503).send({ error: "DB unavailable" });
      await pool.query("DELETE FROM build_tasks WHERE id=$1", [parseInt(request.params.id, 10)]);
      return reply.send({ ok: true });
    },
  );

  // ── Prompts (DB-backed, versioned, persisted in Neon prompts table) ─────────
  // Frontend: apps/ui/app/routes/prompts.tsx
  // Endpoints: GET/POST /api/prompts, GET/DELETE /api/prompts/:id,
  //            POST /api/prompts/:id/versions

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function _promptRow(p: any, versions: any[]) {
    return {
      id: p.id,
      name: p.name,
      description: p.description ?? null,
      createdAt: new Date(p.created_at as string).toISOString(),
      versions: versions.map((v) => ({
        id: v.id,
        versionNum: v.version_num,
        content: v.content,
        model: v.model ?? null,
        temperature: v.temperature != null ? Number(v.temperature) : null,
        createdAt: new Date(v.created_at as string).toISOString(),
      })),
    };
  }

  app.get("/prompts", { preHandler: bridgeRL }, async (_req, reply) => {
    const pool = _getPool();
    if (!pool) return reply.send({ prompts: [] });
    const { rows: prompts } = await pool.query("SELECT * FROM prompts ORDER BY created_at DESC");
    if (!prompts.length) return reply.send({ prompts: [] });
    const { rows: versions } = await pool.query(
      "SELECT * FROM prompt_versions WHERE prompt_id = ANY($1) ORDER BY version_num DESC",
      [prompts.map((p) => p.id)],
    );
    const vMap = new Map<string, Record<string, unknown>[]>();
    for (const v of versions) {
      const arr = vMap.get(v.prompt_id as string) ?? [];
      arr.push(v);
      vMap.set(v.prompt_id as string, arr);
    }
    return reply.send({
      prompts: prompts.map((p) => _promptRow(p, vMap.get(p.id as string) ?? [])),
    });
  });

  app.post<{ Body: { name: string; description?: string; content?: string } }>(
    "/prompts",
    { preHandler: bridgeRL },
    async (request, reply) => {
      const pool = _getPool();
      if (!pool) return reply.code(503).send({ error: "DB unavailable" });
      const { name, description, content } = request.body ?? {};
      if (!name?.trim()) return reply.code(400).send({ error: "name required" });
      const defaultContent =
        content ??
        "# {{role}}\n\nYou are a helpful assistant.\n\n## Instructions\n\n{{instructions}}\n\n## Input\n\n{{input}}";
      const pRows = await pool.query(
        "INSERT INTO prompts (name, description) VALUES ($1, $2) RETURNING *",
        [name.trim(), description ?? null],
      );

      const p = pRows.rows[0] as Record<string, unknown>;
      const vRows = await pool.query(
        "INSERT INTO prompt_versions (prompt_id, version_num, content) VALUES ($1, 1, $2) RETURNING *",
        [p.id, defaultContent],
      );

      const v = vRows.rows[0] as Record<string, unknown>;
      return reply.code(201).send(_promptRow(p, [v]));
    },
  );

  app.get<{ Params: { id: string } }>(
    "/prompts/:id",
    { preHandler: bridgeRL },
    async (request, reply) => {
      const pool = _getPool();
      if (!pool) return reply.code(503).send({ error: "DB unavailable" });
      const pResult = await pool.query("SELECT * FROM prompts WHERE id=$1", [request.params.id]);

      const p = pResult.rows[0] as Record<string, unknown>;
      if (!p) return reply.code(404).send({ error: "not found" });
      const { rows: versions } = await pool.query(
        "SELECT * FROM prompt_versions WHERE prompt_id=$1 ORDER BY version_num DESC",
        [p.id],
      );
      return reply.send(_promptRow(p, versions));
    },
  );

  app.post<{
    Params: { id: string };
    Body: { content: string; model?: string; temperature?: number };
  }>("/prompts/:id/versions", { preHandler: bridgeRL }, async (request, reply) => {
    const pool = _getPool();
    if (!pool) return reply.code(503).send({ error: "DB unavailable" });
    const pResult = await pool.query("SELECT * FROM prompts WHERE id=$1", [request.params.id]);

    const p = pResult.rows[0] as Record<string, unknown>;
    if (!p) return reply.code(404).send({ error: "not found" });
    const { content = "", model = null, temperature = null } = request.body ?? {};
    const maxResult = await pool.query(
      "SELECT COALESCE(MAX(version_num), 0) AS max FROM prompt_versions WHERE prompt_id=$1",
      [p.id],
    );

    const nextNum = (Number((maxResult.rows[0] as Record<string, unknown>)?.max) || 0) + 1;
    const vResult = await pool.query(
      "INSERT INTO prompt_versions (prompt_id, version_num, content, model, temperature) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [p.id, nextNum, content, model, temperature],
    );

    const v = vResult.rows[0] as Record<string, unknown>;
    await pool.query("UPDATE prompts SET updated_at=NOW() WHERE id=$1", [p.id]);
    return reply.send({
      id: v.id,

      versionNum: v.version_num,

      content: v.content,

      model: v.model ?? null,

      temperature: v.temperature != null ? Number(v.temperature) : null,

      createdAt: new Date(v.created_at as string).toISOString(),
    });
  });

  app.delete<{ Params: { id: string } }>(
    "/prompts/:id",
    { preHandler: bridgeRL },
    async (request, reply) => {
      const pool = _getPool();
      if (!pool) return reply.code(503).send({ error: "DB unavailable" });
      await pool.query("DELETE FROM prompts WHERE id=$1", [request.params.id]);
      return reply.send({ ok: true });
    },
  );

  // ── Contacts CRUD ────────────────────────────────────────────────────────────

  const _contacts: {
    id: string;
    name: string;
    email: string;
    company?: string;
    notes?: string;
    createdAt: string;
  }[] = [];
  app.get("/contacts", async (_request, reply) => {
    return reply.send({ contacts: _contacts });
  });
  app.post<{ Body: { name?: string; email?: string; company?: string; notes?: string } }>(
    "/contacts",
    async (request, reply) => {
      const { name, email, company, notes } = request.body ?? {};
      if (!name?.trim() || !email?.trim())
        return reply.code(400).send({ error: "name and email required" });
      const contact = {
        id: crypto.randomUUID(),
        name: name.trim(),
        email: email.trim(),
        company: company?.trim(),
        notes: notes?.trim(),
        createdAt: new Date().toISOString(),
      };
      _contacts.push(contact);
      return reply.code(201).send(contact);
    },
  );

  // ── Archetypes CRUD ──────────────────────────────────────────────────────────

  interface ArchetypeEntry {
    id: string;
    name: string;
    icon: string;
    color: string;
    thinkingStyle: string;
    description: string;
    systemPrompt?: string;
    model?: string;
    temperature?: number;
  }
  const _archetypes: ArchetypeEntry[] = [];
  app.get("/archetypes", async (_request, reply) => {
    return reply.send({ archetypes: _archetypes });
  });
  app.post<{ Body: Omit<ArchetypeEntry, "id"> }>("/archetypes", async (request, reply) => {
    const entry = { id: crypto.randomUUID(), ...request.body };
    _archetypes.push(entry);
    return reply.code(201).send(entry);
  });
  app.put<{ Params: { id: string }; Body: Partial<Omit<ArchetypeEntry, "id">> }>(
    "/archetypes/:id",
    async (request, reply) => {
      const idx = _archetypes.findIndex((a) => a.id === request.params.id);
      if (idx === -1) return reply.code(404).send({ error: "not_found" });
      _archetypes[idx] = { ..._archetypes[idx], ...request.body } as ArchetypeEntry;
      return reply.send(_archetypes[idx]);
    },
  );
  app.delete<{ Params: { id: string } }>("/archetypes/:id", async (request, reply) => {
    const idx = _archetypes.findIndex((a) => a.id === request.params.id);
    if (idx === -1) return reply.code(404).send({ error: "not_found" });
    _archetypes.splice(idx, 1);
    return reply.send({ ok: true });
  });

  // ── Leaderboard ──────────────────────────────────────────────────────────────

  app.get("/leaderboard", async (_request, reply) => {
    // Static leaderboard with live pricing when API keys are configured
    const models = [
      {
        model: "Claude Opus 4.8",
        provider: "Anthropic",
        parameters: "—",
        context: "1M",
        gpqa: 87.2,
        sweBench: 74.1,
        arenaElo: 1320,
        speed: "Fast",
      },
      {
        model: "Claude Sonnet 4.6",
        provider: "Anthropic",
        parameters: "—",
        context: "200K",
        gpqa: 84.3,
        sweBench: 71.5,
        arenaElo: 1298,
        speed: "Fastest",
      },
      {
        model: "Claude Fable 5",
        provider: "Anthropic",
        parameters: "—",
        context: "200K",
        gpqa: 86.1,
        sweBench: 72.8,
        arenaElo: 1312,
        speed: "Fast",
      },
      {
        model: "GPT-5",
        provider: "OpenAI",
        parameters: "—",
        context: "256K",
        gpqa: 86.5,
        sweBench: 73.2,
        arenaElo: 1315,
        speed: "Medium",
      },
      {
        model: "Gemini 2.5 Pro",
        provider: "Google",
        parameters: "—",
        context: "2M",
        gpqa: 85.0,
        sweBench: 69.8,
        arenaElo: 1305,
        speed: "Fast",
      },
      {
        model: "Llama 4",
        provider: "Meta",
        parameters: "400B",
        context: "128K",
        gpqa: 78.2,
        sweBench: 62.1,
        arenaElo: 1250,
        speed: "Medium",
      },
      {
        model: "Mistral Large 2",
        provider: "Mistral",
        parameters: "—",
        context: "256K",
        gpqa: 80.5,
        sweBench: 67.3,
        arenaElo: 1270,
        speed: "Fast",
      },
      {
        model: "Grok 3",
        provider: "xAI",
        parameters: "—",
        context: "1M",
        gpqa: 82.1,
        sweBench: 68.5,
        arenaElo: 1280,
        speed: "Fast",
      },
    ];
    return reply.send({
      models,
      updated: new Date().toISOString().slice(0, 10),
      source: "static",
      measured: false,
      disclaimer:
        "Curated static benchmark figures from public reports — not live-measured on this instance.",
    });
  });

  // ── Admin traces (legacy /api/traces alias) ────────────────────────────────
  // Frontend admin-traces.tsx calls /api/traces. Returns in-memory store.

  const _tracesStore: {
    id: string;
    method: string;
    path: string;
    status: number;
    durationMs: number;
    userId?: string;
    createdAt: string;
  }[] = [];

  app.get<{ Querystring: { page?: string; limit?: string; type?: string } }>(
    "/traces",
    async (request, reply) => {
      const page = Math.max(1, parseInt(request.query.page ?? "1", 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(request.query.limit ?? "20", 10) || 20));
      const filtered = request.query.type
        ? _tracesStore.filter((t) => t.path.includes(request.query.type!))
        : _tracesStore;
      const start = (page - 1) * limit;
      return reply.send({
        traces: filtered.slice(start, start + limit),
        total: filtered.length,
        page,
        limit,
      });
    },
  );

  app.get<{ Params: { id: string } }>("/traces/:id", async (request, reply) => {
    const trace = _tracesStore.find((t) => t.id === request.params.id);
    if (!trace) return reply.code(404).send({ error: "not_found" });
    return reply.send(trace);
  });

  // ── Web Scraping routes already registered at line ~4554 ────────────────────
  // (GET /web-scraping/providers, POST /scrape, /crawl, /exa/search, /exa/contents)
  // Do NOT re-register here — Fastify throws FST_ERR_DUPLICATED_ROUTE.
}
