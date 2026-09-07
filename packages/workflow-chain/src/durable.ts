// SPDX-License-Identifier: Apache-2.0
/**
 * durable — Temporal-style activities + signals for workflow bodies (pass 75).
 *
 * Row 218 (temporal) credits @nexus/workflow-chain with saga compensation
 * (pass 24) and @nexus/task-queue with retries/timers/cron, but not
 * Temporal's two other core workflow mechanics:
 *
 *   • ACTIVITIES — first-class NAMED units of work, registered on a runtime
 *     and invoked by name from a workflow body, each carrying its own
 *     RetryPolicy (initialIntervalMs × backoffCoefficient ^ attempt, capped at
 *     maximumIntervalMs, giving up after maximumAttempts with the last error).
 *     A workflow that calls an activity waits for it to finish.
 *   • SIGNALS — named external messages addressed to a workflow. A signal sent
 *     BEFORE the workflow reaches its wait is not lost: it is buffered and
 *     delivered the moment the workflow waits on that name (Temporal's
 *     send-before-handle guarantee). A signal sent while the workflow is
 *     already waiting wakes it immediately with the payload.
 *
 * Honest divergences (documented, not silently dropped): this is an
 * in-process engine — workflow bodies stay alive across waits rather than
 * being persisted and replayed, activities execute inline under their retry
 * policy (no separate worker/task-queue dispatch), and activity heartbeats
 * are worker-runtime machinery. Persistence/replay, worker dispatch, and
 * heartbeats stay out (Temporal's server/runtime is non-TS here).
 */
import { setTimeout as sleepTimers } from "node:timers/promises";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Temporal-style activity retry policy. */
export interface ActivityRetryPolicy {
  /** Delay before the first retry. Default 1000ms. */
  initialIntervalMs?: number;
  /** Exponential backoff multiplier. Default 2.0. */
  backoffCoefficient?: number;
  /** Cap on the per-attempt delay. Default 60_000ms. */
  maximumIntervalMs?: number;
  /** Total attempts (including the first). Default unlimited. */
  maximumAttempts?: number;
}

export interface ActivityDefinition<INPUT = unknown, OUTPUT = unknown> {
  /** Activity name — what workflow bodies invoke. */
  name: string;
  /** The unit of work itself. */
  run(input: INPUT): Promise<OUTPUT> | OUTPUT;
  retry?: ActivityRetryPolicy;
}

/** Context handed to a workflow body by {@link DurableRuntime.start}. */
export interface WorkflowContext {
  readonly workflowId: string;
  /**
   * Run a registered activity by name, waiting for its (retried) completion.
   * Rejects with {@link ActivityNotFoundError} for unknown names and with the
   * last attempt error when the retry policy is exhausted.
   */
  runActivity<INPUT = unknown, OUTPUT = unknown>(
    name: string,
    input: INPUT,
  ): Promise<OUTPUT>;
  /**
   * Wait for a signal. Signals delivered before this wait are buffered and
   * drained in order; a signal arriving while waiting resolves it at once.
   * Optionally bound by `timeoutMs` (rejects when the timeout elapses first).
   */
  waitForSignal<PAYLOAD = unknown>(
    signal: string,
    opts?: { timeoutMs?: number },
  ): Promise<PAYLOAD>;
  /** Deliver a signal to this workflow (buffered when nobody is waiting). */
  signal<PAYLOAD = unknown>(name: string, payload: PAYLOAD): void;
  /** Suspend the body for `ms` (workflow timer helper). */
  sleep(ms: number): Promise<void>;
}

export class ActivityNotFoundError extends Error {
  constructor(name: string) {
    super(`Unknown activity: ${name}`);
    this.name = "ActivityNotFoundError";
  }
}

// ── Runtime ───────────────────────────────────────────────────────────────────

interface PendingSignal<PAYLOAD> {
  name: string;
  payload: PAYLOAD;
}

/** One running workflow instance: its signal buffer + active waiter. */
class WorkflowInstance<RESULT> {
  private readonly buffer = new Map<string, unknown[]>();
  private waiter:
    | { name: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }
    | undefined;
  private done = false;

  constructor(
    readonly workflowId: string,
    private readonly runtime: DurableRuntime,
    private readonly body: (ctx: WorkflowContext) => Promise<RESULT>,
  ) {}

  /** The workflow body's own handle to this instance's signals/waits. */
  private ctx(): WorkflowContext {
    return {
      workflowId: this.workflowId,
      runActivity: (name, input) => this.runtime.runActivity(name, input),
      waitForSignal: (name, opts) => this.wait(name, opts),
      signal: (name, payload) => {
        this.deliver(name, payload);
      },
      sleep: (ms) => sleepTimers(ms),
    };
  }

  run(): Promise<RESULT> {
    return this.body(this.ctx()).finally(() => {
      this.done = true;
      // A leftover waiter (body abandoned mid-wait) never resolves.
      this.waiter = undefined;
    });
  }

