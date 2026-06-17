// SPDX-License-Identifier: Apache-2.0
/**
 * stm — STM (Style Transformation Module) output transformer pipeline.
 *
 * Transforms LLM output text through a configurable pipeline of rewrite modules
 * (hedge-reducer, directness-optimizer, etc.) before returning to the client.
 *
 * Provides:
 *   • STMModule              — module interface
 *   • STMModuleId            — known module identifiers
 *   • TransformInput/Output  — typed I/O
 *   • applySTMs()            — pipeline executor
 *   • HedgeReducer           — removes hedge phrases
 *   • DirectnessOptimizer    — replaces passive/verbose constructions
 *   • TruncationGuard        — enforces max char limit
 *   • STMRegistry            — module registration + lookup
 *   • STMPipeline            — assembled pipeline with partial-module support
 *   • MockSTMModule          — test double
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type STMModuleId = string;

/** Transform context interface definition. */
export interface TransformContext {
  sessionId?: string;
  userId?: string;
  locale?: string;
  metadata?: Record<string, unknown>;
}

/** Transform input interface definition. */
export interface TransformInput {
  text: string;
  moduleIds?: STMModuleId[]; // null/undefined → apply all registered
  context?: TransformContext;
  maxChars?: number; // enforced by TruncationGuard
}

/** Module result interface definition. */
export interface ModuleResult {
  moduleId: STMModuleId;
  before: string;
  after: string;
  changed: boolean;
}

/** Transform output interface definition. */
export interface TransformOutput {
  original: string;
  transformed: string;
  modules: ModuleResult[];
  truncated: boolean;
  charCount: number;
}

/** Stm module interface definition. */
export interface STMModule {
  id: STMModuleId;
  description: string;
  apply(text: string, ctx?: TransformContext): string;
}

// ── HedgeReducer ─────────────────────────────────────────────────────────────

