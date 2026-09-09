// SPDX-License-Identifier: Apache-2.0
/**
 * Workspace-global usage/cost log with write-behind durability.
 *
 * `_costLog` in api-bridge.ts used to be purely in-memory: an API restart wiped
 * every request/token/cost number, so the dashboard's usage stats, the windowed
 * series, and the weekly-digest inputs all reset to zero on each deploy/restart.
 *
 * This store keeps the SAME in-memory array as the hot read path (api-bridge
 * binds its `_costLog` to `costLogStore.entries`, so every existing read is
 * untouched) and additionally persists it:
 *
 *   - `record()` stays synchronous in memory — zero hot-path KV latency.
 *   - A debounced, batched flush (seconds-level, trailing edge with a max
 *     interval under sustained load) writes only the new tail entries.
 *   - Storage is day-sharded KV keys (`costlog:day:YYYY-MM-DD` → CostEntry[],
 *     TTL 150 d) so a flush rewrites at most the day(s) it touches, not the
 *     whole log.
 *   - `load()` at boot reads the day keys back into memory (newest
 *     MAX_ENTRIES, chronological), so reads, windowed stats, and the digest
 *     behave identically across restarts.
 *
 * Failures are best-effort by design: a KV error or a process death between
 * flushes loses at most the last few seconds of entries — never the history.
 * Entries are workspace-global (not per-user), matching the single-install
 * semantics the weekly digest already assumes.
 *
 * Residual: if a flush straddles midnight AND the KV write of the second day
 * fails, the retry re-appends the first day's tail (a few seconds of entries
 * double-counted). Astronomically rare; acceptable vs. losing the data.
 */

import type { KVStore } from "@nexus/kv";

import { getSharedKV, withTimeout } from "./shared-kv.js";

export interface CostEntry {
  ts: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Authenticated owner of the spend, when the call site knows it. Entries
   * without one are pre-attribution or system-internal calls; personal
   * analytics never show them under a user's name. */
  userId?: string;
}

/**
 * Personal-analytics scope: keep only the caller's own entries.
 *
 * The dashboard and /costs/* surfaces are framed as "your usage"; before this
 * scoping they summed the WHOLE server's cost log, so a brand-new account
 * showed every user's requests and spend as its own (playtest-observed leak).
 * Entries without a userId (system-internal calls, pre-attribution history)
 * belong to no user and stay out of personal views — the operator surface
 * (/analytics/*) remains the global one.
 */
export function scopeCostEntriesToUser(
  entries: readonly CostEntry[],
  userId: string | undefined,
): readonly CostEntry[] {
  if (!userId) return entries;
  return entries.filter((e) => e.userId === userId);
}

/** Keep the same ceiling the in-memory log always used. */
const MAX_COST_ENTRIES = 10_000;
/** Day records outlive every analytics window the UI offers (≤90 d). */
const DAY_KEY_TTL_MS = 150 * 24 * 60 * 60 * 1000;
/** Trailing debounce — flush this long after the last record lands. */
const FLUSH_IDLE_MS = 2_000;
/** …but never wait longer under sustained load. */
const FLUSH_MAX_MS = 10_000;

const dayOf = (tsIso: string): string => tsIso.slice(0, 10);
const dayKey = (day: string): string => `costlog:day:${day}`;

/** Operator-visible flush health (surfaced on /health/ready). */
export interface CostLogFlushStats {
  /** Entries recorded but not yet confirmed on KV (the un-flushed tail). */
  pendingEntries: number;
  dirty: boolean;
  /** ISO timestamp of the last successful flush (null before the first). */
  lastFlushAt: string | null;
  /** ms since the last successful flush (null before the first). */
  lastFlushAgeMs: number | null;
  consecutiveFailures: number;
  totalFlushes: number;
  totalFailures: number;
}

