// SPDX-License-Identifier: Apache-2.0
/**
 * Judica-compat routes — mounts under /api (no version prefix).
 *
 * Bridges the Judica frontend's /api/* call surface to the Nexus backend.
 * Three categories:
 *
 *   A) Path aliases   — delegate to same packages as existing /api/v1/* routes
 *   B) New endpoints  — real implementations (chat stream, ab)
 *   C) Stubs          — in-memory CRUD or 501 for features not yet backed
 *
 * Register in server.ts under { prefix: "/api" }.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import type { ServerResponse } from "node:http";
import path from "node:path";

import { AdaptiveScraper, HttpxEngine, isScraped } from "@nexus/adaptive-scraper";
import type { AgentDefinition } from "@nexus/agent-runtime";
import {
  KernelManager,
  DockerReplExecutor,
  isDockerAvailable,
  type ReplLanguage,
} from "@nexus/code-repl";
import {
  COUNCIL_TEMPLATES,
  detectTaskCategory,
  rankPeers,
  runCouncilDebate,
  summarizeRatings,
  extractFinalAnswer,
  MAX_DEBATE_ROUNDS,
  type DebateMember,
  type IStreamingTransport,
} from "@nexus/council";
import { db } from "@nexus/db";
import { userProviderCredentials, auditLog, users } from "@nexus/db/schema";
import { globalFlags } from "@nexus/feature-flags";
import { scoreResponse, ULTRAPLINIAN_MODELS } from "@nexus/gauntlet";
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
import { FixedEmbedder, MemoryManager, createBestEmbedder, type IEmbedder } from "@nexus/memory";
import { AdapterRegistry, NexusAdapterError, defineAdapter } from "@nexus/plugin-sdk";
import { applyParseltongue, getDefaultConfig as redteamDefaultConfig } from "@nexus/redteam";
import type { RetrievalSource, ScoredChunk, SourceRetrieverFn } from "@nexus/retrieval";
import { pinnedFetch } from "@nexus/runtime";
import { searchBrave, searchExa, searchSearxNG, searchSerper } from "@nexus/search-orchestrator";
import { StealthBrowser, PatchrightDriver, isPatchrightAvailable } from "@nexus/stealth-browser";
import { eq, and, isNull, desc } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { launchBrowserTask } from "../lib/agent-queue.js";
import { observeAnswer } from "../lib/answer-drift.js";
import { ANON_OWNER, loadArchetypeStore, seatCouncil } from "../lib/archetype-store.js";
import { emitAuditEvent } from "../lib/audit-emitter.js";
import {
  applyBrowserAction,
  browserDecisionMessages,
  parseBrowserDecision,
  type BrowserActionType,
  type BrowserAgentContext,
  type BrowserAgentDecision,
  type BrowserAgentSession,
  type BrowserAgentStep,
  runBrowserAgentTask,
  DEFAULT_MAX_AGENT_STEPS,
} from "../lib/browser-agent.js";
import { closeChannel, createChannel, writeChannel } from "../lib/channels.js";
import { findPii, maskProfanity, redactPii } from "../lib/chat-safety.js";
import {
  citedNumbers,
  gatherSources,
  sourcesFooter,
  sourcesPrompt,
  supportingNumbers,
  type SourceSet,
} from "../lib/citations.js";
import {
  costLogStore,
  scopeCostEntriesToUser,
  trackCost,
  type CostEntry,
} from "../lib/cost-log.js";
import { sha256hex } from "../lib/crypto-utils.js";
import { searchDuckDuckGo } from "../lib/duckduckgo.js";
import { guardExec } from "../lib/exec-guard.js";
import { getKG } from "../lib/knowledge-graph-store.js";
import { getMemoryStore } from "../lib/memory-store.js";
import { cachedDriver } from "../lib/llm-cache-driver.js";
import { FailoverDriver, getFailoverDriver, setFailoverProviders } from "../lib/llm-failover.js";
import { heuristicScores, openaiScores } from "../lib/moderation-score.js";
import { resolveOAuthDriver } from "../lib/oauth-drivers.js";
import { pendingCount } from "../lib/org-approvals.js";
import { allRuns } from "../lib/org-runtime.js";
import { claimable, ownerIdFor, ownsRow, seesOwnerless } from "../lib/owner.js";
import { PersistentStore } from "../lib/persistent-store.js";
import { getPgPool } from "../lib/pg-pool.js";
import {
  asUser,
  buildUserDriverRegistry,
  compatibleEndpointError,
  invalidateUserDrivers,
  listUserDrivers,
  listUserModels,
  serviceKey,
  userEndpoint,
} from "../lib/provider-keys.js";
import { fetchPublic, unsafeUrlReason } from "../lib/public-url.js";
import { makeUserRateLimitPreHandler } from "../lib/rate-limiter.js";
import {
  emitReaction,
  fireReactionEvent,
  HANDLER_TYPES,
  provideReactionDeps,
  reactionEvents,
  reactionRules,
  type ReactionRule,
} from "../lib/reactions.js";
import { getTrace, listTraces } from "../lib/request-traces.js";
import { listResearchJobs } from "../lib/research-jobs.js";
import { recordCouncilRun } from "../lib/routing-data.js";
import { encryptSecret, SecretCryptoUnavailableError } from "../lib/secret-crypto.js";
import { getThread } from "../lib/threads-store.js";
import { runUntrustedJs } from "../lib/untrusted-js.js";
// Event emitters push completion/failure into the per-user notification store.
// (The HTTP surface for the store lives in routes/notifications.ts.)
import { getCacheUserId, getUserDrivers } from "../lib/user-context.js";
import { maybeEmitWeeklyDigest } from "../lib/weekly-digest.js";
import { requireAuthWithTier, requireUserId } from "../middleware/auth.js";

import { requireAdminRole as requireAdminRoleBridge } from "./admin-users.js";
import { archetypesRoutes } from "./archetypes.js";
import { connectorsBridgeRoutes } from "./connectors-bridge.js";
import { costsRoutes } from "./costs.js";
import { gatewayLog } from "./gateway.js";
import { kbRoutes, listKbsFor, searchKb } from "./kb.js";
import { kgRoutes } from "./kg.js";
import { marketplaceRoutes } from "./marketplace.js";
import { memoryBridgeRoutes } from "./memory-bridge.js";
import { registerResearchRoutes } from "./research.js";
import { allFeedback } from "./rlhf.js";
import { sandboxRoutes, runViaPyodide, runViaPiston } from "./sandbox.js";
import { searchRoutes } from "./search.js";
import { registerSkillRoutes } from "./skills.js";
import { stmBridgeRoutes } from "./stm-bridge.js";
import { tokensRoutes } from "./tokens.js";
import { workflowsRoutes } from "./workflows.js";

// ── SSE helpers ───────────────────────────────────────────────────────────────

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

/** Streams opened with `live`, teed into a channel others can watch. */
const liveChannels = new WeakMap<ServerResponse, string>();

function sseWrite(raw: ServerResponse, ev: unknown): void {
  const live = liveChannels.get(raw);
  if (live) writeChannel(live, JSON.stringify(ev));
  if (!raw.destroyed) raw.write(`data: ${JSON.stringify(ev)}\n\n`);
}

// ── Lazy-init packages ────────────────────────────────────────────────────────

let _registry: DriverRegistry | null = null;
function getRegistry(): DriverRegistry {
  if (_registry) return _registry;
  const reg = new DriverRegistry();
  const envDrivers: [string, string, (apiKey: string) => LlmDriver][] = [
    ["OPENAI_API_KEY", "openai", (apiKey) => new OpenAIDriver({ apiKey })],
    ["GROQ_API_KEY", "groq", (apiKey) => new GroqDriver({ apiKey })],
    ["ANTHROPIC_API_KEY", "anthropic", (apiKey) => new AnthropicDriver({ apiKey })],
    ["GEMINI_API_KEY", "gemini", (apiKey) => new GeminiDriver({ apiKey })],
    ["DEEPSEEK_API_KEY", "deepseek", (apiKey) => new DeepSeekDriver({ apiKey })],
    ["MISTRAL_API_KEY", "mistral", (apiKey) => new MistralDriver({ apiKey })],
    ["OPENROUTER_API_KEY", "openrouter", (apiKey) => new OpenRouterDriver({ apiKey })],
  ];
  // <NAME>S lists more keys for the same provider; each is its own chain entry (groq#2, …),
  // so a key that hits its rate limit is benched and the next key answers.
  for (const [envVar, id, make] of envDrivers) {
    const keys = [
      ...new Set(
        [process.env[envVar], ...(process.env[`${envVar}S`] ?? "").split(",")]
          .map((k) => k?.trim())
          .filter((k): k is string => !!k),
      ),
    ];
    keys.forEach((key, i) => reg.register(make(key), i === 0 ? id : `${id}#${i + 1}`));
  }
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
let DEFAULT_MODEL = process.env.NEXUS_DEFAULT_MODEL ?? "anthropic/claude-3.5-haiku";

/** Current UTC timestamp as ISO-8601. */
const now = (): string => new Date().toISOString();

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
  // A provider's extra keys (groq#2, …) follow it directly.
  const base = (i: string) => i.split("#")[0]!;
  const rest = DEFAULT_PROVIDER_ORDER.flatMap((p) => ids.filter((i) => base(i) === p)).concat(
    ids.filter((i) => !DEFAULT_PROVIDER_ORDER.includes(base(i))),
  );
  const order = preferred ? [preferred, ...rest.filter((i) => i !== preferred)] : rest;
  return order
    .map((id) => ({ id, driver: reg.get(id) }))
    .filter((e): e is { id: string; driver: LlmDriver } => Boolean(e.driver));
}

export function getDefaultDriver() {
  const entries = buildFailoverEntries();
  // The caller's own saved keys come first; the server's keys stay as fallback.
  const own = getUserDrivers().map((e) => ({
    id: `user:${e.id}`,
    driver: e.driver,
    ownModel: true,
  }));
  if (own.length > 0) return new FailoverDriver([...own, ...entries]);
  if (entries.length === 0) return undefined;
  setFailoverProviders(entries);
  return getFailoverDriver();
}

/**
 * The caller's failover chain, own keys first, where every provider answers on
 * its own default model — except `provider`, when given, which is tried first
 * and receives the model the caller requests. A failover step therefore never
 * sends one provider's model id to another. Undefined when nothing is
 * configured, or when `provider` is not reachable with any key the caller has.
 * `alone` drops the rest of the chain, for a call that must be answered by `provider`.
 */
export function getPinnedDriver(provider?: string, alone = false): FailoverDriver | undefined {
  const all = [
    ...getUserDrivers().map((e) => ({ id: `user:${e.id}`, provider: e.id, driver: e.driver })),
    ...buildFailoverEntries().map((e) => ({ ...e, provider: e.id })),
  ];
  const pin = provider ? all.find((e) => e.provider === provider) : undefined;
  if (provider && !pin) return undefined;
  if (all.length === 0) return undefined;
  return new FailoverDriver([
    ...(pin ? [{ id: pin.id, driver: pin.driver }] : []),
    ...(pin && alone
      ? []
      : all.filter((e) => e !== pin).map((e) => ({ id: e.id, driver: e.driver, ownModel: true }))),
  ]);
}

/**
 * A chain over only free models: every ":free" model the caller's connections list, one entry
 * each so a rate limit benches just that model, then local ones. Undefined when there are none.
 */
export function getFreeDriver(
  connections: { provider: string; models: string[] }[],
): FailoverDriver | undefined {
  const own = new Map(getUserDrivers().map((e) => [e.id, e.driver]));
  const free = connections.flatMap(({ provider, models }) => {
    const driver = own.get(provider);
    return driver
      ? models
          .filter((m) => m.endsWith(":free"))
          .map((model) => ({ id: `user:${provider}`, driver, model }))
      : [];
  });
  const local = [
    ...getUserDrivers().map((e) => ({ id: `user:${e.id}`, driver: e.driver })),
    ...buildFailoverEntries(),
  ].filter((e) => LOCAL_PROVIDERS.has(e.driver.provider));
  const entries = [...free, ...local.map((e) => ({ ...e, ownModel: true }))];
  return entries.length ? new FailoverDriver(entries) : undefined;
}

const LOCAL_PROVIDERS = new Set(["ollama", "lmstudio"]);

/** Strip markdown code fences then JSON.parse — handles ` ```json ` and ` ``` ` variants. */
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

// ── Cost tracking ─────────────────────────────────────────────────────────────

// Usage/cost log — durable via lib/cost-log.ts (write-behind to day-sharded KV
// keys; boot reloads it so dashboard stats, windowed series, and the weekly
// digest survive API restarts). `_costLog` stays the same in-memory array every
// read below touches; only recording moved into the store.
const _costLog: readonly CostEntry[] = costLogStore.entries;

const _trackCost = trackCost;

const NO_LLM_MESSAGE = "No LLM provider configured. Add a provider key in Settings.";

