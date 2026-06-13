// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/alerts — Configurable alert rules engine.
 *
 * Architecture
 * ─────────────
 *   AlertRule     — a named, typed rule with condition + severity + cooldown
 *   AlertChannel  — injectable notification endpoint (webhook, email, Slack…)
 *   AlertEngine   — evaluates a metric value against all registered rules,
 *                   deduplicates via per-rule cooldown windows, dispatches
 *                   alerts to all wired channels, and optionally emits hook events
 *
 * Built-in condition types
 * ─────────────────────────
 *   threshold   — fires when value crosses a numeric limit (gt / gte / lt / lte / eq / neq)
 *   rate        — fires when a count exceeds N occurrences in a time window
 *   pattern     — fires when a string value matches a substring or regex
 *   composite   — fires when ALL child conditions evaluate true (AND-gate)
 *
 * Wire-up example
 * ────────────────
 * ```ts
 * import { AlertEngine, AlertRule } from "@nexus/alerts";
 *
 * const engine = new AlertEngine({
 *   channels: [webhookChannel, emailChannel],
 *   hooks: globalHooks,
 * });
 *
 * engine.addRule({
 *   id: "high-cost",
 *   name: "Daily cost threshold",
 *   metric: "cost.usd.daily",
 *   condition: { type: "threshold", operator: "gt", value: 10 },
 *   severity: "warning",
 *   cooldownMs: 3_600_000,   // re-alert at most once per hour
 * });
 *
 * await engine.evaluate("cost.usd.daily", 12.5);  // fires alert
 * await engine.evaluate("cost.usd.daily", 13.0);  // suppressed (in cooldown)
 * ```
 *
 * Zero hard inter-package dependencies.  AgentHooks interface is re-declared
 * locally (structurally compatible with @nexus/hooks HookRegistry).
 */

import { randomUUID } from "node:crypto";

// ── Error ─────────────────────────────────────────────────────────────────────

export type AlertErrorCode =
  | "RULE_NOT_FOUND"
  | "DUPLICATE_RULE"
  | "INVALID_CONDITION"
  | "CHANNEL_SEND_FAILED"
  | "EVALUATE_FAILED";

export class AlertError extends Error {
  readonly code: AlertErrorCode;
  readonly context?: Record<string, unknown>;

  constructor(code: AlertErrorCode, message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = "AlertError";
    this.code = code;
    this.context = context;
  }
}

// ── Condition types ───────────────────────────────────────────────────────────

export type NumericOperator = "gt" | "gte" | "lt" | "lte" | "eq" | "neq";

/** Fires when a numeric metric crosses a threshold. */
export interface ThresholdCondition {
  type: "threshold";
  operator: NumericOperator;
  value: number;
}

/**
 * Fires when `count` events occur within `windowMs` milliseconds.
 * The caller must supply a clock / counter — the condition itself is stateless;
 * the AlertEngine maintains per-rule rate state internally.
 */
export interface RateCondition {
  type: "rate";
  /** Maximum allowed count within the window before the alert fires */
  count: number;
  /** Window size in milliseconds */
  windowMs: number;
}

/**
 * Fires when a string metric value matches a pattern.
 * `pattern` is treated as a plain substring if `regex` is false (default).
 */
export interface PatternCondition {
  type: "pattern";
  pattern: string;
  /** Interpret `pattern` as a regular expression (default: false) */
  regex?: boolean;
  /** Case-insensitive matching (default: false) */
  ignoreCase?: boolean;
}

/**
 * Fires when ALL child conditions evaluate to true (logical AND).
 * Children must be ThresholdCondition or PatternCondition — composite
 * nesting and rate children are not supported to avoid O(n²) complexity.
 */
export interface CompositeCondition {
  type: "composite";
  conditions: Array<ThresholdCondition | PatternCondition>;
}

export type AlertCondition =
  | ThresholdCondition
  | RateCondition
  | PatternCondition
  | CompositeCondition;

// ── Rule ──────────────────────────────────────────────────────────────────────

export type AlertSeverity = "info" | "warning" | "critical";

export interface AlertRule {
  /** Unique rule identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /**
   * Metric key this rule watches.
   * Use dot-notation: "cost.usd.daily", "latency.p99.ms", "error.rate.5m".
   * Pass "*" to match any metric.
   */
  metric: string;
  condition: AlertCondition;
  severity: AlertSeverity;
  /**
   * Minimum milliseconds between repeated alerts for this rule (default: 0).
   * Set to e.g. 3_600_000 to re-alert at most once per hour.
   */
  cooldownMs?: number;
  /** Arbitrary metadata forwarded to channels in the AlertEvent */
  metadata?: Record<string, unknown>;
  /** If false, rule is evaluated but alerts are suppressed (default: true) */
  enabled?: boolean;
}

// ── Alert event ───────────────────────────────────────────────────────────────

export interface AlertEvent {
  /** Unique id for this alert instance */
  id: string;
  /** The rule that fired */
  ruleId: string;
  ruleName: string;
  severity: AlertSeverity;
  metric: string;
  /** The value that triggered the alert */
  value: unknown;
  firedAt: number;
  metadata?: Record<string, unknown>;
}

