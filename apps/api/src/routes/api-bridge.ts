// SPDX-License-Identifier: Apache-2.0
/**
 * Judica-compat routes — mounts under /api (no version prefix).
 *
 * Bridges the Judica frontend's /api/* call surface to the Nexus backend.
 * Three categories:
 *
 *   A) Path aliases   — delegate to same packages as existing /api/v1/* routes
 *   B) New endpoints  — real implementations (chat stream, ab)
 *   C) Store-backed   — PersistentStore CRUD for surfaces without a table yet
 *
 * Sign-in lives at /api/v1/auth/*; this prefix only bridges the older surface.
 *
 * Register in server.ts under { prefix: "/api" }.
 */

import type { ServerResponse } from "node:http";

import { AdaptiveScraper, HttpxEngine } from "@nexus/adaptive-scraper";
import { isDockerAvailable } from "@nexus/code-repl";
import { ULTRAPLINIAN_MODELS } from "@nexus/council/gauntlet";
import { db } from "@nexus/db";
import { auditLog } from "@nexus/db/schema";
import { globalFlags } from "@nexus/feature-flags";
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
  type LlmUsage,
} from "@nexus/llm/drivers";
import { FixedEmbedder, MemoryManager, createBestEmbedder, type IEmbedder } from "@nexus/memory";
import { searchBrave, searchExa, searchSearxNG, searchSerper } from "@nexus/search-orchestrator";
import { desc } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { writeChannel } from "../lib/channels.ts";
import { costLogStore, trackCost, type CostEntry } from "../lib/cost-log.ts";
import { sha256hex } from "../lib/crypto-utils.ts";
import { searchDuckDuckGo, searchWikipedia } from "../lib/duckduckgo.ts";
import { getKG } from "../lib/knowledge-graph-store.ts";
import {
  FailoverDriver,
  getFailoverDriver,
  setFailoverProviders,
  type FailoverProviderEntry,
} from "../lib/llm-failover.ts";
import { getMemoryStore } from "../lib/memory-store.ts";
import { resolveOAuthDriver } from "../lib/oauth-drivers.ts";
import { claimable } from "../lib/owner.ts";
import { PersistentStore } from "../lib/persistent-store.ts";
import { getPgPool } from "../lib/pg-pool.ts";
import {
  buildUserDriverRegistry,
  listUserModels,
  serviceKey,
  userEndpoint,
} from "../lib/provider-keys.ts";
import { callerFetch, fetchPublic } from "../lib/public-url.ts";
import { getTrace, listTraces } from "../lib/request-traces.ts";
// Event emitters push completion/failure into the per-user notification store.
// (The HTTP surface for the store lives in routes/notifications.ts.)
import { getCacheUserId, getUserDrivers } from "../lib/user-context.ts";

import { requireAdminRole as requireAdminRoleBridge } from "./admin-users.ts";
import { analyticsRoutes } from "./analytics.ts";
import { archetypesRoutes } from "./archetypes.ts";
import { billingBridgeRoutes } from "./billing-bridge.ts";
import { browserAgentRoutes } from "./browser-agent.ts";
import { chatRoutes } from "./chat.ts";
import { codeAgentRoutes } from "./code-agent.ts";
import { citationSources, contextRoutes, mentionContext } from "./context.ts";
import { costsRoutes } from "./costs.ts";
import { deliberationsRoutes } from "./deliberations.ts";
import { gatewayLog } from "./gateway.ts";
import { kbRoutes } from "./kb.ts";
import { kgRoutes } from "./kg.ts";
import { memoryBridgeRoutes } from "./memory-bridge.ts";
import { moderationRoutes, runModeration, type ModerationDeps } from "./moderation.ts";
import { negBlock, negRulesFor, negationRoutes, type NegRule } from "./negation.ts";
import { projectsRoutes } from "./projects.ts";
import { providerKeysRoutes } from "./provider-keys.ts";
import { reactionsRoutes } from "./reactions.ts";
import { allFeedback } from "./rlhf.ts";
import { sandboxRoutes } from "./sandbox.ts";
import { searchRoutes } from "./search.ts";
import { settingsRoutes } from "./settings.ts";
import { registerSkillRoutes } from "./skills.ts";
import { specialisationPreamble, specialisationRoutes } from "./specialisation.ts";
import { systemConfigRoutes } from "./system-config.ts";
import { tokensRoutes } from "./tokens.ts";
import { ttsRoutes } from "./tts.ts";
import { workflowsRoutes } from "./workflows.ts";

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
/** NEXUS_DEFAULT_COUNCIL as members: `provider:model` pairs, comma-separated. */
function defaultCouncil(): { label: string; provider: string; model: string }[] {
  return (process.env.NEXUS_DEFAULT_COUNCIL ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.includes(":"))
    .map((s) => {
      const at = s.indexOf(":");
      const model = s.slice(at + 1);
      return { label: model.split("/").at(-1)!, provider: s.slice(0, at), model };
    });
}

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

