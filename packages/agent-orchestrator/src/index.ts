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
  signal?: AbortSignal;
}

export interface OrchestrateResult {
  runId: string;
  winnerId: string | null;
  reason?: string;
  merged: boolean;
  candidates: Candidate[];
}

/**
 * Run the full fan-out → score → merge cycle. Always tears down every worktree,
 * even on failure, so no isolated branches/dirs leak.
 */
export async function orchestrate(opts: OrchestrateOptions): Promise<OrchestrateResult> {
  const { task, agents, runner, scorer, worktrees, runId } = opts;
  const baseRef = opts.baseRef ?? "HEAD";
  const merge = opts.merge ?? true;

  if (agents.length === 0) throw new Error("orchestrate: at least one agent required");
  const ids = new Set(agents.map((a) => a.id));
  if (ids.size !== agents.length) throw new Error("orchestrate: agent ids must be unique");

  // 1. Spin up one worktree per agent and run them all in parallel. allSettled
  //    so one agent's crash doesn't sink its siblings.
  const created: Array<{ spec: AgentSpec; wt: Worktree }> = [];
  for (const spec of agents) {
    const wt = await worktrees.create(`${runId}-${spec.id}`, baseRef);
    created.push({ spec, wt });
  }

  try {
    const settled = await Promise.allSettled(
      created.map(async ({ spec, wt }): Promise<Candidate> => {
        const { summary } = await runner({
          task,
          spec,
          workingDir: wt.path,
          signal: opts.signal,
        });
        const diff = await worktrees.diff(wt, baseRef);
        return { spec, summary, diff, ok: true };
      }),
    );

    const candidates: Candidate[] = settled.map((r, i) =>
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

    // 2. Score only the agents that actually produced something.
    const viable = candidates.filter((c) => c.ok && c.diff.trim().length > 0);
    if (viable.length === 0) {
      return { runId, winnerId: null, merged: false, candidates };
    }

    const { winnerId, reason } = await scorer(task, viable);
    const winner = created.find((c) => c.spec.id === winnerId);
    if (!winner) {
      throw new Error(`scorer returned unknown winnerId "${winnerId}"`);
    }

    // 3. Merge the winner into the base branch (losers are discarded on cleanup).
    let merged = false;
    if (merge) {
      await worktrees.merge(winner.wt, baseRef);
      merged = true;
    }

    return { runId, winnerId, reason, merged, candidates };
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