// ── Channel ───────────────────────────────────────────────────────────────────

/** Injectable notification endpoint. */
export interface AlertChannel {
  /** Unique channel name for logging / dedup */
  readonly name: string;
  /**
   * Send a notification for an alert event.
   * Implementors should throw on unrecoverable errors; the engine will catch
   * and collect them without stopping other channels.
   */
  send(event: AlertEvent): Promise<void>;
}

/** No-op channel — records sent events for test inspection. */
export class NullAlertChannel implements AlertChannel {
  readonly name = "null";
  readonly sent: AlertEvent[] = [];

  async send(event: AlertEvent): Promise<void> {
    this.sent.push(event);
  }
}

/** In-memory channel that throws after N calls — used for failure tests. */
export class FailingAlertChannel implements AlertChannel {
  readonly name: string;
  private calls = 0;
  constructor(name = "failing") {
    this.name = name;
  }
  async send(_event: AlertEvent): Promise<void> {
    this.calls++;
    throw new Error(`Channel "${this.name}" failed on call #${this.calls}`);
  }
}

// ── Hook emitter (local re-declaration) ──────────────────────────────────────

export interface AlertHooks {
  emit(
    event: string,
    payload: Record<string, unknown>,
  ): Promise<{ handled: number; aborted: boolean; errors: unknown[] }>;
}

// ── Rate state ────────────────────────────────────────────────────────────────

interface RateWindow {
  timestamps: number[];
}

// ── Engine config ─────────────────────────────────────────────────────────────

export interface AlertEngineConfig {
  channels?: AlertChannel[];
  hooks?: AlertHooks;
  /**
   * Clock override — defaults to Date.now().
   * Inject a deterministic clock in tests.
   */
  now?: () => number;
}

// ── Dispatch result ───────────────────────────────────────────────────────────

export interface DispatchResult {
  /** Number of rules that fired */
  fired: number;
  /** Number of rules suppressed by cooldown */
  suppressed: number;
  /** Number of rules that were disabled */
  disabled: number;
  /** Alerts fired this evaluation */
  events: AlertEvent[];
  /** Per-channel send errors (non-fatal) */
  channelErrors: Array<{ channel: string; error: string }>;
}

// ── AlertEngine ───────────────────────────────────────────────────────────────

export class AlertEngine {
  private readonly rules = new Map<string, AlertRule>();
  private readonly channels: AlertChannel[];
  private readonly hooks?: AlertHooks;
  private readonly now: () => number;

  /** Last fire timestamp per rule id (for cooldown) */
  private readonly lastFired = new Map<string, number>();

  /** Rate-window state per rule id */
  private readonly rateState = new Map<string, RateWindow>();

  constructor(config: AlertEngineConfig = {}) {
    this.channels = config.channels ?? [];
    this.hooks = config.hooks;
    this.now = config.now ?? (() => Date.now());
  }

  // ── Rule management ────────────────────────────────────────────────────────

  addRule(rule: AlertRule): this {
    if (this.rules.has(rule.id)) {
      throw new AlertError("DUPLICATE_RULE", `Rule "${rule.id}" is already registered`, {
        ruleId: rule.id,
      });
    }
    this.rules.set(rule.id, { enabled: true, cooldownMs: 0, ...rule });
    return this;
  }

  removeRule(id: string): this {
    if (!this.rules.has(id)) {
      throw new AlertError("RULE_NOT_FOUND", `Rule "${id}" is not registered`, { ruleId: id });
    }
    this.rules.delete(id);
    this.lastFired.delete(id);
    this.rateState.delete(id);
    return this;
  }

  updateRule(id: string, patch: Partial<Omit<AlertRule, "id">>): this {
    const existing = this.rules.get(id);
    if (!existing) {
      throw new AlertError("RULE_NOT_FOUND", `Rule "${id}" is not registered`, { ruleId: id });
    }
    this.rules.set(id, { ...existing, ...patch });
    return this;
  }

  getRule(id: string): AlertRule | undefined {
    return this.rules.get(id);
  }

  listRules(): AlertRule[] {
    return [...this.rules.values()];
  }

  clearRules(): this {
    this.rules.clear();
    this.lastFired.clear();
    this.rateState.clear();
    return this;
  }

  // ── Evaluation ─────────────────────────────────────────────────────────────

