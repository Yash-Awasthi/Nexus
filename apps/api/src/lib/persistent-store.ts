// SPDX-License-Identifier: Apache-2.0
/**
 * PersistentStore — Map-compatible store that survives server restarts.
 *
 * Backed by Postgres (nexus_kv table) when DATABASE_URL is set, otherwise a
 * JSON file under NEXUS_DATA_DIR. Route handlers stay synchronous — writes are
 * fire-and-forget to the backing store. On server start call load() once per
 * store to hydrate the in-memory map.
 *
 * Generic infrastructure, extracted from routes/api-bridge.ts (which owns its
 * own raw-pg pool for its ~17 direct query sites; this module keeps a private
 * pool so other route modules can share the store class without importing the
 * bridge monolith).
 */

import fs from "node:fs";
import path from "node:path";

import { getPgPool } from "./pg-pool.js";

/** NEXUS_DATA_DIR, else ./data (./data/stores for the JSON-backed stores, where they always lived). */
export function dataDir(sub?: "stores"): string {
  return process.env.NEXUS_DATA_DIR ?? path.join(process.cwd(), "data", ...(sub ? [sub] : []));
}

const _DATA_DIR = dataDir("stores");

const _getPool = getPgPool;

let _tableReady: Promise<void> | null = null;
/** Ensure the nexus_kv table exists (idempotent; called lazily by load()). */
function _ensureTable(): Promise<void> {
  if (_tableReady) return _tableReady;
  const pool = _getPool();
  if (!pool) {
    _tableReady = Promise.resolve();
    return _tableReady;
  }
  _tableReady = pool
    .query(
      `CREATE TABLE IF NOT EXISTS nexus_kv (
        collection TEXT NOT NULL,
        id         TEXT NOT NULL,
        data       JSONB NOT NULL,
        PRIMARY KEY (collection, id)
      )`,
    )
    .then(() => undefined)
    .catch(() => undefined);
  return _tableReady;
}

export class PersistentStore<T> {
  private _mem = new Map<string, T>();

  constructor(private _name: string) {}

  /** Load from backing store. Call once at server startup. */
  async load(): Promise<void> {
    await _ensureTable();
    const pool = _getPool();
    if (pool) {
      try {
        const { rows } = await pool.query<{ id: string; data: T }>(
          "SELECT id, data FROM nexus_kv WHERE collection = $1",
          [this._name],
        );
        for (const r of rows) {
          // Key contract is a string id — skip rows that violate it (e.g. a
          // test pg mock that answers arbitrary row shapes for every query)
          // instead of hydrating garbage entries that crash readers.
          if (typeof r.id !== "string" || r.data === undefined || r.data === null) continue;
          this._mem.set(r.id, r.data);
        }
      } catch {
        /* table not yet created — first boot */
      }
    } else {
      try {
        const file = path.join(_DATA_DIR, `${this._name}.json`);
        const saved = JSON.parse(fs.readFileSync(file, "utf8")) as T[] | Record<string, T>;
        // Older files are a bare array, keyed by each value's id.
        const entries = Array.isArray(saved)
          ? saved.map((item) => [(item as { id: string }).id, item] as const)
          : Object.entries(saved);
        for (const [id, item] of entries) this._mem.set(id, item);
      } catch {
        /* first run — no file yet */
      }
    }
  }

  /**
   * Re-read one entry from the backing store.
   *
   * The in-memory map is this process's copy, which goes stale the moment
   * another process writes the same collection — the worker running a job the
   * API started, for one. Returns undefined when the entry is unknown to both.
   */
  async refresh(id: string): Promise<T | undefined> {
    const pool = _getPool();
    if (!pool) return this._mem.get(id);
    try {
      const { rows } = await pool.query<{ data: T }>(
        "SELECT data FROM nexus_kv WHERE collection = $1 AND id = $2",
        [this._name, id],
      );
      const data = rows[0]?.data;
      if (data === undefined || data === null) return this._mem.get(id);
      this._mem.set(id, data);
      return data;
    } catch {
      return this._mem.get(id);
    }
  }

  // ── Map-compatible interface ───────────────────────────────────────────────

  get(id: string): T | undefined {
    return this._mem.get(id);
  }
  has(id: string): boolean {
    return this._mem.has(id);
  }
  get size(): number {
    return this._mem.size;
  }
  values(): IterableIterator<T> {
    return this._mem.values();
  }
  delete(id: string): void {
    this._mem.delete(id);
    void this._write(id, null);
  }

  set(id: string, val: T): void {
    this._mem.set(id, val);
    void this._write(id, val);
  }

  /** `set`, resolved once the row is stored: for a write another process reads next. */
  async save(id: string, val: T): Promise<void> {
    this._mem.set(id, val);
    await this._write(id, val);
  }

  /**
   * The caller's slice of the store: the same calls, with every key kept under
   * the caller's id, so one account can neither list nor address another's.
   */
  for(req: { nexusUserId?: string }) {
    const prefix = `${req.nexusUserId ?? "anonymous"}::`;
    return {
      get: (id: string) => this.get(prefix + id),
      has: (id: string) => this.has(prefix + id),
      set: (id: string, val: T) => this.set(prefix + id, val),
      delete: (id: string) => this.delete(prefix + id),
      values: () =>
        [...this._mem.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v),
    };
  }

  // ── Private persistence ────────────────────────────────────────────────────

  private async _write(id: string, val: T | null): Promise<void> {
    const pool = _getPool();
    if (pool) {
      if (val === null) {
        await pool
          .query("DELETE FROM nexus_kv WHERE collection=$1 AND id=$2", [this._name, id])
          .catch(() => {});
      } else {
        await pool
          .query(
            "INSERT INTO nexus_kv (collection,id,data) VALUES($1,$2,$3) ON CONFLICT (collection,id) DO UPDATE SET data=$3",
            [this._name, id, val as unknown],
          )
          .catch(() => {});
      }
    } else {
      // JSON file — write entire collection (small stores, infrequent writes), keyed as in memory
      try {
        fs.mkdirSync(_DATA_DIR, { recursive: true });
        fs.writeFileSync(
          path.join(_DATA_DIR, `${this._name}.json`),
          JSON.stringify(Object.fromEntries(this._mem), null, 2),
        );
      } catch {
        /* ignore write errors (read-only fs) */
      }
    }
  }
}
