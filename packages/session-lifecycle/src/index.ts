// SPDX-License-Identifier: Apache-2.0
/**
 * session-lifecycle — Session completion, cleanup, and idempotency guards.
 *
 * Provides:
 *   • SessionState          — typed session state machine
 *   • SessionRecord         — full session record with metadata
 *   • SessionStore          — in-memory session registry
 *   • SessionCompletionHandler — finalize + mark completed + broadcast
 *   • GeneratorExitHandler  — async generator cleanup with timeout
 *   • IdempotencyGuard      — prevents double-completion
 *   • LifecycleEventBus     — simple typed event bus for lifecycle events
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type SessionStatus = "pending" | "running" | "completed" | "failed" | "aborted";

/** Session record interface definition. */
export interface SessionRecord {
  id: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  metadata: Record<string, unknown>;
  error?: string;
}

// ── LifecycleEvent ────────────────────────────────────────────────────────────

export type LifecycleEventType =
  | "session_started"
  | "session_completed"
  | "session_failed"
  | "session_aborted"
  | "cleanup_started"
  | "cleanup_finished";

/** Lifecycle event interface definition. */
export interface LifecycleEvent {
  type: LifecycleEventType;
  sessionId: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

/** Lifecycle listener type alias. */
export type LifecycleListener = (event: LifecycleEvent) => void;

/** Lifecycle event bus. */
export class LifecycleEventBus {
  private listeners = new Map<LifecycleEventType | "*", Set<LifecycleListener>>();

  on(type: LifecycleEventType | "*", listener: LifecycleListener): () => void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
    return () => set.delete(listener);
  }

  emit(event: LifecycleEvent): void {
    const specific = this.listeners.get(event.type);
    const wildcard = this.listeners.get("*");
    specific?.forEach((l) => {
      try {
        l(event);
      } catch {
        /* isolate */
      }
    });
    wildcard?.forEach((l) => {
      try {
        l(event);
      } catch {
        /* isolate */
      }
    });
  }

  clear(): void {
    this.listeners.clear();
  }
}

// ── SessionStore ──────────────────────────────────────────────────────────────

let _ssSeq = 0;

/** Session store. */
export class SessionStore {
  private sessions = new Map<string, SessionRecord>();

  create(metadata: Record<string, unknown> = {}): SessionRecord {
    const id = `session-${++_ssSeq}`;
    const now = new Date().toISOString();
    const record: SessionRecord = {
      id,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      metadata,
    };
    this.sessions.set(id, record);
    return record;
  }

  get(id: string): SessionRecord | undefined {
    return this.sessions.get(id);
  }
  has(id: string): boolean {
    return this.sessions.has(id);
  }

  update(id: string, patch: Partial<SessionRecord>): SessionRecord {
    const record = this.sessions.get(id);
    if (!record) throw new Error(`Session not found: ${id}`);
    const updated = { ...record, ...patch, updatedAt: new Date().toISOString() };
    this.sessions.set(id, updated);
    return updated;
  }

  delete(id: string): boolean {
    return this.sessions.delete(id);
  }
  list(): SessionRecord[] {
    return [...this.sessions.values()];
  }
  count(): number {
    return this.sessions.size;
  }
  clear(): void {
    this.sessions.clear();
  }

  byStatus(status: SessionStatus): SessionRecord[] {
    return this.list().filter((s) => s.status === status);
  }
}

// ── IdempotencyGuard ──────────────────────────────────────────────────────────

/**
 * Prevents a session from being completed more than once.
 * Tracks which session IDs have already been finalized.
 */
export class IdempotencyGuard {
  private completed = new Set<string>();

  /** Returns true if this is the first completion attempt. */
  tryComplete(sessionId: string): boolean {
    if (this.completed.has(sessionId)) return false;
    this.completed.add(sessionId);
    return true;
  }

  isCompleted(sessionId: string): boolean {
    return this.completed.has(sessionId);
  }
  reset(sessionId: string): void {
    this.completed.delete(sessionId);
  }
  clear(): void {
    this.completed.clear();
  }
  size(): number {
    return this.completed.size;
  }
}

