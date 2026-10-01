// SPDX-License-Identifier: Apache-2.0
/**
 * Provider failover + live model discovery — opencode-style API management at
 * the getDefaultDriver() choke point.
 *
 * Routing: a FailoverDriver owns an ordered list of provider entries (built by
 * api-bridge from the live DriverRegistry — NEXUS_LLM_PROVIDER first, then the
 * historical default order, then any extras). complete() tries each provider
 * in order; a provider error (auth, rate-limit, network) fails over to the
 * next; every response carries `servedBy: <providerId>`. stream() fails over
 * only when the previous provider threw BEFORE emitting any delta — partial
 * output is never duplicated onto a second provider.
 *
 * Composition with the cache (lib/llm-cache-driver.ts):
 *   FailoverDriver ─► CachingDriver(providerA) ─► providerA
 *                    └► CachingDriver(providerB) ─► providerB
 * Each provider has its OWN cache wrapper, and the cache key already includes
 * the wrapped driver's provider identity — so a cache hit can never cross
 * provider identity (an entry stored by A is only ever served as A). A hit
 * short-circuits before the provider is contacted (that's the point), which
 * means a cached prompt keeps being served even while its provider is down —
 * staleness is bounded by LLM_CACHE_TTL_MS and the L1 memory tier's ≤5 min
 * TTL; a provider outage never serves data older than TTL. If ALL providers
 * are down AND nothing is cached, the last provider error propagates.
 *
 * Discovery: the /health/ready `llmProviders` block is sourced from the live
 * registry entries this module was fed (never hardcoded in a route): provider
 * id, driver provider name, driver model, and the streaming capability
 * detected from the driver's shape.
 */

import { CooldownTracker, parseRetryFromText } from "@nexus/gateway";
import {
  LlmError,
  type LlmDriver,
  type LlmRequestOptions,
  type LlmResponse,
  type StreamHandler,
} from "@nexus/llm-drivers";

import { cachedDriver } from "./llm-cache-driver.js";
import { getCacheUserId } from "./user-context.js";

export interface FailoverProviderEntry {
  /** Registry key, e.g. "groq" (also used as the servedBy id). */
  id: string;
  driver: LlmDriver;
  /** Ignore the caller's model and use the driver's own (a user's key for another provider). */
  ownModel?: boolean;
  /** Always call this model, whatever the caller asked for. */
  model?: string;
}

/** Live discovery entry — sourced from the registry, not hardcoded. */
export interface ProviderSnapshot {
  id: string;
  provider: string;
  model: string;
  streaming: boolean;
}

export interface ProviderStat {
  id: string;
  attempts: number;
  failures: number;
  lastError?: string;
}

/** Failover responses surface the serving provider on every call. */
export interface FailoverLlmResponse extends LlmResponse {
  servedBy: string;
}

let _entries: FailoverProviderEntry[] = [];
let _driver: FailoverDriver | null = null;

const _stats = new Map<string, { attempts: number; failures: number; lastError?: string }>();
let _lastServedBy: string | null = null;

function record(entryId: string, ok: boolean, err?: unknown): void {
  const s = _stats.get(entryId) ?? { attempts: 0, failures: 0 };
  s.attempts++;
  if (!ok) {
    s.failures++;
    s.lastError = err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300);
  }
  _stats.set(entryId, s);
  if (ok) _lastServedBy = entryId;
}

/** Replace the provider list (api-bridge feeds it from the registry). */
export function setFailoverProviders(entries: FailoverProviderEntry[]): void {
  _entries = entries;
  _driver = null;
}

// A provider that answered 429 stays out of the chain until the wait it named, so every agent
// step does not spend a round trip on a key that is out of tokens for the day.
let _bench = new CooldownTracker();

/** One bench per provider, model and key: a user's own key is theirs, not every user's. */
const benchKey = (entry: FailoverProviderEntry, model: string) =>
  `${entry.id}:${entry.id.startsWith("user:") ? (getCacheUserId() ?? "") : ""}:${model}`;

