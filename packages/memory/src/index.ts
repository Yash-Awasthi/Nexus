// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "node:crypto";

import { neon } from "@neondatabase/serverless";

/**
 * @nexus/memory — long-term agent memory with vector search.
 *
 * Architecture:
 *   IEmbedder        — text → float32 vector (swap in any model)
 *   IMemoryStore     — CRUD + k-NN search over MemoryEntry rows
 *   MemoryManager    — high-level API: remember / recall / forget / list
 *
 * Included implementations:
 *   FixedEmbedder    — deterministic pseudo-embedding for tests/dev (no API calls)
 *   InMemoryStore    — cosine-similarity vector store (dev / unit tests)
 *
 * Production path:
 *   Swap InMemoryStore for a PgVectorStore (pgvector + Drizzle) and
 *   FixedEmbedder for an OpenAI / local model embedder — no other changes.
 */

// ── Core types ────────────────────────────────────────────────────────────────

export interface MemoryEntry {
  /** UUID assigned at store time */
  id: string;
  /** The original text that was remembered */
  text: string;
  /** Float vector produced by the embedder */
  embedding: number[];
  /** Arbitrary metadata (agent id, source, tags, …) */
  metadata: Record<string, unknown>;
  /** Unix epoch seconds */
  createdAt: number;
  /** Optional TTL — entry is logically expired after this epoch second */
  expiresAt?: number;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  /** Cosine similarity in [0, 1] — higher is more similar */
  score: number;
}

export interface MemoryFilter {
  /** Only return entries where metadata matches all supplied key-value pairs */
  metadata?: Record<string, unknown>;
  /** Exclude logically expired entries (default: true) */
  excludeExpired?: boolean;
}

export interface RememberOptions {
  metadata?: Record<string, unknown>;
  /** TTL in seconds from now */
  ttl?: number;
}

// ── IEmbedder ─────────────────────────────────────────────────────────────────

export interface IEmbedder {
  /**
   * Convert a text string into a numeric embedding vector.
   * The dimensionality must be consistent across calls.
   */
  embed(text: string): Promise<number[]>;
  readonly dimensions: number;
}

// ── IMemoryStore ──────────────────────────────────────────────────────────────

export interface IMemoryStore {
  /**
   * Persist a MemoryEntry. Returns the stored entry (with server-side fields set).
   */
  save(entry: MemoryEntry): Promise<MemoryEntry>;

  /**
   * k-NN search — return up to `limit` entries ordered by cosine similarity
   * to the supplied query vector.
   */
  search(
    queryEmbedding: number[],
    limit: number,
    filter?: MemoryFilter,
  ): Promise<MemorySearchResult[]>;

  /**
   * Remove a single entry by id. No-op if not found.
   */
  delete(id: string): Promise<void>;

  /**
   * List all entries, optionally filtered.
   */
  list(filter?: MemoryFilter): Promise<MemoryEntry[]>;

  /**
   * Remove all entries matching the filter. Returns count removed.
   */
  purge(filter?: MemoryFilter): Promise<number>;
}

// ── MemoryError ───────────────────────────────────────────────────────────────

export type MemoryErrorCode =
  | "STORE_WRITE_FAILED"
  | "STORE_READ_FAILED"
  | "EMBED_FAILED"
  | "NOT_FOUND"
  | "DIMENSION_MISMATCH";

export class MemoryError extends Error {
  readonly code: MemoryErrorCode;
  constructor(code: MemoryErrorCode, message: string) {
    super(message);
    this.name = "MemoryError";
    this.code = code;
  }
}

// ── GroqEmbedder ──────────────────────────────────────────────────────────────

interface GroqEmbeddingResponse {
  data: { embedding: number[]; index: number }[];
  model: string;
}

export interface GroqEmbedderConfig {
  /** Groq API key — defaults to process.env.GROQ_API_KEY */
  apiKey?: string;
  /**
   * Groq embedding model.
   * Default: "nomic-embed-text-v1.5" (768 dimensions, free tier, fast).
   */
  model?: string;
}

