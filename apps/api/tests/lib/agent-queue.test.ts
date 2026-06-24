// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { buildAgentRunJob } from "../../src/lib/agent-queue.js";

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
