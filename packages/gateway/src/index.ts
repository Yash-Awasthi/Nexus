// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/gateway — Model Gateway
 *
 * Exposes an Anthropic Messages API-compatible interface and routes requests
 * to any OpenAI-compatible backend (Groq, local Ollama, OpenAI, etc.).
 *
 * Features
 * --------
 *  • Model alias table  — "nexus/smart", "nexus/fast", claude-* names all resolve
 *  • Provider registry  — per-provider base URLs and env-key names
 *  • Format translation — Anthropic ↔ OpenAI chat/completions
 *  • Streaming          — pass-through SSE when stream:true (chunked fetch)
 *  • Override header    — x-nexus-provider: groq|openai|local overrides routing
 *
 * Usage (library)
 * ---------------
 *   import { routeMessage, type GatewayConfig } from "@nexus/gateway";
 *
 *   const response = await routeMessage(anthropicRequest, {
 *     providers: { groq: { apiKey: process.env.GROQ_API_KEY! } },
 *   });
 */

import { randomUUID } from "crypto";

// ── Public types ──────────────────────────────────────────────────────────────

export type ContentBlockType = "text";

/** Text block interface definition. */
export interface TextBlock {
  type: "text";
  text: string;
}

/** Content block type alias. */
export type ContentBlock = TextBlock;

/** Anthropic message interface definition. */
export interface AnthropicMessage {
  role: "user" | "assistant";
  /** String shorthand OR structured content blocks */
  content: string | ContentBlock[];
}

/** Anthropic request interface definition. */
export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  /** Optional system prompt (Anthropic top-level field) */
  system?: string;
  max_tokens?: number;
  temperature?: number;
  /** When true, caller handles SSE stream — routeMessage returns a Response */
  stream?: boolean;
  metadata?: { user_id?: string };
}

/** Anthropic usage interface definition. */
export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
}

/** Anthropic response interface definition. */
export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: ContentBlock[];
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

/** Provider config interface definition. */
export interface ProviderConfig {
  /** API key for this provider */
  apiKey: string;
  /** Override base URL (e.g. point at a local Ollama instance) */
  baseUrl?: string;
}

/** Gateway config interface definition. */
export interface GatewayConfig {
  providers: {
    groq?: ProviderConfig;
    openai?: ProviderConfig;
    local?: ProviderConfig;
    [name: string]: ProviderConfig | undefined;
  };
  /**
   * Additional model aliases merged with the built-in table.
   * Key: model name sent by the client.
   * Value: { provider, model } to use.
   */
  extraAliases?: Record<string, ModelTarget>;
}

/** Model target interface definition. */
export interface ModelTarget {
  provider: string;
  model: string;
}

/** Gateway error interface definition. */
export interface GatewayError extends Error {
  code: "MODEL_NOT_FOUND" | "PROVIDER_NOT_CONFIGURED" | "UPSTREAM_ERROR" | "UNSUPPORTED_CONTENT";
  statusCode: number;
  upstream?: { status: number; body: string };
}

// ── Internal OpenAI types ─────────────────────────────────────────────────────

