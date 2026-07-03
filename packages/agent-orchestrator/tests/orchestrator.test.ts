// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  orchestrate,
  scoreByConfidence,
  type WorktreeManager,
  type Worktree,
  type Candidate,
} from "../src/index.js";

/** In-memory fake worktree manager — records the lifecycle, no real git. */
function fakeWorktrees() {
  const events: string[] = [];
  const diffs: Record<string, string> = {};
  const mgr: WorktreeManager & { events: string[]; diffs: Record<string, string> } = {
    events,
    diffs,
    async create(runId) {
      events.push(`create:${runId}`);
      return { path: `/tmp/${runId}`, branch: `orchestrator/${runId}` };
    },
    async diff(wt: Worktree) {
      return diffs[wt.branch] ?? "";
    },
    async applyDiff(wt: Worktree, diff: string) {
      events.push(`apply:${wt.branch}`);
      diffs[wt.branch] = diff;
    },
    async merge(wt: Worktree) {
      events.push(`merge:${wt.branch}`);
    },
    async remove(wt: Worktree) {
      events.push(`remove:${wt.branch}`);
    },
  };
  return mgr;
}

const baseOpts = (over: Partial<Parameters<typeof orchestrate>[0]> = {}) => ({
  task: "fix the bug",
  runId: "r1",
  agents: [
    { id: "a", model: "model-a" },
    { id: "b", model: "model-b" },
  ],
  runner: async () => ({ summary: "done" }),
  scorer: async () => ({ winnerId: "b", reason: "best" }),
  worktrees: fakeWorktrees(),
  ...over,
});

describe("orchestrate", () => {
  it("fans out to every agent, merges the winner, cleans up all worktrees", async () => {
    const wt = fakeWorktrees();
    wt.diffs["orchestrator/r1-a"] = "diff-a";
    wt.diffs["orchestrator/r1-b"] = "diff-b";
    const res = await orchestrate(baseOpts({ worktrees: wt }));

    expect(res.winnerId).toBe("b");
    expect(res.merged).toBe(true);
    expect(res.candidates).toHaveLength(2);
    // only the winner's branch is merged
    expect(wt.events.filter((e) => e.startsWith("merge:"))).toEqual(["merge:orchestrator/r1-b"]);
    // both worktrees torn down regardless of winner
    expect(wt.events.filter((e) => e.startsWith("remove:")).sort()).toEqual([
      "remove:orchestrator/r1-a",
      "remove:orchestrator/r1-b",
    ]);
  });

  it("isolates a crashing agent — its sibling still wins", async () => {
    const wt = fakeWorktrees();
    wt.diffs["orchestrator/r1-b"] = "diff-b";
    const res = await orchestrate(
      baseOpts({
        worktrees: wt,
        runner: async ({ spec }) => {
          if (spec.id === "a") throw new Error("boom");
          return { summary: "ok" };
        },
      }),
    );
    expect(res.winnerId).toBe("b");
    const failed = res.candidates.find((c) => c.spec.id === "a")!;
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("boom");
    // worktrees still cleaned up
    expect(wt.events.filter((e) => e.startsWith("remove:"))).toHaveLength(2);
  });

  it("returns no winner and does not merge when every diff is empty", async () => {
    const wt = fakeWorktrees(); // no diffs registered → all empty
    const res = await orchestrate(baseOpts({ worktrees: wt }));
    expect(res.winnerId).toBeNull();
    expect(res.merged).toBe(false);
    expect(wt.events.some((e) => e.startsWith("merge:"))).toBe(false);
    expect(wt.events.filter((e) => e.startsWith("remove:"))).toHaveLength(2);
  });

  it("can skip merge (dry run) but still scores a winner", async () => {
    const wt = fakeWorktrees();
    wt.diffs["orchestrator/r1-a"] = "diff-a";
    wt.diffs["orchestrator/r1-b"] = "diff-b";
    const res = await orchestrate(baseOpts({ worktrees: wt, merge: false }));
    expect(res.winnerId).toBe("b");
    expect(res.merged).toBe(false);
    expect(wt.events.some((e) => e.startsWith("merge:"))).toBe(false);
  });

  it("rejects duplicate agent ids", async () => {
    await expect(
      orchestrate(
        baseOpts({
          agents: [
            { id: "x", model: "m1" },
            { id: "x", model: "m2" },
          ],
        }),
      ),
    ).rejects.toThrow(/unique/);
  });

  it("throws when the scorer names an unknown winner", async () => {
    const wt = fakeWorktrees();
    wt.diffs["orchestrator/r1-a"] = "diff-a";
    wt.diffs["orchestrator/r1-b"] = "diff-b";
    await expect(
      orchestrate(baseOpts({ worktrees: wt, scorer: async () => ({ winnerId: "ghost" }) })),
    ).rejects.toThrow(/unknown winnerId/);
    // cleanup still ran despite the throw
    expect(wt.events.filter((e) => e.startsWith("remove:"))).toHaveLength(2);
  });
});

