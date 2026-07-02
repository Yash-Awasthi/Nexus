// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { buildAgentRunJob, parseCompressHeader } from "../../src/lib/agent-queue.js";

describe("buildAgentRunJob", () => {
  it("keys sessionId and taskId off the same id", () => {
    const job = buildAgentRunJob({ instruction: "fix the bug" }, "sess-1");
    expect(job.sessionId).toBe("sess-1");
    expect(job.taskId).toBe("sess-1");
    expect(job.instruction).toBe("fix the bug");
  });

  it("passes worktree + provider through to the worker payload", () => {
    const job = buildAgentRunJob(
      {
        instruction: "ship it",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        worktree: { repoPath: "/repo", baseBranch: "main", startRun: true },
      },
      "abc",
    );
    expect(job.provider).toBe("anthropic");
    expect(job.model).toBe("claude-sonnet-4-6");
    expect(job.worktree).toEqual({ repoPath: "/repo", baseBranch: "main", startRun: true });
  });
});

describe("parseCompressHeader", () => {
  it("maps off-ish values to false", () => {
    for (const v of ["off", "false", "0", "none", "no", "OFF", " Off "]) {
      expect(parseCompressHeader(v)).toBe(false);
    }
  });

  it("maps on-ish values to 'lossless'", () => {
    for (const v of ["lossless", "on", "true", "1", "yes", "ON"]) {
      expect(parseCompressHeader(v)).toBe("lossless");
    }
  });

  it("returns undefined for absent/empty/unknown (keep runtime default)", () => {
    expect(parseCompressHeader(undefined)).toBeUndefined();
    expect(parseCompressHeader("")).toBeUndefined();
    expect(parseCompressHeader("weird")).toBeUndefined();
  });

  it("uses the first value when given an array header", () => {
    expect(parseCompressHeader(["off", "on"])).toBe(false);
  });
});