  /**
   * Evaluate `value` for metric `metric` against all matching rules.
   * Returns a DispatchResult describing which rules fired or were suppressed.
   */
  async evaluate(metric: string, value: unknown): Promise<DispatchResult> {
    const result: DispatchResult = {
      fired: 0,
      suppressed: 0,
      disabled: 0,
      events: [],
      channelErrors: [],
    };

    const now = this.now();

    for (const rule of this.rules.values()) {
      if (rule.metric !== metric && rule.metric !== "*") continue;
      if (rule.enabled === false) {
        result.disabled++;
        continue;
      }

      // ── Cooldown check ────────────────────────────────────────────────────
      const cooldown = rule.cooldownMs ?? 0;
      const lastFiredAt = this.lastFired.get(rule.id) ?? 0;
      if (cooldown > 0 && now - lastFiredAt < cooldown) {
        result.suppressed++;
        continue;
      }

      // ── Condition evaluation ──────────────────────────────────────────────
      let fires: boolean;
      try {
        fires = this._evalCondition(rule.condition, value, rule.id, now);
      } catch (cause) {
        throw new AlertError(
          "EVALUATE_FAILED",
          `Rule "${rule.id}" condition evaluation failed: ${String(cause)}`,
          { ruleId: rule.id, metric, value },
        );
      }

      if (!fires) continue;

      // ── Build event ───────────────────────────────────────────────────────
      const event: AlertEvent = {
        id: randomUUID(),
        ruleId: rule.id,
        ruleName: rule.name,
        severity: rule.severity,
        metric,
        value,
        firedAt: now,
        metadata: rule.metadata,
      };

      this.lastFired.set(rule.id, now);
      result.fired++;
      result.events.push(event);

      // ── Dispatch to channels ──────────────────────────────────────────────
      for (const channel of this.channels) {
        try {
          await channel.send(event);
        } catch (cause) {
          result.channelErrors.push({
            channel: channel.name,
            error: String(cause),
          });
        }
      }

      // ── Hook emit ─────────────────────────────────────────────────────────
      if (this.hooks) {
        try {
          await this.hooks.emit("alert.fired", {
            ruleId: event.ruleId,
            ruleName: event.ruleName,
            severity: event.severity,
            metric: event.metric,
            value: event.value,
            firedAt: event.firedAt,
          });
        } catch {
          // Hook errors are non-fatal
        }
      }
    }

    return result;
  }

  /**
   * Convenience: reset the cooldown state for a specific rule so it can
   * fire again immediately.  Useful in tests and after rule mutations.
   */
  resetCooldown(ruleId: string): this {
    this.lastFired.delete(ruleId);
    return this;
  }

  /**
   * Convenience: reset rate-window state for a specific rule.
   */
  resetRateWindow(ruleId: string): this {
    this.rateState.delete(ruleId);
    return this;
  }

  // ── Condition evaluation helpers ───────────────────────────────────────────

  private _evalCondition(
    condition: AlertCondition,
    value: unknown,
    ruleId: string,
    now: number,
  ): boolean {
    switch (condition.type) {
      case "threshold":
        return this._evalThreshold(condition, value);
      case "rate":
        return this._evalRate(condition, ruleId, now);
      case "pattern":
        return this._evalPattern(condition, value);
      case "composite":
        return condition.conditions.every((c) => this._evalCondition(c, value, ruleId, now));
      default: {
        const _exhaustive: never = condition;
        throw new AlertError(
          "INVALID_CONDITION",
          `Unknown condition type: ${JSON.stringify(_exhaustive)}`,
        );
      }
    }
  }

  private _evalThreshold(condition: ThresholdCondition, value: unknown): boolean {
    if (typeof value !== "number") return false;
    switch (condition.operator) {
      case "gt":  return value > condition.value;
      case "gte": return value >= condition.value;
      case "lt":  return value < condition.value;
      case "lte": return value <= condition.value;
      case "eq":  return value === condition.value;
      case "neq": return value !== condition.value;
    }
  }

  private _evalRate(condition: RateCondition, ruleId: string, now: number): boolean {
    const windowStart = now - condition.windowMs;
    let state = this.rateState.get(ruleId);
    if (!state) {
      state = { timestamps: [] };
      this.rateState.set(ruleId, state);
    }
    // Record this evaluation
    state.timestamps.push(now);
    // Evict timestamps outside the window
    state.timestamps = state.timestamps.filter((t) => t > windowStart);
    return state.timestamps.length > condition.count;
  }

  private _evalPattern(condition: PatternCondition, value: unknown): boolean {
    if (typeof value !== "string") return false;
    const haystack = condition.ignoreCase ? value.toLowerCase() : value;
    const needle = condition.ignoreCase
      ? condition.pattern.toLowerCase()
      : condition.pattern;
    if (condition.regex) {
      const flags = condition.ignoreCase ? "i" : "";
      return new RegExp(condition.pattern, flags).test(value);
    }
    return haystack.includes(needle);
  }
}

// ── Convenience factory ────────────────────────────────────────────────────────

/**
 * Create a one-shot threshold alert rule with sensible defaults.
 *
 * ```ts
 * engine.addRule(thresholdRule("high-latency", "latency.p99.ms", "gt", 500, "warning"));
 * ```
 */
export function thresholdRule(
  id: string,
  metric: string,
  operator: NumericOperator,
  value: number,
  severity: AlertSeverity = "warning",
  opts?: Partial<Omit<AlertRule, "id" | "metric" | "condition" | "severity">>,
): AlertRule {
  return {
    id,
    name: opts?.name ?? id,
    metric,
    condition: { type: "threshold", operator, value },
    severity,
    ...opts,
  };
}
