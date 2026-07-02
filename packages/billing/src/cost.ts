// SPDX-License-Identifier: Apache-2.0
/**
 * USD cost model + billing lifecycle (estimate → reserve → settle).
 *
 * Pricing comes from @nexus/provider-registry (seedable from models.dev), so a
 * single source feeds both the model picker and the bill. This module is pure
 * and in-memory — no DB, no network — so it tests deterministically and can run
 * on the request hot path without I/O.
 *
 * Lifecycle
 * ─────────
 *   1. ESTIMATE — before the call, price the worst case (full max-output) so a
 *      reservation never under-books.
 *   2. RESERVE  — hold the estimate against an optional cap. Over the cap throws
 *      QuotaExceededError *before* the provider call (no silent overspend).
 *   3. SETTLE   — after the call, charge the ACTUAL token usage and return the
 *      delta vs the reservation (positive = overage, negative = refund). Streaming
 *      partials settle the same way: settle once with the final usage.
 */

import { globalRegistry, type ProviderRegistry } from "@nexus/provider-registry";

// ── Cost model ──────────────────────────────────────────────────────────────────

/** Token counts for one request. Cache fields are optional (most calls have none). */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Prompt-cache read (hit) tokens — billed at the cache-read rate when known. */
  cacheReadTokens?: number;
  /** Prompt-cache write (store) tokens — billed at the cache-write rate when known. */
  cacheWriteTokens?: number;
}

/** Per-component USD breakdown of a request's cost. */
export interface CostBreakdown {
  modelId: string;
  /** True when the model was not found in the registry (all rates fell back to 0). */
  unknownModel: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  totalCost: number;
}

/**
 * Price a request from the registry. Unknown models yield a zero-cost breakdown
 * with `unknownModel: true` rather than throwing — metering must never lose a
 * completed call. Cache read/write fall back to the input rate when the model
 * doesn't publish a dedicated cache price.
 */
export function computeCost(
  modelId: string,
  usage: TokenUsage,
  registry: ProviderRegistry = globalRegistry,
): CostBreakdown {
  const m = registry.get(modelId);
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;

  const inRate = m?.costPerInputToken ?? 0;
  const outRate = m?.costPerOutputToken ?? 0;
  const cacheReadRate = m?.costPerCacheReadToken ?? inRate;
  const cacheWriteRate = m?.costPerCacheWriteToken ?? inRate;

  const inputCost = inputTokens * inRate;
  const outputCost = outputTokens * outRate;
  const cacheReadCost = cacheReadTokens * cacheReadRate;
  const cacheWriteCost = cacheWriteTokens * cacheWriteRate;

  return {
    modelId,
    unknownModel: m === undefined,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    inputCost,
    outputCost,
    cacheReadCost,
    cacheWriteCost,
    totalCost: inputCost + outputCost + cacheReadCost + cacheWriteCost,
  };
}

/**
 * Worst-case estimate for a reservation: price `inputTokens` plus the model's full
 * `maxOutputTokens` (or `assumedOutputTokens` when given). Reserving the ceiling
 * means settle only ever refunds, never surprises with an overage.
 */
export function estimateMaxCost(
  modelId: string,
  inputTokens: number,
  opts: { assumedOutputTokens?: number; registry?: ProviderRegistry } = {},
): number {
  const registry = opts.registry ?? globalRegistry;
  const outputTokens = opts.assumedOutputTokens ?? registry.get(modelId)?.maxOutputTokens ?? 0;
  return computeCost(modelId, { inputTokens, outputTokens }, registry).totalCost;
}

// ── Billing lifecycle ───────────────────────────────────────────────────────────

/** Thrown when a reservation would push projected spend past the cap. */
export class QuotaExceededError extends Error {
  readonly code = "QUOTA_EXCEEDED";
  constructor(
    readonly scope: string,
    readonly capUsd: number,
    readonly projectedUsd: number,
  ) {
    super(
      `quota exceeded for ${scope}: projected $${projectedUsd.toFixed(6)} > cap $${capUsd.toFixed(6)}`,
    );
    this.name = "QuotaExceededError";
  }
}

/** An outstanding hold against the ledger, returned by `reserve()`. */
export interface Reservation {
  id: string;
  estimatedUsd: number;
}

/** Result of settling a reservation. `delta` > 0 is overage, < 0 is a refund. */
export interface SettleResult {
  charged: number;
  estimated: number;
  delta: number;
}

/**
 * In-memory ledger tracking committed (settled) spend plus outstanding holds,
 * against an optional USD cap. One ledger per quota scope (token / user / account)
 * — compose several to build the hierarchy: reserve against all, settle against
 * all. Not persistent; back it with the DB for durable accounting.
 */
export class BillingLedger {
  private settled = 0;
  private readonly holds = new Map<string, number>();

  constructor(
    private readonly capUsd: number | null = null,
    private readonly scope = "ledger",
  ) {}

  /** Total actually-charged spend. */
  get committed(): number {
    return this.settled;
  }

  /** Sum of outstanding (un-settled) reservations. */
  get reserved(): number {
    let sum = 0;
    for (const v of this.holds.values()) sum += v;
    return sum;
  }

  /** Committed + reserved — what spend would be if every hold settled at estimate. */
  get projected(): number {
    return this.settled + this.reserved;
  }

  /** Remaining headroom under the cap, or null when uncapped. */
  get remaining(): number | null {
    return this.capUsd === null ? null : this.capUsd - this.projected;
  }

  /**
   * Hold `estimatedUsd` for `id`. Throws QuotaExceededError if it would exceed the
   * cap (checked BEFORE the provider call). Re-reserving the same id replaces the
   * prior hold.
   */
  reserve(id: string, estimatedUsd: number): Reservation {
    const projectedWithout = this.settled + (this.reserved - (this.holds.get(id) ?? 0));
    if (this.capUsd !== null && projectedWithout + estimatedUsd > this.capUsd) {
      throw new QuotaExceededError(this.scope, this.capUsd, projectedWithout + estimatedUsd);
    }
    this.holds.set(id, estimatedUsd);
    return { id, estimatedUsd };
  }

  /**
   * Settle `id` with the actual cost: drop the hold, add to committed spend, and
   * report the delta vs the estimate. Settling an unknown id charges with a 0
   * estimate (delta == charged).
   */
  settle(id: string, actualUsd: number): SettleResult {
    const estimated = this.holds.get(id) ?? 0;
    this.holds.delete(id);
    this.settled += actualUsd;
    return { charged: actualUsd, estimated, delta: actualUsd - estimated };
  }

  /** Cancel a hold without charging (e.g. the call failed before any tokens). */
  release(id: string): void {
    this.holds.delete(id);
  }
}
