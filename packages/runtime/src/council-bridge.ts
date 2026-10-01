// SPDX-License-Identifier: Apache-2.0
/**
 * CouncilBridge — wires the @nexus/runtime planner to @nexus/council.
 *
 * Responsibility:
 *   When the planner determines a task requires multi-agent deliberation,
 *   it calls CouncilBridge.deliberate(). The bridge:
 *     1. Maps the runtime Signal into a CouncilRequest
 *     2. Emits nexus.council.started on the event bus
 *     3. Calls the DeliberationEngine (injected, not imported directly)
 *     4. Maps the ProposalResult into a RuntimeVerdict
 *     5. Emits nexus.council.verdict on the event bus
 *     6. Returns the RuntimeVerdict to the planner
 *
 * The bridge is transport-agnostic: the DeliberationEngine is injected
 * via ICouncilEngine, decoupling @nexus/runtime from @nexus/council at
 * the import level (ADR-0004: TS/Python boundary via interfaces).
 */

import { randomUUID } from "node:crypto";

import type { IEventBus } from "./event-bus.js";
import type { ITraceRecorder } from "./interfaces/observability.interface.js";

// ─── Shared council types (mirrors @nexus/contracts shapes) ──────────────────

export interface CouncilSignal {
  id: string;
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "critical";
  context?: Record<string, unknown>;
  /** Limit which models can deliberate — undefined means use engine defaults */
  modelHints?: string[];
}

export type VerdictDecision = "approve" | "reject" | "defer" | "escalate";

export interface RuntimeVerdict {
  verdictId: string;
  signalId: string;
  decision: VerdictDecision;
  confidence: number;
  rationale: string;
  dissents: string[];
  costUsd: number;
  deliberatedAt: Date;
}

// ─── Council engine interface (injected, not imported from @nexus/council) ───

export interface ICouncilVote {
  model: string;
  provider: string;
  vote: "yes" | "no" | "abstain";
  reasoning: string;
  confidence: number;
}

export interface ICouncilResult {
  proposalId: string;
  outcome: "approved" | "rejected" | "deferred";
  votes: ICouncilVote[];
  consensus: number;
  summary: string;
  totalLatencyMs: number;
  /** Populated if the engine threw BudgetExceededError */
  budgetExceeded?: boolean;
  costUsd?: number;
}

export interface ICouncilEngine {
  deliberate(request: {
    proposal: {
      title: string;
      description: string;
      context?: Record<string, unknown>;
      models?: string[];
    };
    budgetUsd?: number;
    timeoutMs?: number;
  }): Promise<{ ok: boolean; result?: ICouncilResult; error?: string }>;
}

// ─── Bridge config ────────────────────────────────────────────────────────────

export interface CouncilBridgeConfig {
  engine: ICouncilEngine;
  eventBus: IEventBus;
  tracer?: ITraceRecorder;
  /** Default per-deliberation budget cap in USD (default: 0.10) */
  defaultBudgetUsd?: number;
  /** Default deliberation timeout in ms (default: 60_000) */
  defaultTimeoutMs?: number;
}

// ─── Outcome mapping ──────────────────────────────────────────────────────────

function mapOutcome(outcome: ICouncilResult["outcome"], confidence: number): VerdictDecision {
  if (outcome === "approved") return "approve";
  if (outcome === "rejected") return "reject";
  // deferred — if confidence is very low escalate, otherwise defer
  return confidence < 0.3 ? "escalate" : "defer";
}

function dissentsFrom(votes: ICouncilVote[], majority: "yes" | "no"): string[] {
  const minority = majority === "yes" ? "no" : "yes";
  return votes.filter((v) => v.vote === minority).map((v) => v.model);
}

function majorityVote(votes: ICouncilVote[]): "yes" | "no" {
  const yes = votes.filter((v) => v.vote === "yes").length;
  const no = votes.filter((v) => v.vote === "no").length;
  return yes >= no ? "yes" : "no";
}

// ─── CouncilBridge ────────────────────────────────────────────────────────────

export class CouncilBridge {
  private readonly engine: ICouncilEngine;
  private readonly eventBus: IEventBus;
  private readonly tracer?: ITraceRecorder;
  private readonly defaultBudgetUsd: number;
  private readonly defaultTimeoutMs: number;

  constructor(config: CouncilBridgeConfig) {
    this.engine = config.engine;
    this.eventBus = config.eventBus;
    this.tracer = config.tracer;
    this.defaultBudgetUsd = config.defaultBudgetUsd ?? 0.1;
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 60_000;
  }