const HEDGE_PATTERNS: [RegExp, string][] = [
  [/\bIt(?:'s| is) (?:worth noting that|important to note that)\b/gi, ""],
  [/\bIt (?:should|may) be noted that\b/gi, ""],
  [/\bIn (?:many|some) cases[,]?\s*/gi, ""],
  [/\bGenerally speaking[,]?\s*/gi, ""],
  [/\bIt (?:seems|appears) (?:that|to be) /gi, ""],
  [/\bI (?:think|believe|feel) (?:that )?/gi, ""],
  [/\bOne could (?:argue|say) (?:that )?/gi, ""],
  [/\bPerhaps /gi, ""],
  [/\bMaybe /gi, ""],
  [/\bApparently /gi, ""],
];

/** Hedge reducer. */
export class HedgeReducer implements STMModule {
  readonly id = "hedge-reducer";
  readonly description = "Removes hedge phrases to produce more direct statements";

  apply(text: string): string {
    let result = text;
    for (const [pattern, replacement] of HEDGE_PATTERNS) {
      result = result.replace(pattern, replacement);
    }
    // Collapse double spaces and fix sentence starts
    return result
      .replace(/\s{2,}/g, " ")
      .replace(/^\s+/gm, "")
      .trim();
  }
}

// ── DirectnessOptimizer ───────────────────────────────────────────────────────

const DIRECTNESS_PATTERNS: [RegExp, string][] = [
  [/\bin order to\b/gi, "to"],
  [/\bdue to the fact that\b/gi, "because"],
  [/\bfor the purpose of\b/gi, "to"],
  [/\bat this point in time\b/gi, "now"],
  [/\bprior to\b/gi, "before"],
  [/\bsubsequent to\b/gi, "after"],
  [/\bwith regard to\b/gi, "regarding"],
  [/\bin the event that\b/gi, "if"],
  [/\bnotwithstanding the fact that\b/gi, "although"],
  [/\ba large number of\b/gi, "many"],
  [/\bthe majority of\b/gi, "most"],
  [/\ba small number of\b/gi, "few"],
  [/\bwith the exception of\b/gi, "except"],
];

/** Directness optimizer. */
export class DirectnessOptimizer implements STMModule {
  readonly id = "directness-optimizer";
  readonly description = "Replaces verbose/passive constructions with direct equivalents";

  apply(text: string): string {
    let result = text;
    for (const [pattern, replacement] of DIRECTNESS_PATTERNS) {
      result = result.replace(pattern, replacement);
    }
    return result.trim();
  }
}

// ── TruncationGuard ───────────────────────────────────────────────────────────

export class TruncationGuard implements STMModule {
  readonly id = "truncation-guard";
  readonly description = "Enforces maximum character limit";

  private maxChars: number;

  constructor(maxChars = 50_000) {
    this.maxChars = maxChars;
  }

  apply(text: string): string {
    return text.length > this.maxChars ? text.slice(0, this.maxChars) : text;
  }

  didTruncate(text: string): boolean {
    return text.length > this.maxChars;
  }

  setMaxChars(n: number): void {
    this.maxChars = n;
  }
  getMaxChars(): number {
    return this.maxChars;
  }
}

// ── MockSTMModule ─────────────────────────────────────────────────────────────

export class MockSTMModule implements STMModule {
  readonly id: STMModuleId;
  readonly description: string;
  private transform: (text: string) => string;
  readonly calls: string[] = [];

  constructor(id: STMModuleId, transform: (text: string) => string = (t) => t, description = "") {
    this.id = id;
    this.transform = transform;
    this.description = description;
  }

  apply(text: string): string {
    this.calls.push(text);
    return this.transform(text);
  }
}

// ── STMRegistry ───────────────────────────────────────────────────────────────

export class STMRegistry {
  private modules = new Map<STMModuleId, STMModule>();

  register(module: STMModule): this {
    this.modules.set(module.id, module);
    return this;
  }

  get(id: STMModuleId): STMModule | undefined {
    return this.modules.get(id);
  }
  has(id: STMModuleId): boolean {
    return this.modules.has(id);
  }
  list(): STMModule[] {
    return [...this.modules.values()];
  }
  ids(): STMModuleId[] {
    return [...this.modules.keys()];
  }
  unregister(id: STMModuleId): boolean {
    return this.modules.delete(id);
  }
  clear(): void {
    this.modules.clear();
  }
  size(): number {
    return this.modules.size;
  }
}

// ── applySTMs ─────────────────────────────────────────────────────────────────

export function applySTMs(
  text: string,
  modules: STMModule[],
  ctx?: TransformContext,
): { text: string; results: ModuleResult[] } {
  let current = text;
  const results: ModuleResult[] = [];

  for (const mod of modules) {
    const before = current;
    current = mod.apply(current, ctx);
    results.push({
      moduleId: mod.id,
      before,
      after: current,
      changed: before !== current,
    });
  }

  return { text: current, results };
}

// ── STMPipeline ───────────────────────────────────────────────────────────────

export class STMPipeline {
  private registry: STMRegistry;
  private truncationGuard: TruncationGuard;

  constructor(registry?: STMRegistry, maxChars = 50_000) {
    this.registry = registry ?? new STMRegistry();
    this.truncationGuard = new TruncationGuard(maxChars);
  }

  transform(input: TransformInput): TransformOutput {
    const MAX_CHARS = input.maxChars ?? this.truncationGuard.getMaxChars();

    // Validate modules exist
    if (input.moduleIds) {
      for (const id of input.moduleIds) {
        if (!this.registry.has(id)) {
          throw new Error(`STM module not found: ${id}`);
        }
      }
    }

    // Determine which modules to apply
    const modules = input.moduleIds
      ? input.moduleIds.map((id) => this.registry.get(id)!)
      : this.registry.list();

    const { text, results } = applySTMs(input.text, modules, input.context);

    // Apply truncation
    const truncated = text.length > MAX_CHARS;
    const finalText = truncated ? text.slice(0, MAX_CHARS) : text;

    return {
      original: input.text,
      transformed: finalText,
      modules: results,
      truncated,
      charCount: finalText.length,
    };
  }

  getRegistry(): STMRegistry {
    return this.registry;
  }

  /** Partially apply only specific module IDs (skip missing without error). */
  transformPartial(input: TransformInput): TransformOutput {
    const safeIds = (input.moduleIds ?? this.registry.ids()).filter((id) => this.registry.has(id));
    return this.transform({ ...input, moduleIds: safeIds });
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createDefaultPipeline(maxChars = 50_000): STMPipeline {
  const registry = new STMRegistry()
    .register(new HedgeReducer())
    .register(new DirectnessOptimizer());
  return new STMPipeline(registry, maxChars);
}

// ── Rolling window metrics ─────────────────────────────────────────────────────
// Ported from OpenBB: rolling window accumulator pattern used in
// openbb_platform/extensions/technical/openbb_technical/helpers.py
// (parkinson volatility, standard_deviation — both are fixed-size window → stat).
// Adapted as a pure-TS circular buffer for tracking per-session text metrics
// (e.g., hedge-word density drift, verbosity score, output length distribution).

/**
 * Fixed-size circular buffer accumulating numeric samples in insertion order.
 * Provides O(1) push and O(n) statistical reads. Matches the window semantics
 * of OpenBB's `rolling(window=N).apply(f)` — oldest sample is evicted on push
 * once the buffer is full.
 */
export class RollingWindow {
  private readonly _buf: number[];
  private _pos = 0;
  private _count = 0;
  readonly size: number;

  constructor(size: number) {
    if (size < 1) throw new RangeError("RollingWindow: size must be >= 1");
    this.size = size;
    this._buf = new Array<number>(size).fill(0);
  }

  /** Add a sample, evicting the oldest when the buffer is full. */
  push(value: number): void {
    this._buf[this._pos] = value;
    this._pos = (this._pos + 1) % this.size;
    if (this._count < this.size) this._count++;
  }

  /** Return samples oldest-first. Length equals min(pushCount, size). */
  values(): number[] {
    if (this._count < this.size) return this._buf.slice(0, this._count);
    return [...this._buf.slice(this._pos), ...this._buf.slice(0, this._pos)];
  }

  mean(): number {
    const v = this.values();
    return v.length === 0 ? 0 : v.reduce((a, b) => a + b, 0) / v.length;
  }

  /**
   * Sample standard deviation (Bessel-corrected, n-1 denominator).
   * Mirrors OpenBB's `standard_deviation` helper which uses `data.std()`.
   */
  stddev(): number {
    const v = this.values();
    if (v.length < 2) return 0;
    const m = this.mean();
    const variance =
      v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1);
    return Math.sqrt(variance);
  }

  min(): number {
    const v = this.values();
    return v.length === 0 ? 0 : Math.min(...v);
  }

  max(): number {
    const v = this.values();
    return v.length === 0 ? 0 : Math.max(...v);
  }

  /** True once the buffer has accumulated at least `size` samples. */
  get filled(): boolean {
    return this._count >= this.size;
  }

  /** Total number of samples pushed so far (capped at size for display). */
  get count(): number {
    return this._count;
  }

  /** Reset the buffer to zero state. */
  reset(): void {
    this._buf.fill(0);
    this._pos = 0;
    this._count = 0;
  }
}

/** Configuration for a {@link RollingMetricTracker}. */
export interface RollingMetricConfig {
  /** Number of observations to keep in the rolling window. */
  windowSize: number;
  /** Function that extracts a numeric signal from a text sample. */
  extractFn: (text: string) => number;
  /** Human-readable label (e.g., "hedge-density", "output-length"). */
  label: string;
}

/** Point-in-time snapshot of a rolling metric. */
export interface RollingMetricSnapshot {
  label: string;
  count: number;
  mean: number;
  stddev: number;
  min: number;
  max: number;
  /** Most recently observed value, or null if no observations yet. */
  latest: number | null;
}

/**
 * Tracks a rolling numeric metric extracted from STM transform inputs or
 * outputs across a session. Useful for detecting drift — e.g., rising
 * hedge-word density or growing output verbosity over time.
 *
 * @example
 * ```ts
 * const hedgeDensity = new RollingMetricTracker({
 *   windowSize: 20,
 *   label: "hedge-density",
 *   extractFn: (text) => (text.match(/\bperhaps\b|\bmaybe\b/gi) ?? []).length / text.length,
 * });
 * hedgeDensity.observe(transformedText);
 * const snap = hedgeDensity.snapshot();
 * if (snap.mean > 0.01) logger.warn("hedge density drift detected", snap);
 * ```
 */
export class RollingMetricTracker {
  private readonly _window: RollingWindow;
  private readonly _extractFn: (text: string) => number;
  readonly label: string;

  constructor(config: RollingMetricConfig) {
    this._window = new RollingWindow(config.windowSize);
    this._extractFn = config.extractFn;
    this.label = config.label;
  }

  /** Observe a text sample; returns the extracted numeric value. */
  observe(text: string): number {
    const value = this._extractFn(text);
    this._window.push(value);
    return value;
  }

  /** Return current rolling statistics. */
  snapshot(): RollingMetricSnapshot {
    const v = this._window.values();
    return {
      label: this.label,
      count: this._window.count,
      mean: this._window.mean(),
      stddev: this._window.stddev(),
      min: v.length > 0 ? this._window.min() : 0,
      max: v.length > 0 ? this._window.max() : 0,
      latest: v.length > 0 ? v[v.length - 1]! : null,
    };
  }

  reset(): void {
    this._window.reset();
  }
}

/** Built-in metric extractors for common STM signals. */
export const STMMetrics = {
  /** Raw character count. */
  charCount: (text: string) => text.length,

  /** Word count. */
  wordCount: (text: string) => text.trim().split(/\s+/).length,

  /**
   * Hedge-word density: count of hedge phrases per 100 words.
   * Use alongside HedgeReducer to detect whether the upstream model
   * is generating increasingly hedged output over a session.
   */
  hedgeDensity: (text: string) => {
    const words = text.trim().split(/\s+/).length || 1;
    const hedges =
      (
        text.match(
          /\b(?:perhaps|maybe|apparently|seemingly|it seems|it appears|i think|i believe|one could argue|generally speaking|in many cases)\b/gi
        ) ?? []
      ).length;
    return (hedges / words) * 100;
  },

  /**
   * Verbosity ratio: average words per sentence.
   * High values indicate verbose output that DirectnessOptimizer should target.
   */
  verbosityRatio: (text: string) => {
    const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    if (sentences.length === 0) return 0;
    const words = text.trim().split(/\s+/).length;
    return words / sentences.length;
  },
} as const;

// ── Fixed-risk position sizing ─────────────────────────────────────────────────
// Ported from nautechsystems/nautilus_trader: risk/sizing.pyx FixedRiskSizer
// Pattern: given an entry price, a stop-loss price, total equity, and a risk
// fraction, compute the maximum position size that keeps the dollar risk within
// the fraction of equity. Used in @nexus/stm to bound STM signal amplitudes so
// that no single signal decision risks more than a configurable fraction of
// available capital.

/**
 * Result of a fixed-risk position size calculation.
 */
export interface PositionSizeResult {
  /** Calculated position size in units. */
  quantity: number;
  /** Dollar amount at risk (entry–stopLoss × quantity × priceIncrement). */
  dollarRisk: number;
  /** Risk as a fraction of equity (should ≈ riskFraction if not capped). */
  effectiveRiskFraction: number;
  /** Risk in price ticks between entry and stop-loss. */
  riskTicks: number;
}

/**
 * Compute a position size using the fixed-risk model from nautilus_trader.
 *
 * Formula (from FixedRiskSizer.calculate):
 *   riskTicks   = |entry − stopLoss| / priceIncrement
 *   riskMoney   = equity × riskFraction − (equity × riskFraction × commissionRate × 2)
 *   quantity    = floor(riskMoney / (riskTicks × priceIncrement))
 *   quantity    = min(quantity, hardLimit ?? ∞) — rounded down to unitBatchSize
 *
 * @param entry         Entry price.
 * @param stopLoss      Stop-loss price (different side from entry).
 * @param equity        Total equity available.
 * @param riskFraction  Fraction of equity to risk (e.g. 0.01 = 1%).
 * @param priceIncrement Minimum price movement (tick size). Default 0.01.
 * @param commissionRate Round-trip commission rate as fraction. Default 0.
 * @param hardLimit      Maximum position size cap. Default unlimited.
 * @param unitBatchSize  Lot size — quantity is rounded down to a multiple. Default 1.
 */
export function fixedRiskSize(
  entry: number,
  stopLoss: number,
  equity: number,
  riskFraction: number,
  priceIncrement = 0.01,
  commissionRate = 0,
  hardLimit?: number,
  unitBatchSize = 1
): PositionSizeResult {
  if (equity <= 0) return { quantity: 0, dollarRisk: 0, effectiveRiskFraction: 0, riskTicks: 0 };
  if (priceIncrement <= 0) throw new RangeError("fixedRiskSize: priceIncrement must be > 0");

  const riskTicks = Math.abs(entry - stopLoss) / priceIncrement;
  if (riskTicks === 0) return { quantity: 0, dollarRisk: 0, effectiveRiskFraction: 0, riskTicks: 0 };

  const riskMoney = equity * riskFraction;
  const commission = riskMoney * commissionRate * 2; // round-trip
  const riskable = Math.max(riskMoney - commission, 0);

  let quantity = Math.floor(riskable / (riskTicks * priceIncrement));
  if (hardLimit !== undefined) quantity = Math.min(quantity, hardLimit);
  quantity = Math.floor(quantity / unitBatchSize) * unitBatchSize;

  const dollarRisk = quantity * riskTicks * priceIncrement;
  const effectiveRiskFraction = equity > 0 ? dollarRisk / equity : 0;

  return { quantity, dollarRisk, effectiveRiskFraction, riskTicks };
}
