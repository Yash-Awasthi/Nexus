// SPDX-License-Identifier: Apache-2.0
/**
 * session-sync — Cross-device session synchronisation layer.
 *
 * Provides:
 *   • SyncSession       — a serialisable session state
 *   • SyncOperation     — a delta operation (add/update/delete)
 *   • SyncStore         — in-memory session store with conflict resolution
 *   • VectorClock       — logical clock for distributed ordering
 *   • ConflictResolver  — last-write-wins and custom merge strategies
 *   • SyncManager       — orchestrates push/pull/merge lifecycle
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type SyncStatus = "clean" | "pending" | "conflict" | "synced";

export type OpType = "set" | "delete" | "merge";

export interface SyncSession {
  id: string;
  userId: string;
  deviceId: string;
  data: Record<string, unknown>;
  vectorClock: Record<string, number>; // deviceId → logical time
  updatedAt: string;
  status: SyncStatus;
  version: number;
}

export interface SyncOperation {
  sessionId: string;
  deviceId: string;
  type: OpType;
  key: string;
  value?: unknown;
  timestamp: string;
  logicalTime: number;
}

export interface ConflictResolution {
  winner: "local" | "remote" | "merged";
  resolved: Record<string, unknown>;
}

// ── ID util ───────────────────────────────────────────────────────────────────

let _seq = 0;
function uid(prefix: string) { return `${prefix}-${Date.now()}-${++_seq}`; }

// ── VectorClock ───────────────────────────────────────────────────────────────

export class VectorClock {
  private clock: Record<string, number>;

  constructor(initial: Record<string, number> = {}) {
    this.clock = { ...initial };
  }

  tick(deviceId: string): number {
    this.clock[deviceId] = (this.clock[deviceId] ?? 0) + 1;
    return this.clock[deviceId]!;
  }

  get(deviceId: string): number {
    return this.clock[deviceId] ?? 0;
  }

  merge(other: Record<string, number>): void {
    for (const [device, time] of Object.entries(other)) {
      this.clock[device] = Math.max(this.clock[device] ?? 0, time);
    }
  }

  /** Returns true if `this` happened-before `other` (all entries ≤ other). */
  happenedBefore(other: VectorClock): boolean {
    const allDevices = new Set([...Object.keys(this.clock), ...Object.keys(other.clock)]);
    let strictlyBefore = false;
    for (const d of allDevices) {
      const a = this.clock[d] ?? 0;
      const b = other.clock[d] ?? 0;
      if (a > b) return false;
      if (a < b) strictlyBefore = true;
    }
    return strictlyBefore;
  }

  /** Returns true if neither clock happened-before the other (concurrent). */
  concurrent(other: VectorClock): boolean {
    return !this.happenedBefore(other) && !other.happenedBefore(this);
  }

  toJSON(): Record<string, number> {
    return { ...this.clock };
  }

  static from(raw: Record<string, number>): VectorClock {
    return new VectorClock(raw);
  }
}

// ── ConflictResolver ──────────────────────────────────────────────────────────

export type MergeStrategy = "last-write-wins" | "union" | "custom";

export type CustomMergeFn = (
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
) => Record<string, unknown>;

export class ConflictResolver {
  private strategy: MergeStrategy;
  private customFn?: CustomMergeFn;

  constructor(strategy: MergeStrategy = "last-write-wins", customFn?: CustomMergeFn) {
    this.strategy = strategy;
    this.customFn = customFn;
  }

  resolve(
    local: SyncSession,
    remote: SyncSession,
  ): ConflictResolution {
    if (this.strategy === "last-write-wins") {
      const localTime = new Date(local.updatedAt).getTime();
      const remoteTime = new Date(remote.updatedAt).getTime();
      if (remoteTime > localTime) {
        return { winner: "remote", resolved: { ...remote.data } };
      }
      return { winner: "local", resolved: { ...local.data } };
    }

    if (this.strategy === "union") {
      return { winner: "merged", resolved: { ...remote.data, ...local.data } };
    }

    if (this.strategy === "custom" && this.customFn) {
      return { winner: "merged", resolved: this.customFn(local.data, remote.data) };
    }

    return { winner: "local", resolved: { ...local.data } };
  }
}

// ── SyncStore ─────────────────────────────────────────────────────────────────

export class SyncStore {
  private sessions = new Map<string, SyncSession>();
  private ops: SyncOperation[] = [];