  /**
   * Deliberate on a signal and return a RuntimeVerdict.
   *
   * The caller (planner) decides whether to proceed with a task based on the
   * verdict.decision:
   *   - "approve"  → enqueue the task immediately
   *   - "reject"   → cancel the task, emit nexus.tasks.failed
   *   - "defer"    → re-queue with lower priority after a backoff
   *   - "escalate" → create an ApprovalRequest (human-in-the-loop gate)
   */
  async deliberate(
    signal: CouncilSignal,
    options?: { budgetUsd?: number; timeoutMs?: number },
  ): Promise<RuntimeVerdict> {
    const verdictId = randomUUID();
    const budgetUsd = options?.budgetUsd ?? this.defaultBudgetUsd;
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;

    const span = this.tracer?.startSpan("council.deliberate", undefined, {
      signalId: signal.id,
      verdictId,
      priority: signal.priority,
    });

    // Emit: deliberation started
    await this.eventBus.publish("nexus.council.started", {
      event_id: randomUUID(),
      occurred_at: new Date().toISOString(),
      version: "1.0.0",
      verdict_id: verdictId,
      signal_id: signal.id,
      archetypes: [], // engine selects archetypes internally
      budget_usd: budgetUsd,
    });

    let result: RuntimeVerdict;

    try {
      const response = await Promise.race([
        this.engine.deliberate({
          proposal: {
            title: signal.title,
            description: signal.description,
            context: { signalId: signal.id, priority: signal.priority, ...(signal.context ?? {}) },
            models: signal.modelHints,
          },
          budgetUsd,
          timeoutMs,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => {
            reject(new Error(`Council deliberation timed out after ${timeoutMs}ms`));
          }, timeoutMs),
        ),
      ]);

      if (!response.ok || !response.result) {
        // Engine returned an error — escalate to human
        result = {
          verdictId,
          signalId: signal.id,
          decision: "escalate",
          confidence: 0,
          rationale: response.error ?? "Engine returned no result",
          dissents: [],
          costUsd: 0,
          deliberatedAt: new Date(),
        };
      } else {
        const r = response.result;
        const majority = majorityVote(r.votes);
        result = {
          verdictId,
          signalId: signal.id,
          decision: mapOutcome(r.outcome, r.consensus),
          confidence: r.consensus,
          rationale: r.summary,
          dissents: dissentsFrom(r.votes, majority),
          costUsd: r.costUsd ?? 0,
          deliberatedAt: new Date(),
        };
      }
    } catch (err) {
      const isTimeout = err instanceof Error && err.message.includes("timed out");
      result = {
        verdictId,
        signalId: signal.id,
        decision: isTimeout ? "defer" : "escalate",
        confidence: 0,
        rationale: err instanceof Error ? err.message : String(err),
        dissents: [],
        costUsd: 0,
        deliberatedAt: new Date(),
      };
    }

    // Emit: verdict reached
    await this.eventBus.publish("nexus.council.verdict", {
      event_id: randomUUID(),
      occurred_at: result.deliberatedAt.toISOString(),
      version: "1.0.0",
      verdict_id: result.verdictId,
      signal_id: result.signalId,
      decision: result.decision,
      confidence: result.confidence,
      cost_usd: result.costUsd,
      dissents: result.dissents,
    });

    if (span) {
      this.tracer?.endSpan(span.spanId, {
        decision: result.decision,
        confidence: result.confidence,
        costUsd: result.costUsd,
      });
    }

    return result;
  }
}

// ─── PlannerCouncilRouter ─────────────────────────────────────────────────────

/**
 * PlannerCouncilRouter — decides when to call the council vs. auto-approve.
 *
 * Rules (applied in order, first match wins):
 *   1. If task.governanceMetadata.dangerous === true → always deliberate
 *   2. If task.governanceMetadata.costEstimate > autoApproveThresholdUsd → deliberate
 *   3. If signal.priority === "critical" → deliberate
 *   4. Otherwise → auto-approve (bypass council for low-stakes tasks)
 */

export interface RoutedTask {
  taskId: string;
  type: string;
  payload: Record<string, unknown>;
  governanceMetadata?: {
    dangerous?: boolean;
    costEstimate?: number;
    resourceScope?: string;
  };
}

export interface RouterConfig {
  bridge: CouncilBridge;
  /** Tasks with costEstimate above this go to council (default: 0.05 USD) */
  autoApproveThresholdUsd?: number;
}

export class PlannerCouncilRouter {
  private readonly bridge: CouncilBridge;
  private readonly threshold: number;

  constructor(config: RouterConfig) {
    this.bridge = config.bridge;
    this.threshold = config.autoApproveThresholdUsd ?? 0.05;
  }

  /**
   * Route a task: returns the verdict.
   * Auto-approve returns a synthetic "approve" verdict without calling the council.
   */
  async route(task: RoutedTask, signalContext?: Partial<CouncilSignal>): Promise<RuntimeVerdict> {
    const needsCouncil = this.requiresDeliberation(task, signalContext);

    if (!needsCouncil) {
      // Auto-approve: synthetic verdict, no LLM cost
      return {
        verdictId: randomUUID(),
        signalId: signalContext?.id ?? randomUUID(),
        decision: "approve",
        confidence: 1.0,
        rationale: "Auto-approved: below governance threshold",
        dissents: [],
        costUsd: 0,
        deliberatedAt: new Date(),
      };
    }

    const signal: CouncilSignal = {
      id: signalContext?.id ?? randomUUID(),
      title: signalContext?.title ?? `Governance review: ${task.type}`,
      description:
        signalContext?.description ??
        `Task ${task.taskId} of type "${task.type}" requires council deliberation. ` +
          `Resource scope: ${task.governanceMetadata?.resourceScope ?? "unknown"}. ` +
          `Estimated cost: $${task.governanceMetadata?.costEstimate ?? 0}.`,
      priority: signalContext?.priority ?? "medium",
      context: {
        taskId: task.taskId,
        taskType: task.type,
        ...(task.governanceMetadata ?? {}),
        ...(signalContext?.context ?? {}),
      },
      modelHints: signalContext?.modelHints,
    };

    return this.bridge.deliberate(signal);
  }

  private requiresDeliberation(task: RoutedTask, signal?: Partial<CouncilSignal>): boolean {
    if (task.governanceMetadata?.dangerous) return true;
    if ((task.governanceMetadata?.costEstimate ?? 0) > this.threshold) return true;
    if (signal?.priority === "critical") return true;
    return false;
  }
}
