// SPDX-License-Identifier: Apache-2.0
import type { LlmToolFn, RuntimeMessage } from "@nexus/agent-runtime";
import { describe, expect, it, vi } from "vitest";

import {
  buildReviewInput,
  parseLearnings,
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