// The smallest prompt each provider+model could not fit: a larger one goes to the next entry.
let _tooLarge = new Map<string, number>();

/** Rough prompt size in tokens; only ever compared with sizes measured the same way. */
const promptSize = (opts: LlmRequestOptions) =>
  Math.ceil(
    ((opts.systemPrompt?.length ?? 0) +
      opts.messages.reduce((n, m) => n + (m.content ?? "").length, 0)) /
      4,
  );

function benched(
  entry: FailoverProviderEntry,
  model: string,
  opts: LlmRequestOptions,
): string | null {
  const key = benchKey(entry, model);
  const ceiling = _tooLarge.get(key);
  if (ceiling !== undefined && promptSize(opts) >= ceiling)
    return `${entry.id}: prompt too large for ${model}`;
  const ms = _bench.benchRemainingMs(key);
  return ms > 0 ? `${entry.id}: rate-limited for ${formatWait(ms)} more` : null;
}

function formatWait(ms: number): string {
  const m = Math.floor(ms / 60_000);
  return m >= 60
    ? `${Math.floor(m / 60)}h${m % 60}m`
    : m > 0
      ? `${m}m`
      : `${Math.ceil(ms / 1000)}s`;
}

function noteOutcome(
  entry: FailoverProviderEntry,
  model: string,
  opts: LlmRequestOptions,
  err?: unknown,
): void {
  const key = benchKey(entry, model);
  if (!err) return _bench.onSuccess(key);
  if (err instanceof LlmError && err.code === "CONTEXT_LENGTH_EXCEEDED") {
    const size = promptSize(opts);
    _tooLarge.set(key, Math.min(_tooLarge.get(key) ?? size, size));
    return;
  }
  if (!(err instanceof LlmError) || err.code !== "RATE_LIMITED") return;
  const retryAfterMs = parseRetryFromText(err.message);
  const grade = /per\s*day|\bt?pd\b|\brpd\b|daily/i.test(err.message) ? "exhausted" : "transient";
  _bench.recordRateLimited(key, { grade, ...(retryAfterMs ? { retryAfterMs } : {}) });
}

/** Reset entries + counters (tests only). */
export function resetFailover(): void {
  _entries = [];
  _driver = null;
  _stats.clear();
  _bench = new CooldownTracker();
  _tooLarge = new Map();
  _lastServedBy = null;
}

/** Live discovery snapshot — only the configured registry providers. */
export function getProviderSnapshot(): ProviderSnapshot[] {
  return _entries.map((e) => ({
    id: e.id,
    provider: e.driver.provider,
    model: e.driver.model,
    streaming: typeof (e.driver as { stream?: unknown }).stream === "function",
  }));
}

export function getProviderStats(): {
  order: string[];
  providers: ProviderStat[];
  lastServedBy: string | null;
} {
  return {
    order: _entries.map((e) => e.id),
    providers: _entries.map((e) => ({
      id: e.id,
      attempts: _stats.get(e.id)?.attempts ?? 0,
      failures: _stats.get(e.id)?.failures ?? 0,
      lastError: _stats.get(e.id)?.lastError,
    })),
    lastServedBy: _lastServedBy,
  };
}

// The last provider's error alone hides why the others failed (a user's rate
// limit reads as "fetch failed" from an absent local Ollama).
function withAllFailures(err: unknown, failures: string[]): unknown {
  if (failures.length > 1 && err instanceof Error) err.message = failures.join("; ");
  return err;
}

/**
 * The request as one entry should receive it. A caller asking for the chain's
 * own default (the first entry's model) did not choose a model at all, so a
 * later entry answers on its own model rather than being sent a foreign id —
 * sending Groq's model name to Gemini can only fail.
 */
const modelFor = (
  entry: FailoverProviderEntry,
  opts: LlmRequestOptions,
  chainDefault: string,
  first: boolean,
): LlmRequestOptions =>
  entry.model
    ? { ...opts, model: entry.model }
    : entry.ownModel || (!first && opts.model === chainDefault && entry.driver.model)
      ? { ...opts, model: entry.driver.model }
      : opts;

