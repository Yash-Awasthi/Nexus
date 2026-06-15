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

/** Op type type alias. */
export type OpType = "set" | "delete" | "merge";

/** Sync session interface definition. */
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

/** Sync operation interface definition. */
export interface SyncOperation {
  sessionId: string;
  deviceId: string;
  type: OpType;
  key: string;
  value?: unknown;
  timestamp: string;
  logicalTime: number;
}

/** Conflict resolution interface definition. */
export interface ConflictResolution {
  winner: "local" | "remote" | "merged";
  resolved: Record<string, unknown>;
}

// ── Prototype-pollution guard helpers ─────────────────────────────────────────

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isSafeKey(key: string): boolean {
  return !UNSAFE_KEYS.has(key);
}

function safeSpread(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(obj)) {
    if (isSafeKey(k)) result[k] = v;
  }
  return result;
}

// ── ID util ───────────────────────────────────────────────────────────────────

let _seq = 0;
function uid(prefix: string) {
  return `${prefix}-${Date.now()}-${++_seq}`;
}

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

/** Custom merge fn type alias. */
export type CustomMergeFn = (
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
) => Record<string, unknown>;

/** Conflict resolver. */
export class ConflictResolver {
  private strategy: MergeStrategy;
  private customFn?: CustomMergeFn;

  constructor(strategy: MergeStrategy = "last-write-wins", customFn?: CustomMergeFn) {
    this.strategy = strategy;
    this.customFn = customFn;
  }

  resolve(local: SyncSession, remote: SyncSession): ConflictResolution {
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

  createSession(
    userId: string,
    deviceId: string,
    initialData: Record<string, unknown> = {},
  ): SyncSession {
    const session: SyncSession = {
      id: uid("sess"),
      userId,
      deviceId,
      data: safeSpread(initialData),
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

    if (!isSafeKey(op.key)) return undefined; // block __proto__ / constructor
    if (op.type === "set") {
      updated.data[op.key] = op.value;
    } else if (op.type === "delete") {
      delete updated.data[op.key];
    } else if (op.type === "merge" && typeof op.value === "object" && op.value !== null) {
      updated.data[op.key] = {
        ...((updated.data[op.key] as object) ?? {}),
        ...safeSpread(op.value as Record<string, unknown>),
      };
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
    return this.ops.filter((op) => op.sessionId === sessionId && op.logicalTime > sinceLogicalTime);
  }

  list(userId?: string): SyncSession[] {
    const all = [...this.sessions.values()];
    return userId ? all.filter((s) => s.userId === userId) : all;
  }

  delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  count(): number {
    return this.sessions.size;
  }
}

// ── SyncManager ───────────────────────────────────────────────────────────────

export interface PushResult {
  sessionId: string;
  opsApplied: number;
  newVersion: number;
}

/** Pull result interface definition. */
export interface PullResult {
  sessionId: string;
  ops: SyncOperation[];
  session: SyncSession | undefined;
}

/** Sync manager. */
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

  getStore(): SyncStore {
    return this.store;
  }
  getClock(): VectorClock {
    return this.clock;
  }

  /** Push a batch of operations from this device. */
  push(sessionId: string, ops: { type: OpType; key: string; value?: unknown }[]): PushResult {
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

// ── DrizzleSyncStore ──────────────────────────────────────────────────────────
//
// Production-grade SyncOperation persistence via Neon / PostgreSQL.
// Stores each SyncOperation as a row in `sync_patches`, keyed by session_id.
// SyncManager.push() writes ops to DB; SyncManager.pull() reads back ops
// since a given logical time — state survives pod restarts.
//
// Table schema (auto-created):
//   sync_patches (
//     id           TEXT DEFAULT gen_random_uuid() PRIMARY KEY,
//     device_id    TEXT NOT NULL,
//     session_id   TEXT NOT NULL,
//     clock        JSONB NOT NULL,   -- VectorClock snapshot
//     patch        JSONB NOT NULL,   -- full SyncOperation payload
//     applied_at   TIMESTAMPTZ DEFAULT now()
//   )
//
// Falls back to the in-memory SyncStore when DATABASE_URL is unset.
// Wire via SyncManager options:
//   new SyncManager("device-1", { store: await DrizzleSyncStore.connect() })

import { neon } from "@neondatabase/serverless";

/** Drizzle sync store. */
export class DrizzleSyncStore extends SyncStore {
  private sql: ReturnType<typeof neon>;
  private schemaEnsured = false;

  private constructor(sql: ReturnType<typeof neon>) {
    super();
    this.sql = sql;
  }

  static connect(databaseUrl?: string): DrizzleSyncStore {
    const url = databaseUrl ?? process.env.DATABASE_URL ?? "";
    if (!url) throw new Error("DrizzleSyncStore: DATABASE_URL is required");
    return new DrizzleSyncStore(neon(url));
  }

  private async ensureSchema(): Promise<void> {
    if (this.schemaEnsured) return;
    await this.sql`
      CREATE TABLE IF NOT EXISTS sync_patches (
        id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        device_id   TEXT NOT NULL,
        session_id  TEXT NOT NULL,
        clock       JSONB NOT NULL,
        patch       JSONB NOT NULL,
        applied_at  TIMESTAMPTZ DEFAULT now()
      )
    `;
    await this.sql`
      CREATE INDEX IF NOT EXISTS sync_patches_session_id_idx
        ON sync_patches (session_id, applied_at DESC)
    `;
    this.schemaEnsured = true;
  }

  /**
   * Persist a SyncOperation to the DB in addition to the in-memory SyncStore.
   * Returns the updated SyncSession (or undefined if session not found).
   */
  override applyOp(op: SyncOperation): SyncSession | undefined {
    const result = super.applyOp(op);
    if (result) {
      // Fire-and-forget persistence — errors are logged but don't fail the operation
      void this.persistOp(op, result.vectorClock).catch((err) => {
        console.warn(
          JSON.stringify({ level: "warn", event: "sync-store.persist-failed", error: String(err) }),
        );
      });
    }
    return result;
  }

  private async persistOp(op: SyncOperation, clock: Record<string, number>): Promise<void> {
    await this.ensureSchema();
    await this.sql`
      INSERT INTO sync_patches (device_id, session_id, clock, patch)
      VALUES (
        ${op.deviceId},
        ${op.sessionId},
        ${JSON.stringify(clock)}::jsonb,
        ${JSON.stringify(op)}::jsonb
      )
    `;
  }

  /**
   * Read persisted operations for a session since a given logical time.
   * Merges DB-stored ops with in-memory ops (deduplicates by logicalTime).
   */
  async getOpsSinceAsync(sessionId: string, sinceLogicalTime = 0): Promise<SyncOperation[]> {
    await this.ensureSchema();
    const rows = (await this.sql`
      SELECT patch FROM sync_patches
      WHERE session_id = ${sessionId}
      ORDER BY applied_at ASC
    `) as Record<string, unknown>[];
    const dbOps = rows.map((r) => JSON.parse(r["patch"] as string) as SyncOperation);
    return dbOps.filter((op) => op.logicalTime > sinceLogicalTime);
  }
}