  createSession(userId: string, deviceId: string, initialData: Record<string, unknown> = {}): SyncSession {
    const session: SyncSession = {
      id: uid("sess"),
      userId,
      deviceId,
      data: { ...initialData },
      vectorClock: { [deviceId]: 0 },
      updatedAt: new Date().toISOString(),
      status: "clean",
      version: 1,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(sessionId: string): SyncSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Apply a set/delete/merge operation to a session. */
  applyOp(op: SyncOperation): SyncSession | undefined {
    const session = this.sessions.get(op.sessionId);
    if (!session) return undefined;

    const updated = { ...session, data: { ...session.data } };

    if (op.type === "set") {
      updated.data[op.key] = op.value;
    } else if (op.type === "delete") {
      delete updated.data[op.key];
    } else if (op.type === "merge" && typeof op.value === "object" && op.value !== null) {
      updated.data[op.key] = { ...(updated.data[op.key] as object ?? {}), ...(op.value as object) };
    }

    updated.vectorClock = { ...updated.vectorClock };
    updated.vectorClock[op.deviceId] = Math.max(
      updated.vectorClock[op.deviceId] ?? 0,
      op.logicalTime,
    );
    updated.updatedAt = op.timestamp;
    updated.status = "synced";
    updated.version = session.version + 1;

    this.sessions.set(session.id, updated);
    this.ops.push(op);
    return updated;
  }

  /** Get all operations for a session after a given logical time. */
  getOpsSince(sessionId: string, sinceLogicalTime: number): SyncOperation[] {
    return this.ops.filter(
      (op) => op.sessionId === sessionId && op.logicalTime > sinceLogicalTime,
    );
  }

  list(userId?: string): SyncSession[] {
    const all = [...this.sessions.values()];
    return userId ? all.filter((s) => s.userId === userId) : all;
  }

  delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  count(): number { return this.sessions.size; }
}

// ── SyncManager ───────────────────────────────────────────────────────────────

export interface PushResult {
  sessionId: string;
  opsApplied: number;
  newVersion: number;
}

export interface PullResult {
  sessionId: string;
  ops: SyncOperation[];
  session: SyncSession | undefined;
}

export class SyncManager {
  private store: SyncStore;
  private resolver: ConflictResolver;
  private clock: VectorClock;
  private deviceId: string;

  constructor(deviceId: string, opts: { store?: SyncStore; resolver?: ConflictResolver } = {}) {
    this.deviceId = deviceId;
    this.store = opts.store ?? new SyncStore();
    this.resolver = opts.resolver ?? new ConflictResolver("last-write-wins");
    this.clock = new VectorClock();
  }

  getStore(): SyncStore { return this.store; }

  /** Push a batch of operations from this device. */
  push(sessionId: string, ops: Array<{ type: OpType; key: string; value?: unknown }>): PushResult {
    let opsApplied = 0;
    let session: SyncSession | undefined;

    for (const op of ops) {
      const logicalTime = this.clock.tick(this.deviceId);
      session = this.store.applyOp({
        sessionId,
        deviceId: this.deviceId,
        type: op.type,
        key: op.key,
        value: op.value,
        timestamp: new Date().toISOString(),
        logicalTime,
      });
      if (session) opsApplied++;
    }

    return {
      sessionId,
      opsApplied,
      newVersion: session?.version ?? 0,
    };
  }

  /** Pull operations since a given logical time. */
  pull(sessionId: string, sinceLogicalTime = 0): PullResult {
    const ops = this.store.getOpsSince(sessionId, sinceLogicalTime);
    const session = this.store.get(sessionId);
    if (session) {
      this.clock.merge(session.vectorClock);
    }
    return { sessionId, ops, session };
  }

  /** Merge a remote session into local, resolving conflicts. */
  merge(sessionId: string, remote: SyncSession): ConflictResolution {
    const local = this.store.get(sessionId);
    if (!local) {
      // No local copy — just import remote
      return { winner: "remote", resolved: { ...remote.data } };
    }

    const localClock = VectorClock.from(local.vectorClock);
    const remoteClock = VectorClock.from(remote.vectorClock);

    if (remoteClock.happenedBefore(localClock)) {
      return { winner: "local", resolved: { ...local.data } };
    }

    if (localClock.happenedBefore(remoteClock)) {
      return { winner: "remote", resolved: { ...remote.data } };
    }

    // Concurrent — use resolver
    return this.resolver.resolve(local, remote);
  }
}