/**
 * Real semantic embedder backed by the Groq embeddings API.
 *
 * Uses `nomic-embed-text-v1.5` (768-dimensional) by default.
 * Drop-in replacement for FixedEmbedder — same IEmbedder contract.
 * Requires GROQ_API_KEY env var (or pass apiKey in config).
 *
 * Usage:
 *   const memory = new MemoryManager({
 *     store: new InMemoryStore(),
 *     embedder: new GroqEmbedder({ apiKey: process.env.GROQ_API_KEY }),
 *   });
 */
export class GroqEmbedder implements IEmbedder {
  readonly dimensions = 768;
  private readonly apiKey: string;
  private readonly model: string;
  private static readonly ENDPOINT = "https://api.groq.com/openai/v1/embeddings";

  constructor(config: GroqEmbedderConfig = {}) {
    const key = config.apiKey ?? process.env.GROQ_API_KEY ?? "";
    if (!key) {
      throw new MemoryError(
        "EMBED_FAILED",
        "GroqEmbedder requires an API key — set GROQ_API_KEY or pass apiKey in config",
      );
    }
    this.apiKey = key;
    this.model = config.model ?? "nomic-embed-text-v1.5";
  }

  async embed(text: string): Promise<number[]> {
    let response: Response;
    try {
      response = await fetch(GroqEmbedder.ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: this.model, input: text }),
      });
    } catch (cause) {
      throw new MemoryError("EMBED_FAILED", `Groq embeddings request failed: ${String(cause)}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      throw new MemoryError("EMBED_FAILED", `Groq API error ${response.status}: ${body}`);
    }

    let data: GroqEmbeddingResponse;
    try {
      data = (await response.json()) as GroqEmbeddingResponse;
    } catch (cause) {
      throw new MemoryError("EMBED_FAILED", `Failed to parse Groq response: ${String(cause)}`);
    }

    const embedding = data.data[0]?.embedding;
    if (!embedding || embedding.length === 0) {
      throw new MemoryError("EMBED_FAILED", "Groq returned an empty embedding");
    }
    if (embedding.length !== this.dimensions) {
      throw new MemoryError(
        "DIMENSION_MISMATCH",
        `Expected ${this.dimensions} dimensions, got ${embedding.length}`,
      );
    }
    return embedding;
  }
}

// ── FixedEmbedder ─────────────────────────────────────────────────────────────

/**
 * Deterministic pseudo-embedder.
 * Maps each character to a dimension via a simple hash so that similar
 * strings produce similar vectors. Useful for tests and local dev without
 * any external API calls.
 *
 * NOT suitable for production semantic search.
 */
export class FixedEmbedder implements IEmbedder {
  readonly dimensions: number;

  constructor(dimensions = 128) {
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<number[]> {
    const vec = new Float32Array(this.dimensions);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      const idx = (code * 31 + i * 7) % this.dimensions;
      vec[idx] = (vec[idx] ?? 0) + code / 127;
    }
    return normalize(Array.from(vec));
  }
}

// ── InMemoryStore ─────────────────────────────────────────────────────────────

/**
 * In-memory vector store using exact cosine-similarity search.
 * O(n) per query — fine for development and unit tests.
 * Replace with PgVectorStore for production (uses pgvector IVFFlat index).
 */
export class InMemoryStore implements IMemoryStore {
  private readonly entries = new Map<string, MemoryEntry>();

  async save(entry: MemoryEntry): Promise<MemoryEntry> {
    this.entries.set(entry.id, { ...entry });
    return entry;
  }

  async search(
    queryEmbedding: number[],
    limit: number,
    filter?: MemoryFilter,
  ): Promise<MemorySearchResult[]> {
    const candidates = this._filtered(filter);
    const scored: MemorySearchResult[] = candidates.map((entry) => ({
      entry,
      score: cosineSimilarity(queryEmbedding, entry.embedding),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  async delete(id: string): Promise<void> {
    this.entries.delete(id);
  }

  async list(filter?: MemoryFilter): Promise<MemoryEntry[]> {
    return this._filtered(filter);
  }

  async purge(filter?: MemoryFilter): Promise<number> {
    const toRemove = this._filtered(filter);
    for (const e of toRemove) this.entries.delete(e.id);
    return toRemove.length;
  }

  /** Total entries (including expired). */
  get size(): number {
    return this.entries.size;
  }

  private _filtered(filter?: MemoryFilter): MemoryEntry[] {
    const excludeExpired = filter?.excludeExpired ?? true;
    const now = Math.floor(Date.now() / 1000);
    const results: MemoryEntry[] = [];

    for (const entry of this.entries.values()) {
      if (excludeExpired && entry.expiresAt !== undefined && entry.expiresAt < now) continue;

      if (filter?.metadata) {
        const matches = Object.entries(filter.metadata).every(([k, v]) => entry.metadata[k] === v);
        if (!matches) continue;
      }

      results.push(entry);
    }
    return results;
  }
}

// ── PgVectorStore ─────────────────────────────────────────────────────────────

export interface PgVectorStoreConfig {
  /** Postgres connection string — defaults to process.env.DATABASE_URL */
  databaseUrl?: string;
}

/**
 * Production vector store backed by Postgres + pgvector.
 *
 * Uses the Neon serverless HTTP driver for edge/serverless compatibility.
 * `ensureSchema()` is called lazily on the first operation — no manual
 * migration required; the table is created automatically.
 *
 * Similarity search uses pgvector's cosine distance operator (`<=>`).
 * Score returned = 1 - cosine_distance, so 1.0 = identical, 0.0 = orthogonal.
 */
export class PgVectorStore implements IMemoryStore {
  private readonly sql: ReturnType<typeof neon>;
  private schemaEnsured = false;

  constructor(config: PgVectorStoreConfig = {}) {
    const url = config.databaseUrl ?? process.env.DATABASE_URL ?? "";
    if (!url) {
      throw new MemoryError(
        "STORE_READ_FAILED",
        "PgVectorStore requires DATABASE_URL — pass databaseUrl or set the env var",
      );
    }
    this.sql = neon(url);
  }

  // ── Schema bootstrap ────────────────────────────────────────────────────────

  private async ensureSchema(): Promise<void> {
    if (this.schemaEnsured) return;
    try {
      await this.sql`CREATE EXTENSION IF NOT EXISTS vector`;
      await this.sql`
        CREATE TABLE IF NOT EXISTS memory_entries (
          id          TEXT        PRIMARY KEY,
          text        TEXT        NOT NULL,
          embedding   vector(768) NOT NULL,
          metadata    JSONB       NOT NULL DEFAULT '{}',
          created_at  INTEGER     NOT NULL,
          expires_at  INTEGER
        )
      `;
      await this.sql`
        CREATE INDEX IF NOT EXISTS memory_entries_created_at_idx
          ON memory_entries (created_at)
      `;
      this.schemaEnsured = true;
    } catch (cause) {
      throw new MemoryError("STORE_WRITE_FAILED", `Schema bootstrap failed: ${String(cause)}`);
    }
  }

  // ── IMemoryStore implementation ─────────────────────────────────────────────

  async save(entry: MemoryEntry): Promise<MemoryEntry> {
    await this.ensureSchema();
    const embStr = `[${entry.embedding.join(",")}]`;
    try {
      await this.sql`
        INSERT INTO memory_entries (id, text, embedding, metadata, created_at, expires_at)
        VALUES (
          ${entry.id},
          ${entry.text},
          ${embStr}::vector,
          ${JSON.stringify(entry.metadata)}::jsonb,
          ${entry.createdAt},
          ${entry.expiresAt ?? null}
        )
        ON CONFLICT (id) DO UPDATE SET
          text       = EXCLUDED.text,
          embedding  = EXCLUDED.embedding,
          metadata   = EXCLUDED.metadata,
          created_at = EXCLUDED.created_at,
          expires_at = EXCLUDED.expires_at
      `;
    } catch (cause) {
      throw new MemoryError("STORE_WRITE_FAILED", `save() failed: ${String(cause)}`);
    }
    return entry;
  }

  async search(
    queryEmbedding: number[],
    limit: number,
    filter?: MemoryFilter,
  ): Promise<MemorySearchResult[]> {
    await this.ensureSchema();
    const embStr = `[${queryEmbedding.join(",")}]`;
    const now = Math.floor(Date.now() / 1000);
    const excludeExpired = filter?.excludeExpired ?? true;

    let rows: Record<string, unknown>[];
    try {
      rows = (await this.sql`
        SELECT
          id,
          text,
          embedding::text  AS embedding_str,
          metadata,
          created_at,
          expires_at,
          1 - (embedding <=> ${embStr}::vector) AS score
        FROM memory_entries
        WHERE (
          ${excludeExpired ? 1 : 0}::int = 0
          OR expires_at IS NULL
          OR expires_at > ${now}
        )
        ORDER BY embedding <=> ${embStr}::vector
        LIMIT ${limit}
      `) as unknown as Record<string, unknown>[];
    } catch (cause) {
      throw new MemoryError("STORE_READ_FAILED", `search() failed: ${String(cause)}`);
    }

    const results: MemorySearchResult[] = [];
    for (const row of rows) {
      const entry = pgRowToEntry(row);
      if (filter?.metadata) {
        const matches = Object.entries(filter.metadata).every(([k, v]) => entry.metadata[k] === v);
        if (!matches) continue;
      }
      results.push({ entry, score: row.score as number });
    }
    return results;
  }

  async delete(id: string): Promise<void> {
    await this.ensureSchema();
    try {
      await this.sql`DELETE FROM memory_entries WHERE id = ${id}`;
    } catch (cause) {
      throw new MemoryError("STORE_WRITE_FAILED", `delete() failed: ${String(cause)}`);
    }
  }

  async list(filter?: MemoryFilter): Promise<MemoryEntry[]> {
    await this.ensureSchema();
    const now = Math.floor(Date.now() / 1000);
    const excludeExpired = filter?.excludeExpired ?? true;

    let rows: Record<string, unknown>[];
    try {
      rows = (await this.sql`
        SELECT id, text, embedding::text AS embedding_str, metadata, created_at, expires_at
        FROM memory_entries
        WHERE (
          ${excludeExpired ? 1 : 0}::int = 0
          OR expires_at IS NULL
          OR expires_at > ${now}
        )
        ORDER BY created_at DESC
      `) as unknown as Record<string, unknown>[];
    } catch (cause) {
      throw new MemoryError("STORE_READ_FAILED", `list() failed: ${String(cause)}`);
    }

    const entries = rows.map(pgRowToEntry);
    if (!filter?.metadata) return entries;

    return entries.filter((entry) =>
      Object.entries(filter.metadata!).every(([k, v]) => entry.metadata[k] === v),
    );
  }

  async purge(filter?: MemoryFilter): Promise<number> {
    await this.ensureSchema();
    const now = Math.floor(Date.now() / 1000);
    const excludeExpired = filter?.excludeExpired ?? true;

    if (!filter?.metadata) {
      // Fast path: single DELETE without fetching rows first
      try {
        const deleted = (await this.sql`
          DELETE FROM memory_entries
          WHERE (
            ${excludeExpired ? 1 : 0}::int = 0
            OR expires_at IS NULL
            OR expires_at > ${now}
          )
          RETURNING id
        `) as unknown as Record<string, unknown>[];
        return deleted.length;
      } catch (cause) {
        throw new MemoryError("STORE_WRITE_FAILED", `purge() failed: ${String(cause)}`);
      }
    }

    // Metadata-filtered path: list matching entries then delete individually
    const entries = await this.list(filter);
    if (entries.length === 0) return 0;
    try {
      for (const entry of entries) {
        await this.sql`DELETE FROM memory_entries WHERE id = ${entry.id}`;
      }
    } catch (cause) {
      throw new MemoryError("STORE_WRITE_FAILED", `purge(metadata) failed: ${String(cause)}`);
    }
    return entries.length;
  }
}

/** Convert a raw Postgres row to a MemoryEntry. */
function pgRowToEntry(row: Record<string, unknown>): MemoryEntry {
  const embStr = row.embedding_str as string;
  const embedding = embStr
    .slice(1, -1)
    .split(",")
    .map((v) => parseFloat(v));
  return {
    id: row.id as string,
    text: row.text as string,
    embedding,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: row.created_at as number,
    ...(row.expires_at != null ? { expiresAt: row.expires_at as number } : {}),
  };
}

// ── MemoryManager ─────────────────────────────────────────────────────────────

export interface MemoryManagerConfig {
  store: IMemoryStore;
  embedder: IEmbedder;
  /** Default k for recall() when limit is not supplied */
  defaultRecallLimit?: number;
}

/**
 * High-level agent memory API.
 *
 * Usage:
 *   const memory = new MemoryManager({
 *     store: new InMemoryStore(),
 *     embedder: new FixedEmbedder(),
 *   });
 *
 *   await memory.remember("The user prefers dark mode", { metadata: { agentId: "ui-agent" } });
 *   const results = await memory.recall("user preferences");
 */
export class MemoryManager {
  private readonly store: IMemoryStore;
  private readonly embedder: IEmbedder;
  private readonly defaultLimit: number;

  constructor(config: MemoryManagerConfig) {
    this.store = config.store;
    this.embedder = config.embedder;
    this.defaultLimit = config.defaultRecallLimit ?? 5;
  }

  /**
   * Embed and persist a text memory.
   * Returns the stored MemoryEntry.
   */
  async remember(text: string, options: RememberOptions = {}): Promise<MemoryEntry> {
    let embedding: number[];
    try {
      embedding = await this.embedder.embed(text);
    } catch (cause) {
      throw new MemoryError("EMBED_FAILED", `Embedding failed: ${String(cause)}`);
    }

    const now = Math.floor(Date.now() / 1000);
    const entry: MemoryEntry = {
      id: randomUUID(),
      text,
      embedding,
      metadata: options.metadata ?? {},
      createdAt: now,
      ...(options.ttl !== undefined ? { expiresAt: now + options.ttl } : {}),
    };

    try {
      return await this.store.save(entry);
    } catch (cause) {
      throw new MemoryError("STORE_WRITE_FAILED", `Store write failed: ${String(cause)}`);
    }
  }

  /**
   * Semantic recall — embed the query and return the k most similar memories.
   */
  async recall(
    query: string,
    limit?: number,
    filter?: MemoryFilter,
  ): Promise<MemorySearchResult[]> {
    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.embedder.embed(query);
    } catch (cause) {
      throw new MemoryError("EMBED_FAILED", `Query embedding failed: ${String(cause)}`);
    }

    try {
      return await this.store.search(queryEmbedding, limit ?? this.defaultLimit, filter);
    } catch (cause) {
      throw new MemoryError("STORE_READ_FAILED", `Store search failed: ${String(cause)}`);
    }
  }

  /**
   * Remove a specific memory by id.
   */
  async forget(id: string): Promise<void> {
    await this.store.delete(id);
  }

  /**
   * List all stored memories, optionally filtered.
   */
  async list(filter?: MemoryFilter): Promise<MemoryEntry[]> {
    return this.store.list(filter);
  }

  /**
   * Bulk-delete memories matching a filter. Returns count removed.
   */
  async purge(filter?: MemoryFilter): Promise<number> {
    return this.store.purge(filter);
  }

  /**
   * Summarise the memory store (count, oldest, newest).
   */
  async stats(): Promise<{ total: number; oldest?: number; newest?: number }> {
    const all = await this.store.list({ excludeExpired: false });
    if (all.length === 0) return { total: 0 };
    const times = all.map((e) => e.createdAt);
    return {
      total: all.length,
      oldest: Math.min(...times),
      newest: Math.max(...times),
    };
  }
}

// ── Math helpers ──────────────────────────────────────────────────────────────

function dot(a: number[], b: number[]): number {
  let sum = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

function magnitude(v: number[]): number {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  const magA = magnitude(a);
  const magB = magnitude(b);
  if (magA === 0 || magB === 0) return 0;
  return dot(a, b) / (magA * magB);
}

export function normalize(v: number[]): number[] {
  const mag = magnitude(v);
  if (mag === 0) return v;
  return v.map((x) => x / mag);
}
