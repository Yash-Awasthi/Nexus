// SPDX-License-Identifier: Apache-2.0
/**
 * A memory store for databases without pgvector (the desktop's embedded
 * Postgres). Entries, embeddings included, are written through to
 * PersistentStore and searched in process — the same exact cosine search
 * InMemoryStore does, but it survives a restart.
 */

import {
  InMemoryStore,
  PgVectorStore,
  type IMemoryStore,
  type MemoryEntry,
  type MemoryFilter,
  type MemorySearchResult,
} from "@nexus/memory";

import { PersistentStore } from "./persistent-store.js";
import { isNeonCompatibleUrl } from "./pg-pool.js";

class KvMemoryStore implements IMemoryStore {
  private readonly mem = new InMemoryStore();
  private readonly rows: PersistentStore<MemoryEntry>;
  private readonly ready: Promise<void>;

  constructor(collection = "memory_entries") {
    this.rows = new PersistentStore<MemoryEntry>(collection);
    this.ready = this.rows.load().then(async () => {
      for (const e of this.rows.values()) await this.mem.save(e);
      return undefined;
    });
  }

  async save(entry: MemoryEntry): Promise<MemoryEntry> {
    await this.ready;
    this.rows.set(entry.id, entry);
    return this.mem.save(entry);
  }

  async search(
    queryEmbedding: number[],
    limit: number,
    filter?: MemoryFilter,
  ): Promise<MemorySearchResult[]> {
    await this.ready;
    return this.mem.search(queryEmbedding, limit, filter);
  }

  async delete(id: string): Promise<void> {
    await this.ready;
    this.rows.delete(id);
    await this.mem.delete(id);
  }

  async list(filter?: MemoryFilter): Promise<MemoryEntry[]> {
    await this.ready;
    return this.mem.list(filter);
  }

  async purge(filter?: MemoryFilter): Promise<number> {
    await this.ready;
    const gone = await this.mem.list(filter);
    for (const e of gone) this.rows.delete(e.id);
    return this.mem.purge(filter);
  }
}

/**
 * The one memory store every route shares: pgvector on a server database,
 * KvMemoryStore on the embedded one, process memory with no database at all.
 * Separate instances per route would each see only their own writes. Routes
 * build their managers at import, so the backend is chosen on first use.
 */
class SharedMemoryStore implements IMemoryStore {
  private backend: IMemoryStore | null = null;

  private get inner(): IMemoryStore {
    this.backend ??= isNeonCompatibleUrl(process.env.DATABASE_URL)
      ? new PgVectorStore({ databaseUrl: process.env.DATABASE_URL })
      : process.env.DATABASE_URL
        ? new KvMemoryStore()
        : new InMemoryStore();
    return this.backend;
  }

  save(entry: MemoryEntry) {
    return this.inner.save(entry);
  }
  search(queryEmbedding: number[], limit: number, filter?: MemoryFilter) {
    return this.inner.search(queryEmbedding, limit, filter);
  }
  delete(id: string) {
    return this.inner.delete(id);
  }
  list(filter?: MemoryFilter) {
    return this.inner.list(filter);
  }
  purge(filter?: MemoryFilter) {
    return this.inner.purge(filter);
  }
}

const _shared = new SharedMemoryStore();

export function getMemoryStore(): IMemoryStore {
  return _shared;
}