// ── SessionCompletionHandler ──────────────────────────────────────────────────

export interface CompletionOptions {
  finalMetadata?: Record<string, unknown>;
  error?: string;
  status?: "completed" | "failed" | "aborted";
}

/** Completion result interface definition. */
export interface CompletionResult {
  sessionId: string;
  wasAlreadyCompleted: boolean;
  record: SessionRecord;
}

/** Session completion handler. */
export class SessionCompletionHandler {
  private store: SessionStore;
  private bus: LifecycleEventBus;
  private guard: IdempotencyGuard;

  constructor(store: SessionStore, bus: LifecycleEventBus, guard?: IdempotencyGuard) {
    this.store = store;
    this.bus = bus;
    this.guard = guard ?? new IdempotencyGuard();
  }

  complete(sessionId: string, opts: CompletionOptions = {}): CompletionResult {
    // Idempotency check
    if (!this.guard.tryComplete(sessionId)) {
      const record = this.store.get(sessionId)!;
      return { sessionId, wasAlreadyCompleted: true, record };
    }

    const status = opts.status ?? (opts.error ? "failed" : "completed");
    const now = new Date().toISOString();

    const record = this.store.update(sessionId, {
      status,
      completedAt: now,
      error: opts.error,
      metadata: {
        ...(this.store.get(sessionId)?.metadata ?? {}),
        ...(opts.finalMetadata ?? {}),
      },
    });

    const eventType: LifecycleEventType =
      status === "completed"
        ? "session_completed"
        : status === "failed"
          ? "session_failed"
          : "session_aborted";

    this.bus.emit({
      type: eventType,
      sessionId,
      timestamp: now,
      data: { status, error: opts.error },
    });

    return { sessionId, wasAlreadyCompleted: false, record };
  }

  getGuard(): IdempotencyGuard {
    return this.guard;
  }
}

// ── GeneratorExitHandler ──────────────────────────────────────────────────────

export interface CleanupTask {
  name: string;
  fn: () => Promise<void> | void;
}

/** Cleanup result interface definition. */
export interface CleanupResult {
  sessionId: string;
  tasks: { name: string; success: boolean; error?: string }[];
  durationMs: number;
}

/** Generator exit handler. */
export class GeneratorExitHandler {
  private bus: LifecycleEventBus;
  private timeoutMs: number;

  constructor(bus: LifecycleEventBus, timeoutMs = 5_000) {
    this.bus = bus;
    this.timeoutMs = timeoutMs;
  }

  async cleanup(sessionId: string, tasks: CleanupTask[]): Promise<CleanupResult> {
    const t0 = Date.now();
    this.bus.emit({ type: "cleanup_started", sessionId, timestamp: new Date().toISOString() });

    const results: CleanupResult["tasks"] = [];

    for (const task of tasks) {
      try {
        const p = Promise.resolve(task.fn());
        const timeout = new Promise<void>((_, rej) =>
          setTimeout(() => rej(new Error(`Timeout: ${task.name}`)), this.timeoutMs),
        );
        await Promise.race([p, timeout]);
        results.push({ name: task.name, success: true });
      } catch (err) {
        results.push({
          name: task.name,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const durationMs = Date.now() - t0;
    this.bus.emit({
      type: "cleanup_finished",
      sessionId,
      timestamp: new Date().toISOString(),
      data: { durationMs },
    });

    return { sessionId, tasks: results, durationMs };
  }
}

// ── Convenience factory ───────────────────────────────────────────────────────

export function createLifecycle(): {
  store: SessionStore;
  bus: LifecycleEventBus;
  guard: IdempotencyGuard;
  completionHandler: SessionCompletionHandler;
  exitHandler: GeneratorExitHandler;
} {
  const store = new SessionStore();
  const bus = new LifecycleEventBus();
  const guard = new IdempotencyGuard();
  const completionHandler = new SessionCompletionHandler(store, bus, guard);
  const exitHandler = new GeneratorExitHandler(bus);
  return { store, bus, guard, completionHandler, exitHandler };
}
