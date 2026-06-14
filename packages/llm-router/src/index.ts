// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/llm-router — Multi-provider LLM abstraction layer.
 *
 * Core concepts
 * ─────────────
 *   LLMProvider   — injectable interface any model provider must satisfy.
 *   LLMRouter     — resolves model aliases, routes to the right provider,
 *                   tries fallback chains on transient errors.
 *   ProviderAlias — maps a human alias ("nexus/smart") to a (provider, model).
 *   FallbackChain — ordered list of aliases to attempt when the primary fails.
 *
 * Built-in providers
 * ──────────────────
 *   ClaudeProvider  — Anthropic Messages API (injectable fetch)
 *   GroqProvider    — Groq Chat Completions API (OpenAI-compat, injectable fetch)
 *   OpenAIProvider  — OpenAI Chat Completions API (injectable fetch)
 *   NullProvider    — deterministic stub for tests
 *
 * Routing strategies
 * ──────────────────
 *   first        — always use the first available provider for an alias
 *   round-robin  — distribute requests across multiple providers for an alias
 *   least-latency — route to the provider with the lowest observed avg latency
 *
 * Usage
 * ─────
 * ```ts
 * const router = new LLMRouter({
 *   providers: [new ClaudeProvider({ apiKey: process.env.ANTHROPIC_KEY! }),
 *               new GroqProvider({ apiKey: process.env.GROQ_KEY! })],
 *   aliases: [
 *     { alias: "nexus/smart", provider: "claude", model: "claude-opus-4-5" },
 *     { alias: "nexus/fast",  provider: "groq",   model: "llama-3.1-70b-versatile" },
 *   ],
 *   fallbacks: { "nexus/smart": ["nexus/fast"] },
 *   strategy: "first",
 * });
 *
 * const resp = await router.complete({ model: "nexus/smart", messages: [...] });
 * ```
 */

import { randomUUID } from "node:crypto";

// ── Injectable fetch ──────────────────────────────────────────────────────────

export type FetchFn = typeof fetch;

// ── Error ─────────────────────────────────────────────────────────────────────

export class LLMRouterError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "LLMRouterError";
  }
}

// ── Shared types ──────────────────────────────────────────────────────────────

export type MessageRole = "system" | "user" | "assistant";

export interface LLMMessage {
  role: MessageRole;
  content: string;
}

export interface LLMRequest {
  /** Concrete model name (e.g. "claude-opus-4-5") or router alias (e.g. "nexus/smart"). */
  model: string;
  messages: LLMMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Pass-through metadata forwarded to the provider. */
  metadata?: Record<string, unknown>;
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LLMResponse {
  id: string;
  /** Resolved model name actually used. */
  model: string;
  content: string;
  usage: LLMUsage;
  /** Provider that served this response. */
  provider: string;
  latencyMs: number;
  /** True when served from a prompt cache layer. */
  cached?: boolean;
}

// ── Provider interface ────────────────────────────────────────────────────────

export interface LLMProvider {
  /** Unique provider identifier (e.g. "claude", "groq", "openai"). */
  readonly name: string;
  /** Model names this provider can serve. */
  readonly models: readonly string[];
  /** Complete a chat request and return the full response. */
  complete(request: LLMRequest): Promise<LLMResponse>;
}

// ── NullProvider — deterministic stub ────────────────────────────────────────

export interface NullProviderConfig {
  name?: string;
  models?: string[];
  /** Fixed response content (default: "null response"). */
  content?: string;
  /** Fixed latency in ms (default: 0). */
  latencyMs?: number;
  /** If set, throws this error on every complete() call. */
  error?: Error;
}

export class NullProvider implements LLMProvider {
  readonly name: string;
  readonly models: readonly string[];
  private readonly _content: string;
  private readonly _latencyMs: number;
  private readonly _error?: Error;
  public callCount = 0;
  public lastRequest?: LLMRequest;

  constructor(config: NullProviderConfig = {}) {
    this.name = config.name ?? "null";
    this.models = config.models ?? ["null-model"];
    this._content = config.content ?? "null response";
    this._latencyMs = config.latencyMs ?? 0;
    this._error = config.error;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    this.callCount++;
    this.lastRequest = request;
    if (this._error) throw this._error;
    return {
      id: randomUUID(),
      model: request.model,
      content: this._content,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      provider: this.name,
      latencyMs: this._latencyMs,
    };
  }
}

// ── ClaudeProvider ────────────────────────────────────────────────────────────

export interface ClaudeProviderConfig {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchFn;
  defaultModel?: string;
}

const CLAUDE_MODELS = [
  "claude-opus-4-5",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "claude-3-5-sonnet-20241022",
  "claude-3-5-haiku-20241022",
  "claude-3-opus-20240229",
] as const;

export class ClaudeProvider implements LLMProvider {
  readonly name = "claude";
  readonly models: readonly string[] = CLAUDE_MODELS;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetch: FetchFn;

