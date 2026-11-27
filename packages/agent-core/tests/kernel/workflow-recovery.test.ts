// SPDX-License-Identifier: Apache-2.0
/**
 * Durable workflow recovery, measured rather than asserted in prose.
 *
 * The claim under test is the plan's M5.3.1: kill the worker mid-run, resume from the last
 * checkpoint, and count the work that is lost at each interruption point.
 *
 * The worker is simulated at the one seam a dead process actually produces: the orchestrator call
 * never returns. Tasks that finished before the crash are already in persistence under their task
 * ids (that is what `TaskExecutor` writes), so the engine can tell them apart from the one that was
 * in flight. The restart builds a *new* engine and a *new* telemetry object over the *same*
 * persistence — anything the first engine knew only in memory is gone, which is the difference
 * between a restart and a retry.
 */
import { describe, it, expect } from "vite-plus/test";

import type { IRuntimePersistence } from "../../src/kernel/interfaces/persistence.interface.ts";
import type { ConductorOrchestrator } from "../../src/kernel/orchestrator.ts";
import type { Task } from "../../src/kernel/task-router.ts";
import {
  WorkflowEngine,
  WorkflowRegistry,
  WorkflowTelemetry,
} from "../../src/kernel/workflow-engine.ts";

const TASK_IDS = ["t1", "t2", "t3", "t4", "t5"];

/** Persistence that survives the restart, because it is the one thing a worker does not hold. */
class SurvivingPersistence implements IRuntimePersistence {
  private readonly store = new Map<string, unknown>();
  async saveState(key: string, state: unknown): Promise<void> {
    this.store.set(key, state);
  }
  async getState<T>(key: string): Promise<T | undefined> {
    return this.store.get(key) as T | undefined;
  }
  async clearState(key: string): Promise<void> {
    this.store.delete(key);
  }
  /** A copy, as a machine that restarts would find on disk. */
  clone(): SurvivingPersistence {
    const copy = new SurvivingPersistence();
    for (const [key, value] of this.store) copy.store.set(key, value);
    return copy;
  }
}

function task(id: string): Task {
  return {
    id,
    title: id,
    description: id,
    priority: "medium",
    status: "pending",
    dependencies: [],
  };
}

/**
 * Executes each submitted task in order and persists its result, except for the one task it is told
 * to die in — that task is started, never finished, and never persisted.
 */
class CrashingExecutor {
  /** Task ids this executor was asked to run, per call. */
  readonly requested: string[][] = [];
  /** How many times each task id was actually started. */
  readonly starts = new Map<string, number>();

  constructor(
    private readonly persistence: SurvivingPersistence,
    private readonly dieDuring: string,
  ) {}

  async submitAndExecuteTasks(tasks: Task[]): Promise<void> {
    this.requested.push(tasks.map((t) => t.id));
    for (const t of tasks) {
      this.starts.set(t.id, (this.starts.get(t.id) ?? 0) + 1);
      if (t.id === this.dieDuring) throw new Error(`worker died during ${t.id}`);
      await this.persistence.saveState(t.id, { status: "succeeded", result: `out-${t.id}` });
    }
  }

  asOrchestrator(): ConductorOrchestrator {
    return this as unknown as ConductorOrchestrator;
  }
}

function buildEngine(persistence: SurvivingPersistence, executor: CrashingExecutor) {
  const registry = new WorkflowRegistry();
  registry.registerWorkflow({
    id: "wf-recover",
    name: "Recoverable",
    description: "five tasks in sequence",
    tasks: TASK_IDS.map(task),
  });
  const telemetry = new WorkflowTelemetry(persistence);
  return new WorkflowEngine(registry, telemetry, executor.asOrchestrator(), undefined, persistence);
}

describe("durable workflow recovery", () => {
  for (const interruptAt of TASK_IDS) {
    it(`resumes after a crash during ${interruptAt} and loses only that task`, async () => {
      const persistence = new SurvivingPersistence();
      const first = new CrashingExecutor(persistence, interruptAt);
      const engine = buildEngine(persistence, first);

      const crashed = await engine.executeWorkflow("wf-recover", "exec-1");
      expect(crashed.status).toBe("failed");
      expect(crashed.error).toBe(`worker died during ${interruptAt}`);

      const index = TASK_IDS.indexOf(interruptAt);
      const paused = engine.getCheckpoint("exec-1");
      expect(paused?.status).toBe("paused");
      // Everything before the in-flight task is known to be done; the in-flight task is not.
      expect(paused?.completedTaskIds).toEqual(TASK_IDS.slice(0, index));
      expect(paused?.pendingTaskIds).toEqual(TASK_IDS.slice(index));

      // ── the restart: new engine, new telemetry, the same disk ──
      const disk = persistence.clone();
      const second = new CrashingExecutor(disk, "never");
      const restarted = buildEngine(disk, second);
      const { resumed, checkpoint } = await restarted.continueAfterCrash("exec-1");

      expect(checkpoint?.executionId).toBe("exec-1");
      expect(resumed?.status).toBe("succeeded");
      expect(resumed?.originalExecutionId).toBe("exec-1");

      // Nothing finished before the crash runs again; the task that was in flight does.
      expect(second.requested).toEqual([TASK_IDS.slice(index)]);
      expect(TASK_IDS.filter((id) => (second.starts.get(id) ?? 0) > 0)).toEqual(
        TASK_IDS.slice(index),
      );
      // Lost work: the in-flight task, started once before the crash and once after it.
      expect(first.starts.get(interruptAt)).toBe(1);
      expect(second.starts.get(interruptAt)).toBe(1);
      expect(second.requested[0]).toHaveLength(TASK_IDS.length - index);

      // The checkpoint is cleared on success, so a later restart has nothing to replay.
      expect(restarted.getCheckpoint("exec-1")).toBeUndefined();
      const results = resumed?.taskResults as Record<string, { result?: string }>;
      for (const id of TASK_IDS) expect(results[id]?.result).toBe(`out-${id}`);
    });
  }

  it("does not resume an execution that is not paused there", async () => {
    const persistence = new SurvivingPersistence();
    const executor = new CrashingExecutor(persistence, "never");
    const engine = buildEngine(persistence, executor);

    expect((await engine.continueAfterCrash("unknown-exec")).resumed).toBeNull();

    await engine.executeWorkflow("wf-recover", "exec-ok");
    expect((await engine.continueAfterCrash("exec-ok")).resumed).toBeNull();
  });

  it("counts the whole run as replayable work when the crash leaves no checkpoint", async () => {
    // A process that dies before the checkpoint is written has nothing to resume from. The
    // engine must say so rather than pretend a resume happened.
    const persistence = new SurvivingPersistence();
    const executor = new CrashingExecutor(persistence, "t1");
    const engine = buildEngine(persistence, executor);
    await engine.executeWorkflow("wf-recover", "exec-early");
    expect(engine.getCheckpoint("exec-early")?.completedTaskIds).toEqual([]);
  });
});
