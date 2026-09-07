// SPDX-License-Identifier: Apache-2.0
/**
 * Mission-memory tests — distilling a prior run's record + graph into the
 * bounded prompt block that a continuation mission starts from.
 *
 * Covers: verdict/issues/excerpt/tool-trace distillation, bounded length,
 * tool-trace failure marking, and the loader's ownership/terminal gates.
 */

import { describe, it, expect } from "vitest";
import type { MissionRecord } from "@nexus/agent-engine";

import {
  distillMissionMemory,
  filterReviewIssues,
  isReviewNoise,
  loadMissionMemory,
  outcomeSummary,
  summarizeSkillExecutions,
  summarizeToolTrace,
} from "../../src/lib/mission-memory.js";
import type { SessionGraph } from "../../src/lib/session-graph.js";

const REJECTED: MissionRecord = {
  id: "mission-abc123",
  goal: "Write the word done to a file named memory-proof.txt and confirm it exists.",
  status: "completed",
  accepted: false,
  maxIterationsReached: true,
  iteration: 1,
  maxIterations: 3,
  acceptScore: 70,
  phases: [
    { phase: "started", iteration: 0, timestamp: "2026-09-07T00:00:00Z" },
    { phase: "acting", iteration: 0, note: "steps: 2", timestamp: "2026-09-07T00:00:01Z" },
    {
      phase: "reviewing",
      iteration: 0,
      note: "score 0/100 \u2014 reject",
      timestamp: "2026-09-07T00:00:02Z",
    },
  ],
  actingSteps: 2,
  spawnCount: 0,
  lastReview: {
    score: 0,
    verdict: "reject",
    issues: ["The file was not actually written.", "The claimed output does not exist."],
    suggestions: ["Run the code and verify the file on disk."],
  },
  finalContent: "I wrote the file memory-proof.txt with the word done. Output was verified.",
  usage: { inputTokens: 500, outputTokens: 120, totalTokens: 620 },
  createdAt: "2026-09-07T00:00:00Z",
  updatedAt: "2026-09-07T00:00:03Z",
};

const GRAPH: SessionGraph = {
  sessionId: "mission-abc123",
  userId: "u1",
  kind: "mission",
  title: "mission-abc123",
  nodes: [
    { id: "n:phase:0:started", kind: "phase", label: "started", ts: "2026-09-07T00:00:00Z" },
    { id: "n:tool:1", kind: "tool", label: "write_file", detail: '{"path":"memory-proof.txt"}', ts: "2026-09-07T00:00:01Z" },
    { id: "n:tool:1:out", kind: "error", label: "write_file result", detail: "error: EACCES permission denied", ts: "2026-09-07T00:00:01Z" },
    { id: "n:tool:2", kind: "tool", label: "read_file", detail: '{"path":"memory-proof.txt"}', ts: "2026-09-07T00:00:02Z" },
    { id: "n:tool:2:out", kind: "report", label: "read_file result", detail: "ok (4ms): [not found]", ts: "2026-09-07T00:00:02Z" },
  ],
  edges: [],
  createdAt: "2026-09-07T00:00:00Z",
  updatedAt: "2026-09-07T00:00:02Z",
};

describe("isReviewNoise / filterReviewIssues", () => {
  it("flags the reviewer parse-failure artifact as harness noise", () => {
    expect(isReviewNoise("reviewer returned unparseable output: That looks great!")).toBe(true);
    expect(isReviewNoise("The file was not actually written.")).toBe(false);
  });

  it("drops parse-failure artifacts while keeping genuine issues", () => {
    expect(
      filterReviewIssues([
        "reviewer returned unparseable output: Here is the script…",
        "The claimed output does not exist.",
      ]),
    ).toEqual(["The claimed output does not exist."]);
    expect(filterReviewIssues(undefined)).toEqual([]);
  });
});

describe("outcomeSummary", () => {
  it("summarizes a rejected run with the review verdict", () => {
    expect(outcomeSummary(REJECTED)).toContain("REJECTED");
    expect(outcomeSummary(REJECTED)).toContain("0/100");
  });

  it("handles failed and aborted runs", () => {
    expect(outcomeSummary({ ...REJECTED, status: "failed", error: "boom" })).toContain("FAILED");
    expect(outcomeSummary({ ...REJECTED, status: "aborted" })).toContain("ABORTED");
  });

  it("never reads an unparsed review as a reject 0/100", () => {
    const unparsed = {
      ...REJECTED,
      lastReview: {
        score: 0,
        verdict: "unknown" as const,
        issues: [],
        suggestions: [],
        unparsed: true,
      },
    };
    expect(outcomeSummary(unparsed)).toContain("UNKNOWN");
    expect(outcomeSummary(unparsed)).not.toContain("REJECTED");
    expect(outcomeSummary(unparsed)).not.toContain("0/100");
  });
});

