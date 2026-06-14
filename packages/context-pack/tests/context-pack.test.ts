// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  assembleContextPack,
  nullFetchers,
  estimateTokens,
  type ContextFetchers,
  type RecentTask,
  type ActiveSignal,
  type MemoryFact,
} from "../src/index.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<RecentTask> = {}): RecentTask {
  return {
    id: "t-1",
    type: "email.send",
    status: "completed",
    priority: "medium",
    createdAt: "2026-06-13T10:00:00.000Z",
    ...overrides,
  };
}

function makeSignal(overrides: Partial<ActiveSignal> = {}): ActiveSignal {
  return {
    id: "s-1",
    signalType: "anomaly.detected",
    summary: "Unusual login from IP 1.2.3.4",
    priority: "high",
    createdAt: "2026-06-13T09:55:00.000Z",
    ...overrides,
  };
}

function makeMemory(overrides: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id: "m-1",
    text: "The user prefers concise responses.",
    score: 0.95,
    createdAt: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function makeFetchers(overrides: Partial<{
  tasks: RecentTask[];
  signals: ActiveSignal[];
  memories: MemoryFact[];
}> = {}): ContextFetchers {
  return {
    fetchRecentTasks: vi.fn().mockResolvedValue(overrides.tasks ?? [makeTask()]),
    fetchActiveSignals: vi.fn().mockResolvedValue(overrides.signals ?? [makeSignal()]),
    fetchMemories: vi.fn().mockResolvedValue(overrides.memories ?? [makeMemory()]),
  };
}

// ── assembleContextPack — structure ──────────────────────────────────────────

describe("assembleContextPack — basic structure", () => {
  it("returns a ContextPack with all required fields", async () => {
    const pack = await assembleContextPack(nullFetchers);
    expect(pack).toHaveProperty("systemPrompt");
    expect(pack).toHaveProperty("sections");
    expect(pack).toHaveProperty("totalTokenEstimate");
    expect(pack).toHaveProperty("assembledAt");
    expect(pack).toHaveProperty("wasTrimmed");
  });

  it("systemPrompt is a non-empty string", async () => {
    const pack = await assembleContextPack(nullFetchers);
    expect(typeof pack.systemPrompt).toBe("string");
    expect(pack.systemPrompt.length).toBeGreaterThan(0);
  });

  it("assembledAt is an ISO 8601 string", async () => {
    const pack = await assembleContextPack(nullFetchers);
    expect(() => new Date(pack.assembledAt)).not.toThrow();
    expect(pack.assembledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("sections array has at least the preamble section", async () => {
    const pack = await assembleContextPack(nullFetchers);
    expect(pack.sections.length).toBeGreaterThanOrEqual(1);
    expect(pack.sections[0]?.name).toBe("Preamble");
  });

  it("totalTokenEstimate equals sum of section token estimates", async () => {
    const pack = await assembleContextPack(nullFetchers);
    const sum = pack.sections.reduce((s, sec) => s + sec.tokenEstimate, 0);
    expect(pack.totalTokenEstimate).toBe(sum);
  });

  it("systemPrompt contains content from all sections joined by ---", async () => {
    const pack = await assembleContextPack(makeFetchers());
    for (const section of pack.sections) {
      expect(pack.systemPrompt).toContain(section.content);
    }
    expect(pack.systemPrompt).toContain("---");
  });
});

// ── Preamble section ──────────────────────────────────────────────────────────

describe("assembleContextPack — preamble", () => {
  it("includes default role text when agentRole not provided", async () => {
    const pack = await assembleContextPack(nullFetchers);
    expect(pack.systemPrompt).toContain("Nexus");
    expect(pack.systemPrompt).toContain("multi-agent");
  });

  it("uses custom agentRole when provided", async () => {
    const pack = await assembleContextPack(nullFetchers, {
      agentRole: "You are a specialized security auditor.",
    });
    expect(pack.systemPrompt).toContain("security auditor");
    expect(pack.systemPrompt).not.toContain("multi-agent orchestration");
  });

  it("preamble section is never trimmed in a normal budget", async () => {
    const pack = await assembleContextPack(nullFetchers);
    expect(pack.sections[0]?.trimmed).toBe(false);
  });
});

// ── Signals section ───────────────────────────────────────────────────────────

describe("assembleContextPack — signals", () => {
  it("includes signal type and summary in system prompt", async () => {
    const fetchers = makeFetchers({
      signals: [makeSignal({ signalType: "auth.brute_force", summary: "Too many failed logins" })],
    });
    const pack = await assembleContextPack(fetchers);
    expect(pack.systemPrompt).toContain("auth.brute_force");
    expect(pack.systemPrompt).toContain("Too many failed logins");
  });

  it("renders priority emoji for critical signals", async () => {
    const fetchers = makeFetchers({
      signals: [makeSignal({ priority: "critical" })],
    });
    const pack = await assembleContextPack(fetchers);
    expect(pack.systemPrompt).toContain("🔴");
  });

  it("renders 'No active signals' when signals array is empty", async () => {
    const fetchers = makeFetchers({ signals: [] });
    const pack = await assembleContextPack(fetchers);
    expect(pack.systemPrompt).toContain("No active signals");
  });

  it("requests only maxSignals from the fetcher", async () => {
    const fetchers = makeFetchers();
    await assembleContextPack(fetchers, { maxSignals: 3 });
    expect(fetchers.fetchActiveSignals).toHaveBeenCalledWith(3);
  });
});

// ── Tasks section ─────────────────────────────────────────────────────────────

describe("assembleContextPack — tasks", () => {
  it("includes task type and status in system prompt", async () => {
    const fetchers = makeFetchers({
      tasks: [makeTask({ type: "code.review", status: "running" })],
    });
    const pack = await assembleContextPack(fetchers);
    expect(pack.systemPrompt).toContain("code.review");
    expect(pack.systemPrompt).toContain("running");
  });

  it("renders ✓ for completed tasks", async () => {
    const fetchers = makeFetchers({
      tasks: [makeTask({ status: "completed" })],
    });
    const pack = await assembleContextPack(fetchers);
    expect(pack.systemPrompt).toContain("✓");
  });

  it("renders ✗ for failed tasks", async () => {
    const fetchers = makeFetchers({
      tasks: [makeTask({ status: "failed", error: "OOM error" })],
    });
    const pack = await assembleContextPack(fetchers);
    expect(pack.systemPrompt).toContain("✗");
    expect(pack.systemPrompt).toContain("OOM error");
  });

  it("renders 'No recent tasks' when tasks array is empty", async () => {
    const fetchers = makeFetchers({ tasks: [] });
    const pack = await assembleContextPack(fetchers);
    expect(pack.systemPrompt).toContain("No recent tasks");
  });

  it("requests only maxTasks from the fetcher", async () => {
    const fetchers = makeFetchers();
    await assembleContextPack(fetchers, { maxTasks: 5 });
    expect(fetchers.fetchRecentTasks).toHaveBeenCalledWith(5);
  });

  it("truncates error text to 120 chars", async () => {
    const longError = "E".repeat(200);
    const fetchers = makeFetchers({
      tasks: [makeTask({ status: "failed", error: longError })],
    });
    const pack = await assembleContextPack(fetchers);
    // The rendered error should not contain 200 'E' characters
    const errorLine = pack.systemPrompt.match(/Error: (E+)/)?.[1] ?? "";
    expect(errorLine.length).toBeLessThanOrEqual(120);
  });
});

// ── Memories section ──────────────────────────────────────────────────────────

describe("assembleContextPack — memories", () => {
  it("includes memory text in system prompt", async () => {
    const fetchers = makeFetchers({
      memories: [makeMemory({ text: "User timezone is Asia/Kolkata." })],
    });
    const pack = await assembleContextPack(fetchers);
    expect(pack.systemPrompt).toContain("User timezone is Asia/Kolkata.");
  });

  it("shows relevance percentage when score is set", async () => {
    const fetchers = makeFetchers({
      memories: [makeMemory({ score: 0.87 })],
    });
    const pack = await assembleContextPack(fetchers);
    expect(pack.systemPrompt).toContain("87%");
  });

  it("omits relevance when score is undefined", async () => {
    const fetchers = makeFetchers({
      memories: [makeMemory({ score: undefined })],
    });
    const pack = await assembleContextPack(fetchers);
    expect(pack.systemPrompt).not.toContain("relevance");
  });

  it("renders 'No stored memories' when memories array is empty", async () => {
    const fetchers = makeFetchers({ memories: [] });
    const pack = await assembleContextPack(fetchers);
    expect(pack.systemPrompt).toContain("No stored memories");
  });

  it("passes memoryQuery to fetchMemories", async () => {
    const fetchers = makeFetchers();
    await assembleContextPack(fetchers, { memoryQuery: "timezone preferences" });
    expect(fetchers.fetchMemories).toHaveBeenCalledWith(
      expect.any(Number),
      "timezone preferences",
    );
  });

  it("changes section header when memoryQuery is set", async () => {
    const fetchers = makeFetchers({
      memories: [makeMemory()],
    });
    const pack = await assembleContextPack(fetchers, { memoryQuery: "deployment steps" });
    expect(pack.systemPrompt).toContain('Relevant Memories for "deployment steps"');
  });
});

// ── Extra context ─────────────────────────────────────────────────────────────

describe("assembleContextPack — extraContext", () => {
  it("appends extra context as a section", async () => {
    const pack = await assembleContextPack(nullFetchers, {
      extraContext: "Current project: NEXUS platform v2",
    });
    expect(pack.systemPrompt).toContain("NEXUS platform v2");
    const extraSection = pack.sections.find((s) => s.name === "Additional Context");
    expect(extraSection).toBeDefined();
  });

  it("omits extra context section when not provided", async () => {
    const pack = await assembleContextPack(nullFetchers);
    expect(pack.sections.find((s) => s.name === "Additional Context")).toBeUndefined();
  });
});

// ── Token budget ──────────────────────────────────────────────────────────────

describe("assembleContextPack — token budget", () => {
  it("wasTrimmed is false when content fits in budget", async () => {
    const pack = await assembleContextPack(nullFetchers, { maxTokenBudget: 4000 });
    expect(pack.wasTrimmed).toBe(false);
  });

  it("wasTrimmed is true when budget is very tight", async () => {
    const fetchers = makeFetchers({
      memories: Array.from({ length: 5 }, (_, i) =>
        makeMemory({ text: "A".repeat(500), id: `m-${i}` }),
      ),
    });
    // Very small budget — some section must be trimmed
    const pack = await assembleContextPack(fetchers, { maxTokenBudget: 200 });
    expect(pack.wasTrimmed).toBe(true);
    const trimmedSection = pack.sections.find((s) => s.trimmed);
    expect(trimmedSection).toBeDefined();
    expect(trimmedSection?.content).toContain("truncated to fit token budget");
  });

  it("totalTokenEstimate is within budget when budget is tight", async () => {
    const fetchers = makeFetchers({
      tasks: Array.from({ length: 5 }, (_, i) => makeTask({ id: `t-${i}` })),
    });
    const budget = 300;
    const pack = await assembleContextPack(fetchers, { maxTokenBudget: budget });
    // Allow a small overshoot for the preamble (which we never trim)
    expect(pack.totalTokenEstimate).toBeLessThanOrEqual(budget + 200);
  });

  it("skips a section entirely when remaining budget is ≤ 50 tokens", async () => {
    // Preamble alone will consume most of a tiny budget
    const pack = await assembleContextPack(nullFetchers, { maxTokenBudget: 40 });
    // With only 40 tokens, only preamble should appear (others skipped)
    expect(pack.sections.length).toBe(1);
    expect(pack.sections[0]?.name).toBe("Preamble");
  });
});

// ── Parallel fetching ─────────────────────────────────────────────────────────

describe("assembleContextPack — parallel fetching", () => {
  it("calls all three fetchers exactly once", async () => {
    const fetchers = makeFetchers();
    await assembleContextPack(fetchers);
    expect(fetchers.fetchRecentTasks).toHaveBeenCalledTimes(1);
    expect(fetchers.fetchActiveSignals).toHaveBeenCalledTimes(1);
    expect(fetchers.fetchMemories).toHaveBeenCalledTimes(1);
  });
});

// ── nullFetchers ──────────────────────────────────────────────────────────────

describe("nullFetchers", () => {
  it("returns empty arrays for all three fetchers", async () => {
    const [tasks, signals, memories] = await Promise.all([
      nullFetchers.fetchRecentTasks(10),
      nullFetchers.fetchActiveSignals(5),
      nullFetchers.fetchMemories(8),
    ]);
    expect(tasks).toEqual([]);
    expect(signals).toEqual([]);
    expect(memories).toEqual([]);
  });
});

// ── estimateTokens ────────────────────────────────────────────────────────────

describe("estimateTokens", () => {
  it("returns 1 for a 4-char string", () => {
    expect(estimateTokens("abcd")).toBe(1);
  });

  it("rounds up for partial tokens", () => {
    expect(estimateTokens("abcde")).toBe(2); // 5 chars → ceil(5/4) = 2
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("handles longer strings proportionally", () => {
    const tokens = estimateTokens("a".repeat(400));
    expect(tokens).toBe(100);
  });
});