  /** External signal entry (from {@link DurableRuntime.signal}). */
  deliver(name: string, payload: unknown): boolean {
    if (this.done) return false;
    const w = this.waiter;
    if (w && w.name === name) {
      if (w.timer) clearTimeout(w.timer);
      this.waiter = undefined;
      w.resolve(payload);
      return true;
    }
    // Nobody waiting on this name — buffer for a future wait.
    const list = (this.buffer.get(name) ?? []) as unknown[];
    list.push(payload);
    this.buffer.set(name, list);
    return true;
  }

  private wait<PAYLOAD>(name: string, opts?: { timeoutMs?: number }): Promise<PAYLOAD> {
    // Signals sent before this wait are delivered immediately, in order.
    const buffered = this.buffer.get(name);
    if (buffered && buffered.length > 0) {
      const payload = buffered.shift();
      if (buffered.length === 0) this.buffer.delete(name);
      return Promise.resolve(payload as PAYLOAD);
    }
    return new Promise<PAYLOAD>((resolve, reject) => {
      const timer =
        opts?.timeoutMs !== undefined
          ? setTimeout(() => {
              if (this.waiter?.name === name) this.waiter = undefined;
              reject(new Error(`Signal wait timed out after ${opts.timeoutMs}ms: ${name}`));
            }, opts.timeoutMs)
          : undefined;
      this.waiter = { name, resolve: resolve as (v: unknown) => void, reject, timer };
    });
  }
}

/**
 * In-process durable-workflow runtime: owns the activity registry and the
 * workflow instances whose bodies can call activities and wait on signals.
 */
export class DurableRuntime {
  private readonly activities = new Map<string, ActivityDefinition>();
  private readonly instances = new Map<string, WorkflowInstance<unknown>>();

  /** Register a named activity (or several). */
  registerActivity(def: ActivityDefinition): this;
  registerActivity(defs: ActivityDefinition[]): this;
  registerActivity(defOrDefs: ActivityDefinition | ActivityDefinition[]): this {
    for (const def of Array.isArray(defOrDefs) ? defOrDefs : [defOrDefs]) {
      this.activities.set(def.name, def);
    }
    return this;
  }

  /** Whether an activity with this name is registered. */
  hasActivity(name: string): boolean {
    return this.activities.has(name);
  }

  /**
   * Execute a registered activity with its retry policy. Attempts are spaced
   * initialIntervalMs × backoffCoefficient^attempt, capped at maximumIntervalMs;
   * after maximumAttempts (or unlimited when unset) the LAST error is thrown.
   */
  async runActivity<INPUT = unknown, OUTPUT = unknown>(
    name: string,
    input: INPUT,
  ): Promise<OUTPUT> {
    const def = this.activities.get(name);
    if (!def) throw new ActivityNotFoundError(name);
    const retry = def.retry ?? {};
    const maximumAttempts = retry.maximumAttempts ?? Number.POSITIVE_INFINITY;
    const initial = retry.initialIntervalMs ?? 1_000;
    const coefficient = retry.backoffCoefficient ?? 2.0;
    const maximumInterval = retry.maximumIntervalMs ?? 60_000;

    let lastError: unknown;
    for (let attempt = 1; attempt <= maximumAttempts; attempt++) {
      try {
        return (await def.run(input)) as OUTPUT;
      } catch (err) {
        lastError = err;
        if (attempt >= maximumAttempts) break;
        const delay = Math.min(initial * coefficient ** attempt, maximumInterval);
        await sleepTimers(delay);
      }
    }
    throw lastError;
  }

  /**
   * Launch a workflow body under a unique id. Runs immediately; the returned
   * promise resolves with the body's result once it finishes (after any
   * activity calls and signal waits). Signals sent before the body waits are
   * buffered and delivered when it does.
   */
  async start<RESULT = unknown>(
    workflowId: string,
    body: (ctx: WorkflowContext) => Promise<RESULT>,
  ): Promise<RESULT> {
    if (this.instances.has(workflowId)) {
      throw new Error(`Workflow already running: ${workflowId}`);
    }
    const instance = new WorkflowInstance(workflowId, this, body);
    this.instances.set(workflowId, instance as WorkflowInstance<unknown>);
    try {
      return await instance.run();
    } finally {
      this.instances.delete(workflowId);
    }
  }

  /**
   * Deliver a signal to a running workflow. Returns true when the workflow
   * exists and the signal was delivered (immediately if it was waiting,
   * buffered otherwise); false for unknown or already-finished workflows.
   */
  signal<PAYLOAD = unknown>(workflowId: string, name: string, payload: PAYLOAD): boolean {
    const instance = this.instances.get(workflowId);
    return instance ? instance.deliver(name, payload) : false;
  }
}
