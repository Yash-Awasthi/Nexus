// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/escalation-breaker — runaway/cost guardrail policy for agent runs.
 *
 * Where `@nexus/confidence-circuit-breaker` trips a circuit (closed → open →
 * half-open) on error rates and low confidence, this package implements the
 * OTHER classic pattern: a steer → constrain → stop ESCALATION LADDER that
 * nudges before it stops. It models a single mission/run rather than a hive
 * of persistent agents.
 *
 * This module owns the POLICY only — trip conditions + the escalation
 * ladder. It has no side effects: it reads signals and returns decisions;
 * the caller performs the enforcement (send a corrective directive, record
 * the level, abort the run) and emits the state.
 *
 * Inputs aggregate three sources:
 *   (a) usage samples (cumulative tokens) — for cost + token velocity;
 *   (b) tool-use / error events — repeated identical tool calls, error storms;
 *   (c) no-progress — burning tokens without doing anything new.
 *
 * Velocity is the DIFF of consecutive cumulative samples (Δ/Δt), never a
 * single sample treated as an increment.
 *
 * Safe by construction: steer-first, one level per tick (never jump to a
 * kill), de-escalates a level per healthy tick (recovery), and `hardStop`
 * is OFF by default — without it the ladder caps at `constrained` and never
 * stops the run.
 */

import { createHash } from "node:crypto";

// ── Types ────────────────────────────────────────────────────────────────────

export type BreakerLevel = "healthy" | "steering" | "constrained" | "stopped";

/** Emitted on every tick so the caller can keep its UI/record live. */
export interface BreakerState {
  runId: string;
  level: BreakerLevel;
  reason: string;
  ts: number;
}

/** What the caller should do this tick. `action` fires only when the level
 *  ESCALATES (so a durable steer directive isn't re-emitted every tick). */
export type BreakerAction = "none" | "steer" | "constrain" | "stop";

export interface BreakerDecision {
  state: BreakerState;
  action: BreakerAction;
  /** True when the level changed since the previous tick (escalation OR recovery). */
  changed: boolean;
}

/** Cumulative usage snapshot (monotonic counters, never per-tick deltas). */
export interface UsageSample {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** Optional dollar cost attributed to this run so far. */
  usd?: number;
  /** Sample timestamp (ms). */
  ts: number;
}

/** Per-run input for one tick. */
export interface BreakerInput {
  runId: string;
  /** Cumulative usage snapshot, or null when unknown (skips cost/velocity trips). */
  sample: UsageSample | null;
  /** Did the run make coordination progress recently (a phase transition, a
   *  persisted record write, an inbox/queue drain)? */
  progressing: boolean;
  /** When the run's own workspace/artifacts last changed, or omitted. */
  lastWorkAt?: number;
}

export interface BreakerConfig {
  enabled?: boolean;
  /** Allow the ladder to reach `stopped` (kills the run). Default false —
   *  without it the ladder caps at `constrained` and never stops. */
  hardStop?: boolean;
  /** Consecutive identical tool calls (same name+input) before tripping. */
  repeatedToolLimit?: number;
  /** Consecutive api errors / retries before tripping. */
  errorStormLimit?: number;
  /** Output-token velocity (per minute) that trips the velocity arm. */
  tokenVelocityPerMin?: number;
  /** Floor-wide cost cap in USD; the run trips when it exceeds it. */
  costCapUsd?: number;
  /** Floor-wide token cap; the run trips when it exceeds it. */
  costCapTokens?: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULTS = {
  enabled: true,
  hardStop: false,
  repeatedToolLimit: 8,
  errorStormLimit: 5,
  tokenVelocityPerMin: 60_000, // output tokens/min — coarse backstop, deliberately high
} as const;

/** How recent a DISTINCT tool call must be to count as progress for the
 *  no-progress arm. */
const PROGRESS_TOOL_WINDOW_MS = 300_000;
/** Consecutive tripping ticks the no-progress arm needs before it fires — a
 *  one-tick blip never steers on its own. */
const NO_PROGRESS_TICKS = 2;

const LEVELS: BreakerLevel[] = ["healthy", "steering", "constrained", "stopped"];
const rank = (l: BreakerLevel): number => LEVELS.indexOf(l);
const actionFor = (l: BreakerLevel): BreakerAction =>
  l === "steering"
    ? "steer"
    : l === "constrained"
      ? "constrain"
      : l === "stopped"
        ? "stop"
        : "none";

/** Total tokens in a cumulative sample (all kinds), 0 when unknown. */
const tokensOf = (s: UsageSample | null): number =>
  s ? s.input + s.output + s.cacheRead + s.cacheCreation : 0;

interface RunBreakerState {
  level: BreakerLevel;
  reason: string;
  lastSample: UsageSample | null;
  /** Consecutive identical tool calls (same name+input). */
  repeatKey: string | null;
  repeatCount: number;
  /** Consecutive api_error / retry events with no intervening progress. */
  errorCount: number;
  /** When the last DISTINCT (name+input) tool call ran. A varied tool stream
   *  is work — it must not read as "no progress". A true single-call loop
   *  never refreshes this; an alternating loop that would is still
   *  backstopped by the velocity arm. */
  lastDistinctToolAt: number;
  /** Consecutive ticks the no-progress condition held (debounce counter). */
  noProgressTicks: number;
}

// ── The breaker ──────────────────────────────────────────────────────────────

export class EscalationBreaker {
  private runs = new Map<string, RunBreakerState>();