/** A call no provider in the chain was allowed to take. */
export class CallRefused extends Error {}

/** The failover driver over the current provider list (rebuilt on set). */
export function getFailoverDriver(): FailoverDriver | undefined {
  if (_entries.length === 0) return undefined;
  if (!_driver) _driver = new FailoverDriver(_entries);
  return _driver;
}

/**
 * LlmDriver decorator — tries each provider in order; every response carries
 * `servedBy`. complete() is cached per provider (see module doc for how the
 * layers compose); stream() fails over only before any delta was emitted.
 */
export class FailoverDriver implements LlmDriver {
  readonly provider = "failover";
  readonly model: string;

  constructor(private readonly entries: FailoverProviderEntry[]) {
    this.model = entries[0]?.driver.model ?? "";
  }

  /**
   * `guard` says why a call on a "provider/model" may not happen (a budget it could cross); such
   * providers are skipped, and when every one is, the call is refused without contacting any.
   */
  async complete(
    opts: LlmRequestOptions,
    guard?: (model: string) => string | null,
  ): Promise<LlmResponse> {
    let lastErr: unknown;
    let refusal: string | null = null;
    const failures: string[] = [];
    for (const [i, entry] of this.entries.entries()) {
      const entryOpts = modelFor(entry, opts, this.model, i === 0);
      const model = entryOpts.model ?? entry.driver.model;
      const why = guard?.(`${entry.driver.provider}/${model}`);
      if (why) {
        refusal ??= why;
        continue;
      }
      const resting = benched(entry, model, entryOpts);
      if (resting) {
        failures.push(resting);
        lastErr ??= new Error(resting);
        continue;
      }
      try {
        const res = await cachedDriver(entry.driver).complete(entryOpts);
        noteOutcome(entry, model, entryOpts);
        record(entry.id, true);
        const served: FailoverLlmResponse = { ...res, servedBy: entry.id };
        return served;
      } catch (err) {
        noteOutcome(entry, model, entryOpts, err);
        record(entry.id, false, err);
        lastErr = err;
        failures.push(`${entry.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (refusal && failures.length === 0) throw new CallRefused(refusal);
    throw withAllFailures(lastErr, failures);
  }

  async stream(opts: LlmRequestOptions, handler: StreamHandler): Promise<LlmResponse> {
    let lastErr: unknown;
    const failures: string[] = [];
    for (const [i, entry] of this.entries.entries()) {
      let emitted = false;
      const tracked: StreamHandler = (delta) => {
        emitted = true;
        return handler(delta);
      };
      const entryOpts = modelFor(entry, opts, this.model, i === 0);
      const model = entryOpts.model ?? entry.driver.model;
      const resting = benched(entry, model, entryOpts);
      if (resting) {
        failures.push(resting);
        lastErr ??= new Error(resting);
        continue;
      }
      try {
        const res = await cachedDriver(entry.driver).stream(entryOpts, tracked);
        noteOutcome(entry, model, entryOpts);
        record(entry.id, true);
        const served: FailoverLlmResponse = { ...res, servedBy: entry.id };
        return served;
      } catch (err) {
        noteOutcome(entry, model, entryOpts, err);
        record(entry.id, false, err);
        lastErr = err;
        failures.push(`${entry.id}: ${err instanceof Error ? err.message : String(err)}`);
        // Partial output already delivered — never replay it on another provider.
        if (emitted) break;
      }
    }
    throw withAllFailures(lastErr, failures);
  }

  countTokens(text: string): number {
    return this.entries[0]?.driver.countTokens(text) ?? text.length;
  }

  /** Each entry in order, its model, and how long it stays benched for the current caller. */
  status(): { id: string; provider: string; model: string; restingMs: number }[] {
    return this.entries.map((e) => {
      const model = e.model ?? e.driver.model;
      return {
        id: e.id,
        provider: e.driver.provider,
        model,
        restingMs: _bench.benchRemainingMs(benchKey(e, model)),
      };
    });
  }
}
