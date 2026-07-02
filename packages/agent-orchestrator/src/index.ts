// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/agent-orchestrator — parallel multi-agent orchestration.
 *
 * Fan one task out across N agents (typically different models) running in
 * parallel, each in its own isolated git worktree so their edits never collide.
 * Capture each agent's diff, score the candidates, merge the winner into the
 * base branch, discard the losers.
 *
 * Everything pluggable is injected — the agent runner (wraps @nexus/agent-runtime),
 * the scorer (wrap @nexus/council to reuse its multi-model vote), and the
 * WorktreeManager (real git in prod, a fake in tests). This package owns the
 * coordination, not the agent or the voting.
 */
export { GitWorktreeManager, type WorktreeManager, type Worktree } from "./worktree.js";
import type { WorktreeManager, Worktree } from "./worktree.js";

/** One agent variant to race — usually a distinct model/provider. */
export interface AgentSpec {
  /** Stable id for this candidate (e.g. the model name). Must be unique per run. */
  id: string;
  /** Model identifier passed through to the runner. */
  model: string;
}

/** Context handed to the runner for a single agent execution. */
export interface AgentRunContext {
  task: string;
  spec: AgentSpec;
  /** Isolated working directory the agent must edit (the worktree path). */
  workingDir: string;
  signal?: AbortSignal;
}

/** Runs one agent to completion in its worktree. Wraps agent-runtime at the call site. */
export type AgentRunner = (ctx: AgentRunContext) => Promise<{ summary: string }>;

/** A finished agent run plus the diff it produced. */
export interface Candidate {
  spec: AgentSpec;
  summary: string;
  diff: string;
  /** False when the agent threw; failed candidates are excluded from scoring. */
  ok: boolean;
  error?: string;
}

/** Picks the winning candidate. Wrap @nexus/council here to reuse its scoring. */
export type Scorer = (
  task: string,
  candidates: Candidate[],
) => Promise<{ winnerId: string; reason?: string }>;

/** Result of the pre-merge verification gate (§6.3). */
export interface MergeGateResult {
  passed: boolean;
  reason?: string;
}

/**
 * Evidence-first verification gate run on the winning candidate BEFORE its diff is
 * merged. Return `{passed:false}` to block the merge (the run is left resumable so
 * the merge can be retried once the evidence exists). Wrap tests/CI/a council
 * re-check here. When absent, a winner with a non-empty diff is allowed to merge.
 */
export type MergeGate = (winner: Candidate, candidates: Candidate[]) => Promise<MergeGateResult>;

/** Stages a run passes through; emitted to {@link Checkpointer} for durable resume. */
export type OrchestrationStage = "fanned-out" | "resumed" | "scored" | "gate-blocked" | "merged";

export interface OrchestrationCheckpoint {
  runId: string;
  stage: OrchestrationStage;
  candidates?: Candidate[];
  winnerId?: string | null;
  gate?: MergeGateResult;
}

/** Durable checkpoint sink — invoked at each stage boundary so a run can resume. */
export type Checkpointer = (cp: OrchestrationCheckpoint) => Promise<void> | void;

export interface OrchestrateOptions {
  task: string;
  agents: AgentSpec[];
  runner: AgentRunner;
  scorer: Scorer;
  worktrees: WorktreeManager;
  /** Branch/ref to fork worktrees from and merge the winner into. Default "HEAD". */
  baseRef?: string;
  /** Unique id for this orchestration run (used in branch/worktree names). */
  runId: string;
  /** Merge the winning diff into baseRef. Default true. */
  merge?: boolean;
  /** Verification gate the winner must pass before merge (§6.3). */
  mergeGate?: MergeGate;
  /** Durable checkpoint sink invoked at each stage boundary (§6.3). */
  checkpoint?: Checkpointer;
  /**
   * Resume from a checkpoint: replay these persisted candidate diffs into fresh
   * worktrees instead of re-running the agents. The runner is never called.
   */
  resumeFrom?: { candidates: Candidate[] };
  signal?: AbortSignal;
}

export interface OrchestrateResult {
  runId: string;
  winnerId: string | null;
  reason?: string;
  merged: boolean;
  candidates: Candidate[];
  /** Gate outcome when a merge was attempted; absent when merge was not requested. */
  gate?: MergeGateResult;
}

/**
 * Run the full fan-out → score → merge cycle. Always tears down every worktree,
 * even on failure, so no isolated branches/dirs leak.
 */