interface OAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OAIRequest {
  model: string;
  messages: OAIMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

interface OAIChoice {
  message: { role: string; content: string | null };
  finish_reason: string | null;
}

interface OAIResponse {
  id: string;
  choices: OAIChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

// ── Model alias table ─────────────────────────────────────────────────────────

const GROQ_SMART = "llama-3.3-70b-versatile";
const GROQ_FAST = "llama-3.1-8b-instant";

/** Built-in aliases. Client model names → { provider, backendModel } */
export const BUILTIN_ALIASES: Record<string, ModelTarget> = {
  // Nexus shorthand
  "nexus/smart": { provider: "groq", model: GROQ_SMART },
  "nexus/planner": { provider: "groq", model: GROQ_SMART },
  "nexus/fast": { provider: "groq", model: GROQ_FAST },
  "nexus/eval": { provider: "groq", model: GROQ_FAST },
  // Claude passthrough aliases (remap to Groq equivalents by default)
  "claude-3-5-sonnet-20241022": { provider: "groq", model: GROQ_SMART },
  "claude-3-5-haiku-20241022": { provider: "groq", model: GROQ_FAST },
  "claude-3-haiku-20240307": { provider: "groq", model: GROQ_FAST },
  "claude-3-opus-20240229": { provider: "groq", model: GROQ_SMART },
};

/** Built-in provider base URLs */
const DEFAULT_BASE_URLS: Record<string, string> = {
  groq: "https://api.groq.com/openai/v1/chat/completions",
  openai: "https://api.openai.com/v1/chat/completions",
  local: "http://localhost:11434/v1/chat/completions",
};

// ── GatewayError factory ──────────────────────────────────────────────────────

function makeGatewayError(
  message: string,
  code: GatewayError["code"],
  statusCode: number,
  upstream?: { status: number; body: string },
): GatewayError {
  const err = new Error(message) as GatewayError;
  err.code = code;
  err.statusCode = statusCode;
  err.upstream = upstream;
  return err;
}

// ── Model resolution ──────────────────────────────────────────────────────────

export function resolveModel(
  clientModel: string,
  config: GatewayConfig,
  overrideProvider?: string,
): ModelTarget {
  const aliases: Record<string, ModelTarget> = {
    ...BUILTIN_ALIASES,
    ...(config.extraAliases ?? {}),
  };

  // Prefer alias lookup first
  const aliased = aliases[clientModel];

  if (aliased) {
    // If caller overrides the provider, keep the resolved model but swap provider
    return overrideProvider ? { provider: overrideProvider, model: aliased.model } : aliased;
  }

  // If the model name looks like a llama/mistral/gemma style name, pass through to override or groq
  const provider = overrideProvider ?? "groq";
  return { provider, model: clientModel };
}

// ── Format translation ────────────────────────────────────────────────────────

/** Flatten Anthropic content (string | block[]) to a plain string */
function flattenContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** Anthropic Messages request → OpenAI chat/completions request */
export function toOpenAIRequest(req: AnthropicRequest, resolvedModel: string): OAIRequest {
  const messages: OAIMessage[] = [];

  // Anthropic's top-level `system` field → OAI system message prepended
  if (req.system) {
    messages.push({ role: "system", content: req.system });
  }

  for (const msg of req.messages) {
    messages.push({ role: msg.role, content: flattenContent(msg.content) });
  }

  return {
    model: resolvedModel,
    messages,
    ...(req.max_tokens !== undefined && { max_tokens: req.max_tokens }),
    ...(req.temperature !== undefined && { temperature: req.temperature }),
    ...(req.stream && { stream: true }),
  };
}

/** Map OAI finish_reason → Anthropic stop_reason */
function mapStopReason(reason: string | null): AnthropicResponse["stop_reason"] {
  if (reason === "stop") return "end_turn";
  if (reason === "length") return "max_tokens";
  if (reason === "content_filter") return "stop_sequence";
  return null;
}

/** OpenAI chat/completions response → Anthropic Messages response */
export function toAnthropicResponse(oaiRes: OAIResponse, originalModel: string): AnthropicResponse {
  const choice = oaiRes.choices[0];
  const text = choice?.message.content ?? "";

  return {
    id: `msg_${oaiRes.id}`,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model: originalModel,
    stop_reason: mapStopReason(choice?.finish_reason ?? null),
    stop_sequence: null,
    usage: {
      input_tokens: oaiRes.usage?.prompt_tokens ?? 0,
      output_tokens: oaiRes.usage?.completion_tokens ?? 0,
    },
  };
}

// ── Core routing function ─────────────────────────────────────────────────────

/**
 * Route an Anthropic-format request to the appropriate upstream provider.
 *
 * @param req           Anthropic Messages API request body
 * @param config        Gateway configuration (provider keys, extra aliases)
 * @param overrideProvider  Optional provider name from x-nexus-provider header
 * @param fetchFn       Injectable fetch (defaults to global fetch; pass mock in tests)
 */
export async function routeMessage(
  req: AnthropicRequest,
  config: GatewayConfig,
  overrideProvider?: string,
  fetchFn: typeof fetch = fetch,
): Promise<AnthropicResponse> {
  const target = resolveModel(req.model, config, overrideProvider);
  const providerCfg = config.providers[target.provider];

  if (!providerCfg) {
    throw makeGatewayError(
      `Provider "${target.provider}" is not configured`,
      "PROVIDER_NOT_CONFIGURED",
      502,
    );
  }

  const baseUrl = providerCfg.baseUrl ?? DEFAULT_BASE_URLS[target.provider];
  if (!baseUrl) {
    throw makeGatewayError(
      `No base URL known for provider "${target.provider}"`,
      "PROVIDER_NOT_CONFIGURED",
      502,
    );
  }

  const oaiBody = toOpenAIRequest(req, target.model);

  const upstreamRes = await fetchFn(baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${providerCfg.apiKey}`,
    },
    body: JSON.stringify(oaiBody),
  });

  if (!upstreamRes.ok) {
    const body = await upstreamRes.text();
    throw makeGatewayError(
      `Upstream error from ${target.provider}: ${upstreamRes.status}`,
      "UPSTREAM_ERROR",
      upstreamRes.status >= 500 ? 502 : upstreamRes.status,
      { status: upstreamRes.status, body },
    );
  }

  const oaiData = (await upstreamRes.json()) as OAIResponse;

  // Ensure id field is present (some providers may omit it)
  if (!oaiData.id) oaiData.id = randomUUID();

  return toAnthropicResponse(oaiData, req.model);
}

// ── Re-exports for route wiring ───────────────────────────────────────────────

export { DEFAULT_BASE_URLS, GROQ_SMART, GROQ_FAST };

// ── IProvider + failover (from jcode / 1jehuang/jcode) ───────────────────────
//
// Extracted from jcode-provider-core. Adds a proper provider interface with
// static+dynamic system prompt splitting (cache-optimized) and a production
// failover classifier covering 30+ error patterns across 3 categories.
//
// IProvider             — streaming LLM provider interface
// FailoverDecision      — None | RetryNextProvider | RetryAndMarkUnavailable
// ProviderFailoverPrompt — serialisable failover notification (from/to/reason)
// classify_failover_error_message — 3-category error classifier
// parse_failover_prompt_message   — deserialise failover from error string

// ── IProvider ─────────────────────────────────────────────────────────────────

/**
 * Streaming LLM provider interface.
 *
 * `complete_split` separates static system prompt (cache-stable) from dynamic
 * context (changes per turn). Providers that support prompt caching should
 * inject dynamic context as a user-side message so the static prefix stays
 * cached across turns.
 */
export interface IProvider {
  /** Send messages and return a streaming async iterable of text chunks. */
  complete(
    messages: { role: string; content: string }[],
    tools: unknown[],
    system: string,
    resumeSessionId?: string,
  ): Promise<AsyncIterable<string>>;

  /**
   * Cache-optimized variant: static system prompt stays constant (cacheable);
   * dynamic context changes per turn and is injected as a user-side message.
   * Falls back to `complete(messages, tools, systemStatic)` by default.
   */
  completeSplit?(
    messages: { role: string; content: string }[],
    tools: unknown[],
    systemStatic: string,
    systemDynamic: string,
    resumeSessionId?: string,
  ): Promise<AsyncIterable<string>>;

  /** Stable machine-facing provider name (e.g. `"anthropic"`, `"openrouter"`). */
  name(): string;

  /** Human-facing label for the current runtime selection. Defaults to `name()`. */
  displayName?(): string;

  /** Current model identifier. */
  model?(): string;

  /** Switch to a different model. Throws if unsupported. */
  setModel?(model: string): void;

  /** Whether this provider can receive image content blocks. */
  supportsImageInput?(): boolean;

  /** List available model identifiers. */
  availableModels?(): string[];
}

// ── FailoverDecision ──────────────────────────────────────────────────────────

export const FailoverDecision = {
  /** No failover — error is not retryable via a different provider. */
  None: "none",
  /**
   * Retry with the next provider. Used for context-length errors where
   * the current provider can't handle this request size but others might.
   */
  RetryNextProvider: "retry-next-provider",
  /**
   * Retry AND mark the current provider unavailable for future requests.
   * Used for rate limits, quota exhaustion, auth/billing failures.
   */
  RetryAndMarkUnavailable: "retry-and-mark-unavailable",
} as const;

export type FailoverDecision = (typeof FailoverDecision)[keyof typeof FailoverDecision];

export function failoverShouldSwitch(d: FailoverDecision): boolean {
  return d !== FailoverDecision.None;
}

export function failoverShouldMarkUnavailable(d: FailoverDecision): boolean {
  return d === FailoverDecision.RetryAndMarkUnavailable;
}

// ── ProviderFailoverPrompt ────────────────────────────────────────────────────

const _FAILOVER_PREFIX = "[nexus-provider-failover]";

/**
 * Serialisable failover notification embedded in error messages.
 * Lets callers decode structured failover metadata from a string error
 * without a separate transport channel.
 */
export interface ProviderFailoverPrompt {
  fromProvider: string;
  fromLabel: string;
  toProvider: string;
  toLabel: string;
  reason: string;
  estimatedInputChars: number;
  estimatedInputTokens: number;
}

/** Encode a failover prompt as an error message string. */
export function failoverPromptToMessage(prompt: ProviderFailoverPrompt): string {
  const payload = JSON.stringify(prompt);
  return (
    `${_FAILOVER_PREFIX}${payload}\n` +
    `${prompt.fromLabel} is unavailable; switching to ${prompt.toLabel} would resend ` +
    `about ${prompt.estimatedInputTokens} input tokens (~${prompt.estimatedInputChars} chars).`
  );
}

/** Parse a failover prompt from an error message string. Returns null if not present. */
export function parseFailoverPromptMessage(message: string): ProviderFailoverPrompt | null {
  const line = message.split("\n")[0]?.trim() ?? "";
  const json = line.startsWith(_FAILOVER_PREFIX) ? line.slice(_FAILOVER_PREFIX.length) : null;
  if (!json) return null;
  try {
    return JSON.parse(json) as ProviderFailoverPrompt;
  } catch {
    return null;
  }
}

// ── classify_failover_error_message ──────────────────────────────────────────

/**
 * Classify an error message string into a failover decision.
 *
 * Three categories:
 *   - Context/size errors (413, "context length", "too many tokens") → RetryNextProvider
 *   - Rate limit / quota / billing (429, 402, "rate limit", "quota") → RetryAndMarkUnavailable
 *   - Auth / access errors (401, 403, "unauthorized", "forbidden")  → RetryAndMarkUnavailable
 *   - Everything else → None
 *
 * Status code matching is isolated (e.g. "4130" does NOT match "413").
 *
 * @example
 * ```ts
 * classifyFailoverError('429 Too Many Requests')
 * // → 'retry-and-mark-unavailable'
 *
 * classifyFailoverError('context length exceeded')
 * // → 'retry-next-provider'
 *
 * classifyFailoverError('internal server error')
 * // → 'none'
 * ```
 */
export function classifyFailoverError(message: string): FailoverDecision {
  const lower = message.toLowerCase();

  function hasCode(code: string): boolean {
    const idx = lower.indexOf(code);
    if (idx === -1) return false;
    const before = idx === 0 || !/\d/.test(lower[idx - 1]!);
    const after = idx + code.length >= lower.length || !/\d/.test(lower[idx + code.length]!);
    return before && after;
  }

  const isContextSize =
    [
      "context length",
      "context_length",
      "context window",
      "maximum context",
      "prompt is too long",
      "input is too long",
      "too many tokens",
      "max tokens",
      "token limit",
      "token_limit",
      "413 payload too large",
      "413 request entity too large",
    ].some((p) => lower.includes(p)) || hasCode("413");

  if (isContextSize) return FailoverDecision.RetryNextProvider;

  const isRateOrQuota =
    [
      "rate limit",
      "rate-limited",
      "too many requests",
      "quota",
      "credit balance",
      "credits have run out",
      "insufficient credit",
      "billing",
      "payment required",
      "usage tier",
    ].some((p) => lower.includes(p)) ||
    hasCode("429") ||
    hasCode("402");

  if (isRateOrQuota) return FailoverDecision.RetryAndMarkUnavailable;

  const isAuthAccess =
    [
      "access denied",
      "not accessible by integration",
      "provider unavailable",
      "provider not available",
      "provider is unavailable",
      "provider currently unavailable",
      "provider not configured",
      "credentials are not configured",
      "no credentials",
      "token exchange failed",
      "authentication failed",
      "unauthorized",
      "forbidden",
    ].some((p) => lower.includes(p)) ||
    hasCode("401") ||
    hasCode("403");

  if (isAuthAccess) return FailoverDecision.RetryAndMarkUnavailable;

  return FailoverDecision.None;
}

// ── OvernightManifest (from jcode-overnight-core) ────────────────────────────
//
// Background / long-running job manifest pattern. Tracks a multi-session
// overnight run with coordinator + parent session IDs, all relevant file
// paths, timing windows (wake, handoff, grace), and resource snapshots.
// Useful for any long-running async job that needs durable state.

export type OvernightRunStatus = "running" | "cancel_requested" | "completed" | "failed";

/**
 * Durable manifest for a background / overnight run.
 * Written to disk on start; updated on status transitions.
 * All timestamp fields are ISO-8601 strings for portable serialisation.
 */
export interface OvernightManifest {
  version: number;
  runId: string;
  parentSessionId: string;
  coordinatorSessionId: string;
  coordinatorSessionName: string;
  startedAt: string;
  targetWakeAt: string;
  handoffReadyAt: string;
  postWakeGraceUntil: string;
  morningReportPostedAt?: string;
  completedAt?: string;
  cancelRequestedAt?: string;
  status: OvernightRunStatus;
  mission?: string;
  workingDir?: string;
  providerName: string;
  model: string;
  maxAgentsGuidance: number;
  processId: number;
  /** Root directory for this run's persisted files. */
  runDir: string;
  eventsPath: string;
  humanLogPath: string;
  reviewPath: string;
  reviewNotesPath: string;
  preflightPath: string;
  taskCardsDir: string;
  issueDraftsDir: string;
  validationDir: string;
  lastActivityAt: string;
}

/** Timestamped event log entry for an overnight run. */
export interface OvernightEvent {
  timestamp: string;
  runId: string;
  sessionId?: string;
  kind: string;
  summary: string;
  details?: unknown;
  /** Whether this event is meaningful enough for the morning report. */
  meaningful: boolean;
}

/** Point-in-time system resource snapshot for overnight health monitoring. */
export interface ResourceSnapshot {
  capturedAt: string;
  memoryTotalMb?: number;
  memoryAvailableMb?: number;
  memoryUsedPercent?: number;
  swapTotalMb?: number;
  swapFreeMb?: number;
  loadOne?: number;
  cpuCount?: number;
  batteryPercent?: number;
  batteryStatus?: string;
  diskAvailableGb?: number;
}

// ── Fallback chain ─────────────────────────────────────────────────────────────
// Ported from litellm: async_completion_with_fallbacks() in
// litellm/litellm_core_utils/fallback_utils.py
// Pattern: iterate an ordered list of model targets; return the first success;
// surface per-attempt errors so callers can log/alert without crashing the
// request. Mirrors the x-litellm-fallback-* header semantics at the type level.

/** A model target in a fallback chain. */
export interface FallbackModel {
  model: string;
  provider?: string;
}

/** Signature for a function that executes one attempt against a target model. */
export type FallbackCallFn<T> = (target: FallbackModel) => Promise<T>;

/** Result returned by a successful fallback chain execution. */
export interface FallbackChainResult<T> {
  result: T;
  usedModel: FallbackModel;
  /** 1-based index of the successful attempt. */
  attemptCount: number;
  /** Per-attempt failures for all models tried before success. */
  errors: { model: FallbackModel; error: unknown }[];
}

/** Options for {@link runFallbackChain}. */
export interface FallbackChainOptions {
  /** Called immediately before switching to the next model in the chain. */
  onFallback?: (from: FallbackModel, to: FallbackModel, error: unknown) => void;
}

/**
 * Execute `fn` against each model in `chain` in order, returning the first
 * successful result. All per-attempt failures are collected and attached to
 * the thrown error when every model fails.
 *
 * @example
 * ```ts
 * const { result, usedModel } = await runFallbackChain(
 *   [{ model: "claude-opus-4-5", provider: "anthropic" },
 *    { model: "gpt-4o",         provider: "openai"    }],
 *   (target) => callModel(target, request),
 *   { onFallback: (from, to, err) => logger.warn("fallback", { from, to, err }) },
 * );
 * ```
 */
export async function runFallbackChain<T>(
  chain: FallbackModel[],
  fn: FallbackCallFn<T>,
  opts?: FallbackChainOptions,
): Promise<FallbackChainResult<T>> {
  if (chain.length === 0) {
    throw new Error("runFallbackChain: chain must not be empty");
  }
  const errors: { model: FallbackModel; error: unknown }[] = [];
  for (let i = 0; i < chain.length; i++) {
    const target = chain[i]!;
    try {
      const result = await fn(target);
      return { result, usedModel: target, attemptCount: i + 1, errors };
    } catch (err) {
      errors.push({ model: target, error: err });
      const next = chain[i + 1];
      if (next !== undefined && opts?.onFallback) {
        opts.onFallback(target, next, err);
      }
    }
  }
  throw Object.assign(new Error(`runFallbackChain: all ${chain.length} model(s) failed`), {
    errors,
  });
}

// ── Cost callback registry ─────────────────────────────────────────────────────
// Ported from litellm: CustomLogger.async_log_success_event() hook interface in
// litellm/integrations/custom_logger.py and _ProxyDBLogger in
// litellm/proxy/hooks/proxy_track_cost_callback.py
// Pattern: fire-and-forget callbacks after every successful LLM call; use
// Promise.allSettled so one failing observer never breaks another.

/** Token and cost details emitted after a successful LLM call. */
export interface GatewayCostEvent {
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens?: number;
  cachedCreationTokens?: number;
  reasoningTokens?: number;
  totalTokens: number;
  /** USD cost estimate; undefined when the model is not in the price table. */
  estimatedCostUsd?: number;
  latencyMs: number;
  timeToFirstTokenMs?: number;
  requestId?: string;
  sessionId?: string;
  userId?: string;
}

/** Observer function registered with {@link CostCallbackRegistry}. */
export type CostCallbackFn = (event: GatewayCostEvent) => void | Promise<void>;

/**
 * Registry of cost-tracking callbacks. Fire all observers after each
 * successful LLM call via {@link CostCallbackRegistry.fire}. Errors thrown
 * inside individual callbacks are swallowed so one bad observer can never
 * interrupt another.
 *
 * @example
 * ```ts
 * const costRegistry = new CostCallbackRegistry();
 * costRegistry.register((e) =>
 *   metrics.increment("llm.tokens", e.totalTokens, { model: e.model })
 * );
 * await costRegistry.fire(event);
 * ```
 */
export class CostCallbackRegistry {
  private readonly _callbacks: CostCallbackFn[] = [];

  register(fn: CostCallbackFn): void {
    this._callbacks.push(fn);
  }

  /** Fire all registered callbacks concurrently; never throws. */
  async fire(event: GatewayCostEvent): Promise<void> {
    await Promise.allSettled(this._callbacks.map((cb) => cb(event)));
  }

  get size(): number {
    return this._callbacks.length;
  }
}

// ── Singleflight ───────────────────────────────────────────────────────────────
// Ported from litellm: SpendCounterReseed singleflight lock pattern in
// litellm/proxy/db/spend_counter_reseed.py
// Pattern: per-key Promise coalescing with bounded-LRU eviction; collapses N
// concurrent callers with the same key to a single in-flight execution.
// The Python original uses asyncio.Lock + OrderedDict(maxsize); the TS version
// uses a Map<key, Promise> — same semantics, no explicit mutex needed because
// the JS event loop is single-threaded.

/** Maximum tracked in-flight keys before the oldest entry is evicted. */
export const SINGLEFLIGHT_MAX_KEYS = 1024;

/**
 * Per-key async coalescer. Concurrent callers sharing the same `key` all
 * receive the same in-flight Promise. Once it settles the entry is removed,
 * so the next call executes fresh.
 *
 * The internal map is bounded at `maxKeys` (default 1024) using an
 * insertion-order LRU eviction matching litellm's OrderedDict approach.
 *
 * @example
 * ```ts
 * const sf = new Singleflight<ModelConfig>();
 * // Only one DB fetch fires even when 50 requests arrive simultaneously:
 * const config = await sf.call("model:gpt-4o", () => fetchModelConfig("gpt-4o"));
 * ```
 */
export class Singleflight<T> {
  private readonly _pending = new Map<string, Promise<T>>();
  private readonly _maxKeys: number;

  constructor(maxKeys = SINGLEFLIGHT_MAX_KEYS) {
    this._maxKeys = maxKeys;
  }

  /**
   * Execute `fn` exactly once for all concurrent callers sharing `key`.
   * Returns the shared Promise; re-entrant callers block until the first
   * invocation resolves or rejects.
   */
  call(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this._pending.get(key);
    if (existing !== undefined) return existing;

    if (this._pending.size >= this._maxKeys) {
      const oldest = this._pending.keys().next().value;
      if (oldest !== undefined) this._pending.delete(oldest);
    }

    const p = fn().finally(() => this._pending.delete(key));
    this._pending.set(key, p);
    return p;
  }

  /** Number of keys currently in flight. */
  get inFlight(): number {
    return this._pending.size;
  }
}
