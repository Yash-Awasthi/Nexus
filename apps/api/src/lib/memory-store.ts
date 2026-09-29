// SPDX-License-Identifier: Apache-2.0
/**
 * The one memory store every route shares: pgvector on a server database or on
 * the embedded one (PGlite loads the extension), process memory with no
 * database at all. Separate instances per route would each see only their own
 * writes. Routes build their managers at import, so the backend is chosen on
 * first use.
 */

import {
  InMemoryStore,
  PgVectorStore,
  sqlFromQuery,
  type IMemoryStore,
  type MemoryEntry,
  type MemoryFilter,
} from "@nexus/memory";

import { getPgPool, isEmbeddedUrl, isNeonCompatibleUrl, type PgLike } from "./pg-pool.js";

/** Where desktop builds without pgvector kept memory: nexus_kv rows of this collection. */
const LEGACY_COLLECTION = "memory_entries";

/**
 * Move those rows into memory_entries, deleting each only once it is saved, so
 * an entry pgvector refuses (a different embedding size) stays where it was.
 */
async function importLegacyKv(pool: PgLike, store: IMemoryStore): Promise<void> {
  let rows: { id: string; data: MemoryEntry }[];
  try {
    ({ rows } = await pool.query<{ id: string; data: MemoryEntry }>(
      "SELECT id, data FROM nexus_kv WHERE collection = $1",
      [LEGACY_COLLECTION],
    ));
  } catch (err) {
    if ((err as Error).message.includes("does not exist")) return;
    throw err;
  }
  for (const { id, data } of rows) {
    try {
      await store.save(data);
    } catch (err) {
      console.warn(`[memory] kept legacy entry ${id} in nexus_kv: ${String(err)}`);
      continue;
    }
    await pool.query("DELETE FROM nexus_kv WHERE collection = $1 AND id = $2", [
      LEGACY_COLLECTION,
      id,
    ]);
  }
}

async function openBackend(url: string | undefined): Promise<IMemoryStore> {
  if (isNeonCompatibleUrl(url)) return new PgVectorStore({ databaseUrl: url });
  if (!isEmbeddedUrl(url)) return new InMemoryStore();
  const pool = getPgPool(url)!;
  const store = new PgVectorStore({
    sql: sqlFromQuery((text, params) => pool.query(text, params)),
  });
  await importLegacyKv(pool, store);
  return store;
}

class SharedMemoryStore implements IMemoryStore {
  private backend: Promise<IMemoryStore> | null = null;

  private inner(): Promise<IMemoryStore> {
    return (this.backend ??= openBackend(process.env.DATABASE_URL));
  }

  async save(entry: MemoryEntry) {
    return (await this.inner()).save(entry);
  }
  async search(queryEmbedding: number[], limit: number, filter?: MemoryFilter) {
    return (await this.inner()).search(queryEmbedding, limit, filter);
  }
  async delete(id: string) {
    return (await this.inner()).delete(id);
  }
  async list(filter?: MemoryFilter) {
    return (await this.inner()).list(filter);
  }
  async purge(filter?: MemoryFilter) {
    return (await this.inner()).purge(filter);
  }
}

const _shared = new SharedMemoryStore();

export function getMemoryStore(): IMemoryStore {
  return _shared;
}
