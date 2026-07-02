// SPDX-License-Identifier: Apache-2.0
import type { LlmToolFn, RuntimeMessage } from "@nexus/agent-runtime";
import { describe, expect, it, vi } from "vitest";

import {
  appendUnifiedDiff,
  buildReviewInput,
  learningToBullet,
  parseLearnings,
  proposeLearningUpdates,
  reviewSession,
} from "../../src/handlers/agent-review.js";

describe("parseLearnings", () => {
  it("parses a JSON array of learnings, embedded in prose", () => {
    const out = parseLearnings(
      'Here are the learnings: [{"type":"gotcha","content":"vitest globs are root-relative"},' +
        '{"type":"pattern","content":"reuse runScriptBounded"}] done',
    );
    expect(out).toEqual([
      { type: "gotcha", content: "vitest globs are root-relative" },
      { type: "pattern", content: "reuse runScriptBounded" },
    ]);
  });

  it("defaults an unknown type to memory and drops empty content", () => {
    const out = parseLearnings('[{"type":"weird","content":"x"},{"type":"skill","content":"  "}]');
    expect(out).toEqual([{ type: "memory", content: "x" }]);
  });

  it("returns [] for no array / invalid JSON", () => {
    expect(parseLearnings("nothing here")).toEqual([]);
    expect(parseLearnings("[not json]")).toEqual([]);
    expect(parseLearnings('{"not":"array"}')).toEqual([]);
  });
});

describe("buildReviewInput", () => {
  it("flattens roles and bounds length", () => {
    const msgs: RuntimeMessage[] = [
      { role: "user", content: "do x" },
      { role: "assistant", content: "done" },
    ];
    expect(buildReviewInput(msgs)).toBe("[user] do x\n[assistant] done");
    expect(buildReviewInput([{ role: "user", content: "a".repeat(100) }], 10)).toHaveLength(10);
  });
});

describe("reviewSession", () => {
  it("returns [] without calling the model on an empty transcript", async () => {
    const llm = vi.fn();
    expect(await reviewSession([], llm as unknown as LlmToolFn)).toEqual([]);
    expect(llm).not.toHaveBeenCalled();
  });

  it("runs one tool-less review turn and parses the learnings", async () => {
    const llm = vi.fn().mockResolvedValue({
      content: '[{"type":"pattern","content":"worktrees key off origin/<base>"}]',
      toolCalls: [],
    });
    const out = await reviewSession(
      [{ role: "user", content: "build worktrees" }],
      llm as unknown as LlmToolFn,
    );
    expect(out).toEqual([{ type: "pattern", content: "worktrees key off origin/<base>" }]);
    // System prompt set, no tools advertised.
    const call = llm.mock.calls[0];
    expect(call?.[1]?.systemPrompt).toContain("DURABLE learnings");
    expect(call?.[1]?.tools).toBeUndefined();
  });
});

describe("appendUnifiedDiff", () => {
  it("appends to a non-empty file keeping the last line as context", () => {
    const diff = appendUnifiedDiff("MEMORY.md", "- one\n- two\n", ["- three"]);
    expect(diff).toBe(
      "--- a/MEMORY.md\n+++ b/MEMORY.md\n@@ -2,1 +2,2 @@\n - two\n+- three\n",
    );
  });

  it("emits a new-file hunk (no context line) for empty content", () => {
    const diff = appendUnifiedDiff("MEMORY.md", "", ["- a", "- b"]);
    expect(diff).toBe("--- a/MEMORY.md\n+++ b/MEMORY.md\n@@ -0,0 +1,2 @@\n+- a\n+- b\n");
  });

  it("returns '' when there is nothing to add", () => {
    expect(appendUnifiedDiff("MEMORY.md", "x", [])).toBe("");
  });
});

describe("proposeLearningUpdates", () => {
  it("routes memory/pattern/gotcha to MEMORY.md and skill to SKILLS.md, never applied", () => {
    const proposals = proposeLearningUpdates(
      [
        { type: "gotcha", content: "vitest globs are root-relative" },
        { type: "skill", content: "use runScriptBounded" },
        { type: "pattern", content: "worktrees key off origin/<base>" },
      ],
      { memory: "- (memory) old fact\n", skills: "" },
    );
    const byPath = Object.fromEntries(proposals.map((p) => [p.path, p]));
    expect(Object.keys(byPath).sort()).toEqual(["MEMORY.md", "SKILLS.md"]);
    expect(byPath["MEMORY.md"].additions).toEqual([
      "- (gotcha) vitest globs are root-relative",
      "- (pattern) worktrees key off origin/<base>",
    ]);
    expect(byPath["SKILLS.md"].additions).toEqual(["- (skill) use runScriptBounded"]);
    expect(proposals.every((p) => p.applied === false)).toBe(true);
    expect(byPath["MEMORY.md"].diff).toContain("+- (gotcha) vitest globs are root-relative");
  });

  it("skips learnings already present in the target file (idempotent) and empty targets", () => {
    const proposals = proposeLearningUpdates(
      [
        { type: "memory", content: "already known" },
        { type: "memory", content: "already known" },
      ],
      { memory: "- (memory) already known\n" },
    );
    expect(proposals).toEqual([]);
  });

  it("formats a bullet with its type tag", () => {
    expect(learningToBullet({ type: "gotcha", content: "x" })).toBe("- (gotcha) x");
  });
});
