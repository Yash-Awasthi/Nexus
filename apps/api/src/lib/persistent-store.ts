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

import { Pool } from "pg";

const _DATA_DIR = process.env.NEXUS_DATA_DIR ?? path.join(process.cwd(), "data", "stores");

// `undefined` = "not yet initialised" sentinel; `null` = "no DATABASE_URL".
let _pgPool: Pool | null | undefined;
function _getPool(): Pool | null {
  if (_pgPool !== undefined) return _pgPool;
  if (process.env.DATABASE_URL) {
    _pgPool = new Pool({ connectionString: process.env.DATABASE_URL });
  } else {
    _pgPool = null;
  }
  return _pgPool;
}

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
        const items = JSON.parse(fs.readFileSync(file, "utf8")) as T[];
        for (const item of items) this._mem.set((item as { id: string })["id"], item);
      } catch {
        /* first run — no file yet */
      }
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
    this._write(id, null);
  }

  set(id: string, val: T): void {
    this._mem.set(id, val);
    this._write(id, val);
  }

  // ── Private persistence ────────────────────────────────────────────────────

  private _write(id: string, val: T | null): void {
    const pool = _getPool();
    if (pool) {
      if (val === null) {
        pool
          .query("DELETE FROM nexus_kv WHERE collection=$1 AND id=$2", [this._name, id])
          .catch(() => {});
      } else {
        pool
          .query(
            "INSERT INTO nexus_kv (collection,id,data) VALUES($1,$2,$3) ON CONFLICT (collection,id) DO UPDATE SET data=$3",
            [this._name, id, val as unknown],
          )
          .catch(() => {});
      }
    } else {
      // JSON file — write entire collection (small stores, infrequent writes)
      try {
        fs.mkdirSync(_DATA_DIR, { recursive: true });
        fs.writeFileSync(
          path.join(_DATA_DIR, `${this._name}.json`),
          JSON.stringify(Array.from(this._mem.values()), null, 2),
        );
      } catch {
        /* ignore write errors (read-only fs) */
      }
    }
  }
}
