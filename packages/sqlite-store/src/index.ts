// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/sqlite-store — SQLite offline storage adapter.
 *
 * Provides SQLite-compatible interfaces for KV storage and observation/memory
 * storage — enabling local dev, offline mode, and edge deployments without Postgres.
 *
 * Architecture
 * ─────────────
 *   KVStore             — generic key-value store interface (get/set/delete/list/clear)
 *   InMemoryKVStore     — Map-backed implementation (tests / serverless)
 *   SqliteKVStore       — better-sqlite3-backed implementation (Node.js with SQLite file)
 *   ObservationStore    — typed observation/event log interface
 *   InMemoryObsStore    — in-memory observation store
 *   SqliteAdapter       — thin wrapper around better-sqlite3 (injectable in production)
 *
 * Production usage (requires better-sqlite3 installed separately):
 * ```ts
 * import Database from "better-sqlite3";
 * import { SqliteKVStore } from "@nexus/sqlite-store";
 * const db = new Database("nexus.db");
 * const kv = new SqliteKVStore(db, "kv_store");
 * ```
 *
 * Test / offline usage (zero deps):
 * ```ts
 * import { InMemoryKVStore } from "@nexus/sqlite-store";
 * const kv = new InMemoryKVStore();
 * ```
 */

// ── KVStore interface ─────────────────────────────────────────────────────────

export interface KVStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(prefix?: string): Promise<{ key: string; value: string }[]>;
  clear(): Promise<void>;
  size(): Promise<number>;
}

// ── InMemoryKVStore ───────────────────────────────────────────────────────────

interface KVEntry {
  value: string;
  expiresAt?: number;
}

/** In memory kv store. */
export class InMemoryKVStore implements KVStore {
  private readonly data = new Map<string, KVEntry>();

  async get(key: string): Promise<string | undefined> {
    const entry = this.data.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && Date.now() > entry.expiresAt) {
      this.data.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    this.data.set(key, {
      value,
      expiresAt: ttlMs !== undefined ? Date.now() + ttlMs : undefined,
    });
  }

  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }

  async list(prefix?: string): Promise<{ key: string; value: string }[]> {
    const now = Date.now();
    const result: { key: string; value: string }[] = [];
    for (const [k, entry] of this.data) {
      if (entry.expiresAt !== undefined && now > entry.expiresAt) continue;
      if (prefix && !k.startsWith(prefix)) continue;
      result.push({ key: k, value: entry.value });
    }
    return result.sort((a, b) => a.key.localeCompare(b.key));
  }

  async clear(): Promise<void> {
    this.data.clear();
  }

  async size(): Promise<number> {
    return this.data.size;
  }
}

// ── SqliteKVStore ─────────────────────────────────────────────────────────────

/** Minimal surface of better-sqlite3 Database needed by SqliteKVStore. */
export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

/** Sqlite statement interface definition. */
export interface SqliteStatement {
  run(...params: unknown[]): void;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/**
 * SQLite-backed KV store.
 * Pass a `better-sqlite3` Database instance.
 * Table is auto-created on construction.
 */
export class SqliteKVStore implements KVStore {
  private readonly stmts: {
    get: SqliteStatement;
    set: SqliteStatement;
    del: SqliteStatement;
    list: SqliteStatement;
    listPfx: SqliteStatement;
    clear: SqliteStatement;
    count: SqliteStatement;
  };

  constructor(db: SqliteDatabase, table = "nexus_kv") {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${table} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER
      )
    `);
    this.stmts = {
      get:     db.prepare(`SELECT value, expires_at FROM ${table} WHERE key = ?`),
      set:     db.prepare(`INSERT OR REPLACE INTO ${table} (key, value, expires_at) VALUES (?, ?, ?)`),
      del:     db.prepare(`DELETE FROM ${table} WHERE key = ?`),
      list:    db.prepare(`SELECT key, value FROM ${table} WHERE (expires_at IS NULL OR expires_at > ?) ORDER BY key`),
      listPfx: db.prepare(`SELECT key, value FROM ${table} WHERE key LIKE ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY key`),
      clear:   db.prepare(`DELETE FROM ${table}`),
      count:   db.prepare(`SELECT COUNT(*) as n FROM ${table} WHERE (expires_at IS NULL OR expires_at > ?)`),
    };
  }

  async get(key: string): Promise<string | undefined> {
    const row = this.stmts.get.get(key) as { value: string; expires_at: number | null } | undefined;
    if (!row) return undefined;
    if (row.expires_at !== null && Date.now() > row.expires_at) return undefined;
    return row.value;
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    const expiresAt = ttlMs !== undefined ? Date.now() + ttlMs : null;
    this.stmts.set.run(key, value, expiresAt);
  }

  async delete(key: string): Promise<boolean> {
    this.stmts.del.run(key);
    return true;
  }

  async list(prefix?: string): Promise<{ key: string; value: string }[]> {
    const now = Date.now();
    if (prefix) {
      return this.stmts.listPfx.all(`${prefix}%`, now) as { key: string; value: string }[];
    }
    return this.stmts.list.all(now) as { key: string; value: string }[];
  }

  async clear(): Promise<void> {
    this.stmts.clear.run();
  }

  async size(): Promise<number> {
    const row = this.stmts.count.get(Date.now()) as { n: number };
    return row.n;
  }
}

// ── ObservationStore ──────────────────────────────────────────────────────────

export interface Observation {
  id: string;
  sessionId: string;
  type: string;
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

/** Observation store interface definition. */
export interface ObservationStore {
  add(obs: Observation): Promise<void>;
  getBySession(sessionId: string): Promise<Observation[]>;
  getByType(type: string, limit?: number): Promise<Observation[]>;
  delete(id: string): Promise<boolean>;
  clear(): Promise<void>;
  count(): Promise<number>;
}

// ── InMemoryObsStore ──────────────────────────────────────────────────────────

export class InMemoryObsStore implements ObservationStore {
  private readonly obs: Observation[] = [];

  async add(o: Observation): Promise<void> {
    this.obs.push(o);
  }

  async getBySession(sessionId: string): Promise<Observation[]> {
    return this.obs
      .filter((o) => o.sessionId === sessionId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async getByType(type: string, limit = 100): Promise<Observation[]> {
    return this.obs
      .filter((o) => o.type === type)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  async delete(id: string): Promise<boolean> {
    const idx = this.obs.findIndex((o) => o.id === id);
    if (idx === -1) return false;
    this.obs.splice(idx, 1);
    return true;
  }

  async clear(): Promise<void> {
    this.obs.length = 0;
  }

  async count(): Promise<number> {
    return this.obs.length;
  }
}

// ── Serialization helpers ─────────────────────────────────────────────────────

/** Serialize a JS value to string for KV storage. */
export function serialize(value: unknown): string {
  return JSON.stringify(value);
}

/** Deserialize a string from KV storage back to T. Returns undefined on parse failure. */
export function deserialize<T>(raw: string | undefined): T | undefined {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