  constructor(config: ClaudeProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://api.anthropic.com";
    this.fetch = config.fetch ?? globalThis.fetch;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const start = Date.now();
    const systemMsg = request.messages.find((m) => m.role === "system");
    const userMsgs = request.messages.filter((m) => m.role !== "system");

    const body = {
      model: request.model,
      max_tokens: request.maxTokens ?? 1024,
      messages: userMsgs,
      ...(systemMsg ? { system: systemMsg.content } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };

    const res = await this.fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new LLMRouterError(
        `Claude API error ${res.status}: ${text}`,
        "PROVIDER_ERROR",
        { provider: "claude", status: res.status },
      );
    }

    const data = await res.json() as {
      id: string;
      model: string;
      content: Array<{ type: string; text: string }>;
      usage: { input_tokens: number; output_tokens: number };
    };

    const content = data.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const latencyMs = Date.now() - start;

    return {
      id: data.id,
      model: data.model,
      content,
      usage: {
        promptTokens: data.usage.input_tokens,
        completionTokens: data.usage.output_tokens,
        totalTokens: data.usage.input_tokens + data.usage.output_tokens,
      },
      provider: "claude",
      latencyMs,
    };
  }
}

// ── GroqProvider ──────────────────────────────────────────────────────────────

export interface GroqProviderConfig {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchFn;
}

const GROQ_MODELS = [
  "llama-3.1-70b-versatile",
  "llama-3.1-8b-instant",
  "llama-3.3-70b-versatile",
  "mixtral-8x7b-32768",
  "gemma2-9b-it",
] as const;

export class GroqProvider implements LLMProvider {
  readonly name = "groq";
  readonly models: readonly string[] = GROQ_MODELS;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetch: FetchFn;

  constructor(config: GroqProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://api.groq.com/openai";
    this.fetch = config.fetch ?? globalThis.fetch;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    return _openAICompatComplete(this.fetch, this.baseUrl, this.apiKey, "groq", request);
  }
}

// ── OpenAIProvider ────────────────────────────────────────────────────────────

export interface OpenAIProviderConfig {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchFn;
  /** Override provider name (useful for OpenAI-compat endpoints). */
  providerName?: string;
}

const OPENAI_MODELS = [
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4-turbo",
  "gpt-3.5-turbo",
  "o1-preview",
  "o1-mini",
] as const;

export class OpenAIProvider implements LLMProvider {
  readonly name: string;
  readonly models: readonly string[] = OPENAI_MODELS;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetch: FetchFn;

  constructor(config: OpenAIProviderConfig) {
    this.name = config.providerName ?? "openai";
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
    this.fetch = config.fetch ?? globalThis.fetch;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    return _openAICompatComplete(this.fetch, this.baseUrl, this.apiKey, this.name, request);
  }
}

// ── Shared OpenAI-compat completion helper ────────────────────────────────────

interface OpenAICompatResponse {
  id: string;
  model: string;
  choices: Array<{ message: { content: string } }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

async function _openAICompatComplete(
  fetchFn: FetchFn,
  baseUrl: string,
  apiKey: string,
  providerName: string,
  request: LLMRequest,
): Promise<LLMResponse> {
  const start = Date.now();
  const body = {
    model: request.model,
    messages: request.messages,
    ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
  };

  const url = baseUrl.endsWith("/chat/completions")
    ? baseUrl
    : `${baseUrl}/chat/completions`;

  const res = await fetchFn(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LLMRouterError(
      `${providerName} API error ${res.status}: ${text}`,
      "PROVIDER_ERROR",
      { provider: providerName, status: res.status },
    );
  }

  const data = await res.json() as OpenAICompatResponse;
  const content = data.choices[0]?.message.content ?? "";
  const latencyMs = Date.now() - start;

  return {
    id: data.id,
    model: data.model,
    content,
    usage: {
      promptTokens: data.usage.prompt_tokens,
      completionTokens: data.usage.completion_tokens,
      totalTokens: data.usage.total_tokens,
    },
    provider: providerName,
    latencyMs,
  };
}

// ── Router config ─────────────────────────────────────────────────────────────

export type RoutingStrategy = "first" | "round-robin" | "least-latency";

export interface ProviderAlias {
  /** The alias string callers use, e.g. "nexus/smart". */
  alias: string;
  /** Provider name to route to. */
  provider: string;
  /** Concrete model name to pass to the provider. */
  model: string;
}

export interface RouterConfig {
  providers: LLMProvider[];
  /**
   * Alias table — maps friendly names to (provider, model) pairs.
   * If omitted, requests must use concrete model names.
   */
  aliases?: ProviderAlias[];
  /**
   * Fallback chains — when the primary alias fails with a transient error,
   * try these aliases in order.
   * Keys are alias names; values are ordered lists of fallback aliases.
   */
  fallbacks?: Record<string, string[]>;
  /**
   * Routing strategy when multiple providers serve the same alias.
   * Default: "first".
   */
  strategy?: RoutingStrategy;
}

// ── ResolvedRoute ─────────────────────────────────────────────────────────────

interface ResolvedRoute {
  provider: LLMProvider;
  model: string;
}

// ── LLMRouter ─────────────────────────────────────────────────────────────────

export class LLMRouter {
  private readonly providers = new Map<string, LLMProvider>();
  private readonly aliases: ProviderAlias[];
  private readonly fallbacks: Record<string, string[]>;
  private readonly strategy: RoutingStrategy;