export class CostLogStore {
  private readonly _kvOverride?: KVStore;
  /**
   * NEVER reassigned — readers (api-bridge's `_costLog`) bind this exact array
   * at module eval. `load()` fills it in place; the `readonly` field pin makes
   * a future reassignment a compile error, not a silent stale-read bug.
   */
  private readonly _entries: CostEntry[] = [];
  /** `_entries[0.._watermark)` are already persisted; the tail is the delta. */
  private _watermark = 0;
  private _dirty = false;
  private _firstDirtyAt = 0;
  private _timer: NodeJS.Timeout | null = null;
  private _lastFlushAt = 0;
  private _consecutiveFailures = 0;
  private _totalFlushes = 0;
  private _totalFailures = 0;
  /** Serializes flush calls — a shutdown flush must run after any in-flight
   * debounced flush, never read-modify-write the same day key concurrently. */
  private _flushTail: Promise<void> = Promise.resolve();

  /** @param kv optional KV override (tests inject a broken store here). */
  constructor(kv?: KVStore) {
    this._kvOverride = kv;
  }

  private _kv(): KVStore {
    return this._kvOverride ?? getSharedKV();
  }

  /** Read view — api-bridge binds its `_costLog` here; all reads are unchanged. */
  get entries(): readonly CostEntry[] {
    return this._entries;
  }

  /**
   * Synchronous hot-path record: push into memory (cap-trimming the oldest,
   * exactly as the old inline code did) and arm the debounced flush.
   */
  record(entry: CostEntry): void {
    this._entries.push(entry);
    if (this._entries.length > MAX_COST_ENTRIES) {
      this._entries.splice(0, this._entries.length - MAX_COST_ENTRIES);
    }
    this._dirty = true;
    if (!this._firstDirtyAt) this._firstDirtyAt = Date.now();
    this._armFlush();
  }

  /**
   * Persist the un-flushed tail to the day keys. Safe to call directly (tests,
   * shutdown hooks); returns after all day writes settle. Never throws.
   */
  async flush(): Promise<void> {
    this._flushTail = this._flushTail.then(() => this._flushOnce());
    await this._flushTail;
  }

  private async _flushOnce(): Promise<void> {
    this._clearTimer();
    if (!this._dirty) return;
    const delta = this._entries.slice(this._watermark);
    if (delta.length === 0) {
      this._dirty = false;
      this._firstDirtyAt = 0;
      return;
    }
    const byDay = new Map<string, CostEntry[]>();
    for (const e of delta) {
      const d = dayOf(e.ts);
      const arr = byDay.get(d);
      if (arr) arr.push(e);
      else byDay.set(d, [e]);
    }
    const kv = this._kv();
    for (const [day, add] of byDay) {
      try {
        const key = dayKey(day);
        const existing = (await kv.get<CostEntry[]>(key)) ?? [];
        await kv.set(key, existing.concat(add), DAY_KEY_TTL_MS);
      } catch (err) {
        // Best-effort: keep the watermark so the whole delta is retried on the
        // next flush. (See the midnight-straddle residual in the header.)
        this._consecutiveFailures += 1;
        this._totalFailures += 1;
        console.error(
          JSON.stringify({
            level: "error",
            event: "cost-log.flush-failed",
            day,
            entries: add.length,
            consecutiveFailures: this._consecutiveFailures,
            error: (err as Error).message,
          }),
        );
        return;
      }
    }
    this._watermark = this._entries.length;
    this._dirty = false;
    this._firstDirtyAt = 0;
    this._lastFlushAt = Date.now();
    this._consecutiveFailures = 0;
    this._totalFlushes += 1;
  }