  constructor(private getConfig: () => BreakerConfig) {}

  private cfg(): Required<
    Pick<
      BreakerConfig,
      "enabled" | "hardStop" | "repeatedToolLimit" | "errorStormLimit" | "tokenVelocityPerMin"
    >
  > &
    Pick<BreakerConfig, "costCapUsd" | "costCapTokens"> {
    const c = this.getConfig() ?? {};
    return {
      enabled: c.enabled ?? DEFAULTS.enabled,
      hardStop: c.hardStop ?? DEFAULTS.hardStop,
      repeatedToolLimit: c.repeatedToolLimit ?? DEFAULTS.repeatedToolLimit,
      errorStormLimit: c.errorStormLimit ?? DEFAULTS.errorStormLimit,
      tokenVelocityPerMin: c.tokenVelocityPerMin ?? DEFAULTS.tokenVelocityPerMin,
      costCapUsd: c.costCapUsd,
      costCapTokens: c.costCapTokens,
    };
  }

  private get(runId: string): RunBreakerState {
    let s = this.runs.get(runId);
    if (!s) {
      s = {
        level: "healthy",
        reason: "",
        lastSample: null,
        repeatKey: null,
        repeatCount: 0,
        errorCount: 0,
        lastDistinctToolAt: 0,
        noProgressTicks: 0,
      };
      this.runs.set(runId, s);
    }
    return s;
  }

  /** Drop all state for a run (call when the run ends so it can't leak/zombie). */
  forget(runId: string): void {
    this.runs.delete(runId);
  }

  /** Current breaker level for a run (for live snapshots). */
  levelFor(runId: string): BreakerLevel {
    return this.runs.get(runId)?.level ?? "healthy";
  }

  // ── event-driven inputs ────────────────────────────────────────────────────

  /** A tool call ran. A NEW (name+input) key counts as forward progress
   *  (resets the repeat + error counters and stamps the distinct-tool clock
   *  the no-progress arm reads); the SAME key in a row is the loop signal. */
  recordToolUse(
    runId: string,
    toolName: string | undefined,
    toolInput: unknown,
    now = Date.now(),
  ): void {
    const s = this.get(runId);
    const key = this.toolKey(toolName, toolInput);
    if (key === s.repeatKey) {
      s.repeatCount += 1;
    } else {
      s.repeatKey = key;
      s.repeatCount = 1;
      s.errorCount = 0; // a distinct tool call = progress; clear the error storm
      s.lastDistinctToolAt = now;
    }
  }

  /** An api_error / retry occurred (no forward progress). */
  recordError(runId: string): void {
    this.get(runId).errorCount += 1;
  }

  private toolKey(toolName: string | undefined, toolInput: unknown): string {
    // Capped serialization → hash. A Write/Edit tool_input can carry a whole
    // file body (MBs); capping each string field bounds the work. The key is a
    // HASH of the capped serialization, not a slice: a slice collides on
    // commands sharing a long identical preamble (absolute paths, a cd, an
    // interpreter invocation) — different calls would read as identical.
    // Genuinely identical calls still key identically, so every real loop
    // caught before is still caught.
    let inp = "";
    try {
      // The replacer's `value` is `any` by the lib signature; narrow it so the
      // capped serialization is typed (and lint-clean) rather than `any`.
      inp =
        JSON.stringify(toolInput, (_k, v: unknown) =>
          typeof v === "string" && v.length > 4096 ? v.slice(0, 4096) : v,
        ) ?? "";
    } catch {
      inp = String(toolInput);
    }
    return `${toolName ?? "?"}:${createHash("sha256").update(inp).digest("hex")}`;
  }

  // ── periodic evaluation ────────────────────────────────────────────────────