  /** Round-robin counters per alias. */
  private readonly rrCounters = new Map<string, number>();
  /** Observed avg latency per provider name. */
  private readonly latencyAvg = new Map<string, number>();

  constructor(config: RouterConfig) {
    for (const p of config.providers) {
      this.providers.set(p.name, p);
    }
    this.aliases = config.aliases ?? [];
    this.fallbacks = config.fallbacks ?? {};
    this.strategy = config.strategy ?? "first";
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Send a completion request.  Resolves the alias (if any), picks the
   * appropriate provider, and applies fallback chains on failure.
   */
  async complete(request: LLMRequest): Promise<LLMResponse> {
    const aliasChain = this._buildAliasChain(request.model);

    // Try each alias in the chain
    let lastError: Error | undefined;
    for (const alias of aliasChain) {
      const route = this._resolveAlias(alias);
      if (!route) {
        lastError = new LLMRouterError(
          `No provider found for alias "${alias}"`,
          "NO_PROVIDER",
          { alias },
        );
        continue;
      }

      try {
        const routed: LLMRequest = { ...request, model: route.model };
        const response = await route.provider.complete(routed);
        this._recordLatency(route.provider.name, response.latencyMs);
        return response;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // continue to next fallback
      }
    }

    throw new LLMRouterError(
      `All providers failed for model "${request.model}": ${String(lastError)}`,
      "ALL_PROVIDERS_FAILED",
      { model: request.model, lastError: String(lastError) },
    );
  }

  /** List all registered provider names. */
  listProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  /** List all registered aliases. */
  listAliases(): ProviderAlias[] {
    return [...this.aliases];
  }

  /** Look up a provider by name. */
  getProvider(name: string): LLMProvider | undefined {
    return this.providers.get(name);
  }

  /** Observed average latency for a provider in ms (undefined if no data yet). */
  getLatencyAvg(providerName: string): number | undefined {
    return this.latencyAvg.get(providerName);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** Build the ordered list of aliases to try, starting with the requested one. */
  private _buildAliasChain(model: string): string[] {
    const chain: string[] = [model];
    const fallbacks = this.fallbacks[model] ?? [];
    for (const f of fallbacks) {
      if (!chain.includes(f)) chain.push(f);
    }
    return chain;
  }

  /** Resolve an alias to a (provider, model) pair using the configured strategy. */
  private _resolveAlias(alias: string): ResolvedRoute | undefined {
    // Check if it's a known alias
    const aliasEntries = this.aliases.filter((a) => a.alias === alias);
    if (aliasEntries.length > 0) {
      const entry = this._pickAlias(alias, aliasEntries);
      const provider = this.providers.get(entry.provider);
      if (!provider) return undefined;
      return { provider, model: entry.model };
    }

    // Try to match as a direct model name on any provider
    for (const provider of this.providers.values()) {
      if (provider.models.includes(alias)) {
        return { provider, model: alias };
      }
    }

    return undefined;
  }

  /** Apply the routing strategy to pick one entry from a list of aliases. */
  private _pickAlias(alias: string, entries: ProviderAlias[]): ProviderAlias {
    if (entries.length === 1 || this.strategy === "first") {
      return entries[0]!;
    }

    if (this.strategy === "round-robin") {
      const idx = (this.rrCounters.get(alias) ?? 0) % entries.length;
      this.rrCounters.set(alias, idx + 1);
      return entries[idx]!;
    }

    if (this.strategy === "least-latency") {
      let best = entries[0]!;
      let bestLatency = this.latencyAvg.get(best.provider) ?? Infinity;
      for (const entry of entries.slice(1)) {
        const lat = this.latencyAvg.get(entry.provider) ?? Infinity;
        if (lat < bestLatency) {
          best = entry;
          bestLatency = lat;
        }
      }
      return best;
    }

    return entries[0]!;
  }

  /** Exponential moving average for latency tracking. */
  private _recordLatency(providerName: string, latencyMs: number): void {
    const prev = this.latencyAvg.get(providerName);
    const next = prev === undefined ? latencyMs : prev * 0.8 + latencyMs * 0.2;
    this.latencyAvg.set(providerName, next);
  }
}
