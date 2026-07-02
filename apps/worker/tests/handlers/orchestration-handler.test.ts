// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

// orchestrate() runs real git worktrees + the agent/council loops — mock it so the
// test exercises only the persistence wiring (§6.1). vi.hoisted keeps the fn
// available inside the hoisted vi.mock factory.
const { mockOrchestrate } = vi.hoisted(() => ({ mockOrchestrate: vi.fn() }));
vi.mock("@nexus/agent-orchestrator", () => ({
  orchestrate: mockOrchestrate,
  scoreByConfidence: () => async () => ({ winnerId: "" }),
  GitWorktreeManager: vi.fn(),
}));

// The handler imports these at module load; they pull heavy deps we don't need.
vi.mock("../../src/handlers/agent-handler.js", () => ({ handleAgentRunJob: vi.fn() }));
vi.mock("../../src/handlers/council-handler.js", () => ({ handleCouncilJob: vi.fn() }));

// orchestration-store.js imports @nexus/db, which throws at init without DATABASE_URL.
vi.mock("@nexus/db", () => ({ db: {} }));
vi.mock("@nexus/db/schema", () => ({ orchestrationRuns: { id: "id", status: "status" } }));

import { handleOrchestrationJob } from "../../src/handlers/orchestration-handler.js";
import {
  reenqueueOrchestrationRuns,
  type OrchestrationRunStore,
  type OrchestrationRunPatch,
  type OrchestrationRunRecord,
} from "../../src/handlers/orchestration-store.js";

/** In-memory store standing in for the Drizzle-backed one. */
class FakeStore implements OrchestrationRunStore {
  rows = new Map<string, OrchestrationRunRecord>();
  async upsert(patch: OrchestrationRunPatch): Promise<void> {
    const prev = this.rows.get(patch.id) ?? ({ id: patch.id } as OrchestrationRunRecord);
    this.rows.set(patch.id, { ...prev, ...patch });
  }
  async get(id: string): Promise<OrchestrationRunRecord | null> {
    return this.rows.get(id) ?? null;
  }
  async listNonTerminal(): Promise<OrchestrationRunRecord[]> {
    return [...this.rows.values()].filter((r) => r.status !== "completed" && r.status !== "failed");
  }
}

const basePayload = {
  task: "refactor the auth module",
  repoPath: "/repo",
  models: [{ provider: "anthropic", model: "claude" }],
  taskId: "run-1",
};

describe("handleOrchestrationJob persistence (§6.1)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records running (with payload) then completed with candidates + winner", async () => {
    mockOrchestrate.mockResolvedValue({
      runId: "run-1",
      winnerId: "anthropic/claude#0",
      merged: false,
      candidates: [{ spec: { id: "anthropic/claude#0" }, summary: "did it", diff: "d", ok: true }],
    });
    const store = new FakeStore();

    await handleOrchestrationJob(basePayload, { store });

    const row = store.rows.get("run-1")!;
    expect(row.status).toBe("completed");
    expect(row.winner).toBe("anthropic/claude#0");
    expect(row.candidates).toHaveLength(1);
    // the running transition stashed the payload for restart recovery
    expect((row.payload as { task?: string }).task).toBe("refactor the auth module");
  });

  it("records failed and rethrows when orchestrate throws", async () => {
    mockOrchestrate.mockRejectedValue(new Error("worktree boom"));
    const store = new FakeStore();

    await expect(handleOrchestrationJob(basePayload, { store })).rejects.toThrow("worktree boom");

    const row = store.rows.get("run-1")!;
    expect(row.status).toBe("failed");
    expect(row.error).toContain("worktree boom");
  });

  it("defaults to a no-op store (no throw) when none is injected", async () => {
    mockOrchestrate.mockResolvedValue({
      runId: "run-1",
      winnerId: null,
      merged: false,
      candidates: [],
    });
    await expect(handleOrchestrationJob(basePayload)).resolves.toBeDefined();
  });
});

describe("handleOrchestrationJob merge gate + resume (§6.3)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("leaves a gate-blocked run in the non-terminal 'blocked' status", async () => {
    mockOrchestrate.mockResolvedValue({
      runId: "run-1",
      winnerId: "anthropic/claude#0",
      merged: false,
      candidates: [{ spec: { id: "anthropic/claude#0" }, diff: "", ok: false }],
      gate: { passed: false, reason: "no verifiable diff" },
    });
    const store = new FakeStore();

    await handleOrchestrationJob({ ...basePayload, merge: true }, { store });

    const row = store.rows.get("run-1")!;
    expect(row.status).toBe("blocked");
    expect(row.error).toContain("no verifiable diff");
    // blocked is non-terminal → recovery would resume it
    expect(await store.listNonTerminal()).toHaveLength(1);
  });

  it("resumes from persisted candidates instead of re-running the fan-out", async () => {
    mockOrchestrate.mockResolvedValue({
      runId: "run-1",
      winnerId: "anthropic/claude#0",
      merged: true,
      candidates: [],
      gate: { passed: true },
    });
    const store = new FakeStore();
    // A prior run got as far as scoring, with candidates captured.
    await store.upsert({
      id: "run-1",
      status: "scoring",
      task: basePayload.task,
      candidates: [{ spec: { id: "anthropic/claude#0" }, diff: "d", ok: true }] as unknown[],
    });

    await handleOrchestrationJob({ ...basePayload, merge: true }, { store });

    const opts = mockOrchestrate.mock.calls[0]![0] as { resumeFrom?: { candidates: unknown[] } };
    expect(opts.resumeFrom?.candidates).toHaveLength(1);
  });

  it("does NOT resume a fresh run (no prior candidates)", async () => {
    mockOrchestrate.mockResolvedValue({
      runId: "run-1",
      winnerId: null,
      merged: false,
      candidates: [],
    });
    const store = new FakeStore();
    await handleOrchestrationJob(basePayload, { store });
    const opts = mockOrchestrate.mock.calls[0]![0] as { resumeFrom?: unknown };
    expect(opts.resumeFrom).toBeUndefined();
  });
});

describe("reenqueueOrchestrationRuns — restart recovery (§6.1)", () => {
  it("re-enqueues a non-terminal run from its stored payload", async () => {
    // Simulate a worker that crashed mid-run: the row is left "running".
    const store = new FakeStore();
    await store.upsert({
      id: "run-1",
      status: "running",
      task: basePayload.task,
      payload: basePayload,
    });

    const enqueue = vi.fn().mockResolvedValue(undefined);
    const requeued = await reenqueueOrchestrationRuns(store, enqueue);

    expect(requeued).toEqual(["run-1"]);
    expect(enqueue).toHaveBeenCalledWith(
      "orchestration.run",
      expect.objectContaining({ task: basePayload.task, taskId: "run-1" }),
    );
  });

  it("does not re-enqueue completed runs", async () => {
    const store = new FakeStore();
    await store.upsert({ id: "done", status: "completed", task: "t", payload: basePayload });
    const enqueue = vi.fn().mockResolvedValue(undefined);
    expect(await reenqueueOrchestrationRuns(store, enqueue)).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("marks a payload-less non-terminal run failed instead of looping forever", async () => {
    const store = new FakeStore();
    await store.upsert({ id: "orphan", status: "running", task: "t" });
    const enqueue = vi.fn().mockResolvedValue(undefined);

    const requeued = await reenqueueOrchestrationRuns(store, enqueue);

    expect(requeued).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
    expect(store.rows.get("orphan")!.status).toBe("failed");
  });
});