  /** Evaluate every run for this tick and return a decision per run. The
   *  caller emits each state (keeps the record/UI live) and enforces `action`
   *  when present. */
  tick(inputs: BreakerInput[], nowMs: number): BreakerDecision[] {
    const cfg = this.cfg();
    const decisions: BreakerDecision[] = [];
    if (!cfg.enabled) {
      // Breaker off: report healthy for everyone, take no action.
      for (const { runId } of inputs) {
        const s = this.get(runId);
        const changed = s.level !== "healthy";
        s.level = "healthy";
        s.reason = "";
        decisions.push({
          state: { runId, level: "healthy", reason: "", ts: nowMs },
          action: "none",
          changed,
        });
      }
      return decisions;
    }

    for (const input of inputs) {
      const s = this.get(input.runId);
      const trip = this.evaluate(input, s, cfg, nowMs);
      // remember the cumulative baseline for next tick's velocity diff
      if (input.sample) s.lastSample = input.sample;

      const ceiling: BreakerLevel = cfg.hardStop ? "stopped" : "constrained";
      let target = s.level;
      if (trip.tripping) {
        target = LEVELS[Math.min(rank(s.level) + 1, rank(ceiling))]!;
      } else {
        target = LEVELS[Math.max(rank(s.level) - 1, 0)]!; // recover one level
      }
      const changed = target !== s.level;
      const escalated = rank(target) > rank(s.level);
      s.level = target;
      s.reason = trip.tripping ? trip.reason : changed ? "recovering — signals cleared" : s.reason;

      decisions.push({
        state: { runId: input.runId, level: target, reason: s.reason, ts: nowMs },
        action: escalated ? actionFor(target) : "none",
        changed,
      });
    }
    return decisions;
  }

  /** Pure trip evaluation for one run given its signals + remembered baseline. */
  private evaluate(
    input: BreakerInput,
    s: RunBreakerState,
    cfg: ReturnType<EscalationBreaker["cfg"]>,
    nowMs: number,
  ): { tripping: boolean; reason: string } {
    // (b) repeated identical tool calls
    if (s.repeatCount >= cfg.repeatedToolLimit) {
      return {
        tripping: true,
        reason: `looping: ${s.repeatCount}× identical tool call (${s.repeatKey?.split(":")[0] ?? "?"})`,
      };
    }
    // (b) api_error storm
    if (s.errorCount >= cfg.errorStormLimit) {
      return {
        tripping: true,
        reason: `error storm: ${s.errorCount} consecutive api errors/retries`,
      };
    }
    // (a) cost cap — run total over cap
    if (typeof cfg.costCapUsd === "number" && cfg.costCapUsd > 0) {
      const usd = input.sample?.usd ?? 0;
      if (usd > cfg.costCapUsd) {
        return {
          tripping: true,
          reason: `cost cap: $${usd.toFixed(2)} over the $${cfg.costCapUsd} cap`,
        };
      }
    }
    // (a) token cap — run total tokens over cap
    if (typeof cfg.costCapTokens === "number" && cfg.costCapTokens > 0) {
      const tok = tokensOf(input.sample);
      if (tok > cfg.costCapTokens) {
        return {
          tripping: true,
          reason: `token cap: ${tok.toLocaleString()} tokens over the ${cfg.costCapTokens.toLocaleString()} cap`,
        };
      }
    }
    // (a) token-velocity spike — diff cumulative output across consecutive ticks.
    if (input.sample && s.lastSample) {
      const dOut = input.sample.output - s.lastSample.output;
      const dMin = (input.sample.ts - s.lastSample.ts) / 60_000;
      if (dOut > 0 && dMin > 0) {
        const velocity = dOut / dMin;
        if (velocity > cfg.tokenVelocityPerMin) {
          return {
            tripping: true,
            reason: `token velocity ${Math.round(velocity)}/min > ${cfg.tokenVelocityPerMin}/min`,
          };
        }
        // (c) no-progress: burning output tokens while not making progress.
        // A recent DISTINCT tool call counts as progress too — background
        // workflows do real work that never touches the coordination surface.
        // Debounced: fires only after NO_PROGRESS_TICKS consecutive ticks, so
        // a one-tick blip never steers.
        const toolActive = nowMs - s.lastDistinctToolAt < PROGRESS_TOOL_WINDOW_MS;
        const workActive =
          typeof input.lastWorkAt === "number" &&
          input.lastWorkAt > 0 &&
          nowMs - input.lastWorkAt < PROGRESS_TOOL_WINDOW_MS;
        if (!input.progressing && !toolActive && !workActive) {
          s.noProgressTicks += 1;
          if (s.noProgressTicks >= NO_PROGRESS_TICKS) {
            return {
              tripping: true,
              reason: "no-progress: generating tokens without doing anything new",
            };
          }
        } else {
          s.noProgressTicks = 0;
        }
      }
    }
    return { tripping: false, reason: "" };
  }
}
