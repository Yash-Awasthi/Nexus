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

import type { LlmDriver, LlmRequestOptions, LlmResponse, StreamHandler } from "@nexus/llm-drivers";

import { CachingDriver } from "./llm-cache-driver.js";

export interface FailoverProviderEntry {
  /** Registry key, e.g. "groq" (also used as the servedBy id). */
  id: string;
  driver: LlmDriver;
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

/** Reset entries + counters (tests only). */
export function resetFailover(): void {
  _entries = [];
  _driver = null;
  _stats.clear();
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

// One CachingDriver per provider driver (memoized — the cache key includes the
// wrapped driver's provider identity, so entries never cross providers).
const _cacheWrappers = new WeakMap<LlmDriver, CachingDriver>();
function cached(driver: LlmDriver): CachingDriver {
  let c = _cacheWrappers.get(driver);
  if (!c) {
    c = new CachingDriver(driver);
    _cacheWrappers.set(driver, c);
  }
  return c;
}

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

  async complete(opts: LlmRequestOptions): Promise<LlmResponse> {
    let lastErr: unknown;
    for (const entry of this.entries) {
      try {
        const res = await cached(entry.driver).complete(opts);
        record(entry.id, true);
        const served: FailoverLlmResponse = { ...res, servedBy: entry.id };
        return served;
      } catch (err) {
        record(entry.id, false, err);
        lastErr = err;
      }
    }
    throw lastErr;
  }

  async stream(opts: LlmRequestOptions, handler: StreamHandler): Promise<LlmResponse> {
    let lastErr: unknown;
    for (const entry of this.entries) {
      let emitted = false;
      const tracked: StreamHandler = (delta) => {
        emitted = true;
        return handler(delta);
      };
      try {
        const res = await cached(entry.driver).stream(opts, tracked);
        record(entry.id, true);
        const served: FailoverLlmResponse = { ...res, servedBy: entry.id };
        return served;
      } catch (err) {
        record(entry.id, false, err);
        lastErr = err;
        // Partial output already delivered — never replay it on another provider.
        if (emitted) break;
      }
    }
    throw lastErr;
  }

  countTokens(text: string): number {
    return this.entries[0]?.driver.countTokens(text) ?? text.length;
  }
}
