// SPDX-License-Identifier: Apache-2.0
/**
 * The process's embedded Postgres instances, one per data directory.
 *
 * `@electric-sql/pglite` is Postgres compiled to WASM with an on-disk data
 * directory — a real Postgres with no server to install, which is what lets
 * the desktop app run the API locally. It is single-writer: two instances
 * opened on one directory corrupt it. Both the Drizzle client in this package
 * and the API's pool factory need that database, so the instance is owned
 * here, below both of them.
 *
 * The module is loaded through `createRequire` rather than a static import, so
 * a deployment on a server database never pulls in the WASM build.
 */

import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** The slice of PGlite used here — `pg`-shaped results, plus a script runner. */
export interface EmbeddedDb {
  query: (
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: unknown[]; rowCount?: number | null; affectedRows?: number }>;
  exec: (sql: string) => Promise<unknown>;
  close: () => Promise<void>;
}

const PGLITE_PREFIX = "pglite://";

/** True when `url` asks for the embedded database rather than a server. */
export function isEmbeddedUrl(url: string | undefined): url is string {
  return !!url && url.startsWith(PGLITE_PREFIX);
}

/**
 * `pglite://:memory:` → in-memory; `pglite:///var/x` and `pglite://./x` → that
 * directory. The three-slash form is the absolute one, as in `file://`.
 */
function embeddedDataDir(url: string): string {
  const rest = url.slice(PGLITE_PREFIX.length);
  // Anything after `:memory:` is a label: it keeps two in-memory databases
  // apart without naming a directory that would then be created.
  return rest === "" || rest.startsWith(":memory:") ? "memory://" : rest;
}

const instances = new Map<string, EmbeddedDb>();

/** The one instance for `url`'s data directory, created on first ask. */
export function getEmbeddedDb(url: string): EmbeddedDb {
  const dir = embeddedDataDir(url);
  let db = instances.get(dir);
  if (!db) {
    const { PGlite } = createRequire(import.meta.url)("@electric-sql/pglite") as {
      PGlite: new (dataDir: string) => EmbeddedDb;
    };
    // PGlite creates its own directory but not the parents above it.
    if (dir !== "memory://") mkdirSync(path.dirname(dir), { recursive: true });
    db = new PGlite(dir);
    instances.set(dir, db);
  }
  return db;
}

/** Close the instance behind `url`, if one was opened. */
export async function closeEmbeddedDb(url: string): Promise<void> {
  const dir = embeddedDataDir(url);
  const db = instances.get(dir);
  if (!db) return;
  instances.delete(dir);
  await db.close();
}