const SKILL_GRAPH: SessionGraph = {
  sessionId: "mission-abc123",
  userId: "u1",
  kind: "mission",
  title: "mission-abc123",
  nodes: [
    { id: "n:phase:0:started", kind: "phase", label: "started", ts: "2026-09-07T00:00:00Z" },
    { id: "n:tool:1", kind: "tool", label: "write_file", detail: '{"path":"memory-proof.txt"}', ts: "2026-09-07T00:00:01Z" },
    { id: "n:tool:1:out", kind: "error", label: "write_file result", detail: "error: EACCES permission denied", ts: "2026-09-07T00:00:01Z" },
    // Runtime-emitted skill executions (mission-graph.ts recordSkillExecution):
    // each attempt = started node + terminal node (completed/failed).
    { id: "n:skill:1:start", kind: "skill", label: "report-writer", detail: "[skill-1] python · 30000ms budget", status: "started", ts: "2026-09-07T00:00:02Z" },
    { id: "n:skill:1", kind: "skill", label: "report-writer result", detail: "[skill-1] completed in 1200ms (exit 0)", status: "completed", ts: "2026-09-07T00:00:02Z" },
    { id: "n:skill:2:start", kind: "skill", label: "scraper", detail: "[skill-2] bash · 30000ms budget", status: "started", ts: "2026-09-07T00:00:03Z" },
    { id: "n:skill:2", kind: "skill", label: "scraper result", detail: "[skill-2] failed (exit 2) — Traceback: boom", status: "failed", ts: "2026-09-07T00:00:03Z" },
  ],
  edges: [],
  createdAt: "2026-09-07T00:00:00Z",
  updatedAt: "2026-09-07T00:00:03Z",
};

describe("summarizeSkillExecutions", () => {
  it("includes completed and failed skill executions with their outcomes", () => {
    const s = summarizeSkillExecutions(SKILL_GRAPH);
    expect(s).toContain("report-writer ok — completed in 1200ms (exit 0)");
    expect(s).toContain("scraper FAILED — failed (exit 2) — Traceback: boom");
    // started nodes alone never appear as executions
    expect(s).not.toContain("budget");
  });

  it("returns empty when no skill execution has a terminal status", () => {
    const startedOnly: SessionGraph = {
      ...SKILL_GRAPH,
      nodes: SKILL_GRAPH.nodes.filter((n) => n.kind !== "skill" || n.status === "started"),
    };
    expect(summarizeSkillExecutions(startedOnly)).toBe("");
  });

  it("returns empty for a graph without skill nodes", () => {
    expect(summarizeSkillExecutions(GRAPH)).toBe("");
  });

  it("keeps the newest 4 executions when more ran", () => {
    const many: SessionGraph = {
      ...SKILL_GRAPH,
      nodes: [
        ...SKILL_GRAPH.nodes.slice(0, 3), // phase + tool nodes
        ...Array.from({ length: 5 }, (_, i) => [
          { id: `n:s${i + 1}:start`, kind: "skill" as const, label: `skill-${i + 1}`, detail: `[s${i + 1}] started`, status: "started" as const, ts: "2026-09-07T00:00:10Z" },
          { id: `n:s${i + 1}`, kind: "skill" as const, label: `skill-${i + 1} result`, detail: `[s${i + 1}] completed in ${i + 1}ms (exit 0)`, status: "completed" as const, ts: "2026-09-07T00:00:10Z" },
        ]).flat(),
      ],
    };
    const s = summarizeSkillExecutions(many);
    expect(s.split(" | ")).toHaveLength(4);
    expect(s).toContain("skill-5 ok");
    expect(s).toContain("skill-4 ok");
    expect(s).not.toContain("skill-1 ok");
  });
});

describe("summarizeToolTrace", () => {
  it("marks failed calls and keeps ok calls with outcomes", () => {
    const trace = summarizeToolTrace(GRAPH);
    expect(trace).toContain("write_file FAILED");
    expect(trace).toContain("read_file ok");
    expect(trace).toContain("EACCES");
  });

  it("returns empty for a graph without tool nodes", () => {
    expect(summarizeToolTrace({ ...GRAPH, nodes: GRAPH.nodes.slice(0, 1) })).toBe("");
  });
});

