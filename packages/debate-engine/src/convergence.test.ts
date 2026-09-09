// SPDX-License-Identifier: Apache-2.0
/**
 * Convergence detection + early stopping for multi-agent debate — the
 * the-ai-counsel remainder (iterative rounds where models refine from peer
 * critiques until positions stop moving). Scripted transports drive the loop
 * deterministically: each agent reads its answer from a per-agent script
 * indexed by round.
 */
import { describe, expect, it } from "vitest";
import {
  answersAgree,
  lexicalSimilarity,
  positionalStability,
  runMultiAgentDebate,
  type AgentMessage,
  type MultiAgentDebateResult,
} from "./multiagent-debate.js";

/** Transport that plays back per-agent scripts indexed by round number. */
function scriptedTransport(scripts: Record<string, readonly string[]>) {
  const calls: { agent: string; round: number }[] = [];
  return {
    transport: async (req: {
      agent: string;
      round: number;
      messages: readonly AgentMessage[];
    }): Promise<string> => {
      calls.push({ agent: req.agent, round: req.round });
      const script = scripts[req.agent]!;
      return script[Math.min(req.round, script.length - 1)]!;
    },
    calls,
  };
}

const BASE = {
  question: "Should the migration run at midnight?",
  agents: ["A", "B"] as const,
};

function countRounds(res: MultiAgentDebateResult): number {
  return res.transcripts[0]!.history.filter((m) => m.role === "assistant").length;
}

describe("lexicalSimilarity", () => {
  it("scores identical repeats 1 and disjoint word sets 0", () => {
    expect(lexicalSimilarity("the answer is 42", "the answer is 42")).toBe(1);
    expect(lexicalSimilarity("migrate now", "keep the old system")).toBe(0);
    expect(lexicalSimilarity("42", "42")).toBe(1);
  });
});

describe("positionalStability + answersAgree", () => {
  it("positional stability requires each agent to stop changing", () => {
    expect(positionalStability(["a", "b"], ["a", "b"])).toBe(true);
    expect(positionalStability(["a", "b"], ["a", "c"])).toBe(false);
    expect(positionalStability(["a"], ["a", "b"])).toBe(false);
  });

  it("answersAgree detects consensus across a round", () => {
    expect(answersAgree(["deploy tonight", "deploy tonight"])).toBe(true);
    expect(answersAgree(["deploy tonight", "defer a week"])).toBe(false);
  });
});

describe("runMultiAgentDebate convergence", () => {
  it("keeps legacy fixed-round behaviour when convergence is absent", async () => {
    const { transport } = scriptedTransport({ A: ["a0", "a1", "a2"], B: ["b0", "b1", "b2"] });
    const res = await runMultiAgentDebate({ ...BASE, rounds: 3, transport });
    expect(res.converged).toBe(false);
    expect(res.roundsRun).toBe(3);
    expect(countRounds(res)).toBe(3); // each agent answered exactly 3 times
  });

  it("stops early once every agent's position stabilises", async () => {
    // r0 independent answers; r1 revises; r2 repeats r1 → stable → stop.
    const { transport, calls } = scriptedTransport({
      A: ["a0", "the answer", "the answer"],
      B: ["b0", "the answer", "the answer"],
    });
    const res = await runMultiAgentDebate({
      ...BASE,
      rounds: 6,
      convergence: true,
      transport,
    });
    expect(res.converged).toBe(true);
    expect(res.roundsRun).toBe(3);
    expect(calls.filter((c) => c.round < 3).length).toBe(calls.length); // never called round 3
    expect(res.finalAnswers.every((f) => f.answer === "the answer")).toBe(true);
  });

  it("respects patience: one stable round is not enough, two consecutive are", async () => {
    // wobbles at r1/r3 keep resetting the streak; two consecutive stable rounds end it.
    const { transport } = scriptedTransport({
      A: ["w", "x", "x", "y", "z", "z", "z"],
      B: ["w", "x", "x", "y", "z", "z", "z"],
    });
    const res = await runMultiAgentDebate({
      ...BASE,
      rounds: 8,
      convergence: { patience: 2 },
      transport,
    });
    expect(res.converged).toBe(true);
    expect(res.roundsRun).toBe(7); // r0..r6 — stopped at the second stable round
  });

  it("never converges under the budget when answers keep changing", async () => {
    const { transport } = scriptedTransport({
      A: ["a0", "a1", "a2", "a3"],
      B: ["b0", "b1", "b2", "b3"],
    });
    const res = await runMultiAgentDebate({
      ...BASE,
      rounds: 4,
      convergence: true,
      transport,
    });
    expect(res.converged).toBe(false);
    expect(res.roundsRun).toBe(4);
  });

  it("supports an injected consensus detector that stops on agreement", async () => {
    // Both agents converge on the same wording from the first revision round.
    const { transport } = scriptedTransport({
      A: ["split decision", "deploy at 02:00", "deploy at 02:00"],
      B: ["hold off", "deploy at 02:00", "deploy at 02:00"],
    });
    const res = await runMultiAgentDebate({
      ...BASE,
      rounds: 6,
      convergence: {
        detector: (_prev, curr) => answersAgree(curr, 0.6),
      },
      transport,
    });
    expect(res.converged).toBe(true);
    expect(res.roundsRun).toBe(2); // consensus reached on the first refinement
  });

  it("reports a stable-but-never-consensus run correctly with a positional detector", async () => {
    // Both agents lock their (different) positions early → positional stop.
    const { transport } = scriptedTransport({
      A: ["a0", "alpha lane", "alpha lane"],
      B: ["b0", "beta lane", "beta lane"],
    });
    const res = await runMultiAgentDebate({
      ...BASE,
      rounds: 6,
      convergence: true,
      transport,
    });
    expect(res.converged).toBe(true);
    expect(res.finalAnswers.map((f) => f.answer)).toEqual(["alpha lane", "beta lane"]);
  });
});