export async function orchestrate(opts: OrchestrateOptions): Promise<OrchestrateResult> {
  const { task, agents, runner, scorer, worktrees, runId } = opts;
  const baseRef = opts.baseRef ?? "HEAD";
  const merge = opts.merge ?? true;
  const emit = async (cp: OrchestrationCheckpoint): Promise<void> => {
    if (opts.checkpoint) await opts.checkpoint(cp);
  };

  if (agents.length === 0) throw new Error("orchestrate: at least one agent required");
  const ids = new Set(agents.map((a) => a.id));
  if (ids.size !== agents.length) throw new Error("orchestrate: agent ids must be unique");

  const created: { spec: AgentSpec; wt: Worktree }[] = [];

  try {
    let candidates: Candidate[];

    if (opts.resumeFrom) {
      // Resume path (§6.3): replay persisted diffs into fresh worktrees — the
      // agents are NOT re-run — so the winner can still be scored/gated/merged.
      candidates = opts.resumeFrom.candidates;
      for (const c of candidates) {
        if (!c.ok || !c.diff.trim()) continue;
        const wt = await worktrees.create(`${runId}-${c.spec.id}`, baseRef);
        await worktrees.applyDiff(wt, c.diff);
        created.push({ spec: c.spec, wt });
      }
      await emit({ runId, stage: "resumed", candidates });
    } else {
      // 1. Spin up one worktree per agent and run them all in parallel. allSettled
      //    so one agent's crash doesn't sink its siblings.
      for (const spec of agents) {
        const wt = await worktrees.create(`${runId}-${spec.id}`, baseRef);
        created.push({ spec, wt });
      }
      const settled = await Promise.allSettled(
        created.map(async ({ spec, wt }): Promise<Candidate> => {
          const { summary } = await runner({ task, spec, workingDir: wt.path, signal: opts.signal });
          const diff = await worktrees.diff(wt, baseRef);
          return { spec, summary, diff, ok: true };
        }),
      );
      candidates = settled.map((r, i) =>
        r.status === "fulfilled"
          ? r.value
          : {
              spec: created[i]!.spec,
              summary: "",
              diff: "",
              ok: false,
              error: r.reason instanceof Error ? r.reason.message : String(r.reason),
            },
      );
      await emit({ runId, stage: "fanned-out", candidates });
    }

    // 2. Score only the candidates that actually produced something.
    const viable = candidates.filter((c) => c.ok && c.diff.trim().length > 0);
    if (viable.length === 0) {
      return { runId, winnerId: null, merged: false, candidates };
    }

    const { winnerId, reason } = await scorer(task, viable);
    const winner = created.find((c) => c.spec.id === winnerId);
    if (!winner) {
      throw new Error(`scorer returned unknown winnerId "${winnerId}"`);
    }
    await emit({ runId, stage: "scored", candidates, winnerId });

    // 3. Evidence-first gate, then merge (losers are discarded on cleanup).
    let merged = false;
    let gate: MergeGateResult | undefined;
    if (merge) {
      const winnerCandidate = viable.find((c) => c.spec.id === winnerId)!;
      gate = opts.mergeGate
        ? await opts.mergeGate(winnerCandidate, viable)
        : { passed: winnerCandidate.diff.trim().length > 0 };
      if (gate.passed) {
        await worktrees.merge(winner.wt, baseRef);
        merged = true;
        await emit({ runId, stage: "merged", winnerId, gate });
      } else {
        // Merge blocked — leave the run resumable so it can retry once evidence exists.
        await emit({ runId, stage: "gate-blocked", candidates, winnerId, gate });
      }
    }

    return { runId, winnerId, reason, merged, candidates, gate };
  } finally {
    // 4. Always clean up every worktree, winner included (its work is already
    //    merged into baseRef by this point).
    await Promise.all(created.map(({ wt }) => worktrees.remove(wt)));
  }
}

/**
 * Adapt a council-style yes/no/confidence voter into a {@link Scorer}. Given a
 * function that scores a single candidate's diff 0–1, pick the highest. Keeps
 * @nexus/council as the call-site dependency, not a hard dep of this package.
 */
export function scoreByConfidence(
  scoreOne: (task: string, candidate: Candidate) => Promise<number>,
): Scorer {
  return async (task, candidates) => {
    const scored = await Promise.all(
      candidates.map(async (c) => ({ id: c.spec.id, score: await scoreOne(task, c) })),
    );
    scored.sort((a, b) => b.score - a.score);
    const top = scored[0]!;
    return { winnerId: top.id, reason: `highest score ${top.score.toFixed(3)}` };
  };
}