/** The model internal LLM calls ask for when NEXUS_DEFAULT_MODEL or the admin setting names one. */
let _configuredModel = process.env.NEXUS_DEFAULT_MODEL ?? "";

/**
 * Model for internal LLM calls: the configured one, else the first provider's own model, so a
 * server holding only a Groq key never asks Groq for another provider's model.
 */
function defaultModel(): string {
  return _configuredModel || getDefaultDriver()?.model || "anthropic/claude-3.5-haiku";
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

/**
 * The caller's own connections as chain entries: one per model a connection lists, so a model
 * that is out of allowance hands over to its sibling before the chain leaves the connection.
 */
function ownEntries(skip?: string): FailoverProviderEntry[] {
  return getUserDrivers()
    .filter((e) => e.id !== skip)
    .flatMap<FailoverProviderEntry>((e) =>
      e.models && e.models.length > 1
        ? e.models.map((model) => ({ id: `user:${e.id}`, driver: e.driver, model }))
        : [{ id: `user:${e.id}`, driver: e.driver, ownModel: true }],
    );
}

export function getDefaultDriver() {
  const entries = buildFailoverEntries();
  // The caller's own saved keys come first; the server's keys stay as fallback.
  const own = ownEntries();
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
      : [
          ...ownEntries(pin?.id.startsWith("user:") ? pin.provider : undefined),
          ...buildFailoverEntries()
            .filter((e) => e.id !== pin?.id)
            .map((e) => ({ id: e.id, driver: e.driver, ownModel: true })),
        ]),
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

// ── Cost tracking ─────────────────────────────────────────────────────────────

// Usage/cost log — durable via lib/cost-log.ts (write-behind to day-sharded KV
// keys; boot reloads it so dashboard stats, windowed series, and the weekly
// digest survive API restarts). `_costLog` stays the same in-memory array every
// read below touches; only recording moved into the store.
const _costLog: readonly CostEntry[] = costLogStore.entries;

const _trackCost = trackCost;

/** Bill a call to the provider and model that answered it, which failover may have changed. */
function _trackServed(
  res: { model?: string; usage?: LlmUsage; provider?: string },
  requested: string,
) {
  _trackCost(res.model || requested, res.usage, res.provider);
}

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
  model = defaultModel(),
): Promise<string> {
  const driver = getDefaultDriver();
  if (!driver) throw Object.assign(new Error(NO_LLM_MESSAGE), { statusCode: 503 });
  const res = await driver.complete({ model, messages, maxTokens });
  _trackServed(res, model);
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
export async function fetchModelCatalog(
  base: string,
  key: string | null,
): Promise<string[] | null> {
  const cacheKey = `${base}\n${key ? sha256hex(key) : ""}`;
  const cached = _catalogCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) return cached.ids;
  try {
    // A user saved this base URL; resolve-and-pin so it cannot re-point at a private host.
    const res = await callerFetch(`${base.replace(/\/+$/, "")}/models`, {
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

  await Promise.all([
    _abStore.load(),
    _councilStore.load(),
    _prefsStore.load(),
    _stdAnswers.load(),
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

  // -- CONTEXT MENTION SEARCH — owned by routes/context.ts -------------------
  // Chat reads the same mention blocks as the pickers, so the deps are shared.
  const contextDeps = { getMemory, getScraper, webSearch: _webSearch };
  const moderationDeps: ModerationDeps = {
    serviceKey,
    getCacheUserId,
    getDefaultDriver,
    defaultModel,
    trackServed: _trackServed,
    parseJsonResponse,
    noLlm: NO_LLM_MESSAGE,
  };
  const chatDeps = {
    buildChatRegistry,
    defaultCouncil,
    sse: { headers: SSE_HEADERS, write: sseWrite, liveChannels },
    prefsStore: _prefsStore,
    prefsDefaults: _prefsDefaults,
    runModeration: (text: string, only?: string[]) => runModeration(moderationDeps, text, only),
    stdPreamble: (req: { nexusUserId?: string }, message: string) => _stdPreamble(req, message),
    dissentPreamble: (level: unknown) => _dissentPreamble(level),
    specialisationPreamble: (req: { nexusUserId?: string }, threadId: unknown) =>
      specialisationPreamble(req, threadId),
    negRulesFor: (req: { nexusUserId?: string }, threadId: string) => negRulesFor(req, threadId),
    negBlock: (rules: unknown) => negBlock(rules as NegRule[]),
    mentionContext: (
      raw: unknown,
      userId: string | undefined,
      message: string,
      skip?: readonly string[],
    ) => mentionContext(contextDeps, raw, userId, message, skip),
    citationSources: (raw: unknown, userId: string | undefined, message: string) =>
      citationSources(contextDeps, raw, userId, message),
    getMemory,
    getEmbedder,
  };

  // ══════════════════════════════════════════════════════════════════════════
  // B.4 — CHAT MULTI-MODEL STREAM (multi-round debate)
  // POST /api/chat/stream
  // Body: { message, members: [{label, provider, model}][], round, rounds?, threadId }
  // Streams: opinion* → verdict? → done
  // Each enabled member fires in parallel; text chunks arrive as "opinion" events.
  // rounds >= 2 runs a real debate: round 0 is independent, then every member
  // sees the other members' latest answers and refines (cumulative per-member
  // context, mirroring @nexus/council's runMultiAgentDebate design).
  // Uses server-side DriverRegistry — no client API keys needed.
  // ══════════════════════════════════════════════════════════════════════════

  await chatRoutes(app, chatDeps);

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
      const context = await mentionContext(
        contextDeps,
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
              model: defaultModel(),
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
            _trackServed(res, defaultModel());
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

  await settingsRoutes(app, {
    prefsStore: _prefsStore,
    prefsDefaults: _prefsDefaults,
    councilStore: _councilStore,
    buildChatRegistry,
    validateCouncilMembers: (userId, members, sources) =>
      validateCouncilMembers(userId, members, sources as unknown as Map<string, MemberKeySource>),
  });

  // -- WORKFLOWS — owned by routes/workflows.ts (§16.7) ---------------------
  // Runs use the bridge's LLM wiring (getDefaultDriver/buildChatRegistry) via
  // explicit injection — the module has no circular import.
  await workflowsRoutes(app, { getDefaultDriver, buildChatRegistry });

  // -- API TOKENS — owned by routes/tokens.ts (§16.7) -----------------------
  await app.register(tokensRoutes);

  // -- WEB SEARCH ------------------------------------------------------------
  // The first provider with a key or URL that finds something answers; DuckDuckGo and
  // Wikipedia need neither and go last.

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
      { id: "wikipedia", name: "Wikipedia", ready: true, run: searchWikipedia },
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
        const results = (await p.run(query, max)).slice(0, max);
        if (results.length || p === chosen.at(-1)) return { results, provider: p.id };
      } catch (e) {
        error = `${p.name}: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    return { results: [], provider: null, error };
  }

  // -- COSTS (real — derived from _costLog accumulated by _llm() helper) ------
  // §16.7: the /costs/* surface lives in routes/costs.ts (same mount, same
  // scope, byte-identical response shapes).

  // §16.7 extraction: the /costs/* handlers live in routes/costs.ts (single
  // owner, byte-identical response shapes).
  await app.register(costsRoutes);

  await analyticsRoutes(app, { costLog: _costLog, gatewayLog });

  // -- SANDBOX — owned by routes/sandbox.ts (§16.7) --------------------------
  // JS via vm, Python via Pyodide (WASM), others via a self-hosted Piston.
  // runViaPyodide / runViaPiston are imported from there for the code-agent
  // build/run path below; _dockerReady feeds /sandbox/status telemetry.

  await browserAgentRoutes(app, {
    getRegistry,
    getDriver: getDefaultDriver,
    defaultModel,
  });

  const _dockerReady = isDockerAvailable();
  await sandboxRoutes(app, { dockerReady: _dockerReady });
  await codeAgentRoutes(app, {
    dockerReady: _dockerReady,
    getDriver: getDefaultDriver,
    defaultModel,
    trackServed: _trackServed,
  });

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

  await billingBridgeRoutes(app, { costLog: _costLog });
  await providerKeysRoutes(app);

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

  // -- SKILLS ----------------------------------------------------------------
  // Owner: routes/skills.ts — GET/POST/DELETE /skills plus POST /skills/merge
  // live there (PersistentStore collection "skills", same /api scope, same
  // auth). api-bridge only supplies the narrow driver/cost deps.
  await registerSkillRoutes(app, {
    defaultModel: defaultModel(),
    getDefaultDriver,
    trackCost: _trackCost,
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

  await reactionsRoutes(app, { llm: _llm });

  await specialisationRoutes(app);

  await negationRoutes(app);
  await moderationRoutes(app, moderationDeps);

  await ttsRoutes(app, { serviceKey });

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

  // -- CONTEXT MENTION SEARCH — owned by routes/context.ts -------------------
  await contextRoutes(app, contextDeps);

  await deliberationsRoutes(app, { llm: _llm });

  await systemConfigRoutes(app, {
    initialModel: _configuredModel,
    setModel: (model) => {
      _configuredModel = model;
    },
  });

  await projectsRoutes(app);

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
  // -- ARCHETYPES — owned by routes/archetypes.ts (Stage D1) -------------------
  // Durable, per-user, and read by every council path. The array that used to
  // live here was none of those.
  await app.register(archetypesRoutes);

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
}