describe("distillMissionMemory", () => {
  it("distills an ACTIONABLE directive: verdict, fixes, verify-list, resume point", () => {
    const memory = distillMissionMemory(REJECTED, GRAPH);
    expect(memory.missionId).toBe("mission-abc123");
    expect(memory.summary).toContain("REJECTED");
    expect(memory.text).toContain("REJECTED — review reject 0/100");
    // Imperative shape — fix X, verify Y, resume from Z — not a passive summary.
    expect(memory.text).toContain("REVIEW REJECTED THIS. FIX THESE, then verify:");
    expect(memory.text).toContain("The file was not actually written.");
    expect(memory.text).toContain("Tool trace (resume/verify from these outcomes):");
    expect(memory.text).toContain("write_file FAILED");
    expect(memory.text).toContain("Resume from where the previous output ended:");
    expect(memory.text).toContain("memory-proof.txt");
    expect(memory.text).toContain("Act on the prior run now");
  });

  it("never presents the reviewer's parse-failure prose as a defect to fix", () => {
    const noiseRecord: MissionRecord = {
      ...REJECTED,
      lastReview: {
        score: 0,
        verdict: "reject",
        issues: [
          "reviewer returned unparseable output: That looks great! Here is the final, concise 3-line Python script",
        ],
        suggestions: [],
      },
    };
    const memory = distillMissionMemory(noiseRecord, GRAPH);
    expect(memory.text).not.toContain("unparseable");
    expect(memory.text).not.toContain("REVIEW REJECTED THIS");
    // The tool trace still carries the honest "what failed" signal.
    expect(memory.text).toContain("write_file FAILED");
  });

  it("is bounded", () => {
    const long = {
      ...REJECTED,
      finalContent: "x".repeat(5000),
      lastReview: {
        ...REJECTED.lastReview!,
        issues: ["i".repeat(5000), "j".repeat(5000)],
        suggestions: ["s".repeat(5000)],
      },
    };
    expect(distillMissionMemory(long, GRAPH).text.length).toBeLessThanOrEqual(1700);
  });

  it("omits the review section when there are no genuine issues", () => {
    const memory = distillMissionMemory({ ...REJECTED, lastReview: undefined }, GRAPH);
    expect(memory.text).not.toContain("REVIEW REJECTED THIS");
  });

  it("distills skill executions into the directive alongside the tool trace", () => {
    const memory = distillMissionMemory(REJECTED, SKILL_GRAPH);
    expect(memory.text).toContain(
      "Skill executions (resume/verify from these outcomes): report-writer ok — completed in 1200ms (exit 0) | scraper FAILED — failed (exit 2) — Traceback: boom",
    );
    // Tool/phase capture untouched: the tool trace still reads as before.
    expect(memory.text).toContain("Tool trace (resume/verify from these outcomes):");
    expect(memory.text).toContain("write_file FAILED");
  });

  it("adds no skill section when the graph has no skill executions", () => {
    const memory = distillMissionMemory(REJECTED, GRAPH);
    expect(memory.text).not.toContain("Skill executions");
  });
});

describe("loadMissionMemory", () => {
  it("returns null for unknown missions (per-user isolation)", async () => {
    const memory = await loadMissionMemory("u1", "mission-nope", {
      getRecord: async () => undefined,
      getGraph: async () => undefined,
    });
    expect(memory).toBeNull();
  });

  it("returns null while the mission is still running", async () => {
    const memory = await loadMissionMemory("u1", "mission-abc123", {
      getRecord: async () => ({ ...REJECTED, status: "running" }),
      getGraph: async () => undefined,
    });
    expect(memory).toBeNull();
  });

  it("loads + distills a terminal mission through the injection seams", async () => {
    const memory = await loadMissionMemory("u1", "mission-abc123", {
      getRecord: async () => REJECTED,
      getGraph: async () => GRAPH,
    });
    expect(memory?.text).toContain("REJECTED");
    expect(memory?.text).toContain("write_file FAILED");
  });

  it("continued-mission memory mentions a skill execution at the seam", async () => {
    const memory = await loadMissionMemory("u1", "mission-abc123", {
      getRecord: async () => REJECTED,
      getGraph: async () => SKILL_GRAPH,
    });
    expect(memory?.text).toContain("Skill executions (resume/verify from these outcomes):");
    expect(memory?.text).toContain("report-writer ok — completed in 1200ms (exit 0)");
    expect(memory?.text).toContain("scraper FAILED");
  });
});