describe("merge gate (§6.3)", () => {
  it("blocks the merge when the gate fails, but still names a winner", async () => {
    const wt = fakeWorktrees();
    wt.diffs["orchestrator/r1-a"] = "diff-a";
    wt.diffs["orchestrator/r1-b"] = "diff-b";
    const res = await orchestrate(
      baseOpts({
        worktrees: wt,
        mergeGate: async () => ({ passed: false, reason: "tests failed" }),
      }),
    );
    expect(res.winnerId).toBe("b");
    expect(res.merged).toBe(false);
    expect(res.gate).toEqual({ passed: false, reason: "tests failed" });
    expect(wt.events.some((e) => e.startsWith("merge:"))).toBe(false);
    // worktrees still cleaned up
    expect(wt.events.filter((e) => e.startsWith("remove:"))).toHaveLength(2);
  });

  it("merges when the gate passes and reports the gate result", async () => {
    const wt = fakeWorktrees();
    wt.diffs["orchestrator/r1-a"] = "diff-a";
    wt.diffs["orchestrator/r1-b"] = "diff-b";
    const res = await orchestrate(
      baseOpts({
        worktrees: wt,
        mergeGate: async (winner) => ({ passed: winner.spec.id === "b" }),
      }),
    );
    expect(res.merged).toBe(true);
    expect(res.gate).toEqual({ passed: true });
    expect(wt.events).toContain("merge:orchestrator/r1-b");
  });
});

describe("resume from checkpoint (§6.3)", () => {
  it("replays persisted diffs without re-running the agents, then merges", async () => {
    const wt = fakeWorktrees();
    let runnerCalls = 0;
    const persisted: Candidate[] = [
      { spec: { id: "a", model: "model-a" }, summary: "prior", diff: "diff-a", ok: true },
      { spec: { id: "b", model: "model-b" }, summary: "prior", diff: "diff-b", ok: true },
    ];

    const res = await orchestrate(
      baseOpts({
        worktrees: wt,
        resumeFrom: { candidates: persisted },
        runner: async () => {
          runnerCalls++;
          return { summary: "should-not-run" };
        },
      }),
    );

    expect(runnerCalls).toBe(0); // agents were NOT re-run
    expect(res.winnerId).toBe("b");
    expect(res.merged).toBe(true);
    // each viable candidate's diff was replayed into a fresh worktree
    expect(wt.events.filter((e) => e.startsWith("apply:")).sort()).toEqual([
      "apply:orchestrator/r1-a",
      "apply:orchestrator/r1-b",
    ]);
    expect(wt.events).toContain("merge:orchestrator/r1-b");
  });

  it("emits stage checkpoints for durable resume", async () => {
    const wt = fakeWorktrees();
    wt.diffs["orchestrator/r1-a"] = "diff-a";
    wt.diffs["orchestrator/r1-b"] = "diff-b";
    const stages: string[] = [];
    await orchestrate(baseOpts({ worktrees: wt, checkpoint: (cp) => void stages.push(cp.stage) }));
    expect(stages).toEqual(["fanned-out", "scored", "merged"]);
  });
});

describe("scoreByConfidence", () => {
  it("picks the highest-scoring candidate", async () => {
    const candidates: Candidate[] = [
      { spec: { id: "a", model: "m" }, summary: "", diff: "x", ok: true },
      { spec: { id: "b", model: "m" }, summary: "", diff: "y", ok: true },
    ];
    const scorer = scoreByConfidence(async (_t, c) => (c.spec.id === "a" ? 0.9 : 0.2));
    const { winnerId } = await scorer("task", candidates);
    expect(winnerId).toBe("a");
  });
});
