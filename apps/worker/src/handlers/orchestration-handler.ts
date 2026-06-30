// SPDX-License-Identifier: Apache-2.0
/**
 * Orchestration job — multi-agent orchestration. Fans a single coding task out across N
 * agents (distinct models) running in parallel, each in its own isolated git
 * worktree, then scores the candidate diffs with the council and (optionally)
 * merges the winner.
 *
 * Reuse, not reinvention:
 *   - runner  → handleAgentRunJob   (existing coding-agent loop, confined to the worktree dir)
 *   - scorer  → handleCouncilJob    (existing multi-model vote; consensus = score)
 *   - worktrees → GitWorktreeManager (@nexus/agent-orchestrator)
 */
import {
  orchestrate,
  scoreByConfidence,
  GitWorktreeManager,
  type AgentSpec,
  type Candidate,
} from "@nexus/agent-orchestrator";

import { handleAgentRunJob } from "./agent-handler.js";
import { handleCouncilJob } from "./council-handler.js";

export interface OrchestrationModel {
  /** Unique candidate id (defaults to provider/model). */
  id?: string;
  provider?: string;
  model?: string;
}

export interface OrchestrationJobPayload {
  taskId?: string;
  /** The instruction every agent works on. */
  task: string;
  /** The agents to race (>=1). Each is usually a different model. */
  models: OrchestrationModel[];
  /** Git checkout to fan worktrees out from + merge the winner into. */
  repoPath: string;
  /** Ref to fork from / merge into. Default "HEAD". */
  baseRef?: string;
  /**
   * Merge the winning diff into baseRef. Default FALSE — auto-merging unreviewed
   * agent output is a footgun in prod, so it is strictly opt-in. When false the
   * winner is still chosen and its diff returned for human review.
   */
  merge?: boolean;
  systemPrompt?: string;
  maxSteps?: number;
}

interface CouncilResultShape {
  ok?: boolean;
  result?: { outcome?: string; consensus?: number; dissent?: number };
}

export async function handleOrchestrationJob(payload: OrchestrationJobPayload): Promise<unknown> {
  if (!payload.task?.trim()) throw new Error("orchestration: task is required");
  if (!payload.repoPath) throw new Error("orchestration: repoPath is required");
  if (!payload.models?.length) throw new Error("orchestration: at least one model is required");

  const runId = payload.taskId ?? `orc-${Date.now()}`;
  const agents: AgentSpec[] = payload.models.map((m, i) => ({
    id: m.id ?? `${m.provider ?? "default"}/${m.model ?? "default"}#${i}`,
    model: m.model ?? "",
  }));

  // Map each agent spec back to its provider/model for the runner.
  const specMeta = new Map(agents.map((a, i) => [a.id, payload.models[i]!]));

  const result = await orchestrate({
    runId,
    task: payload.task,
    agents,
    baseRef: payload.baseRef ?? "HEAD",
    merge: payload.merge ?? false,
    worktrees: new GitWorktreeManager(payload.repoPath),

    // Run the real coding-agent loop, confined to the agent's worktree dir.
    runner: async ({ task, spec, workingDir, signal }) => {
      const meta = specMeta.get(spec.id);
      const res = (await handleAgentRunJob({
        instruction: task,
        provider: meta?.provider,
        model: meta?.model,
        systemPrompt: payload.systemPrompt,
        maxSteps: payload.maxSteps,
        workspaceDir: workingDir,
      })) as { content?: string; summary?: string };
      void signal;
      return { summary: res.summary ?? res.content ?? "" };
    },

    // Score each candidate's diff with the council; consensus → 0..1 score.
    scorer: scoreByConfidence(async (task: string, candidate: Candidate) => {
      const verdict = (await handleCouncilJob({
        proposal: {
          title: `Candidate ${candidate.spec.id}`,
          description:
            `Task: ${task}\n\nThe following diff was produced by ${candidate.spec.model}. ` +
            `Does it correctly and cleanly solve the task?\n\n` +
            candidate.diff.slice(0, 12_000),
        },
      })) as CouncilResultShape;
      const r = verdict.result;
      if (!r) return 0;
      // approved → reward by consensus; otherwise penalise by dissent.
      return r.outcome === "approved" ? (r.consensus ?? 0.5) : Math.max(0, 0.5 - (r.dissent ?? 0.5));
    }),
  });

  return result;
}