  /**
   * Operator-visible flush health: pending tail size, age of the last
   * successful flush, and failure counts. A growing `pendingEntries` with
   * climbing `consecutiveFailures` means persistence silently degraded to
   * in-memory — surfaced on /health/ready.
   */
  flushStats(): CostLogFlushStats {
    const now = Date.now();
    return {
      pendingEntries: Math.max(0, this._entries.length - this._watermark),
      dirty: this._dirty,
      lastFlushAt: this._lastFlushAt ? new Date(this._lastFlushAt).toISOString() : null,
      lastFlushAgeMs: this._lastFlushAt ? now - this._lastFlushAt : null,
      consecutiveFailures: this._consecutiveFailures,
      totalFlushes: this._totalFlushes,
      totalFailures: this._totalFailures,
    };
  }

  /** Restore the in-memory log from the day keys (call once at boot). */
  async load(): Promise<void> {
    // Hard cap on the whole boot load: unreachable KV must degrade to an empty
    // in-memory log (the codebase's "fails open if Redis is down" contract),
    // never hang Fastify plugin registration into a boot fatal. The timeout
    // rejects and is swallowed HERE — load() always resolves.
    try {
      await withTimeout(this._loadFromKv(), 2_000, "cost-log load");
    } catch (err) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "cost-log.load-timed-out",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  private async _loadFromKv(): Promise<void> {
    const kv = this._kv();
    let keys: string[];
    try {
      keys = await kv.keys("costlog:day:*");
    } catch (err) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "cost-log.load-keys-failed",
          error: (err as Error).message,
        }),
      );
      return;
    }
    // Some backends only support a bare "*" — filter here for portability.
    const dayKeys = keys.filter((k) => k.startsWith("costlog:day:")).sort();
    const loaded: CostEntry[] = [];
    for (const k of dayKeys) {
      try {
        const arr = await kv.get<CostEntry[]>(k);
        if (Array.isArray(arr) && arr.length > 0) loaded.push(...arr);
      } catch (err) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "cost-log.load-day-failed",
            key: k,
            error: (err as Error).message,
          }),
        );
      }
    }
    // Day keys are chronological; keep the same newest-MAX window memory held.
    if (loaded.length > MAX_COST_ENTRIES) loaded.splice(0, loaded.length - MAX_COST_ENTRIES);
    // Mutate in place — `entries` is bound by readers (api-bridge's `_costLog`)
    // and reassigning the array here would strand them on the stale snapshot.
    this._entries.length = 0;
    this._entries.push(...loaded);
    this._watermark = this._entries.length;
    this._dirty = false;
    this._firstDirtyAt = 0;
  }

  /**
   * Graceful-shutdown flush: persist the pending tail, bounded so a KV hang
   * cannot stall process exit. A clean SIGTERM/SIGINT deploy (app.close() →
   * onClose) loses ~zero; unclean kills (tsx-watch force-kill) stay best-effort
   * as documented — the debounce window is at most a few seconds.
   */
  async close(timeoutMs = 2_000): Promise<void> {
    this._clearTimer();
    if (!this._dirty) return;
    await Promise.race([
      this.flush(),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    // Whatever the race outcome: a timed-out in-flight flush must not leave a
    // later timer armed (the process is exiting; nothing should fire after).
    this._clearTimer();
  }

  private _armFlush(): void {
    if (this._timer) return;
    // Trailing debounce, but bounded so sustained traffic still flushes.
    const elapsed = Date.now() - this._firstDirtyAt;
    const delay = Math.min(FLUSH_IDLE_MS, Math.max(0, FLUSH_MAX_MS - elapsed));
    this._timer = setTimeout(() => {
      this._timer = null;
      void this.flush();
    }, delay);
  }

  private _clearTimer(): void {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
}

/** Process-wide singleton — api-bridge records into and reads from this. */
export const costLogStore = new CostLogStore();

/**
 * Per-1M-token pricing [input, output] USD for cost tracking and the
 * `/api/costs/pricing` surface. Owned here so the recording path (api-bridge's
 * `_trackCost`) and the reporting path (routes/costs.ts, §16.7) share one table.
 */
export const MODEL_PRICES: Record<string, [number, number]> = {
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