/** One-line LLM call with automatic cost tracking. Returns content string. */
function _guessLanguage(code: string): string {
  if (/^\s*(def |from \w+ import )/m.test(code)) return "python";
  if (/^\s*(package main|func \w+\()/m.test(code)) return "go";
  if (/^\s*(fn |use \w+::|impl )/m.test(code)) return "rust";
  if (/\bpublic static void\b|\bSystem\.out\./.test(code)) return "java";
  if (/:\s*(string|number|boolean)\b|\binterface \w+|\btype \w+ =/.test(code)) return "typescript";
  if (/\b(const|let|function)\b|=>/.test(code)) return "javascript";
  if (/^#!.*\b(ba)?sh\b|^\s*(echo|export) /m.test(code)) return "bash";
  return "code";
}

async function _llm(
  messages: { role: LlmRole; content: string }[],
  maxTokens = 512,
  model = DEFAULT_MODEL,
): Promise<string> {
  const driver = getDefaultDriver();
  if (!driver) throw Object.assign(new Error(NO_LLM_MESSAGE), { statusCode: 503 });
  const res = await driver.complete({ model, messages, maxTokens });
  _trackCost(model, res.usage);
  return res.content.trim();
}

// Kept as a local alias so the ~17 direct query sites below read unchanged.
const _getPool = getPgPool;

// ──────────────────────────────────────────────────────────────────────────────

let _scraper: AdaptiveScraper | null = null;
function getScraper(): AdaptiveScraper {
  if (!_scraper)
    _scraper = new AdaptiveScraper([
      new HttpxEngine({ priority: 1, fetch: (url, init) => fetchPublic(String(url), init) }),
    ]);
  return _scraper;
}

let _memory: MemoryManager | null = null;
let _embedder: IEmbedder | null = null;
function getEmbedder(): IEmbedder {
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
  const store = getMemoryStore();
  _memory = new MemoryManager({ store, embedder: getEmbedder() });
  return _memory;
}

// ── In-memory stores for stateful endpoints ───────────────────────────────────

interface AbResult {
  id: string;
  ownerId?: string | null;
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

const _abStore = new PersistentStore<AbResult>("ab_results");
// Rooms store lives in routes/rooms.ts (§16.7).

// ── Council member model-availability validation ──────────────────────────────
// Settings → Council members are saved with a provider + model id. If the model
// no longer exists on the account's key (e.g. llama-3.3-70b-versatile was
// decommissioned by Groq on 2026-08-16), the member fails at run time with an
// opaque per-member error. Validate each model against the provider's catalog
// at save time so the UI can surface an actionable, per-member hint instead.

/** OpenAI-compatible base URLs keyed by member provider id (mirrors
 *  API_PROVIDERS in apps/ui/app/lib/council.ts). Anthropic is intentionally
 *  absent: its API is not OpenAI-compatible and exposes no /models endpoint. */
export const PROVIDER_CATALOG_BASE: Record<string, string> = {
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

const _catalogCache = new Map<string, { ids: string[]; fetchedAt: number }>();
const CATALOG_TTL_MS = 10 * 60_000;

/** Model ids an OpenAI-compatible `/models` lists for one key (cached 10 min); null when unreachable. */
async function fetchModelCatalog(base: string, key: string | null): Promise<string[] | null> {
  const cacheKey = `${base}\n${key ? sha256hex(key) : ""}`;
  const cached = _catalogCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) return cached.ids;
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/models`, {
      headers: { Accept: "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    const ids = (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string");
    _catalogCache.set(cacheKey, { ids, fetchedAt: Date.now() });
    return ids;
  } catch {
    return null;
  }
}

interface CouncilMemberValidation {
  index: number;
  provider: string;
  model: string;
  status: "ok" | "missing" | "missing_model" | "no_key" | "unreachable" | "skipped";
  availableModels?: string[];
}

// Speech, embedding and safety models share the catalogue but cannot sit on a council.
const NON_CHAT_MODEL = /whisper|tts|orpheus|embed|guard|moderation|dall-e|image|audio|transcri/i;

/** Per-member check for a council save: a key backs the member and its model is on that key. */
async function validateCouncilMembers(
  userId: string | undefined,
  members: unknown,
  sources: Map<string, MemberKeySource>,
): Promise<CouncilMemberValidation[]> {
  if (!Array.isArray(members)) return [];
  const listed = new Map(
    (await listUserModels(userId).catch(() => [])).map((c) => [c.provider, c.models]),
  );
  return Promise.all(
    members.map(async (raw, index): Promise<CouncilMemberValidation> => {
      const m = (raw ?? {}) as { provider?: unknown; model?: unknown; enabled?: unknown };
      const provider = typeof m.provider === "string" ? m.provider : "";
      const model = typeof m.model === "string" ? m.model.trim() : "";
      const result = (status: CouncilMemberValidation["status"], ids?: string[]) => ({
        index,
        provider,
        model,
        status,
        ...(ids ? { availableModels: ids.slice(0, 24) } : {}),
      });
      if (m.enabled === false) return result("skipped");
      const source = sources.get(provider) ?? "none";
      if (source === "none") return result("no_key");
      if (!model) return result("missing_model");
      let ids: string[] | null = listed.get(provider)?.length ? listed.get(provider)! : null;
      if (!ids) {
        // A linked account or a local model server has no key-scoped catalogue to read.
        if (source !== "user" && source !== "env") return result("skipped");
        const end =
          source === "user"
            ? await userEndpoint(userId, provider, PROVIDER_CATALOG_BASE)
            : PROVIDER_CATALOG_BASE[provider]
              ? {
                  baseUrl: PROVIDER_CATALOG_BASE[provider],
                  key: process.env[_PROVIDER_KEY_ENV[provider] ?? ""] ?? null,
                }
              : null;
        if (!end) return result("skipped");
        ids = await fetchModelCatalog(end.baseUrl, end.key);
        if (!ids) return result("unreachable");
      }
      if (ids.includes(model)) return result("ok");
      return result(
        "missing",
        ids.filter((id) => !NON_CHAT_MODEL.test(id)),
      );
    }),
  );
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
  // KB store lives in routes/kb.ts (§16.7).

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
    peerRanking: false,
    piiDetection: true,
    autoAnonymize: false,
    blockProfanity: false,
    blockAdultContent: false,
    verbosityLevel: "standard",
    deliberationMode: "standard",
    dissent: "off",
    enableStreaming: true,
  };
  const _prefsStore = new PersistentStore<Record<string, unknown>>("preferences");
  const _stdAnswers = new PersistentStore<StdAnswer>("standard_answers");

  // Projects, groups and tasks used to be plain in-memory Maps — every restart
  // wiped them. Same Map-compatible interface, now durable (PG nexus_kv or JSON).
  // Type shapes live with the project routes (forward references are fine).
  const _groups = new PersistentStore<_Group>("groups");
  const _projects = new PersistentStore<_Project>("projects");
  claimable("groups", _groups);
  claimable("projects", _projects);
  const _tasks = new PersistentStore<_Task>("tasks");

  await Promise.all([
    _abStore.load(),
    _councilStore.load(),
    _prefsStore.load(),
    _stdAnswers.load(),
    _groups.load(),
    _projects.load(),
    _tasks.load(),
  ]);

  // ══════════════════════════════════════════════════════════════════════════
  // B.3 — A/B COMPARISON
  // POST /api/ab/run
  // GET  /api/ab
  // GET  /api/ab/stats
  // GET  /api/ab/:id
  // POST /api/ab/:id/preference
  // ══════════════════════════════════════════════════════════════════════════

  const _abMine = (req: { nexusUserId?: string }) =>
    [..._abStore.values()].filter((r) => (r.ownerId ?? null) === (req.nexusUserId ?? null));

  /** "provider:model" goes to that provider (the caller's key first); a bare id to the default. */
  async function _abDriver(
    userId: string | undefined,
    spec: string,
  ): Promise<{ driver: LlmDriver; model: string }> {
    const i = spec.indexOf(":");
    const provider = i > 0 ? spec.slice(0, i) : "";
    // A bare Ollama id ("llama3.2:1b") also has a colon; provider ids are plain words.
    if (/^[a-z_]+$/.test(provider)) {
      const { registry } = await buildChatRegistry(userId, [provider]);
      const driver = registry.get(provider);
      if (driver) return { driver, model: spec.slice(i + 1) };
      throw new Error(`No key for ${provider}. Add one under Settings → Provider keys.`);
    }
    const driver = getDefaultDriver();
    if (!driver) throw new Error("No LLM provider configured. Add a provider key in Settings.");
    return { driver, model: spec };
  }

  app.post<{ Body: { prompt?: string; modelA?: string; modelB?: string } }>(
    "/ab/run",
    async (request, reply) => {
      const prompt = request.body?.prompt?.trim();
      const { modelA, modelB } = request.body ?? {};
      if (!prompt || !modelA || !modelB) {
        return reply.code(400).send({ error: "prompt, modelA and modelB are required" });
      }

      const side = async (spec: string) => {
        const { driver, model } = await _abDriver(request.nexusUserId, spec);
        const s = Date.now();
        const r = await driver.complete({
          model,
          messages: [{ role: "user" as LlmRole, content: prompt }],
          maxTokens: 1024,
        });
        _trackCost(model, r.usage);
        return {
          content: r.content,
          latency: Date.now() - s,
          tokens: (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0),
        };
      };
      const [resultA, resultB] = await Promise.allSettled([side(modelA), side(modelB)]);
      const errText = (e: unknown) => `Error: ${e instanceof Error ? e.message : String(e)}`;

      const scoreA =
        resultA.status === "fulfilled" ? scoreResponse(resultA.value.content, prompt) : 0;
      const scoreB =
        resultB.status === "fulfilled" ? scoreResponse(resultB.value.content, prompt) : 0;

      const result: AbResult = {
        id: crypto.randomUUID(),
        ownerId: request.nexusUserId ?? null,
        prompt,
        modelA,
        modelB,
        responseA: resultA.status === "fulfilled" ? resultA.value.content : errText(resultA.reason),
        responseB: resultB.status === "fulfilled" ? resultB.value.content : errText(resultB.reason),
        latencyA: resultA.status === "fulfilled" ? resultA.value.latency : 0,
        latencyB: resultB.status === "fulfilled" ? resultB.value.latency : 0,
        tokensA: resultA.status === "fulfilled" ? resultA.value.tokens : 0,
        tokensB: resultB.status === "fulfilled" ? resultB.value.tokens : 0,
        winner: scoreA > scoreB ? "A" : scoreB > scoreA ? "B" : null,
        userPreference: null,
        createdAt: now(),
      };
      _abStore.set(result.id, result);
      return reply.send({ result });
    },
  );

  app.get("/ab", async (request, reply) => {
    return reply.send(_abMine(request).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  });

  app.get("/ab/stats", async (request, reply) => {
    const results = _abMine(request);
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
    const r = _abMine(request).find((x) => x.id === request.params.id);
    if (!r) return reply.code(404).send({ error: "not_found" });
    return reply.send(r);
  });

  app.post<{ Params: { id: string }; Body: { preference?: string } }>(
    "/ab/:id/preference",
    async (request, reply) => {
      const r = _abMine(request).find((x) => x.id === request.params.id);
      if (!r) return reply.code(404).send({ error: "not_found" });
      const pref = request.body?.preference;
      if (pref !== "A" && pref !== "B" && pref !== "tie" && pref !== "both_bad") {
        return reply.code(400).send({ error: "preference must be A, B, tie or both_bad" });
      }
      r.userPreference = pref;
      _abStore.set(r.id, r);
      return reply.send({ ok: true });
    },
  );

  // ══════════════════════════════════════════════════════════════════════════
  // B.4 — PROVIDERS
  // GET /api/providers
  // ══════════════════════════════════════════════════════════════════════════

  app.get("/providers", async (_req, reply) => {
    const ids = new Set([...getRegistry().list(), ...getUserDrivers().map((d) => d.id)]);
    const providers = [...ids].map((p) => ({ id: p, name: p, available: true }));
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
      members: { label: string; provider: string; model: string; archetypeId?: string }[];
      round: number;
      rounds?: number;
      threadId: string;
      /** Prompt modifiers the client has switched on (STM modules). */
      preamble?: string;
      /** @-mentions from the composer: { type: file | symbol | web, value }. */
      mentions?: unknown;
      /** Tee the stream into a channel and send its read ref first. */
      live?: boolean;
      /** A COUNCIL_TEMPLATES id: member roles, the chair's brief, optional ratings. */
      templateId?: string;
    };
  }>("/chat/stream", { preHandler: requireAuthWithTier }, async (request, reply) => {
    const { members, round, rounds } = request.body;
    let message = request.body.message;
    const preamble =
      typeof request.body.preamble === "string" ? request.body.preamble.slice(0, 4000).trim() : "";
    const negations =
      typeof request.body.threadId === "string"
        ? _negBlock(_negRulesFor(request, request.body.threadId))
        : "";
    // Validate BEFORE reply.hijack() — after the hijack a thrown error leaves
    // the client holding an open 200 with zero bytes forever (playtest: a
    // body without `members` hung the stream instead of answering 400).
    if (typeof message !== "string" || !message.trim()) {
      return reply
        .status(400)
        .send({ error: "message_required", message: "body.message must be a non-empty string" });
    }
    if (!Array.isArray(members) || members.length === 0) {
      return reply
        .status(400)
        .send({ error: "members_required", message: "body.members must be a non-empty array" });
    }
    // BYOK: resolve each member's key per-user (saved key first, env fallback).
    const { registry: reg, sources } = await buildChatRegistry(
      request.nexusUserId,
      members.map((m) => m.provider),
    );

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, SSE_HEADERS);
    if (request.body.live === true) {
      const { writerRef, readerRef } = createChannel();
      sseWrite(raw, { type: "live", reader: readerRef });
      liveChannels.set(raw, writerRef.channel_id);
      raw.on("close", () => closeChannel(writerRef.channel_id));
    }

    // Settings → Council Behaviour, Chat Preferences, Privacy & Safety, Content Filters.
    const prefs = {
      ..._prefsDefaults,
      ...(_prefsStore.get(request.nexusUserId ?? "") as Record<string, unknown> | undefined),
    };
    if (prefs.blockAdultContent === true) {
      const verdict = await _runModeration(message, ["sexual"]).catch(() => null);
      if (verdict?.flagged) {
        sseWrite(raw, {
          type: "error",
          message: "Blocked by your content filter: the message looks sexually explicit.",
        });
        raw.end();
        return;
      }
    }
    const pii = prefs.piiDetection === true || prefs.autoAnonymize === true ? findPii(message) : [];
    if (pii.length) {
      const kinds = [...new Set(pii.map((p) => p.type))].join(", ");
      if (prefs.autoAnonymize === true) {
        message = redactPii(message);
        sseWrite(raw, {
          type: "notice",
          message: `Removed personal details or secrets (${kinds}) before sending.`,
        });
      } else {
        sseWrite(raw, {
          type: "notice",
          message: `This message contains personal details or secrets (${kinds}). Turn on auto-anonymize in Settings to remove them before sending.`,
        });
      }
    }
    const clean = prefs.blockProfanity === true ? maskProfanity : (t: string) => t;
    message = clean(message);

    const enabled = members.filter((m) => {
      const driver = reg.get(m.provider);
      return !!driver;
    });

    if (enabled.length === 0) {
      sseWrite(raw, {
        type: "error",
        message:
          "No configured providers match the requested council members. Add a key for one of them under Settings → Provider Keys.",
      });
      raw.end();
      return;
    }

    // Debate depth cap guards resource usage from user-supplied values.
    const cap = globalFlags.getFlag("council.max_debate_rounds", MAX_DEBATE_ROUNDS);
    const debateRounds = Math.max(1, Math.min(MAX_DEBATE_ROUNDS, cap, Math.round(rounds ?? 1)));
    // Env and OAuth drivers arrive unwrapped (BYOK ones already are); the cache
    // replays a clean deterministic stream with zeroed usage.
    const driverFor = (provider: string): LlmDriver | undefined => {
      const raw = reg.get(provider) ?? reg.get("openrouter");
      return raw ? cachedDriver(raw) : undefined;
    };

    // ponytail: masking runs per streamed chunk, so a word split across two chunks slips through.
    const emitOpinion = (member: DebateMember, text: string, debateRound: number) => {
      sseWrite(raw, {
        type: "opinion",
        provider: member.provider,
        label: member.label,
        text: clean(text),
        summary: "",
        round,
        debateRound,
        keySource: sources.get(member.provider) ?? "none",
        ...(member.archetype ? { archetype: member.archetype } : {}),
      });
    };

    const emitErrorOpinion = (member: DebateMember, err: unknown, debateRound: number) => {
      sseWrite(raw, {
        type: "opinion",
        provider: member.provider,
        label: member.label,
        text: `[${member.label} error: ${err instanceof Error ? err.message : String(err)}]`,
        summary: "",
        round,
        debateRound,
        keySource: sources.get(member.provider) ?? "none",
        // Clients render member failures as failures, not as opinions.
        isError: true,
      } as Record<string, unknown>);
    };

    // Custom instructions (Profile page) ride in the per-user preferences
    // store and are prepended as a system message so every council member
    // honours them — previously the field was saved nowhere and read by
    // nothing (playtest: the Profile page advertised a no-op).
    const customInstructions = String(
      (_prefsStore.get(request.nexusUserId ?? "") as Record<string, unknown> | undefined)
        ?.customInstructions ?? "",
    )
      .slice(0, 2000)
      .trim();

    // Stage D2 — personas come from the same archetype registry /api/v1/council
    // resolves against, matched positionally to the members the client sent.
    // The client's provider and model win: those are an explicit UI choice,
    // where the archetype's model is only a default for callers that have none.
    await loadArchetypeStore();
    // A member may name its archetype; auto-council off leaves the rest as themselves.
    const personas = seatCouncil(
      request.nexusUserId ?? ANON_OWNER,
      detectTaskCategory(message),
      enabled.map((m) => (typeof m.archetypeId === "string" ? m.archetypeId : undefined)),
      prefs.autoCouncil !== false,
    );
    const redBlue =
      prefs.deliberationMode === "red_blue"
        ? (i: number) =>
            i % 2 === 0
              ? "You are on the blue team: build the strongest case for the best answer."
              : "You are on the red team: attack the weaknesses and risks in the other answers, then give your own."
        : () => "";
    const template =
      typeof request.body.templateId === "string"
        ? COUNCIL_TEMPLATES[request.body.templateId]
        : undefined;
    const debateMembers: DebateMember[] = enabled.map((m, i) => {
      const persona = personas[i];
      const role = template?.memberPrompts[i % template.memberPrompts.length];
      const systemPrompt = [persona?.systemPrompt, role, redBlue(i)].filter(Boolean).join("\n\n");
      return {
        label: m.label,
        provider: m.provider,
        model: m.model,
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(persona ? { archetype: persona.name } : {}),
        ...(persona?.temperature !== undefined ? { temperature: persona.temperature } : {}),
      };
    });

    const transport: IStreamingTransport = {
      async streamMember(member, messages, onDelta) {
        const driver = driverFor(member.provider);
        if (!driver) throw new Error(`No driver configured for provider "${member.provider}".`);
        let text = "";
        const res = await driver.stream(
          {
            model: member.model,
            messages: messages.map((m) => ({ role: m.role as LlmRole, content: m.content })),
            maxTokens: 2048,
            ...(member.temperature !== undefined ? { temperature: member.temperature } : {}),
          },
          (delta) => {
            if (delta.delta) {
              text += delta.delta;
              onDelta(delta.delta);
            }
          },
        );
        return {
          text,
          usage: {
            promptTokens: res.usage?.inputTokens ?? 0,
            completionTokens: res.usage?.outputTokens ?? 0,
          },
        };
      },
    };

    const reference = _stdPreamble(request, message);
    const dissent = _dissentPreamble(prefs.dissent);
    const domainFocus = _specialisationPreamble(request, request.body.threadId);
    const [mentioned, sourceSet] = await Promise.all([
      _mentionContext(request.body.mentions, request.nexusUserId, message, ["kb", "web"]),
      _citationSources(request.body.mentions, request.nexusUserId, message),
    ]);
    const sourcesBlock = sourcesPrompt(sourceSet);
    const style = [
      {
        concise: "Answer in two or three sentences.",
        detailed: "Give a structured, detailed answer, with headings where they help.",
        exhaustive: "Give a comprehensive answer that covers edge cases, alternatives and caveats.",
      }[String(prefs.verbosityLevel)],
      {
        socratic:
          "Work through the question Socratically: raise the key assumptions as questions, answer each, then conclude.",
        hypothesis:
          "Frame competing hypotheses, weigh the evidence for each, then say which is best supported.",
        confidence: "Give a confidence percentage for each main claim and for your final answer.",
      }[String(prefs.deliberationMode)],
    ]
      .filter(Boolean)
      .join(" ");
    const outcome = await runCouncilDebate(
      transport,
      {
        message,
        members: debateMembers,
        rounds: debateRounds,
        // Later rounds are skipped once the members agree or stop changing their answers.
        untilAgreed: true,
        // A member's model says who agrees with whom; word overlap is the fallback.
        judge: async (prompt: string) => {
          const judgeMember = enabled.find((m) => driverFor(m.provider));
          const judgeDriver = judgeMember && driverFor(judgeMember.provider);
          if (!judgeMember || !judgeDriver) throw new Error("No member can judge agreement.");
          const res = await judgeDriver.complete({
            model: judgeMember.model,
            messages: [{ role: "user" as LlmRole, content: prompt }],
            maxTokens: 600,
            temperature: 0,
          });
          _trackCost(judgeMember.model, res.usage);
          return res.content;
        },
        ...(customInstructions ||
        style ||
        preamble ||
        negations ||
        reference ||
        dissent ||
        domainFocus ||
        mentioned ||
        sourcesBlock
          ? {
              systemPreamble: [
                customInstructions &&
                  `Follow these standing user instructions:\n${customInstructions}`,
                style,
                preamble,
                negations,
                reference,
                dissent,
                domainFocus,
                mentioned,
                sourcesBlock,
              ]
                .filter(Boolean)
                .join("\n\n"),
            }
          : {}),
      },
      {
        onDelta: emitOpinion,
        onMemberError: emitErrorOpinion,
        // Round boundary, announced as part of each member's own text. Clients
        // (and persisted transcripts) concatenate opinion chunks per member, so
        // the boundary must travel IN the stream — a client-side tracker that
        // depends on ordering across events is what glued rounds together
        // (playtest: two error wrappers and two answers fused without a break).
        onRoundStart: (debateRound, roundMembers) => {
          for (const member of roundMembers) {
            emitOpinion(
              member,
              `\n\n――― round ${debateRound + 1} (sees other members' answers) ―――\n`,
              debateRound,
            );
          }
        },
        // Track the real usage once (a cache hit replays with ZEROED usage, so
        // the cost log shows the replay costing nothing).
        onUsage: (member, usage) =>
          _trackCost(member.model, {
            inputTokens: usage?.promptTokens ?? 0,
            outputTokens: usage?.completionTokens ?? 0,
          }),
      },
    );

    // Verdict. A member's model groups the stated final answers by position
    // (word overlap when it cannot), and the line names who is on each side.
    // When the members did not converge there is no majority, and the line says
    // that instead of inventing one.
    if (debateRounds > 1 && outcome.finals.length > 0) {
      const failedCount = Math.max(0, enabled.length - outcome.finals.length);
      const failureNote =
        failedCount > 0 ? ` (${failedCount} member(s) failed — see member errors)` : "";
      const { agreement } = outcome;
      const ran =
        outcome.rounds < debateRounds
          ? `stopped after ${outcome.rounds} of ${debateRounds} rounds`
          : `${debateRounds} rounds`;
      const byOverlap = outcome.judgedBy === "overlap" ? "; by word overlap" : "";
      const others = outcome.positions
        .filter((g) => !agreement?.agreeing.includes(g.members[0]!))
        .map(
          (g) =>
            `${g.members.join(" and ")} ${g.members.length > 1 ? "say" : "says"} ${g.position.slice(0, 120)}`,
        );
      const sides = agreement
        ? `agree: ${agreement.agreeing.join(", ")}${others.length ? `; disagree: ${others.join("; ")}` : ""}${byOverlap}`
        : outcome.positions
            .map((g) => `${g.members.join(", ")}: ${g.position.slice(0, 120)}`)
            .join("; ") + byOverlap;
      const text = clean(
        agreement
          ? `Debate complete (${ran}): ${agreement.agreeing.length}/${enabled.length} members converged${failureNote} (${sides}) — ${agreement.representative.slice(0, 1500)}`
          : `Debate complete (${ran}): no majority position (${sides}) — the ` +
              `${outcome.finals.length} member(s) that answered did not converge${failureNote}.`,
      );
      sseWrite(raw, { type: "verdict", text, summary: "", round });
    }

    // The chair: one member's model reads every final answer and writes the
    // synthesis, keeping the disagreements visible instead of averaging them away.
    // Chair and validator run on a member that answered, not one whose provider just failed.
    const answered = new Set(outcome.finals.map((f) => f.label));
    const lead = enabled.find((m) => answered.has(m.label));
    const chairDriver = lead && driverFor(lead.provider);
    // Settings → peer ranking: members rank each other's anonymised answers first.
    let peerLine = "";
    if (prefs.peerRanking === true && outcome.finals.length >= 2) {
      const ranked = await rankPeers(
        async (label, prompt) => {
          const member = enabled.find((m) => m.label === label);
          const driver = member && driverFor(member.provider);
          if (!member || !driver) throw new Error(`No driver for ${label}.`);
          const res = await driver.complete({
            model: member.model,
            messages: [{ role: "user" as LlmRole, content: prompt }],
            maxTokens: 300,
            temperature: 0,
          });
          _trackCost(member.model, res.usage);
          return res.content;
        },
        message,
        outcome.finals,
        Date.now(),
      ).catch(() => null);
      if (ranked) {
        peerLine = ranked.line;
        sseWrite(raw, {
          type: "verdict",
          text: `${debateRounds > 1 ? "\n\n" : ""}**${clean(ranked.line)}**`,
          summary: "",
          round,
        });
      }
    }
    let chairText = "";
    if (lead && chairDriver && outcome.finals.length >= 2) {
      const persona = new Map(debateMembers.map((m) => [m.label, m.archetype]));
      const answers = outcome.finals
        .map((f) => {
          const who = persona.get(f.label) ? `${f.label} (${persona.get(f.label)})` : f.label;
          return `### ${who}\n${f.text.slice(-3000)}`;
        })
        .join("\n\n");
      let gap = debateRounds > 1 || peerLine ? "\n\n" : "";
      try {
        const res = await chairDriver.stream(
          {
            model: lead.model,
            maxTokens: 900,
            messages: [
              {
                role: "system",
                content:
                  (template ? `${template.masterPrompt}\n\n` : "") +
                  "You chair a council of AI members. Write the council's synthesis in Markdown with these parts: " +
                  "**Answer** (the recommendation in one to three sentences), **Where the council agrees**, " +
                  "**Where it disagrees** (name the members on each side), and **What would settle it**. " +
                  "Be concrete, use only what the members said, and stay under 250 words." +
                  (sourceSet.sources.length ? " Keep the members' [n] source citations." : "") +
                  (peerLine
                    ? ` The members ranked each other's anonymised answers (Borda count): ${peerLine}. ` +
                      "Lead with the top-ranked answer unless its reasoning fails, and say so when you depart from it."
                    : ""),
              },
              { role: "user", content: `Question: ${message}\n\nFinal answers:\n\n${answers}` },
            ],
          },
          (delta) => {
            if (!delta.delta) return;
            chairText += delta.delta;
            sseWrite(raw, { type: "verdict", text: gap + clean(delta.delta), summary: "", round });
            gap = "";
          },
        );
        _trackCost(lead.model, res.usage);
      } catch (err) {
        sseWrite(raw, {
          type: "notice",
          message: `The synthesis could not be written: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    const modelOf = new Map(enabled.map((m) => [m.label, m.model]));
    for (const f of outcome.finals)
      observeAnswer(request.nexusUserId ?? ANON_OWNER, modelOf.get(f.label) ?? f.label, f.text);
    if (outcome.agreement) {
      const agreeing = new Set(outcome.agreement.agreeing);
      void recordCouncilRun(
        request.nexusUserId ?? ANON_OWNER,
        message,
        outcome.finals.map((f) => ({
          model: modelOf.get(f.label) ?? f.label,
          agreed: agreeing.has(f.label),
        })),
      ).catch(() => undefined);
    }

    if (template?.rating && outcome.finals.length > 0) {
      const { line } = summarizeRatings(outcome.finals);
      sseWrite(raw, { type: "verdict", text: `\n\n**${line}**`, summary: "", round });
    }

    const validatorDriver = lead && driverFor(lead.provider);
    if (prefs.coldValidator === true && lead && validatorDriver) {
      const validator: DebateMember = {
        label: "Cold validator",
        provider: lead.provider,
        model: lead.model,
      };
      try {
        const res = await validatorDriver.complete({
          model: validator.model,
          maxTokens: 1024,
          messages: [
            {
              role: "system",
              content:
                "You are a cold, sceptical validator. Check the answers below for factual errors, unsupported claims and missing caveats. List the problems briefly, then give a corrected final answer.",
            },
            {
              role: "user",
              content: `Question: ${message}\n\n${outcome.finals
                .map((f) => `${f.label}:\n${f.text.slice(0, 4000)}`)
                .join("\n\n")}`,
            },
          ],
        });
        _trackCost(validator.model, res.usage);
        emitOpinion(validator, res.content, debateRounds);
      } catch (err) {
        emitErrorOpinion(validator, err, debateRounds);
      }
    }

    if (sourceSet.sources.length) {
      const answer = chairText || outcome.finals.map((f) => f.text).join("\n\n");
      let cited = citedNumbers(answer, sourceSet.sources.length);
      if (!cited.size) {
        const embedder = getEmbedder();
        cited = await supportingNumbers(answer, sourceSet, (texts) =>
          Promise.all(texts.map((t) => embedder.embed(t))),
        ).catch(() => new Set<number>());
      }
      sseWrite(raw, { type: "verdict", text: sourcesFooter(sourceSet, cited), summary: "", round });
    }

    const latest = new Map(outcome.finals.map((f) => [f.label, f.text]));

    // Each member's stated position, scoped to the user so user-scoped recall finds it.
    if (request.nexusUserId) {
      for (const member of enabled) {
        const text = extractFinalAnswer(latest.get(member.label) ?? "");
        if (text) {
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
      const branches = code.match(/\b(if|for|while|case|catch)\b|&&|\|\||\?/g)?.length ?? 0;
      const complexity = Math.min(10, 1 + Math.floor(lines.length / 40) + Math.floor(branches / 8));
      const language = _guessLanguage(code);
      const roles = [
        {
          id: "review",
          label: "Code Review",
          icon: "🔍",
          focus: "readability, naming, duplication and maintainability",
        },
        {
          id: "security",
          label: "Security",
          icon: "🛡",
          focus: "injection, unsafe input handling, secrets, authn/authz and unsafe APIs",
        },
        {
          id: "performance",
          label: "Performance",
          icon: "⚡",
          focus: "algorithmic cost, needless work, blocking calls and memory use",
        },
        {
          id: "correctness",
          label: "Correctness",
          icon: "✅",
          focus: "bugs, edge cases, off-by-one errors, error handling and races",
        },
        {
          id: "architecture",
          label: "Architecture",
          icon: "🏛",
          focus: "structure, coupling, responsibilities and testability",
        },
      ];
      const driver = getDefaultDriver();
      if (!driver) return reply.code(503).send({ error: NO_LLM_MESSAGE });
      const context = await _mentionContext(
        (body as { mentions?: unknown }).mentions,
        request.nexusUserId,
        body.question ?? "",
      );

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, SSE_HEADERS);
      sseWrite(raw, {
        type: "init",
        language,
        linesOfCode: lines.length,
        complexity,
        roles: roles.map(({ id, label, icon }) => ({ id, label, icon })),
      });
      const started = Date.now();
      let issueCount = 0;
      let suggestionCount = 0;
      await Promise.all(
        roles.map(async (role) => {
          const t0 = Date.now();
          try {
            const res = await driver.complete({
              model: DEFAULT_MODEL,
              maxTokens: 1200,
              messages: [
                {
                  role: "system",
                  content:
                    `You are a ${role.label} specialist reviewing ${language} code. Focus only on ${role.focus}. ` +
                    'List each concrete finding on its own line starting with "- " and cite line numbers. ' +
                    "If a fix is worth showing, end with one fenced code block containing the full corrected code. " +
                    "If you find nothing in your area, say so in one line.",
                },
                {
                  role: "user",
                  content:
                    (body.question ? `Question: ${body.question}\n\n` : "") +
                    (context ? `Context:\n${context}\n\n` : "") +
                    "Code:\n```\n" +
                    code.slice(0, 40_000) +
                    "\n```",
                },
              ],
            });
            _trackCost(DEFAULT_MODEL, res.usage);
            const text = res.content.trim();
            issueCount += text.split("\n").filter((l) => /^\s*[-*] /.test(l)).length;
            if (text.includes("```")) suggestionCount++;
            sseWrite(raw, {
              type: "response",
              roleId: role.id,
              text,
              latencyMs: Date.now() - t0,
              tokens: (res.usage?.inputTokens ?? 0) + (res.usage?.outputTokens ?? 0),
              status: "done",
            });
          } catch (err) {
            sseWrite(raw, {
              type: "response",
              roleId: role.id,
              text: "",
              latencyMs: Date.now() - t0,
              tokens: 0,
              status: "error",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }),
      );
      sseWrite(raw, {
        type: "done",
        totalMs: Date.now() - started,
        language,
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

  // -- MEMORY — owned by routes/memory-bridge.ts (§16.7) --------------------
  // (The rest of the bridge memory surface — backend config, compact,
  // delete-all — lives in the same module; see below.)
  await memoryBridgeRoutes(app, { getMemory });

  // -- KNOWLEDGE-GRAPH SYNC — owned by routes/kg.ts --------------------------
  await kgRoutes(app);

  // -- KNOWLEDGE BASES — owned by routes/kb.ts (§16.7) ----------------------
  // Listing, CRUD, documents and the KG-ingestion alias live in the module.
  await kbRoutes(app, { getKG, getMemory, getScraper, llm: _llm });
  await searchRoutes(app, { getMemory, webSearch: _webSearch, llm: _llm });

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

  // Custom instructions (Profile page) persist in the same per-user store so
  // the chat stream can read them; previously PATCH /auth/me 400'd on the
  // field (the users table has no such column) and the save was a silent
  // no-op with a fake success toast.
  app.patch<{ Body: { customInstructions?: unknown } }>(
    "/settings/preferences",
    _prefsPreHandler,
    async (request, reply) => {
      const uid = userIdOf(request);
      if (typeof request.body?.customInstructions !== "string") {
        return reply
          .code(400)
          .send({ error: "invalid_body", message: "customInstructions must be a string" });
      }
      const merged = {
        ...(_prefsStore.get(uid) ?? {}),
        customInstructions: request.body.customInstructions.slice(0, 2000),
      };
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
      mode: "api",
      provider: "openai",
      model: "gpt-5.6-sol",
      baseUrl: "https://api.openai.com/v1",
    },
    {
      id: "gemini",
      label: "Gemini",
      enabled: true,
      mode: "api",
      provider: "gemini",
      model: "gemini-3.6-flash",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    },
    {
      id: "claude",
      label: "Claude",
      enabled: true,
      mode: "api",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      baseUrl: "https://api.anthropic.com",
    },
  ];

  const userIdOf = (request: { nexusUserId?: string }): string => request.nexusUserId ?? "local";

  /** Up to three providers the caller saved keys for; the catalogue seed when there are none. */
  const seedCouncil = async (userId: string | undefined) => {
    const drivers = await listUserDrivers(userId).catch(() => []);
    const named = new Map(
      (await listUserModels(userId).catch(() => [])).map((r) => [r.provider, r.models]),
    );
    const members = drivers.slice(0, 3).map(({ id, driver }) => ({
      id: `key-${id}`,
      label: id,
      enabled: true,
      mode: "api",
      provider: id,
      model: named.get(id)?.[0] ?? driver.model,
    }));
    return members.length > 0 ? members : _COUNCIL_SEED_MEMBERS;
  };

  app.get("/settings/council", { preHandler: requireAuthWithTier }, async (request, reply) => {
    const uid = userIdOf(request);
    const stored = _councilStore.get(uid);
    const seed = stored ? _COUNCIL_SEED_MEMBERS : await seedCouncil(request.nexusUserId);
    const body = stored?.members ?? { members: seed };
    // Strip any legacy secret fields that may have been persisted before the
    // server-side sanitizer existed — never serve them back.
    const members = stripMemberSecrets((body as { members?: unknown } | null)?.members) ?? seed;
    // BYOK: report which key backs each member (saved key, linked account,
    // server env key, local Ollama, or none). Only the source label leaves the server.
    const { sources } = await buildChatRegistry(
      uid,
      Array.isArray(members) ? members.map((m) => (m as { provider: string }).provider) : [],
    );
    const withSources = Array.isArray(members)
      ? members.map((m) => ({
          ...m,
          mode: "api",
          keySource: sources.get((m as { provider: string }).provider) ?? "none",
        }))
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
        if (SECRET_MEMBER_KEYS.has(k) || k === "__proto__") continue;
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
    const list = Array.isArray(members) ? (members as { provider: string }[]) : [];
    const { sources } = await buildChatRegistry(
      uid,
      list.map((m) => m.provider),
    );
    const validations = await validateCouncilMembers(uid, members, sources);
    const keySources = list.map((m, index) => ({
      index,
      source: sources.get(m.provider) ?? "none",
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

  // -- WORKFLOWS — owned by routes/workflows.ts (§16.7) ---------------------
  // Runs use the bridge's LLM wiring (getDefaultDriver/buildChatRegistry) via
  // explicit injection — the module has no circular import.
  await workflowsRoutes(app, { getDefaultDriver, buildChatRegistry });

  // -- API TOKENS — owned by routes/tokens.ts (§16.7) -----------------------
  await app.register(tokensRoutes);

  // -- WEB SEARCH ------------------------------------------------------------
  // The first provider with a key or URL answers; DuckDuckGo needs neither and goes last.

  interface WebSearchHit {
    url: string;
    title: string;
    snippet: string;
    score: number;
  }

  /** Search providers in preference order; each runs only when its key or URL is set. */
  async function _searchProviders(userId: string | undefined) {
    const exaKey = await serviceKey(userId, "exa", "EXA_API_KEY");
    const tavilyKey = await serviceKey(userId, "tavily", "TAVILY_API_KEY");
    const fromDocs = (docs: Awaited<ReturnType<typeof searchBrave>>) =>
      docs.map((r) => ({
        url: String(r.metadata?.url ?? ""),
        title: String(r.metadata?.title ?? ""),
        snippet: r.content?.slice(0, 300) ?? "",
        score: r.score,
      }));
    return [
      {
        id: "exa",
        name: "Exa",
        ready: !!exaKey,
        run: async (q: string) => fromDocs(await searchExa(q, { apiKey: exaKey! })),
      },
      {
        id: "brave",
        name: "Brave",
        ready: !!process.env.BRAVE_API_KEY,
        run: async (q: string) => fromDocs(await searchBrave(q)),
      },
      {
        id: "serper",
        name: "Serper",
        ready: !!process.env.SERPER_API_KEY,
        run: async (q: string) => fromDocs(await searchSerper(q)),
      },
      {
        id: "tavily",
        name: "Tavily",
        ready: !!tavilyKey,
        run: async (q: string, n: number) => {
          const res = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              api_key: tavilyKey,
              query: q,
              search_depth: "basic",
              max_results: n,
            }),
            signal: AbortSignal.timeout(8_000),
          });
          if (!res.ok) throw new Error(`Tavily ${res.status}`);
          const data = (await res.json()) as {
            results?: { url: string; title: string; content: string; score?: number }[];
          };
          return (data.results ?? []).map((r) => ({
            url: r.url,
            title: r.title,
            snippet: r.content?.slice(0, 300) ?? "",
            score: r.score ?? 0.8,
          }));
        },
      },
      {
        id: "searxng",
        name: "SearXNG",
        ready: !!process.env.SEARXNG_URL,
        run: async (q: string) => {
          const { results } = await searchSearxNG(q, { timeoutMs: 8_000 });
          return results.map((r, i) => ({
            url: r.url,
            title: r.title,
            snippet: r.content?.slice(0, 300) ?? "",
            score: 1 - i * 0.05,
          }));
        },
      },
      { id: "duckduckgo", name: "DuckDuckGo", ready: true, run: searchDuckDuckGo },
    ];
  }

  async function _webSearch(
    query: string,
    opts: { provider?: string; max?: number } = {},
  ): Promise<{ results: WebSearchHit[]; provider: string | null; error?: string }> {
    if (!globalFlags.isEnabled("search.web")) {
      return { results: [], provider: null, error: "web search is turned off by an admin" };
    }
    const max = Math.min(Math.max(opts.max ?? 10, 1), 20);
    const all = (await _searchProviders(getCacheUserId() ?? undefined)).filter((p) => p.ready);
    const chosen = opts.provider ? all.filter((p) => p.id === opts.provider) : all;
    let error: string | undefined;
    for (const p of chosen) {
      try {
        return { results: (await p.run(query, max)).slice(0, max), provider: p.id };
      } catch (e) {
        error = `${p.name}: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    return { results: [], provider: null, error };
  }

  // -- COSTS (real — derived from _costLog accumulated by _llm() helper) ------
  // §16.7: the /costs/* surface lives in routes/costs.ts (same mount, same
  // scope, byte-identical response shapes).

  /**
   * Roll _costLog into a zero-filled per-day series for the last `days` days.
   * Single implementation shared by /costs-style analytics, the /dashboard
   * aggregate, and /analytics/daily (which renames the keys for its consumers).
   */
  function dailyUsageSeries(days: number, entries: readonly CostEntry[] = _costLog) {
    const byDay: Record<string, { requests: number; tokens: number; costUsd: number }> = {};
    for (const e of entries) {
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

  // §16.7 extraction: the /costs/* handlers live in routes/costs.ts (single
  // owner, byte-identical response shapes).
  await app.register(costsRoutes);

  // -- ANALYTICS -------------------------------------------------------------

  app.get("/analytics/overview", { preHandler: requireAdminRoleBridge }, async (_req, reply) => {
    // Instance-wide: accounts, spend from the cost log, traffic from the gateway log.
    const totalUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(isNull(users.deletedAt))
      .then((r) => r.length)
      .catch(() => null);
    const costUsd = _costLog.reduce((sum, e) => sum + e.costUsd, 0);
    try {
      const s = await gatewayLog.stats();
      const requests = s.totalRequests;
      const tokens =
        s.totalTokens || _costLog.reduce((sum, e) => sum + e.inputTokens + e.outputTokens, 0);
      const errorRate = requests > 0 ? s.errorRequests / requests : 0;
      return reply.send({
        totalUsers,
        costUsd,
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
        totalUsers,
        costUsd,
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
        const entries = scopeCostEntriesToUser(_costLog, request.nexusUserId).filter((e) =>
          inWeek(e.ts.slice(0, 10)),
        );
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
        const agentRuns = allRuns().filter(
          (r) =>
            r.ownerId === (request.nexusUserId ?? ANON_OWNER) &&
            r.finishedAt !== null &&
            inWeek(r.finishedAt.slice(0, 10)),
        ).length;
        return {
          requests: entries.length,
          tokens,
          costUsd,
          topModel,
          researchCount,
          agentRuns,
          pendingApprovals: pendingCount(request.nexusUserId ?? ANON_OWNER),
        };
      });

      // Window length for the series (1–90, default 7); the client picks how
      // many points it needs for its Today/7d/30d summaries.
      const days = Math.min(Math.max(parseInt(request.query.days ?? "7", 10) || 7, 1), 90);
      // Personal scope: the dashboard says "your usage", so it must sum only
      // the caller's own entries — the raw _costLog is server-global (a fresh
      // account showed every user's spend as its own). Gateway-log stats are
      // likewise unattributed (identity = token slice), so the operator-global
      // latency/error enrichment stays on /analytics/overview only.
      const myEntries = scopeCostEntriesToUser(_costLog, request.nexusUserId);
      const tokens = myEntries.reduce((sum, e) => sum + e.inputTokens + e.outputTokens, 0);
      const costUsd = myEntries.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
      const stats: Record<string, unknown> = {
        requests: myEntries.length,
        tokens,
        costUsd: Math.round(costUsd * 10000) / 10000,
        latencyP50ms: 0,
        latencyP99ms: 0,
        errorRate: 0,
        source: "cost-log",
      };

      // Research rows now come from the durable per-user store (newest first) —
      // dashboard + deep links + history all read the same persisted records.
      const researchJobs = await listResearchJobs(request.nexusUserId);
      return reply.send({
        stats,
        series: dailyUsageSeries(days, myEntries),
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

  // -- SANDBOX — owned by routes/sandbox.ts (§16.7) --------------------------
  // JS via vm, Python via Pyodide (WASM), others via a self-hosted Piston.
  // runViaPyodide / runViaPiston are imported from there for the code-agent
  // build/run path below; _dockerReady feeds /sandbox/status telemetry.

  const _dockerReady = isDockerAvailable();
  await sandboxRoutes(app, { dockerReady: _dockerReady });

  // -- CONNECTORS ------------------------------------------------------------

  // -- ADMIN -----------------------------------------------------------------
  // (playtest round 4) The /admin/users GET/PUT duplicates that lived here were
  // unguarded — any authenticated user could list every user's email or PUT
  // themselves to role "owner" (privilege escalation, demonstrated live).
  // The guarded surface is /api/v1/admin/users (routes/admin-users.ts) — use it.

  app.get("/admin/audit-logs", { preHandler: requireAdminRoleBridge }, async (_req, reply) => {
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

  // -- BILLING: usage (real, user-scoped) ---------------------------------------
  // Frontend: apps/ui/app/routes/billing.tsx. No subscriptions exist (free +
  // BYOK is a locked roadmap decision) — the old synthetic store invented a
  // "pro" subscription per tenant and fabricated token usage from
  // (tenantId.length * 13_037), which a real user saw as their own spend.
  app.get<{ Params: { tid: string } }>("/billing/subscription/:tid", async (_req, reply) => {
    return reply.send({
      planId: "free",
      status: "active",
      note: "Nexus is free — no subscriptions exist.",
    });
  });

  app.get<{ Params: { tid: string } }>("/billing/usage/:tid", async (req, reply) => {
    const periodStart = new Date();
    periodStart.setDate(periodStart.getDate() - 30);
    const entries = scopeCostEntriesToUser(_costLog, req.nexusUserId).filter(
      (e) => new Date(e.ts).getTime() >= periodStart.getTime(),
    );
    return reply.send({
      periodStart: periodStart.toISOString(),
      periodEnd: new Date().toISOString(),
      requests: entries.length,
      tokensIn: entries.reduce((s, e) => s + e.inputTokens, 0),
      tokensOut: entries.reduce((s, e) => s + e.outputTokens, 0),
      cost: Math.round(entries.reduce((s, e) => s + e.costUsd, 0) * 10_000) / 10_000,
      byModel: entries.reduce<Record<string, { requests: number; cost: number }>>((acc, e) => {
        const m = (acc[e.model] ??= { requests: 0, cost: 0 });
        m.requests++;
        m.cost = Math.round((m.cost + e.costUsd) * 10_000) / 10_000;
        return acc;
      }, {}),
    });
  });

  app.post<{ Params: { tid: string } }>("/billing/cancel/:tid", async (_req, reply) => {
    return reply.code(400).send({
      error: "no_subscription",
      message: "Nexus is free — there is no subscription to cancel.",
    });
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
    // Service keys for non-chat features: image models, web search, voice.
    "replicate",
    "flux",
    "stability",
    "recraft",
    "fal",
    "tavily",
    "exa",
    "github",
    "elevenlabs",
    "deepgram",
    "cartesia",
    "assemblyai",
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
    // Any other name is an OpenAI-compatible endpoint, used as `<name>/<model>`.
    if (!VALID_PROVIDERS.includes(provider as ProviderName)) {
      const why = baseUrl
        ? compatibleEndpointError(provider, baseUrl, models)
        : "baseUrl is required";
      if (why)
        return reply
          .code(400)
          .send({ error: "invalid_provider", message: why, valid: VALID_PROVIDERS });
    }
    // Every name, built-in ones like ollama included, meets the same address rule.
    const badUrl = baseUrl ? unsafeUrlReason(baseUrl) : null;
    if (badUrl) return reply.code(400).send({ error: "invalid_base_url", message: badUrl });
    if (apiKey && apiKey.length < 8) return reply.code(400).send({ error: "apiKey too short" });

    const userId = await requireUserId(request, reply);
    if (!userId) return;
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

    invalidateUserDrivers(userId);
    return reply.code(201).send(row);
  });

  // GET /user/provider-keys — list active keys (prefix only, never raw key)
  app.get("/user/provider-keys", { preHandler: requireAuthWithTier }, async (request, reply) => {
    const userId = await requireUserId(request, reply);
    if (!userId) return;
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
      const userId = await requireUserId(request, reply);
      if (!userId) return;
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
      invalidateUserDrivers(userId);
      return reply.send({ ok: true });
    },
  );

  // NOTE: the former GET /user/provider-keys/resolve/:provider endpoint was
  // intentionally removed — decrypted keys must never be returned over HTTP.
  // Server-side callers use resolveUserProviderKey() instead.

  // -- FEEDBACK --------------------------------------------------------------
  // Ratings people give answers (routes/rlhf.ts), summed across every account.

  app.get("/feedback/stats", { preHandler: requireAdminRoleBridge }, async (_req, reply) => {
    const entries = allFeedback();
    const positiveCount = entries.filter((e) => e.rating === "thumbs_up").length;
    const negativeCount = entries.filter((e) => e.rating === "thumbs_down").length;
    const byModel: Record<string, number> = {};
    for (const e of entries) byModel[e.model] = (byModel[e.model] ?? 0) + 1;
    const days = Array.from({ length: 7 }, (_, i) =>
      new Date(Date.now() - (6 - i) * 86_400_000).toISOString().slice(0, 10),
    );
    const recentTrend = days.map((date) => {
      const that = entries.filter((e) => e.createdAt.startsWith(date));
      return {
        date,
        positive: that.filter((e) => e.rating === "thumbs_up").length,
        negative: that.filter((e) => e.rating === "thumbs_down").length,
      };
    });
    const rated = positiveCount + negativeCount;
    return reply.send({
      totalFeedback: entries.length,
      positiveCount,
      negativeCount,
      positiveRate: rated ? positiveCount / rated : 0,
      byModel,
      recentTrend,
    });
  });

  app.get("/feedback/export", { preHandler: requireAdminRoleBridge }, async (_req, reply) =>
    reply.send({ entries: allFeedback() }),
  );

  // -- CONNECTORS — owned by routes/connectors-bridge.ts (§16.7) -------------
  // Seed + load live in the module; byte-identical response shapes.
  await connectorsBridgeRoutes(app, { getMemory });

  const NO_LLM = NO_LLM_MESSAGE;

  // -- SKILLS ----------------------------------------------------------------
  // Owner: routes/skills.ts — GET/POST/DELETE /skills plus POST /skills/merge
  // live there (PersistentStore collection "skills", same /api scope, same
  // auth). api-bridge only supplies the narrow driver/cost deps.
  await registerSkillRoutes(app, {
    defaultModel: DEFAULT_MODEL,
    getDefaultDriver,
    trackCost: _trackCost,
  });

  // KB CRUD + documents live in routes/kb.ts (§16.7) — registered above.

  // -- TOKEN USAGE (LLM token consumption stats) ----------------------------
  // Distinct from /tokens (API key management). Reads from _costLog accumulated
  // by _llm() helper calls.

  app.get("/token-usage", async (req, reply) => {
    // Single pass over the caller's entries: compute used, byModel, byDay simultaneously
    let used = 0;
    const byModel: Record<string, number> = {};
    const byDayMap: Record<string, number> = {};
    for (const e of scopeCostEntriesToUser(_costLog, req.nexusUserId)) {
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
    webSearch: _webSearch,
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

  const _kernelManager = new KernelManager({
    executor: new DockerReplExecutor(),
    jupyterMode: true,
  });

  /** Kernels run code, so the exec policy decides first: readonly mode and deny rules apply. */
  const replRefused = async (request: FastifyRequest, reply: FastifyReply, language: string) =>
    (await guardExec(request, reply, { surface: "repl", command: language })) === "handled";

  // A kernel holds its caller's variables and files; ids are sequential, so ownership is the guard.
  const _kernelOwners = new Map<string, string>();
  const ownsKernel = (request: FastifyRequest, id: string) =>
    _kernelOwners.get(id) === ownerIdFor(request);

  /** The kernels, or null after a 503: without Docker nothing runs, and an empty success would lie. */
  async function _getKernelManager(reply: FastifyReply): Promise<KernelManager | null> {
    if (await _dockerReady) return _kernelManager;
    await reply
      .code(503)
      .send({ error: "docker_required", message: "Running code needs Docker on this machine." });
    return null;
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
      if (await replRefused(request, reply, language)) return;
      const km = await _getKernelManager(reply);
      if (!km) return;
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
      const km = await _getKernelManager(reply);
      if (!km) return;
      const session = km.create(language);
      _kernelOwners.set(session.id, ownerIdFor(request));
      return reply.code(201).send({
        sessionId: session.id,
        language,
        createdAt: now(),
      });
    },
  );

  /** GET /code-agent/sessions — list active kernel sessions. */
  app.get("/code-agent/sessions", async (request, reply) => {
    const km = _kernelManager;
    return reply.send({
      sessions: km
        .list()
        .filter((s) => ownsKernel(request, s.id))
        .map((s) => ({
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
      const km = await _getKernelManager(reply);
      if (!km) return;
      const session = ownsKernel(request, request.params.id)
        ? km.get(request.params.id)
        : undefined;
      if (!session) {
        return reply.code(404).send({ error: "session_not_found", sessionId: request.params.id });
      }
      const { code, timeoutMs = 10_000 } = request.body;
      if (await replRefused(request, reply, session.language)) return;
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
    const km = _kernelManager;
    if (!ownsKernel(request, request.params.id) || !km.has(request.params.id)) {
      return reply.code(404).send({ error: "session_not_found" });
    }
    km.destroy(request.params.id);
    _kernelOwners.delete(request.params.id);
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
    const { task, language = "python" } = request.body ?? {};
    if (!task?.trim()) return reply.code(400).send({ error: "task is required" });
    const gate = { surface: "sandbox" as const, command: language.toLowerCase() };
    if ((await guardExec(request, reply, gate)) === "handled") return;
    const driver = getDefaultDriver();
    if (!driver) {
      return reply.code(402).send({
        error: "no_api_key",
        message: "Add your API key in Language Models settings (BYOK) to use Code Agent.",
      });
    }

    const sessionId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const systemPrompt = `You are a code generation assistant. Write clean, runnable ${language} code to complete the task.
Output ONLY the code — no markdown fences, no explanation, no comments unless required by the code.`;

    try {
      // Step 1: Generate code via the caller's model
      const res = await driver.complete({
        model: DEFAULT_MODEL,
        messages: [systemMsg(systemPrompt), userMsg(task)],
        temperature: 0.2,
        maxTokens: 2048,
      });
      _trackCost(DEFAULT_MODEL, res.usage);
      const generatedCode = res.content
        .trim()
        .replace(/^```[a-z]*\n?/, "")
        .replace(/\n?```$/, "");
      if (!generatedCode) {
        return reply.code(502).send({ error: "empty_code", message: "LLM returned no code" });
      }

      // Step 2: Execute the generated code
      const lang = language.toLowerCase();
      let finalOutput = "";
      let finalError: string | undefined;
      const iterations = 1;

      if (lang === "javascript" || lang === "js") {
        const r = await runUntrustedJs(generatedCode, 5_000);
        finalOutput = r.stdout;
        finalError = r.exitCode === 0 ? undefined : r.stderr;
      } else if (lang === "python" || lang === "py" || lang === "python3") {
        // Python runs locally via Pyodide (WASM) — no Piston needed.
        try {
          const pr = await runViaPyodide(generatedCode);
          finalOutput = pr.stdout;
          finalError = pr.exitCode !== 0 ? pr.stderr : undefined;
        } catch (e) {
          finalError = e instanceof Error ? e.message : String(e);
        }
      } else {
        // Other languages → Piston (guarded against the dead public endpoint).
        try {
          const pr = await runViaPiston(generatedCode, lang);
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
      if (await replRefused(request, reply, language)) return;
      const km = await _getKernelManager(reply);
      if (!km) return;
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
  //        Lazy-init: PatchrightDriver when available, else 503
  // ══════════════════════════════════════════════════════════════════════════

  let _stealthBrowser: StealthBrowser | null = null;

  /** The real browser, or a 503 error: a mock page would pass for a site that was never visited. */
  async function _getBrowser(): Promise<StealthBrowser> {
    if (_stealthBrowser) return _stealthBrowser;
    if (!(await isPatchrightAvailable()))
      throw Object.assign(new Error("Browsing needs Patchright installed on this machine."), {
        statusCode: 503,
      });
    _stealthBrowser = new StealthBrowser({
      driver: new PatchrightDriver({ requestVia: pinnedFetch }),
    });
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
      const unsafe = unsafeUrlReason(request.body.url);
      if (unsafe) return reply.code(400).send({ error: unsafe });
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
      const unsafe = unsafeUrlReason(request.body.url);
      if (unsafe) return reply.code(400).send({ error: unsafe });
      const browser = await _getBrowser();
      return browser.withPage(async (page) => {
        await page.goto(request.body.url);
        const title = await page.title();
        // Extract visible text and all href links via JS eval
        const text = await page.evaluate<string>("document.body?.innerText ?? ''");
        const links = await page.evaluate<string[]>(
          "Array.from(document.querySelectorAll('a[href]')).map(a => a.href).filter(h => h.startsWith('http')).slice(0, 100)",
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
      const unsafe = unsafeUrlReason(request.body.url);
      if (unsafe) return reply.code(400).send({ error: unsafe });
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
  //        chromium); without one the routes answer 503.
  // ══════════════════════════════════════════════════════════════════════════

  const _browserSessions = new PersistentStore<BrowserAgentSession & { ownerId?: string | null }>(
    "browser_agent_sessions",
  );
  const _mySession = (req: { nexusUserId?: string }, s?: { ownerId?: string | null }) =>
    !!s && (s.ownerId ?? null) === (req.nexusUserId ?? null);
  await _browserSessions.load();
  // A session left running belonged to a process that is gone. The queue, or
  // with none this process as its owner, finishes it from the recorded steps.
  for (const stale of [..._browserSessions.values()]) {
    if (stale.status !== "running" && stale.status !== "pending") continue;
    void launchBrowserTask(stale.id).then(async (queued) => {
      if (!queued)
        await asUser(stale.ownerId ?? null, () => _runBrowserAgent(stale)).catch((e: unknown) =>
          _saveSession({
            ...stale,
            status: "error",
            error: e instanceof Error ? e.message : String(e),
          }),
        );
      return queued;
    });
  }
  const MAX_AGENT_STEPS = DEFAULT_MAX_AGENT_STEPS;

  /** Persist a session after mutating it — the store is not a live object. */
  function _saveSession(session: BrowserAgentSession & { ownerId?: string | null }): void {
    // The agent loop saves its own copy of the session, which does not carry the owner.
    const ownerId = session.ownerId ?? _browserSessions.get(session.id)?.ownerId ?? null;
    _browserSessions.set(session.id, { ...session, ownerId });
  }

  /** Ask the LLM for the next browser action given the current page state. */
  async function _nextBrowserAction(context: BrowserAgentContext): Promise<BrowserAgentDecision> {
    const { system, user } = browserDecisionMessages(context);
    // Groq for the decision loop: fast, and reliably available here.
    const reg = getRegistry();
    const drv = reg.get("groq") ?? getDefaultDriver();
    let raw = "";
    if (drv) {
      try {
        const r = await drv.complete({
          model: reg.get("groq") ? "openai/gpt-oss-120b" : DEFAULT_MODEL,
          messages: [systemMsg(system), userMsg(user)],
          maxTokens: 400,
        });
        raw = (r.content ?? "").trim();
      } catch {
        raw = "";
      }
    }
    return parseBrowserDecision(raw);
  }

  /** Run the agent loop on a live page until done / max steps. Mutates session. */
  async function _runBrowserAgent(session: BrowserAgentSession): Promise<void> {
    const browser = await _getBrowser();
    await runBrowserAgentTask(session, {
      withPage: (fn) => browser.withPage(fn),
      decide: _nextBrowserAction,
      save: _saveSession,
      maxSteps: MAX_AGENT_STEPS,
    });
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
      const sessionId = crypto.randomUUID();
      const session: BrowserAgentSession & { ownerId?: string | null } = {
        id: sessionId,
        ownerId: request.nexusUserId ?? null,
        sessionId,
        task: request.body.task,
        url: request.body.startUrl,
        status: "pending",
        steps: [],
        createdAt: now(),
      };

      if (!patchrightOk && !hasCdp) {
        session.status = "error";
        session.error =
          "No browser engine available. Install patchright on the server (pnpm add patchright && npx patchright install chromium) " +
          "or set BROWSER_CDP_URL to a hosted browser (Browserbase/Steel). Browser automation cannot drive your personal logged-in browser from a website.";
        _saveSession(session);
        return reply.code(200).send({ session });
      }

      // Stored before it is queued: the worker reads it from the store as soon as it picks it up.
      await _browserSessions.save(sessionId, session);
      // Answer before the run. Up to MAX_AGENT_STEPS LLM calls plus that many
      // page loads is minutes, which is longer than any reasonable HTTP
      // timeout; the client polls /sessions/:id, which it already does.
      // The worker owns the run when a queue is configured, so a restart
      // resumes it; without one the loop stays in this process, where a restart
      // is still the end of it.
      if (!(await launchBrowserTask(sessionId))) {
        void _runBrowserAgent(session).catch((e: unknown) => {
          session.status = "error";
          session.error = e instanceof Error ? e.message : String(e);
          _saveSession(session);
        });
      }
      return reply.code(202).send({ session });
    },
  );

  app.get("/browser-agent/sessions", async (request, reply) => {
    const sessions = Array.from(_browserSessions.values())
      .filter((s) => _mySession(request, s))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return reply.send({ sessions });
  });

  app.get<{ Params: { id: string } }>("/browser-agent/sessions/:id", async (request, reply) => {
    // Refresh first: when the worker owns the run, every step it records lands
    // in the backing store, and this process's copy is whatever it last wrote.
    const session =
      (await _browserSessions.refresh(request.params.id)) ??
      _browserSessions.get(request.params.id);
    if (!session || !_mySession(request, session))
      return reply.code(404).send({ error: "session not found" });
    return reply.send(session);
  });

  app.post<{
    Params: { id: string };
    Body: { action: BrowserActionType; target?: string; value?: string };
  }>("/browser-agent/sessions/:id/action", async (request, reply) => {
    const session = _browserSessions.get(request.params.id);
    if (!session || !_mySession(request, session))
      return reply.code(404).send({ error: "session not found" });
    const { action, target, value } = request.body ?? {};
    if (!action) return reply.code(400).send({ error: "action is required" });
    const browser = await _getBrowser();
    let ok = true;
    let screenshot: string | undefined;
    try {
      await browser.withPage(async (page) => {
        if (session.url) {
          await applyBrowserAction(page, { type: "navigate", selector: session.url });
        }
        await applyBrowserAction(page, { type: action, selector: target, value });
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
    _saveSession(session);
    return reply.send(session);
  });

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
  app.get("/system/metrics", { preHandler: requireAdminRoleBridge }, async (_req, reply) => {
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

  /** Council instruction for the user's dissent preference; "off" or anything unknown adds none. */
  function _dissentPreamble(level: unknown): string {
    const how = {
      gentle: "note the main counter-argument",
      moderate: "argue the strongest opposing view",
      strong: "argue hard against the emerging consensus",
    }[String(level)];
    return how
      ? `Guard against an echo chamber: before agreeing with the user or each other, ${how}.`
      : "";
  }

  // ── reactions ──────────────────────────────────────────────────────────────

  const _reactionsStore = new PersistentStore<{
    id: string;
    messageId: string;
    emoji: string;
    userId: string | null;
    createdAt: string;
  }>("reactions");
  _reactionsStore.load().catch(() => {});

  // Reactive-agents rules (apps/ui/app/routes/agents.tsx), owned by
  // lib/reactions.ts. Emoji message-reactions share the path for old clients.
  provideReactionDeps({
    summarize: (text) =>
      _llm(
        [
          systemMsg("Summarise this event in one short paragraph a user can act on."),
          userMsg(text),
        ],
        400,
      ),
  });
  const _myRule = (req: { nexusUserId?: string }, id: string) => {
    const rule = reactionRules.get(id);
    return rule && rule.ownerId === (req.nexusUserId ?? null) ? rule : undefined;
  };

  app.post<{ Body: Record<string, unknown> }>("/reactions", async (request, reply) => {
    const body = request.body ?? {};
    if (typeof body.messageId === "string" && typeof body.emoji === "string") {
      const item = {
        id: crypto.randomUUID(),
        messageId: body.messageId,
        emoji: body.emoji.slice(0, 16),
        userId: request.nexusUserId ?? null,
        createdAt: now(),
      };
      _reactionsStore.set(item.id, item);
      return reply.code(201).send(item);
    }
    const eventPattern = String(body.eventPattern ?? "").trim();
    const handlerType = String(body.handlerType ?? "notify");
    if (!eventPattern) return reply.code(400).send({ error: "eventPattern is required" });
    if (!HANDLER_TYPES.includes(handlerType)) {
      return reply
        .code(400)
        .send({ error: `handlerType must be one of: ${HANDLER_TYPES.join(", ")}` });
    }
    const config =
      body.handlerConfig && typeof body.handlerConfig === "object"
        ? (body.handlerConfig as Record<string, unknown>)
        : {};
    if (handlerType === "webhook") {
      const unsafe = unsafeUrlReason(config.url);
      if (unsafe) return reply.code(400).send({ error: `webhook url: ${unsafe}` });
    }
    const rule: ReactionRule = {
      id: crypto.randomUUID(),
      ownerId: request.nexusUserId ?? null,
      eventPattern: eventPattern.slice(0, 128),
      handlerType,
      handlerConfig: config,
      enabled: true,
      triggerCount: 0,
      createdAt: now(),
    };
    reactionRules.set(rule.id, rule);
    return reply.code(201).send(rule);
  });

  app.get<{ Querystring: { messageId?: string } }>("/reactions", async (request, reply) => {
    if (request.query.messageId) {
      return reply.send(
        Array.from(_reactionsStore.values()).filter(
          (r) =>
            r.messageId === request.query.messageId && r.userId === (request.nexusUserId ?? null),
        ),
      );
    }
    return reply.send(
      Array.from(reactionRules.values())
        .filter((r) => r.ownerId === (request.nexusUserId ?? null))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    );
  });

  app.patch<{
    Params: { id: string };
    Body: { enabled?: boolean; handlerConfig?: Record<string, unknown>; eventPattern?: string };
  }>("/reactions/:id", async (request, reply) => {
    const existing = _myRule(request, request.params.id);
    if (!existing) return reply.code(404).send({ error: "rule_not_found" });
    const b = request.body ?? {};
    if (existing.handlerType === "webhook" && b.handlerConfig) {
      const unsafe = unsafeUrlReason(b.handlerConfig.url);
      if (unsafe) return reply.code(400).send({ error: `webhook url: ${unsafe}` });
    }
    const updated: ReactionRule = {
      ...existing,
      ...(typeof b.enabled === "boolean" ? { enabled: b.enabled } : {}),
      ...(b.handlerConfig && typeof b.handlerConfig === "object"
        ? { handlerConfig: b.handlerConfig }
        : {}),
      ...(typeof b.eventPattern === "string" && b.eventPattern.trim()
        ? { eventPattern: b.eventPattern.trim().slice(0, 128) }
        : {}),
    };
    reactionRules.set(updated.id, updated);
    return reply.send(updated);
  });

  app.delete<{ Params: { id: string } }>("/reactions/:id", async (request, reply) => {
    if (_myRule(request, request.params.id)) {
      reactionRules.delete(request.params.id);
      return reply.code(204).send();
    }
    const emoji = _reactionsStore.get(request.params.id);
    if (emoji && emoji.userId === (request.nexusUserId ?? null)) {
      _reactionsStore.delete(request.params.id);
      return reply.code(204).send();
    }
    return reply.code(404).send({ error: "not_found" });
  });

  /** POST /reactions/emit — fire an event now; matching rules run their handlers. */
  app.post<{ Body: { eventType?: string; payload?: Record<string, unknown> } }>(
    "/reactions/emit",
    async (request, reply) => {
      const eventType = request.body?.eventType?.trim() || "message.created";
      const event = await fireReactionEvent(
        request.nexusUserId,
        eventType,
        request.body?.payload ?? {},
      );
      const matchedRules = event.matchedRules
        .map((id) => reactionRules.get(id))
        .filter((r): r is ReactionRule => !!r);
      return reply.send({ event, matchedRules });
    },
  );

  app.get("/reactions/events", async (request, reply) => {
    return reply.send(
      Array.from(reactionEvents.values())
        .filter((e) => e.ownerId === (request.nexusUserId ?? null))
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp)),
    );
  });

  // ── specialisation ─────────────────────────────────────────────────────────
  // A domain applied to a chat thread steers that thread's council: /chat/stream
  // adds the domain's focus to the members' system preamble.

  const _agentRegistry = new PersistentStore<AgentDefinition & { ownerId?: string | null }>(
    "specialisation_profiles",
  );
  const _threadDomains = new PersistentStore<{ id: string; domain: string }>(
    "specialisation_threads",
  );
  await Promise.all([_agentRegistry.load(), _threadDomains.load()]);
  const _profileKey = (req: { nexusUserId?: string }, id: string) =>
    `${req.nexusUserId ?? "anonymous"}:${id}`;

  const _DOMAINS: {
    id: string;
    name: string;
    description: string;
    focus: string;
    modelHint: string;
  }[] = [
    {
      id: "code-review",
      name: "Code Review",
      description: "Correctness, security and maintainability of code changes.",
      focus:
        "Review like a senior engineer: correctness first, then security, then maintainability. Cite lines.",
      modelHint: "anthropic:claude-sonnet-4-6",
    },
    {
      id: "debugger",
      name: "Debugging",
      description: "Finding the root cause of a failure.",
      focus:
        "Debug methodically: state hypotheses, name the evidence that would confirm each, find the root cause before proposing a fix.",
      modelHint: "openai:gpt-5.6-sol",
    },
    {
      id: "architect",
      name: "Architecture",
      description: "System design, trade-offs and boundaries.",
      focus:
        "Think as a systems architect: name the trade-offs, the failure modes and what would change the recommendation.",
      modelHint: "anthropic:claude-sonnet-4-6",
    },
    {
      id: "devops",
      name: "DevOps",
      description: "Deployment, infrastructure and operations.",
      focus:
        "Answer as an SRE: reliability, rollback, observability and cost come before convenience.",
      modelHint: "groq:openai/gpt-oss-120b",
    },
    {
      id: "data-science",
      name: "Data Science",
      description: "Statistics, experiments and data analysis.",
      focus:
        "Answer as a data scientist: state assumptions, check for confounders and say how confident the conclusion can be.",
      modelHint: "gemini:gemini-3.6-flash",
    },
  ];
  /** The applied domain's focus for a chat thread, or "". */
  function _specialisationPreamble(req: { nexusUserId?: string }, threadId: unknown): string {
    if (typeof threadId !== "string") return "";
    const applied = _threadDomains.get(_profileKey(req, threadId));
    const d = _DOMAINS.find((x) => x.id === applied?.domain);
    return d ? `Specialisation (${d.name}): ${d.focus}` : "";
  }

  /** POST /specialisation — save an agent specialisation profile (API clients). */
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
      const profile = { ...request.body, ownerId: request.nexusUserId ?? null };
      _agentRegistry.set(_profileKey(request, request.body.id), profile);
      return reply.code(201).send(request.body);
    },
  );

  app.get("/specialisation", async (request, reply) => {
    const mine = Array.from(_agentRegistry.values()).filter(
      (p) => (p.ownerId ?? null) === (request.nexusUserId ?? null),
    );
    return reply.send(mine.map(({ ownerId: _o, ...p }) => p));
  });

  app.get("/specialisation/domains", async (_req, reply) => {
    return reply.send({
      domains: _DOMAINS.map(({ focus: _f, ...d }) => ({ ...d, enabled: true })),
    });
  });

  app.get<{ Params: { id: string } }>("/specialisation/:id", async (request, reply) => {
    const profile = _agentRegistry.get(_profileKey(request, request.params.id));
    if (!profile) return reply.code(404).send({ error: "not_found" });
    const { ownerId: _o, ...p } = profile;
    return reply.send(p);
  });

  app.delete<{ Params: { id: string } }>("/specialisation/:id", async (request, reply) => {
    const key = _profileKey(request, request.params.id);
    if (!_agentRegistry.has(key)) return reply.code(404).send({ error: "not_found" });
    _agentRegistry.delete(key);
    return reply.code(204).send();
  });

  /** POST /specialisation/apply — steer a chat thread (sessionId = its id) toward a domain. */
  app.post<{ Body: { domain?: string; sessionId?: string } }>(
    "/specialisation/apply",
    async (request, reply) => {
      const domain = _DOMAINS.find((d) => d.id === request.body?.domain?.trim());
      const threadId = request.body?.sessionId?.trim();
      if (!domain || !threadId) {
        return reply.code(400).send({
          error: `sessionId (a chat id) and a domain (${_DOMAINS.map((d) => d.id).join(", ")}) are required`,
        });
      }
      if (!(await getThread(request.nexusUserId, threadId))) {
        return reply
          .code(404)
          .send({ error: "No conversation with that id — copy it from /chat/<id>" });
      }
      const key = _profileKey(request, threadId);
      _threadDomains.set(key, { id: key, domain: domain.id });
      return reply.send({
        message: `${domain.name} now steers every answer in this conversation.`,
        domain: domain.id,
        model: domain.modelHint,
      });
    },
  );

  app.get<{ Params: { id: string } }>("/specialisation/thread/:id", async (request, reply) =>
    reply.send({
      domain: _threadDomains.get(_profileKey(request, request.params.id))?.domain ?? null,
    }),
  );

  app.delete<{ Params: { id: string } }>("/specialisation/thread/:id", async (request, reply) => {
    _threadDomains.delete(_profileKey(request, request.params.id));
    return reply.code(204).send();
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

  // -- NEGATION DETECTION (LLM-based) ----------------------------------------
  // Rules are keyed by conversation (a chat thread id). /chat/stream folds a
  // thread's rules into the system preamble, so saved rules change answers.

  interface _NegRule {
    id: string;
    pattern: string;
    type?: string;
    createdAt: string;
  }
  const _negationRules = new PersistentStore<{ id: string; rules: _NegRule[] }>("negation_rules");
  await _negationRules.load();
  const _negKey = (req: { nexusUserId?: string }, convId: string) =>
    `${req.nexusUserId ?? "anonymous"}:${convId}`;
  const _negRulesFor = (req: { nexusUserId?: string }, convId: string) =>
    _negationRules.get(_negKey(req, convId))?.rules ?? [];
  const _negBlock = (rules: _NegRule[]) =>
    rules.length
      ? "The user has ruled these out. Do not do any of them:\n" +
        rules.map((r) => `- ${r.pattern}`).join("\n")
      : "";

  app.post<{
    Body: { convId?: string; patterns?: { pattern?: unknown; type?: unknown }[] };
  }>("/negation/add", async (request, reply) => {
    const convId = request.body?.convId?.trim();
    const patterns = request.body?.patterns;
    if (!convId || !Array.isArray(patterns))
      return reply.code(400).send({ error: "convId and patterns[] are required" });
    const rules = _negRulesFor(request, convId);
    const known = new Set(rules.map((r) => r.pattern.toLowerCase()));
    for (const p of patterns) {
      const pattern = String(p?.pattern ?? "")
        .trim()
        .slice(0, 300);
      if (!pattern || known.has(pattern.toLowerCase())) continue;
      known.add(pattern.toLowerCase());
      rules.push({
        id: crypto.randomUUID(),
        pattern,
        ...(p.type ? { type: String(p.type).slice(0, 40) } : {}),
        createdAt: now(),
      });
    }
    _negationRules.set(_negKey(request, convId), { id: _negKey(request, convId), rules });
    return reply.send({ ok: true, rules });
  });

  app.get<{ Params: { convId: string } }>("/negation/:convId", async (request, reply) => {
    return reply.send({ rules: _negRulesFor(request, request.params.convId) });
  });

  app.delete<{ Params: { convId: string; ruleId: string } }>(
    "/negation/:convId/:ruleId",
    async (request, reply) => {
      const key = _negKey(request, request.params.convId);
      const rules = _negRulesFor(request, request.params.convId).filter(
        (r) => r.id !== request.params.ruleId,
      );
      _negationRules.set(key, { id: key, rules });
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { convId: string } }>("/negation/:convId", async (request, reply) => {
    _negationRules.delete(_negKey(request, request.params.convId));
    return reply.code(204).send();
  });
  const _strs = (v: unknown, max = 20) =>
    Array.isArray(v)
      ? v
          .map((x) => String(x).trim().slice(0, 500))
          .filter(Boolean)
          .slice(0, max)
      : typeof v === "string"
        ? v
            .split(/[,\n]/)
            .map((x) => x.trim().slice(0, 500))
            .filter(Boolean)
            .slice(0, max)
        : [];

  // -- MODERATION (LLM-based content safety) ---------------------------------
  // The model scores each category; the configured thresholds and actions,
  // not the model, decide what is flagged and what happens.

  interface _ModCategory {
    name: string;
    enabled: boolean;
    threshold: number;
    action: "allow" | "warn" | "block";
  }
  const _MOD_DEFAULTS: _ModCategory[] = [
    { name: "hate", enabled: true, threshold: 0.8, action: "block" },
    { name: "violence", enabled: true, threshold: 0.8, action: "block" },
    { name: "sexual", enabled: true, threshold: 0.9, action: "block" },
    { name: "self_harm", enabled: true, threshold: 0.7, action: "block" },
    { name: "harassment", enabled: true, threshold: 0.8, action: "warn" },
    { name: "spam", enabled: true, threshold: 0.9, action: "warn" },
  ];
  const _modStore = new PersistentStore<{ id: string; categories: _ModCategory[] }>(
    "moderation_config",
  );
  await _modStore.load();
  const _modCategories = () => _modStore.get("config")?.categories ?? _MOD_DEFAULTS;
  const _SEVERITY = { allow: 0, warn: 1, block: 2 } as const;

  /** OpenAI's moderation endpoint when keyed, else the chat model, else keywords. */
  async function _moderationScores(
    text: string,
    names: string[],
  ): Promise<{ scores?: Record<string, unknown>; reason?: unknown }> {
    const openaiKey = await serviceKey(getCacheUserId(), "openai", "OPENAI_API_KEY");
    if (openaiKey) {
      const scores = await openaiScores(text, names, openaiKey).catch(() => null);
      if (scores) return { scores, reason: "Scored by OpenAI moderation." };
    }
    const driver = getDefaultDriver();
    try {
      if (!driver) throw new Error(NO_LLM);
      const res = await driver.complete({
        model: DEFAULT_MODEL,
        messages: [
          {
            role: "user" as LlmRole,
            content: `Rate how strongly this text contains each category, from 0 (not at all) to 1 (clearly).\nCategories: ${names.join(", ")}\nReturn JSON only: { "scores": { "<category>": <0-1>, ... }, "reason": "<one sentence>" }\n\nText:\n${text.slice(0, 4000)}`,
          },
        ],
        maxTokens: 512,
      });
      _trackCost(DEFAULT_MODEL, res.usage);
      return parseJsonResponse(res.content);
    } catch {
      return { scores: heuristicScores(text, names), reason: "Keyword heuristic." };
    }
  }

  async function _runModeration(text: string, only?: string[]) {
    const cats = _modCategories().filter((c) => c.enabled && (!only || only.includes(c.name)));
    const parsed = await _moderationScores(
      text,
      cats.map((c) => c.name),
    );
    const scores: Record<string, number> = {};
    const categories: Record<string, boolean> = {};
    let action: "allow" | "warn" | "block" = "allow";
    for (const c of cats) {
      const score = Math.min(1, Math.max(0, Number(parsed.scores?.[c.name]) || 0));
      scores[c.name] = score;
      categories[c.name] = score >= c.threshold;
      if (categories[c.name] && _SEVERITY[c.action] > _SEVERITY[action]) action = c.action;
    }
    return {
      flagged: Object.values(categories).some(Boolean),
      action,
      reason: String(parsed.reason ?? ""),
      categories,
      scores,
    };
  }

  app.post<{ Body: { text?: string } }>("/moderation/check", async (request, reply) => {
    const text = request.body?.text?.trim();
    if (!text) return reply.code(400).send({ error: "text is required" });
    try {
      return reply.send(await _runModeration(text));
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post<{ Body: { items?: { id: string; text: string }[] } }>(
    "/moderation/batch",
    async (request, reply) => {
      const items = (Array.isArray(request.body?.items) ? request.body.items : [])
        .filter((i) => i && typeof i.text === "string" && i.text.trim())
        .slice(0, 20);
      if (items.length === 0)
        return reply.code(400).send({ error: "items[] with text are required" });

      const results = await Promise.all(
        items.map(async (item) => {
          try {
            return { id: item.id, result: await _runModeration(item.text) };
          } catch (err) {
            return {
              id: item.id,
              result: {
                flagged: false,
                action: "allow" as const,
                reason: String(err),
                categories: {},
                scores: {},
              },
            };
          }
        }),
      );
      return reply.send({ results });
    },
  );

  app.get("/moderation/config", async (_req, reply) =>
    reply.send({ categories: _modCategories() }),
  );
  app.post<{ Body: { categories?: Partial<_ModCategory>[] } }>(
    "/moderation/config",
    { preHandler: requireAdminRoleBridge },
    async (request, reply) => {
      const incoming = Array.isArray(request.body?.categories) ? request.body.categories : [];
      const categories = _modCategories().map((c) => {
        const u = incoming.find((x) => x?.name === c.name);
        if (!u) return c;
        return {
          ...c,
          ...(typeof u.enabled === "boolean" ? { enabled: u.enabled } : {}),
          ...(Number.isFinite(Number(u.threshold))
            ? { threshold: Math.min(1, Math.max(0, Number(u.threshold))) }
            : {}),
          ...(u.action === "allow" || u.action === "warn" || u.action === "block"
            ? { action: u.action }
            : {}),
        };
      });
      _modStore.set("config", { id: "config", categories });
      return reply.send({ categories });
    },
  );

  // -- HALLUCINATION SCORING (LLM-based) ------------------------------------

  const HAL_FACTUAL = 0.3;
  const HAL_HALLUCINATED = 0.6;
  const BAD_JSON = "The model did not return valid JSON. Try again.";

  app.get("/hallucination/thresholds", async (_req, reply) => {
    return reply.send({ factual: HAL_FACTUAL, hallucinated: HAL_HALLUCINATED });
  });

  async function _scoreHallucination(response: string, context?: string) {
    const driver = getDefaultDriver();
    if (!driver) throw new Error(NO_LLM);
    const res = await driver.complete({
      model: DEFAULT_MODEL,
      messages: [
        {
          role: "user" as LlmRole,
          content: `Check this AI response for hallucination${context ? " against the given context" : ""}. Break it into factual claims and judge each.\nReturn JSON only: { "score": <0-1, 0 = fully factual, 1 = clearly hallucinated>, "explanation": "<one or two sentences>", "claims": [{ "text": "<claim>", "verdict": "supported" | "unsupported" | "contradicted" | "unverifiable", "confidence": <0-1> }] }\n\n${context ? `Context:\n${context.slice(0, 6000)}\n\n` : ""}Response:\n${response.slice(0, 6000)}`,
        },
      ],
      maxTokens: 2048,
    });
    _trackCost(DEFAULT_MODEL, res.usage);
    let parsed: { score?: unknown; explanation?: unknown; claims?: unknown };
    try {
      parsed = parseJsonResponse(res.content);
    } catch {
      throw new Error(BAD_JSON);
    }
    const score = Math.min(1, Math.max(0, Number(parsed.score) || 0));
    return {
      score,
      label:
        score < HAL_FACTUAL ? "factual" : score >= HAL_HALLUCINATED ? "hallucinated" : "uncertain",
      explanation: String(parsed.explanation ?? ""),
      claims: (Array.isArray(parsed.claims) ? parsed.claims : [])
        .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === "object")
        .map((c) => ({
          text: String(c.text ?? ""),
          verdict: String(c.verdict ?? "unverifiable"),
          confidence: Math.min(1, Math.max(0, Number(c.confidence) || 0)),
        })),
    };
  }
  const _fail = (reply: FastifyReply, err: unknown) =>
    reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });

  app.post<{ Body: { response?: string; context?: string } }>(
    "/hallucination/score",
    async (request, reply) => {
      const response = request.body?.response?.trim();
      if (!response) return reply.code(400).send({ error: "response is required" });
      try {
        return reply.send(await _scoreHallucination(response, request.body.context?.trim()));
      } catch (err) {
        return _fail(reply, err);
      }
    },
  );

  app.post<{ Body: { answer?: string; context?: string } }>(
    "/hallucination/groundedness",
    async (request, reply) => {
      const answer = request.body?.answer?.trim();
      const context = request.body?.context?.trim();
      if (!answer || !context)
        return reply.code(400).send({ error: "answer and context are required" });
      const driver = getDefaultDriver();
      if (!driver) return reply.code(503).send({ error: NO_LLM });
      const res = await driver.complete({
        model: DEFAULT_MODEL,
        messages: [
          {
            role: "user" as LlmRole,
            content: `How well is this answer supported by the context alone?\nReturn JSON only: { "score": <0-1, 1 = every claim is supported>, "ungroundedClaims": ["<claim not supported by the context>", ...] }\n\nContext:\n${context.slice(0, 8000)}\n\nAnswer:\n${answer.slice(0, 4000)}`,
          },
        ],
        maxTokens: 1024,
      });
      _trackCost(DEFAULT_MODEL, res.usage);
      try {
        const parsed = parseJsonResponse<{ score?: unknown; ungroundedClaims?: unknown }>(
          res.content,
        );
        const score = Math.min(1, Math.max(0, Number(parsed.score) || 0));
        const ungroundedClaims = (
          Array.isArray(parsed.ungroundedClaims) ? parsed.ungroundedClaims : []
        ).map(String);
        return reply.send({
          grounded: score >= 0.7 && ungroundedClaims.length === 0,
          score,
          ungroundedClaims,
        });
      } catch {
        return reply.code(502).send({ error: BAD_JSON });
      }
    },
  );

  app.post<{ Body: { items?: { id: string; response: string; context?: string }[] } }>(
    "/hallucination/batch-score",
    async (request, reply) => {
      const items = (Array.isArray(request.body?.items) ? request.body.items : [])
        .filter((i) => i && typeof i.response === "string" && i.response.trim())
        .slice(0, 10);
      if (items.length === 0)
        return reply.code(400).send({ error: "items[] with a response are required" });
      if (!getDefaultDriver()) return reply.code(503).send({ error: NO_LLM });
      const results = await Promise.all(
        items.map(async (item) => {
          try {
            return { id: item.id, score: await _scoreHallucination(item.response, item.context) };
          } catch (err) {
            return {
              id: item.id,
              score: { score: 0, label: "uncertain", explanation: String(err), claims: [] },
            };
          }
        }),
      );
      return reply.send({ results });
    },
  );

  // -- SPECULATIVE DECODING / CLASSIFY --------------------------------------
  // Simulated at the API level: a short draft pass, then a verify pass that
  // accepts or rewrites it. Stats are the caller's real runs.

  interface _SpecStats {
    id: string;
    runs: number;
    accepted: number;
    speedupSum: number;
    tokens: number;
  }
  const _specStats = new PersistentStore<_SpecStats>("speculative_stats");
  await _specStats.load();
  const _specId = (req: { nexusUserId?: string }) => req.nexusUserId ?? "anonymous";

  app.get("/speculative/config", async (_req, reply) =>
    reply.send({
      enabled: !!getDefaultDriver(),
      draftModel: DEFAULT_MODEL,
      targetModel: DEFAULT_MODEL,
      numSpecTokens: 256,
      mode: "llm-simulated",
    }),
  );
  app.get("/speculative/stats", async (req, reply) => {
    const s = _specStats.get(_specId(req));
    return reply.send({
      totalRuns: s?.runs ?? 0,
      acceptanceRate: s?.runs ? s.accepted / s.runs : 0,
      speedupRatio: s?.runs ? s.speedupSum / s.runs : 0,
      avgTokensGenerated: s?.runs ? Math.round(s.tokens / s.runs) : 0,
    });
  });

  app.post<{ Body: { prompt?: string } }>("/speculative/run", async (req, reply) => {
    const prompt = req.body?.prompt?.trim();
    if (!prompt) return reply.code(400).send({ error: "prompt is required" });
    const driver = getDefaultDriver();
    if (!driver) return reply.code(503).send({ error: NO_LLM });
    const t0 = Date.now();
    const draftRes = await driver.complete({
      model: DEFAULT_MODEL,
      messages: [userMsg(prompt)],
      maxTokens: 256,
    });
    _trackCost(DEFAULT_MODEL, draftRes.usage);
    const draftMs = Date.now() - t0;
    const t1 = Date.now();
    const verifyContent = await _llm(
      [
        userMsg(
          `Prompt: "${prompt.slice(0, 2000)}"\n\nDraft response:\n${draftRes.content}\n\nIf the draft fully and correctly answers the prompt, respond with JSON: {"accepted":true,"output":"<same text>","reason":"correct"}. If it has errors or is incomplete, improve it: {"accepted":false,"output":"<improved>","reason":"<why rejected>"}. Return only valid JSON.`,
        ),
      ],
      1024,
    );
    const verifyMs = Date.now() - t1;
    let verdict: { accepted?: boolean; output?: string; reason?: string } = {};
    try {
      verdict = parseJsonResponse(verifyContent);
    } catch {
      return reply.code(502).send({ error: BAD_JSON });
    }
    const accepted = verdict.accepted === true;
    // Accepting the draft saves the target pass a full generation; rewriting it does not.
    const speedup = accepted ? +((draftMs + verifyMs) / Math.max(1, verifyMs)).toFixed(2) : 1;
    const tokensGenerated = draftRes.usage?.outputTokens ?? 0;
    const prev = _specStats.get(_specId(req));
    _specStats.set(_specId(req), {
      id: _specId(req),
      runs: (prev?.runs ?? 0) + 1,
      accepted: (prev?.accepted ?? 0) + (accepted ? 1 : 0),
      speedupSum: (prev?.speedupSum ?? 0) + speedup,
      tokens: (prev?.tokens ?? 0) + tokensGenerated,
    });
    return reply.send({
      accepted,
      acceptanceRate: accepted ? 1 : 0,
      output: verdict.output ?? draftRes.content,
      draft: draftRes.content,
      reason: verdict.reason ?? "",
      speedup,
      tokensGenerated,
      draftMs,
      verifyMs,
      totalMs: Date.now() - t0,
    });
  });

  app.post<{ Body: { text?: string } }>("/speculative/classify", async (request, reply) => {
    const text = request.body?.text?.trim();
    if (!text) return reply.code(400).send({ error: "text is required" });
    const driver = getDefaultDriver();
    if (!driver) return reply.code(503).send({ error: NO_LLM });
    const res = await driver.complete({
      model: DEFAULT_MODEL,
      messages: [
        {
          role: "user" as LlmRole,
          content: `Classify this text as exactly one of: question, statement, command, code, creative, factual, opinion.\nReturn JSON only: { "category": "<one of the above>", "confidence": <0-1>, "reasoning": "<one sentence>" }\n\n${text.slice(0, 4000)}`,
        },
      ],
      maxTokens: 512,
    });
    _trackCost(DEFAULT_MODEL, res.usage);
    try {
      const p = parseJsonResponse<{
        category?: unknown;
        confidence?: unknown;
        reasoning?: unknown;
      }>(res.content);
      return reply.send({
        category: String(p.category ?? "unknown"),
        confidence: Math.min(1, Math.max(0, Number(p.confidence) || 0)),
        reasoning: String(p.reasoning ?? ""),
      });
    } catch {
      return reply.code(502).send({ error: BAD_JSON });
    }
  });

  // TTS — OpenAI TTS-1 on the caller's key; without one the client speaks locally.
  app.post<{ Body: { text: string; voice?: string } }>("/tts", async (req, reply) => {
    const apiKey =
      (req.headers["x-openai-key"] as string | undefined) ||
      (await serviceKey(req.nexusUserId, "openai", "OPENAI_API_KEY"));
    if (!apiKey)
      return reply.send({
        audio: null,
        message: "Add an OpenAI key under Settings → Provider keys for model voices.",
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

  // -- STANDARD ANSWERS (Q&A knowledge base + LLM match) --------------------
  // Curated answers. /chat/stream hands the council a close match as the
  // reference answer, so curating one changes what the council says.

  interface StdAnswer {
    id: string;
    ownerId?: string | null;
    question: string;
    answer: string;
    tags: string[];
    enabled: boolean;
    matchCount: number;
    createdAt: string;
    updatedAt: string;
  }
  const STD_MATCH_THRESHOLD = 0.6;

  const _stdMine = (req: { nexusUserId?: string }) =>
    Array.from(_stdAnswers.values()).filter(
      (a) => (a.ownerId ?? null) === (req.nexusUserId ?? null),
    );
  const _words = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2),
    );
  /** Word overlap (Jaccard) — cheap enough to run on every chat message. */
  const _lexScore = (a: string, b: string) => {
    const x = _words(a);
    const y = _words(b);
    if (!x.size || !y.size) return 0;
    let both = 0;
    for (const w of x) if (y.has(w)) both++;
    return both / (x.size + y.size - both);
  };
  function _stdBestLexical(req: { nexusUserId?: string }, query: string) {
    let best: { answer: StdAnswer; score: number } | null = null;
    for (const a of _stdMine(req)) {
      if (a.enabled === false) continue;
      const score = _lexScore(query, a.question);
      if (!best || score > best.score) best = { answer: a, score };
    }
    return best;
  }
  function _stdCount(a: StdAnswer) {
    a.matchCount = (a.matchCount ?? 0) + 1;
    _stdAnswers.set(a.id, a);
  }
  /** Reference text for the council when a curated answer fits the question. */
  function _stdPreamble(req: { nexusUserId?: string }, message: string): string {
    const best = _stdBestLexical(req, message);
    if (!best || best.score < STD_MATCH_THRESHOLD) return "";
    _stdCount(best.answer);
    return `A curated standard answer exists for this question. Treat it as authoritative:\nQ: ${best.answer.question}\nA: ${best.answer.answer}`;
  }
  const _stdView = (a: StdAnswer) => ({
    ...a,
    enabled: a.enabled !== false,
    matchCount: a.matchCount ?? 0,
  });

  app.get("/standard-answers", async (req, reply) =>
    reply.send(
      _stdMine(req)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(_stdView),
    ),
  );

  app.post<{ Body: { question?: string; answer?: string; tags?: string[]; enabled?: boolean } }>(
    "/standard-answers",
    async (req, reply) => {
      const question = req.body?.question?.trim();
      const answer = req.body?.answer?.trim();
      if (!question || !answer)
        return reply.code(400).send({ error: "question and answer are required" });
      const a: StdAnswer = {
        id: crypto.randomUUID(),
        ownerId: req.nexusUserId ?? null,
        question: question.slice(0, 2000),
        answer: answer.slice(0, 20_000),
        tags: _strs(req.body.tags),
        enabled: req.body.enabled !== false,
        matchCount: 0,
        createdAt: now(),
        updatedAt: now(),
      };
      _stdAnswers.set(a.id, a);
      return reply.code(201).send(_stdView(a));
    },
  );

  app.put<{ Params: { id: string }; Body: Partial<StdAnswer> }>(
    "/standard-answers/:id",
    async (req, reply) => {
      const a = _stdMine(req).find((x) => x.id === req.params.id);
      if (!a) return reply.code(404).send({ error: "not_found" });
      const b = req.body ?? {};
      if (typeof b.question === "string" && b.question.trim())
        a.question = b.question.trim().slice(0, 2000);
      if (typeof b.answer === "string" && b.answer.trim())
        a.answer = b.answer.trim().slice(0, 20_000);
      if (b.tags !== undefined) a.tags = _strs(b.tags);
      if (typeof b.enabled === "boolean") a.enabled = b.enabled;
      a.updatedAt = now();
      _stdAnswers.set(a.id, a);
      return reply.send(_stdView(a));
    },
  );

  app.delete<{ Params: { id: string } }>("/standard-answers/:id", async (req, reply) => {
    if (!_stdMine(req).some((x) => x.id === req.params.id))
      return reply.code(404).send({ error: "not_found" });
    _stdAnswers.delete(req.params.id);
    return reply.code(204).send();
  });

  app.post<{ Body: { query?: string } }>("/standard-answers/match", async (req, reply) => {
    const query = req.body?.query?.trim();
    if (!query) return reply.code(400).send({ error: "query is required" });
    const answers = _stdMine(req).filter((a) => a.enabled !== false);
    if (!answers.length) return reply.send({ matched: false, score: 0 });
    const driver = getDefaultDriver();
    let best: { answer: StdAnswer; score: number } | null = null;
    if (driver) {
      const catalog = answers.map((a, i) => `[${i}] ${a.question}`).join("\n");
      const res = await driver.complete({
        model: DEFAULT_MODEL,
        messages: [
          {
            role: "user" as LlmRole,
            content: `User question: "${query}"\n\nWhich of these curated questions asks the same thing? Reply with JSON only: {"index": <number or -1 if none>, "confidence": <0-1>}\n\n${catalog}`,
          },
        ],
        maxTokens: 256,
      });
      _trackCost(DEFAULT_MODEL, res.usage);
      try {
        const parsed = parseJsonResponse<{ index: number; confidence: unknown }>(res.content);
        const hit = answers[parsed.index];
        if (hit) best = { answer: hit, score: Number(parsed.confidence) || 0 };
      } catch {
        /* fall back to word overlap below */
      }
    }
    best ??= _stdBestLexical(req, query);
    const matched = !!best && best.score >= STD_MATCH_THRESHOLD;
    if (matched) _stdCount(best!.answer);
    return reply.send({
      matched,
      score: best?.score ?? 0,
      ...(matched ? { answer: _stdView(best!.answer) } : {}),
    });
  });

  // -- CONTEXT MENTION SEARCH --------------------------------------------------
  // Frontend: apps/ui/app/components/ContextMention.tsx + chat.tsx mentions.

  const _IGNORED_DIRS = new Set(["node_modules", ".git", "dist", ".next", "build", "coverage"]);
  const _CODE_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".py"]);

  /**
   * The folder @file and @symbol mentions may read. Opt-in only: the server's
   * own directory holds its source and secrets, never the user's project.
   */
  const _workspaceRoot = (): string | null =>
    process.env.NEXUS_WORKSPACE_DIR ? path.resolve(process.env.NEXUS_WORKSPACE_DIR) : null;

  function _collectWorkspaceFiles(maxDepth = 4, maxFiles = 2_000): string[] {
    const out: string[] = [];
    const root = _workspaceRoot();
    if (!root) return out;
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
        } else if (e.isFile() && !e.name.startsWith(".env")) {
          out.push(path.join(dir, e.name));
          if (out.length >= maxFiles) return;
        }
      }
    };
    walk(root, 0);
    return out;
  }

  /**
   * Read @-mentions from the chat composer into context for the council:
   * a workspace file's text, a symbol's definition, a web page's text.
   * Files outside the workspace root and unsafe URLs are skipped.
   */
  /** The @kb and @web mentions as numbered sources, each kind retrieved in parallel. */
  async function _citationSources(
    raw: unknown,
    userId: string | undefined,
    message: string,
  ): Promise<SourceSet> {
    const mentions = (Array.isArray(raw) ? raw.slice(0, 8) : []) as {
      type?: unknown;
      value?: unknown;
    }[];
    const valuesOf = (type: string) =>
      mentions
        .filter((m) => m?.type === type)
        .map((m) => String(m.value ?? "").trim())
        .filter(Boolean);
    const kbs = valuesOf("kb");
    const pages = valuesOf("web").filter((url) => !unsafeUrlReason(url));
    const retrievers = new Map<RetrievalSource, SourceRetrieverFn>();
    if (kbs.length) {
      retrievers.set("knowledge_base", async (query, limit) => {
        const hits = (
          await Promise.all(kbs.map((kb) => searchKb(getMemory(), userId, query, kb, limit)))
        ).flat();
        return hits.map((h, i) => ({
          id: `kb:${h.kbId}:${i}`,
          docId: `${h.kbId}/${h.docName}`,
          docName: h.docName || h.kbId,
          text: h.text,
          score: h.score,
          source: "knowledge_base" as const,
        }));
      });
    }
    if (pages.length) {
      retrievers.set("web", async () => {
        const chunks: ScoredChunk[] = [];
        for (const url of pages) {
          const page = await getScraper()
            .scrape(url, { timeout: 15_000 })
            .catch(() => null);
          if (!page || !isScraped(page)) continue;
          // Paragraph-sized excerpts, so a citation can point at the part that matched.
          const paras = page.text
            .slice(0, 8_000)
            .split(/\n\s*\n/)
            .filter((p) => p.trim());
          paras.slice(0, 8).forEach((text, i) =>
            chunks.push({
              id: `web:${url}:${i}`,
              docId: url,
              docName: url,
              docSource: url,
              text,
              score: 1 - i * 0.01,
              source: "web",
            }),
          );
        }
        return chunks;
      });
    }
    return gatherSources(message, retrievers);
  }

  async function _mentionContext(
    raw: unknown,
    userId: string | undefined,
    message: string,
    /** Mention types the caller reads itself (the chat council cites kb and web as sources). */
    skip: readonly string[] = [],
  ): Promise<string> {
    if (!Array.isArray(raw)) return "";
    const root = _workspaceRoot();
    const parts: string[] = [];
    for (const m of raw.slice(0, 8) as { type?: unknown; value?: unknown }[]) {
      const type = String(m?.type ?? "");
      const value = String(m?.value ?? "").trim();
      if (!value || skip.includes(type)) continue;
      try {
        if (type === "file") {
          if (!root) continue;
          const abs = path.resolve(root, value);
          if (!abs.startsWith(root + path.sep) || path.basename(abs).startsWith(".env")) continue;
          const text = fs.readFileSync(abs, "utf8").slice(0, 20_000);
          parts.push(`### File: ${path.relative(root, abs)}\n\`\`\`\n${text}\n\`\`\``);
        } else if (type === "symbol") {
          const name = value.replace(/[^\w$]/g, "");
          const def = new RegExp(`(?:function|class|const|interface|type)\\s+${name}\\b`);
          for (const f of _collectWorkspaceFiles()) {
            if (!_CODE_EXT.has(path.extname(f))) continue;
            const src = fs.readFileSync(f, "utf8");
            const at = src.search(def);
            if (at < 0) continue;
            const lines = src.split("\n");
            const line = src.slice(0, at).split("\n").length - 1;
            const snippet = lines.slice(Math.max(0, line - 2), line + 40).join("\n");
            parts.push(
              `### Symbol: ${name} (${path.relative(root ?? "", f)}:${line + 1})\n\`\`\`\n${snippet}\n\`\`\``,
            );
            break;
          }
        } else if (type === "kb") {
          const hits = await searchKb(getMemory(), userId, message, value, 5);
          if (hits.length) {
            const excerpts = hits.map((h) => `[${h.docName}]\n${h.text}`).join("\n\n");
            parts.push(`### Knowledge base excerpts\n${excerpts}`);
          }
        } else if (type === "web") {
          if (unsafeUrlReason(value)) continue;
          const page = await getScraper().scrape(value, { timeout: 15_000 });
          if (isScraped(page)) {
            parts.push(`### Web page: ${value}\n${page.text.slice(0, 8_000)}`);
          }
        }
      } catch {
        parts.push(`### ${type}: ${value}\n(could not be read)`);
      }
    }
    return parts.length ? `The user referenced this context:\n\n${parts.join("\n\n")}` : "";
  }

  /** GET /context/kb?q= — the caller's knowledge bases, for the @kb picker. */
  app.get<{ Querystring: { q?: string } }>("/context/kb", async (request, reply) => {
    const q = (request.query.q ?? "").toLowerCase();
    return reply.send(
      listKbsFor(request.nexusUserId)
        .filter((k) => k.name.toLowerCase().includes(q))
        .map((k) => ({ name: k.name, path: k.id, kind: `${k.documents.length} docs` })),
    );
  });

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
      matches.push({ path: path.relative(_workspaceRoot() ?? "", f), name: base, size });
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
        matches.push({ name, type: kind, file: path.relative(_workspaceRoot() ?? "", f), line });
      }
      if (matches.length >= 50) break;
    }
    return reply.send(matches);
  });

  /**
   * GET /context/web?q= — live results from the configured search provider.
   *
   * This feeds the `@web` mention picker in the chat composer, so anything it
   * returns is quoted into a deliberation as fact. With no provider configured
   * it returns nothing and names what is missing, rather than anything
   * plausible-looking.
   */
  app.get<{ Querystring: { q?: string } }>("/context/web", async (request, reply) => {
    const q = (request.query.q ?? "").trim();
    if (!q) return reply.send([]);
    const { results, provider, error } = await _webSearch(q);
    if (!provider) {
      return reply.send({
        results: [],
        message: `No search provider answered${error ? ` (${error})` : ""}.`,
      });
    }
    return reply.send(
      results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet, provider })),
    );
  });

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
    const entry = _deliberationScores.for(req).get(req.params.id);
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
      _deliberationScores.for(req).set(id, entry);
      return reply.code(201).send(entry);
    },
  );
  app.get<{ Params: { id: string } }>("/deliberations/:id/replay", async (req, reply) => {
    const entry = _deliberationScores.for(req).get(req.params.id);
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

  // ── analytics/daily + providers + models ──────────────────────────────────
  // Used by admin-analytics charts (lazy-loaded via analytics-charts.tsx).
  // Derives data from the in-process _costLog; returns deterministic empty
  // shapes when the log is empty so charts render without errors.

  app.get<{ Querystring: { days?: string } }>(
    "/analytics/daily",
    { preHandler: requireAdminRoleBridge },
    async (request, reply) => {
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
    },
  );

  app.get("/analytics/providers", { preHandler: requireAdminRoleBridge }, async (_req, reply) => {
    const byProvider: Record<string, number> = {};
    for (const e of _costLog) {
      const p = e.model?.split("/")[0] ?? "unknown";
      byProvider[p] = (byProvider[p] ?? 0) + 1;
    }
    const data = Object.entries(byProvider).map(([provider, requests]) => ({ provider, requests }));
    return reply.send({ data });
  });

  app.get<{ Querystring: { limit?: string } }>(
    "/analytics/models",
    { preHandler: requireAdminRoleBridge },
    async (request, reply) => {
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
    },
  );

  // ── system/config ──────────────────────────────────────────────────────────
  // Admin system page. Each key here is read somewhere: default_llm_model is
  // the model the tools ask the default provider for; maintenance_mode turns
  // every /api call away except for admins.

  const _SYS_KEYS: Record<string, { type: "string" | "boolean"; initial: string }> = {
    default_llm_model: { type: "string", initial: DEFAULT_MODEL },
    maintenance_mode: { type: "boolean", initial: process.env.MAINTENANCE_MODE ?? "false" },
  };
  const _sysStore = new PersistentStore<{ id: string; value: string }>("system_config");
  await _sysStore.load();
  const _sysValue = (key: string) => _sysStore.get(key)?.value ?? _SYS_KEYS[key]?.initial ?? "";
  const _applySysConfig = () => {
    DEFAULT_MODEL = _sysValue("default_llm_model") || DEFAULT_MODEL;
  };
  _applySysConfig();

  app.addHook("preHandler", async (request, reply) => {
    if (_sysValue("maintenance_mode") !== "true" || request.url.startsWith("/api/system/config"))
      return;
    const userId = request.nexusUserId;
    const [user] = userId
      ? await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1)
      : [];
    if (user?.role === "admin" || user?.role === "owner") return;
    return reply
      .code(503)
      .send({ error: "maintenance", message: "Nexus is in maintenance mode. Try again later." });
  });

  app.get("/system/config", { preHandler: requireAdminRoleBridge }, async (_req, reply) => {
    const configs = Object.entries(_SYS_KEYS).map(([key, { type }]) => ({
      key,
      value: _sysValue(key),
      type,
    }));
    return reply.send({ configs });
  });

  app.put<{ Params: { key: string }; Body: { value?: unknown } }>(
    "/system/config/:key",
    { preHandler: requireAdminRoleBridge },
    async (request, reply) => {
      const spec = _SYS_KEYS[request.params.key];
      if (!spec) return reply.code(404).send({ error: "unknown config key" });
      const value = String(request.body?.value ?? "").trim();
      if (!value) return reply.code(400).send({ error: "value is required" });
      if (spec.type === "boolean" && value !== "true" && value !== "false") {
        return reply.code(400).send({ error: "value must be true or false" });
      }
      _sysStore.set(request.params.key, { id: request.params.key, value });
      _applySysConfig();
      return reply.send({ ok: true, key: request.params.key, value });
    },
  );

  // ── /v1/projects — Projects CRUD + Groups + Tasks + Archive ──────────────
  // Extended from mission-control: grouping, pinning, task status, archive.

  interface _Group {
    id: string;
    name: string;
    color: string;
    ownerId?: string | null;
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
    /** Standing instructions for work done in this project. */
    instructions?: string;
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

  type _Req = { nexusUserId?: string };
  const _uid = (req: _Req) => req.nexusUserId ?? null;
  const _visible = ownsRow;
  const _myProject = (req: _Req, id: string) => {
    const p = _projects.get(id);
    return p && _visible(req, p) ? p : undefined;
  };
  const _myTask = (req: _Req, id: string) => {
    const t = _tasks.get(id);
    return t && _myProject(req, t.projectId) ? t : undefined;
  };

  // ── Groups CRUD ────────────────────────────────────────────────────────────

  app.get("/v1/groups", async (request, reply) => {
    return reply.send({ groups: [..._groups.values()].filter((g) => _visible(request, g)) });
  });

  app.post<{ Body: { name: string; color?: string } }>("/v1/groups", async (request, reply) => {
    const { name, color = "#6366f1" } = request.body ?? {};
    if (!name?.trim()) return reply.code(400).send({ message: "name is required" });
    const group: _Group = {
      id: `grp_${crypto.randomUUID()}`,
      name: name.trim(),
      color,
      ownerId: _uid(request),
      createdAt: now(),
    };
    _groups.set(group.id, group);
    return reply.code(201).send(group);
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; color?: string } }>(
    "/v1/groups/:id",
    async (request, reply) => {
      const group = _groups.get(request.params.id);
      if (!group || !_visible(request, group))
        return reply.code(404).send({ message: "group not found" });
      if (request.body?.name) group.name = request.body.name.trim();
      if (request.body?.color) group.color = request.body.color;
      _groups.set(group.id, group);
      return reply.send(group);
    },
  );

  app.delete<{ Params: { id: string } }>("/v1/groups/:id", async (request, reply) => {
    const group = _groups.get(request.params.id);
    if (!group || !_visible(request, group))
      return reply.code(404).send({ message: "group not found" });
    _groups.delete(group.id);
    for (const p of _projects.values()) {
      if (p.groupId === group.id) _projects.set(p.id, { ...p, groupId: null });
    }
    return reply.send({ ok: true });
  });

  // ── Projects CRUD ──────────────────────────────────────────────────────────

  app.get("/v1/projects", async (request, reply) => {
    const projects = [..._projects.values()]
      .filter((p) => _visible(request, p))
      .map(_projectView)
      .sort((a, b) => {
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
      id: `proj_${crypto.randomUUID()}`,
      name: name.trim(),
      description: description.trim(),
      icon: icon || name.trim().slice(0, 2).toUpperCase(),
      iconColor,
      groupId,
      pinned: false,
      conversationCount: 0,
      ownerId: _uid(request),
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
      instructions?: string;
    };
  }>("/v1/projects/:id", async (request, reply) => {
    const project = _myProject(request, request.params.id);
    if (!project) return reply.code(404).send({ message: "project not found" });
    if (typeof request.body?.instructions === "string")
      project.instructions = request.body.instructions.slice(0, 2000);
    if (request.body?.name) project.name = request.body.name.trim();
    if (request.body?.description !== undefined)
      project.description = request.body.description.trim();
    if (request.body?.icon) project.icon = request.body.icon;
    if (request.body?.iconColor) project.iconColor = request.body.iconColor;
    if (request.body?.groupId !== undefined) project.groupId = request.body.groupId;
    if (request.body?.pinned !== undefined) project.pinned = request.body.pinned;
    project.updatedAt = now();
    _projects.set(project.id, project);
    return reply.send(_projectView(project));
  });

  app.get<{ Params: { id: string } }>("/v1/projects/:id", async (request, reply) => {
    const project = _myProject(request, request.params.id);
    if (!project) return reply.code(404).send({ message: "project not found" });
    return reply.send(_projectView(project));
  });

  app.delete<{ Params: { id: string } }>("/v1/projects/:id", async (request, reply) => {
    const project = _myProject(request, request.params.id);
    if (!project) return reply.code(404).send({ message: "project not found" });
    _projects.delete(project.id);
    for (const t of [..._tasks.values()]) {
      if (t.projectId === project.id) _tasks.delete(t.id);
    }
    return reply.send({ ok: true });
  });

  // ── Tasks CRUD ─────────────────────────────────────────────────────────────

  app.get<{ Params: { id: string } }>("/v1/projects/:id/tasks", async (request, reply) => {
    if (!_myProject(request, request.params.id))
      return reply.code(404).send({ message: "project not found" });
    const tasks = [..._tasks.values()]
      .filter((t) => t.projectId === request.params.id && !t.archived)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return reply.send({ tasks });
  });

  app.post<{
    Params: { id: string };
    Body: { title: string; agent?: string; branch?: string };
  }>("/v1/projects/:id/tasks", async (request, reply) => {
    if (!_myProject(request, request.params.id))
      return reply.code(404).send({ message: "project not found" });
    const { title, agent = "shell", branch = "main" } = request.body ?? {};
    if (!title?.trim()) return reply.code(400).send({ message: "title is required" });
    const ts = now();
    const task: _Task = {
      id: `task_${crypto.randomUUID()}`,
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
    emitReaction(request.nexusUserId, "task.created", { taskId: task.id, title: task.title });
    return reply.code(201).send(task);
  });

  app.post<{
    Params: { id: string };
    Body: { status?: string; preview?: string; lines?: number };
  }>("/v1/tasks/:id/status", async (request, reply) => {
    const task = _myTask(request, request.params.id);
    if (!task) return reply.code(404).send({ message: "task not found" });
    const status = request.body?.status;
    if (status === "running" || status === "needs-input" || status === "done") {
      if (status === "done" && task.status !== "done") {
        emitReaction(request.nexusUserId, "task.completed", { taskId: task.id, title: task.title });
      }
      task.status = status;
    }
    if (request.body?.preview !== undefined) task.preview = request.body.preview;
    if (request.body?.lines !== undefined) task.lines = request.body.lines;
    task.updatedAt = now();
    _tasks.set(task.id, task);
    return reply.send(task);
  });

  for (const [action, archived] of [
    ["archive", true],
    ["restore", false],
  ] as const) {
    app.post<{ Params: { id: string } }>(`/v1/tasks/:id/${action}`, async (request, reply) => {
      const task = _myTask(request, request.params.id);
      if (!task) return reply.code(404).send({ message: "task not found" });
      task.archived = archived;
      task.updatedAt = now();
      _tasks.set(task.id, task);
      return reply.send({ ok: true });
    });
  }

  app.get("/v1/archive", async (request, reply) => {
    const tasks = [..._tasks.values()]
      .filter((t) => t.archived && _myProject(request, t.projectId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return reply.send({ tasks });
  });

  // Project file attachments.
  interface _ProjectFile {
    id: string;
    projectId: string;
    name: string;
    mimeType: string;
    size: number;
    content: string; // base64
    createdAt: string;
  }
  const _fileStore = new PersistentStore<_ProjectFile>("project-files");
  _fileStore.load().catch(() => {});
  const _fileMeta = ({ content: _content, ...meta }: _ProjectFile) => meta;

  app.get<{ Params: { id: string } }>(
    "/v1/projects/:id/files",
    { preHandler: bridgeRL },
    async (request, reply) => {
      if (!_myProject(request, request.params.id))
        return reply.code(404).send({ error: "project_not_found" });
      const files = [..._fileStore.values()]
        .filter((f) => f.projectId === request.params.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map(_fileMeta);
      return reply.send({ files });
    },
  );

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
      if (!_myProject(request, projectId))
        return reply.code(404).send({ error: "project_not_found" });
      const { name, content, mimeType } = request.body;
      const file: _ProjectFile = {
        id: `file_${crypto.randomUUID()}`,
        projectId,
        name: path.basename(name ?? `upload-${Date.now()}`),
        mimeType: mimeType ?? "application/octet-stream",
        size: Buffer.byteLength(content, "base64"),
        content,
        createdAt: new Date().toISOString(),
      };
      _fileStore.set(file.id, file);
      return reply.code(201).send(_fileMeta(file));
    },
  );

  app.delete<{ Params: { id: string; fileId: string } }>(
    "/v1/projects/:id/files/:fileId",
    { preHandler: bridgeRL },
    async (request, reply) => {
      const file = _fileStore.get(request.params.fileId);
      if (!file || file.projectId !== request.params.id || !_myProject(request, file.projectId)) {
        return reply.code(404).send({ error: "not_found" });
      }
      _fileStore.delete(request.params.fileId);
      return reply.send({ ok: true, deleted: request.params.fileId });
    },
  );

  app.get<{ Params: { id: string; fileId: string } }>(
    "/v1/projects/:id/files/:fileId",
    { preHandler: bridgeRL },
    async (request, reply) => {
      const file = _fileStore.get(request.params.fileId);
      if (!file || file.projectId !== request.params.id || !_myProject(request, file.projectId)) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.send(file);
    },
  );

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

  /** The caller's rows, plus ownerless legacy ones where they may see those. */
  const _mine = (req: { nexusUserId?: string }, p: string) =>
    seesOwnerless(req) ? `(user_id IS NULL OR user_id = ${p})` : `user_id = ${p}`;
  const _claimNull = (table: string, column = "user_id") => ({
    count: async () =>
      Number(
        (await _getPool()?.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column} IS NULL`))
          ?.rows[0]?.n ?? 0,
      ),
    assign: async (userId: string) =>
      (
        await _getPool()?.query(`UPDATE ${table} SET ${column}=$1 WHERE ${column} IS NULL`, [
          userId,
        ])
      )?.rowCount ?? 0,
  });
  claimable("build_tasks", _claimNull("build_tasks"));
  claimable("prompts", _claimNull("prompts"));
  for (const table of ["runtime_tasks", "ingested_events", "signals", "verdicts"])
    claimable(table, _claimNull(table, "owner_id"));
  const _btId = (raw: string) => (/^\d+$/.test(raw) ? parseInt(raw, 10) : null);
  /** Update one of the caller's tasks; null when it is not theirs or not found. */
  async function _btUpdate(
    req: { nexusUserId?: string },
    rawId: string,
    set: string,
    values: unknown[],
  ) {
    const pool = _getPool();
    const id = _btId(rawId);
    if (!pool || id === null) return null;
    const idP = values.length + 1;
    const ownerP = values.length + 2;
    const { rows } = await pool.query(
      `UPDATE build_tasks SET ${set}, updated_at=NOW() WHERE id=$${idP} AND ${_mine(req, `$${ownerP}`)} RETURNING *`,
      [...values, id, req.nexusUserId ?? null],
    );
    return rows[0] ? _btRow(rows[0]) : null;
  }

  app.get("/build/tasks", { preHandler: bridgeRL }, async (request, reply) => {
    const pool = _getPool();
    if (!pool) return reply.send({ tasks: [] });
    const { rows } = await pool.query(
      `SELECT * FROM build_tasks WHERE ${_mine(request, "$1")} ORDER BY created_at DESC LIMIT 200`,
      [request.nexusUserId ?? null],
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
         SELECT id FROM build_tasks
         WHERE status='planned' AND claimed_by IS NULL AND ${_mine(request, "$2")}
         ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
       ) RETURNING *`,
        [agentId, request.nexusUserId ?? null],
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
      `INSERT INTO build_tasks (title, description, status, parent_id, user_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [title.trim(), description, status, parentId, request.nexusUserId ?? null],
    );
    return reply.code(201).send(_btRow(rows[0]));
  });

  app.patch<{ Params: { id: string }; Body: { status?: string } }>(
    "/build/tasks/:id/status",
    { preHandler: bridgeRL },
    async (request, reply) => {
      const task = await _btUpdate(request, request.params.id, "status=$1", [
        request.body?.status ?? "planned",
      ]);
      if (!task) return reply.code(404).send({ error: "not found" });
      return reply.send(task);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/build/tasks/:id/claim",
    { preHandler: bridgeRL },
    async (request, reply) => {
      const task = await _btUpdate(
        request,
        request.params.id,
        "status='claimed', claimed_by='user', claimed_at=NOW()",
        [],
      );
      if (!task) return reply.code(404).send({ error: "not found" });
      return reply.send(task);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/build/tasks/:id/release",
    { preHandler: bridgeRL },
    async (request, reply) => {
      const task = await _btUpdate(
        request,
        request.params.id,
        "status='planned', claimed_by=NULL, claimed_at=NULL",
        [],
      );
      if (!task) return reply.code(404).send({ error: "not found" });
      return reply.send(task);
    },
  );

  app.post<{ Params: { id: string }; Body: { output: string } }>(
    "/build/tasks/:id/submit",
    { preHandler: bridgeRL },
    async (request, reply) => {
      const task = await _btUpdate(
        request,
        request.params.id,
        "status='review', output=$1, submitted_at=NOW()",
        [request.body?.output ?? ""],
      );
      if (!task) return reply.code(404).send({ error: "not found" });
      return reply.send(task);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/build/tasks/:id",
    { preHandler: bridgeRL },
    async (request, reply) => {
      const pool = _getPool();
      if (!pool) return reply.code(503).send({ error: "DB unavailable" });
      const id = _btId(request.params.id);
      if (id === null) return reply.code(404).send({ error: "not found" });
      await pool.query(`DELETE FROM build_tasks WHERE id=$1 AND ${_mine(request, "$2")}`, [
        id,
        request.nexusUserId ?? null,
      ]);
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

  // Prompts written before 0016_prompt_owner have no owner; see seesOwnerless.
  const _UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const _myPrompt = async (
    pool: NonNullable<ReturnType<typeof _getPool>>,
    id: string,
    req: { nexusUserId?: string },
  ) => {
    if (!_UUID.test(id)) return undefined;
    const { rows } = await pool.query(`SELECT * FROM prompts WHERE id=$1 AND ${_mine(req, "$2")}`, [
      id,
      req.nexusUserId ?? null,
    ]);
    return rows[0];
  };

  app.get("/prompts", { preHandler: bridgeRL }, async (request, reply) => {
    const pool = _getPool();
    if (!pool) return reply.send({ prompts: [] });
    const { rows: prompts } = await pool.query(
      `SELECT * FROM prompts WHERE ${_mine(request, "$1")} ORDER BY created_at DESC`,
      [request.nexusUserId ?? null],
    );
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
        "INSERT INTO prompts (name, description, user_id) VALUES ($1, $2, $3) RETURNING *",
        [name.trim(), description ?? null, request.nexusUserId ?? null],
      );

      const p = pRows.rows[0]!;
      const vRows = await pool.query(
        "INSERT INTO prompt_versions (prompt_id, version_num, content) VALUES ($1, 1, $2) RETURNING *",
        [p.id, defaultContent],
      );

      const v = vRows.rows[0]!;
      return reply.code(201).send(_promptRow(p, [v]));
    },
  );

  app.get<{ Params: { id: string } }>(
    "/prompts/:id",
    { preHandler: bridgeRL },
    async (request, reply) => {
      const pool = _getPool();
      if (!pool) return reply.code(503).send({ error: "DB unavailable" });
      const p = await _myPrompt(pool, request.params.id, request);
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
    const p = await _myPrompt(pool, request.params.id, request);
    if (!p) return reply.code(404).send({ error: "not found" });
    const { content = "", model = null, temperature = null } = request.body ?? {};
    if (!content.trim()) return reply.code(400).send({ error: "content required" });
    const maxResult = await pool.query(
      "SELECT COALESCE(MAX(version_num), 0) AS max FROM prompt_versions WHERE prompt_id=$1",
      [p.id],
    );

    const nextNum = (Number(maxResult.rows[0]?.max) || 0) + 1;
    const vResult = await pool.query(
      "INSERT INTO prompt_versions (prompt_id, version_num, content, model, temperature) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [p.id, nextNum, content, model, temperature],
    );

    const v = vResult.rows[0]!;
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
      if (!(await _myPrompt(pool, request.params.id, request)))
        return reply.code(404).send({ error: "not found" });
      await pool.query("DELETE FROM prompts WHERE id=$1", [request.params.id]);
      return reply.send({ ok: true });
    },
  );

  // -- ARCHETYPES — owned by routes/archetypes.ts (Stage D1) -------------------
  // Durable, per-user, and read by every council path. The array that used to
  // live here was none of those.
  await app.register(archetypesRoutes);
  await app.register(stmBridgeRoutes);

  // ── Admin traces — model calls per request (lib/request-traces.ts) ─────────

  app.get<{ Querystring: { page?: string; limit?: string; type?: string } }>(
    "/traces",
    { preHandler: requireAdminRoleBridge },
    async (request, reply) => {
      const page = Math.max(1, parseInt(request.query.page ?? "1", 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(request.query.limit ?? "20", 10) || 20));
      return reply.send(await listTraces({ type: request.query.type, page, limit }));
    },
  );

  app.get<{ Params: { id: string } }>(
    "/traces/:id",
    { preHandler: requireAdminRoleBridge },
    async (request, reply) => {
      const trace = await getTrace(request.params.id);
      if (!trace) return reply.code(404).send({ error: "not_found" });
      return reply.send(trace);
    },
  );

  // Marketplace surface (§16.7 extraction, §16.2 registry-backed) — formerly
  // inline in this file; now owned by routes/marketplace.ts.
  await marketplaceRoutes(app);
}
