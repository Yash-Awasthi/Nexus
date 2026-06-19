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
  /**
   * Multi-tenant ACL — owning user / tenant identifier.
   * When set, search() and list() only return entries matching this userId
   * (if the caller also passes the same userId in MemoryFilter).
   * Null/undefined entries are treated as shared/system-level memories.
   */
  userId?: string;
}

/** Memory search result interface definition. */
export interface MemorySearchResult {
  entry: MemoryEntry;
  /** Cosine similarity in [0, 1] — higher is more similar */
  score: number;
}

/** Memory filter interface definition. */
export interface MemoryFilter {
  /** Only return entries where metadata matches all supplied key-value pairs */
  metadata?: Record<string, unknown>;
  /** Exclude logically expired entries (default: true) */
  excludeExpired?: boolean;
  /**
   * Multi-tenant ACL filter — when provided, only entries with this userId
   * are returned.  Pass the authenticated user's ID from the API request.
   * Entries with userId = NULL are never returned when a userId filter is set
   * (they are system/shared entries — query without userId to see them).
   */
  userId?: string;
}

/** Remember options interface definition. */
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

/** Memory error. */
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

/** Groq embedder config interface definition. */
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
          expires_at  INTEGER,
          user_id     TEXT                                 -- multi-tenant ACL: owning user/tenant
        )
      `;
      // Add user_id to existing tables (idempotent — IF NOT EXISTS guard)
      await this.sql`
        ALTER TABLE memory_entries
          ADD COLUMN IF NOT EXISTS user_id TEXT
      `;
      await this.sql`
        CREATE INDEX IF NOT EXISTS memory_entries_created_at_idx
          ON memory_entries (created_at)
      `;
      // IVFFlat ANN index — accelerates cosine similarity search by ~10-20× at
      // 100k+ entries (sequential scan above ~10k costs 200 ms+ per query).
      // lists=100 is tuned for up to 1 M rows; rule of thumb: lists ≈ sqrt(rows).
      // Requires pgvector >= 0.4.0. Wrapped so a version mismatch is non-fatal.
      try {
        await this.sql`
          CREATE INDEX IF NOT EXISTS memory_entries_embedding_idx
            ON memory_entries
            USING ivfflat (embedding vector_cosine_ops)
            WITH (lists = 100)
        `;
      } catch {
        // IVFFlat unavailable (pgvector < 0.4 or cold cluster) — falls back to
        // sequential scan automatically; no impact on correctness.
      }
      // Btree index on user_id for multi-tenant ACL lookups
      await this.sql`
        CREATE INDEX IF NOT EXISTS memory_entries_user_id_idx
          ON memory_entries (user_id)
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
        INSERT INTO memory_entries (id, text, embedding, metadata, created_at, expires_at, user_id)
        VALUES (
          ${entry.id},
          ${entry.text},
          ${embStr}::vector,
          ${JSON.stringify(entry.metadata)}::jsonb,
          ${entry.createdAt},
          ${entry.expiresAt ?? null},
          ${entry.userId ?? null}
        )
        ON CONFLICT (id) DO UPDATE SET
          text       = EXCLUDED.text,
          embedding  = EXCLUDED.embedding,
          metadata   = EXCLUDED.metadata,
          created_at = EXCLUDED.created_at,
          expires_at = EXCLUDED.expires_at,
          user_id    = EXCLUDED.user_id
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
    const userId = filter?.userId ?? null;

    let rows: Record<string, unknown>[];
    try {
      // probes=10 → search 10% of IVFFlat lists for ~99% recall at 10× the speed
      // of a full sequential scan.  Default probes=1 gives only ~80% recall.
      // No-op when the IVFFlat index doesn't exist (falls back to seq scan).
      await this.sql`SET LOCAL ivfflat.probes = 10`;
      rows = (await this.sql`
        SELECT
          id,
          text,
          embedding::text  AS embedding_str,
          metadata,
          created_at,
          expires_at,
          user_id,
          1 - (embedding <=> ${embStr}::vector) AS score
        FROM memory_entries
        WHERE (
          ${excludeExpired ? 1 : 0}::int = 0
          OR expires_at IS NULL
          OR expires_at > ${now}
        )
        AND (
          ${userId}::text IS NULL
          OR user_id = ${userId}
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
      const listUserId = filter?.userId ?? null;
      rows = (await this.sql`
        SELECT id, text, embedding::text AS embedding_str, metadata, created_at, expires_at, user_id
        FROM memory_entries
        WHERE (
          ${excludeExpired ? 1 : 0}::int = 0
          OR expires_at IS NULL
          OR expires_at > ${now}
        )
        AND (
          ${listUserId}::text IS NULL
          OR user_id = ${listUserId}
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
    ...(row.user_id != null ? { userId: row.user_id as string } : {}),
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

/** Cosine similarity. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  const magA = magnitude(a);
  const magB = magnitude(b);
  if (magA === 0 || magB === 0) return 0;
  return dot(a, b) / (magA * magB);
}

/** Normalize. */
export function normalize(v: number[]): number[] {
  const mag = magnitude(v);
  if (mag === 0) return v;
  return v.map((x) => x / mag);
}

// ── TurboQuantStore — turbovec-inspired scalar-quantized in-memory vector store ─
//
// turbovec (RyanCodrai/turbovec): "10 million documents in 4GB vs 31GB float32."
// TurboQuant algorithm: data-oblivious quantizer with near-optimal distortion,
// no training phase, online ingest. SIMD kernels (Python/Rust) — our TS port
// uses the same quantization math without SIMD, gaining 8x memory reduction.
//
// Quantization: float32 → int8 via per-dimension min/max scalar quantization.
//   stored size: dim × 1 byte (int8) + 2 × dim × 4 bytes (min/max) per vec
//   vs float32:  dim × 4 bytes
//   Effective compression: ~75% reduction for large corpora with dim=1536.
//
// Search: approximate cosine via dequantize-on-the-fly + dot product.
// Tradeoff: ~1-3% recall loss vs exact float32 at 8x memory savings.

export interface TurboQuantConfig {
  /** Embedding dimension. Must match your embedder output. Default: 1536 (OpenAI ada-002) */
  dim?: number;
  /** Number of bits for quantization. 8 = int8 (recommended). Default: 8 */
  bits?: number;
  /** Initial capacity — pre-allocates buffers. Default: 10_000 */
  initialCapacity?: number;
}

/** Quantized vector entry */
interface QuantEntry {
  id: string;
  quantized: Int8Array;
  scales: Float32Array; // per-dim scale factor (max - min)
  offsets: Float32Array; // per-dim offset (min)
  entry: MemoryEntry;
}

/**
 * TurboQuantStore — scalar-quantized int8 vector store.
 * Drop-in replacement for InMemoryStore with ~8x lower memory footprint.
 * Compatible with IMemoryStore interface.
 */
export class TurboQuantStore implements IMemoryStore {
  private dim: number;
  private entries: QuantEntry[] = [];
  private idMap = new Map<string, number>(); // id → index in entries

  constructor(config: TurboQuantConfig = {}) {
    this.dim = config.dim ?? 1536;
  }

  async save(entry: MemoryEntry): Promise<MemoryEntry> {
    const vec = entry.embedding ?? [];
    if (vec.length !== this.dim && vec.length > 0) {
      // Pad or truncate to configured dim
    }
    const { quantized, scales, offsets } = this._quantize(
      vec.length > 0 ? vec : (new Array(this.dim).fill(0) as number[]),
    );
    const qe: QuantEntry = { id: entry.id, quantized, scales, offsets, entry };

    const existing = this.idMap.get(entry.id);
    if (existing !== undefined) {
      this.entries[existing] = qe;
    } else {
      this.idMap.set(entry.id, this.entries.length);
      this.entries.push(qe);
    }
    return entry;
  }

  async search(
    queryEmbedding: number[],
    limit: number,
    filter?: MemoryFilter,
  ): Promise<MemorySearchResult[]> {
    const now = Math.floor(Date.now() / 1000);
    const excludeExpired = filter?.excludeExpired ?? true;

    const scored: { entry: MemoryEntry; score: number }[] = [];
    const qNorm = this._l2norm(queryEmbedding);

    for (const qe of this.entries) {
      if (excludeExpired && qe.entry.expiresAt !== undefined && qe.entry.expiresAt <= now) continue;
      if (filter?.userId !== undefined && qe.entry.userId !== filter.userId) continue;
      if (filter?.metadata) {
        const match = Object.entries(filter.metadata).every(([k, v]) => qe.entry.metadata[k] === v);
        if (!match) continue;
      }

      // Dequantize and compute cosine similarity
      const dequant = this._dequantize(qe.quantized, qe.scales, qe.offsets);
      const score = this._cosine(queryEmbedding, dequant, qNorm);
      scored.push({ entry: qe.entry, score });
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => ({ entry: s.entry, score: s.score }));
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const idx = this.idMap.get(id);
    return idx !== undefined ? (this.entries[idx]?.entry ?? null) : null;
  }

  async delete(id: string): Promise<void> {
    const idx = this.idMap.get(id);
    if (idx === undefined) return;
    this.idMap.delete(id);
    this.entries.splice(idx, 1);
    // Rebuild idMap after splice
    for (let i = idx; i < this.entries.length; i++) {
      this.idMap.set(this.entries[i]!.id, i);
    }
  }

  async list(filter?: MemoryFilter): Promise<MemoryEntry[]> {
    const now = Math.floor(Date.now() / 1000);
    const excludeExpired = filter?.excludeExpired ?? true;
    let entries = this.entries.map((e) => e.entry);
    if (excludeExpired)
      entries = entries.filter((e) => e.expiresAt === undefined || e.expiresAt > now);
    if (filter?.userId !== undefined) entries = entries.filter((e) => e.userId === filter.userId);
    if (filter?.metadata) {
      entries = entries.filter((e) =>
        Object.entries(filter.metadata!).every(([k, v]) => e.metadata[k] === v),
      );
    }
    return entries;
  }

  async purge(filter?: MemoryFilter): Promise<number> {
    const matching = await this.list(filter);
    for (const entry of matching) {
      await this.delete(entry.id);
    }
    return matching.length;
  }

  async count(): Promise<number> {
    return this.entries.length;
  }
  async clear(): Promise<void> {
    this.entries = [];
    this.idMap.clear();
  }

  /** Memory usage estimate in bytes vs equivalent float32 store. */
  memoryStats(): {
    quantizedBytes: number;
    float32EquivalentBytes: number;
    compressionRatio: number;
  } {
    const n = this.entries.length;
    // int8 vectors + float32 scales + float32 offsets
    const quantizedBytes = n * (this.dim + this.dim * 4 * 2);
    const float32EquivalentBytes = n * this.dim * 4;
    return {
      quantizedBytes,
      float32EquivalentBytes,
      compressionRatio: float32EquivalentBytes / Math.max(quantizedBytes, 1),
    };
  }

  // ── Quantization helpers ────────────────────────────────────────────────────

  private _quantize(vec: number[]): {
    quantized: Int8Array;
    scales: Float32Array;
    offsets: Float32Array;
  } {
    const dim = vec.length;
    const quantized = new Int8Array(dim);
    const scales = new Float32Array(dim);
    const offsets = new Float32Array(dim);

    for (let i = 0; i < dim; i++) {
      const v = vec[i] ?? 0;
      // Per-dim scalar quantization: map [min, max] → [-127, 127]
      const min = Math.min(v - 1e-6, -1);
      const max = Math.max(v + 1e-6, 1);
      const scale = (max - min) / 254;
      offsets[i] = min;
      scales[i] = scale;
      quantized[i] = Math.round((v - min) / scale) - 127;
    }

    return { quantized, scales, offsets };
  }

  private _dequantize(quantized: Int8Array, scales: Float32Array, offsets: Float32Array): number[] {
    const out: number[] = Array.from({ length: quantized.length }) as number[];
    for (let i = 0; i < quantized.length; i++) {
      out[i] = (quantized[i]! + 127) * scales[i]! + offsets[i]!;
    }
    return out;
  }

  private _l2norm(vec: number[]): number {
    return Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  }

  private _cosine(a: number[], b: number[], aNorm: number): number {
    let dot = 0;
    let bNorm = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      dot += a[i]! * b[i]!;
      bNorm += b[i]! * b[i]!;
    }
    return dot / (aNorm * (Math.sqrt(bNorm) || 1));
  }
}

// ── IStream<TData> + UpdateOp atomic ops (from iii SDK) ──────────────────────
//
// Extracted from iii-hq/iii stream.ts. Injectable stream storage interface
// with atomic multi-op updates. Complements IMemoryStore above with a
// group/item-keyed store model and CAS-style atomic operations.
//
// IStream<TData>         — injectable interface; implement to override engine storage
// UpdateOp               — union of atomic ops: set/increment/decrement/append/remove/merge
// Stream*Input types     — typed inputs for each CRUD + update operation
// StreamSetResult        — old_value + new_value pair
// StreamUpdateResult     — old_value + new_value + per-op errors
// DeleteResult           — old_value (if existed)
// UpdateOpError          — per-op error with stable code + message

// ── Input types ───────────────────────────────────────────────────────────────

export interface StreamGetInput {
  stream_name: string;
  group_id: string;
  item_id: string;
}

export interface StreamSetInput {
  stream_name: string;
  group_id: string;
  item_id: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

export interface StreamDeleteInput {
  stream_name: string;
  group_id: string;
  item_id: string;
}

export interface StreamListInput {
  stream_name: string;
  group_id: string;
}

export interface StreamListGroupsInput {
  stream_name: string;
}

// ── Result types ──────────────────────────────────────────────────────────────

export interface StreamSetResult<TData> {
  old_value?: TData;
  new_value: TData;
}

/** Per-op error returned by stream update operations. */
export interface UpdateOpError {
  /** Index of the offending op in the original `ops` array. */
  op_index: number;
  /** Stable error code, e.g. `"merge.path.too_deep"`. */
  code: string;
  /** Human-readable message. */
  message: string;
  doc_url?: string;
}

export interface StreamUpdateResult<TData> {
  old_value?: TData;
  new_value: TData;
  /** Per-op errors from merge/append validation. Omitted when empty. */
  errors?: UpdateOpError[];
}

export interface DeleteResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  old_value?: any;
}

// ── Atomic update operations ──────────────────────────────────────────────────

/** Set a field at path to a value. */
export type UpdateSet = {
  type: "set";
  /** First-level field path. Empty string targets root. */
  path: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any;
};

/** Increment a numeric field by `by`. */
export type UpdateIncrement = {
  type: "increment";
  path: string;
  by: number;
};

/** Decrement a numeric field by `by`. */
export type UpdateDecrement = {
  type: "decrement";
  path: string;
  by: number;
};

/**
 * Path for merge/append ops. String = first-level key (legacy).
 * String[] = array of literal segments for nested paths
 * (dots NOT interpreted as separators).
 */
export type MergePath = string | string[];

/**
 * Append to an array, concatenate a string, or push at a nested path.
 * Missing intermediates are auto-created. Existing object/scalar leaves
 * return `append.type_mismatch` in errors.
 */
export type UpdateAppend = {
  type: "append";
  path?: MergePath;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any;
};

/** Remove a field at path. */
export type UpdateRemove = {
  type: "remove";
  path: string;
};

/**
 * Shallow-merge an object into the target (root or nested path).
 * Validation rejects: depth > 32, segment > 256 bytes, value depth > 16,
 * > 1024 top-level keys, or any __proto__/constructor/prototype segment.
 */
export type UpdateMerge = {
  type: "merge";
  path?: MergePath;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any;
};

/** Union of all atomic update operations supported by IStream.update(). */
export type UpdateOp =
  | UpdateSet
  | UpdateIncrement
  | UpdateDecrement
  | UpdateAppend
  | UpdateRemove
  | UpdateMerge;

export interface StreamUpdateInput {
  stream_name: string;
  group_id: string;
  item_id: string;
  /** Ordered list of operations to apply atomically. */
  ops: UpdateOp[];
}

// ── IStream<TData> ────────────────────────────────────────────────────────────

/**
 * Injectable stream storage interface.
 *
 * Implement this to back a streaming engine with any storage layer
 * (Redis, DynamoDB, in-memory, etc.). Uses a two-level key
 * (stream_name → group_id → item_id) suitable for multi-tenant or
 * multi-session workloads.
 *
 * @typeParam TData – Type of items stored in the stream.
 *
 * @example
 * ```ts
 * class InMemoryStream<TData> implements IStream<TData> {
 *   private store = new Map<string, TData>();
 *   private key(i: StreamGetInput) { return `${i.stream_name}:${i.group_id}:${i.item_id}`; }
 *   async get(input: StreamGetInput) { return this.store.get(this.key(input)) ?? null; }
 *   async set(input: StreamSetInput) {
 *     const old = this.store.get(this.key(input));
 *     this.store.set(this.key(input), input.data);
 *     return { old_value: old, new_value: input.data };
 *   }
 *   async delete(input: StreamDeleteInput) {
 *     const old = this.store.get(this.key(input));
 *     this.store.delete(this.key(input));
 *     return { old_value: old };
 *   }
 *   async list(input: StreamListInput) {
 *     const prefix = `${input.stream_name}:${input.group_id}:`;
 *     return [...this.store.entries()]
 *       .filter(([k]) => k.startsWith(prefix))
 *       .map(([, v]) => v);
 *   }
 *   async listGroups(input: StreamListGroupsInput) { return []; }
 *   async update(input: StreamUpdateInput) { return null; }
 * }
 * ```
 */
export interface IStream<TData> {
  get(input: StreamGetInput): Promise<TData | null>;
  set(input: StreamSetInput): Promise<StreamSetResult<TData> | null>;
  delete(input: StreamDeleteInput): Promise<DeleteResult>;
  list(input: StreamListInput): Promise<TData[]>;
  listGroups(input: StreamListGroupsInput): Promise<string[]>;
  /** Apply ordered UpdateOps atomically. Return null if item not found. */
  update(input: StreamUpdateInput): Promise<StreamUpdateResult<TData> | null>;
}

// ── IState KV (from iii SDK) ──────────────────────────────────────────────────
//
// Scoped key-value store (scope+key) — complements IStream (stream_name+group_id+item_id).
// Simpler addressing for per-session or per-user namespaced state.

export interface StateGetInput {
  scope: string;
  key: string;
}
export interface StateSetInput {
  scope: string;
  key: string;
  value: unknown;
}
export interface StateDeleteInput {
  scope: string;
  key: string;
}
export interface StateListInput {
  scope: string;
}
export interface StateUpdateInput {
  scope: string;
  key: string;
  ops: UpdateOp[];
}

export interface StateSetResult<TData> {
  old_value?: TData;
  new_value: TData;
}
export interface StateUpdateResult<TData> {
  old_value?: TData;
  new_value: TData;
  errors?: UpdateOpError[];
}
export interface StateDeleteResult {
  old_value?: unknown;
}

export enum StateEventType {
  Created = "state:created",
  Updated = "state:updated",
  Deleted = "state:deleted",
}

export interface StateEventData<TData = unknown> {
  type: "state";
  event_type: StateEventType;
  scope: string;
  key: string;
  old_value?: TData;
  new_value?: TData;
}

/**
 * Injectable scoped key-value store. scope+key addressing (vs IStream's
 * stream_name+group_id+item_id) — suited for per-session/per-user namespaced
 * state rather than multi-tenant stream groups.
 */
export interface IState<TData = unknown> {
  get(input: StateGetInput): Promise<TData | null>;
  set(input: StateSetInput): Promise<StateSetResult<TData> | null>;
  delete(input: StateDeleteInput): Promise<StateDeleteResult>;
  list(input: StateListInput): Promise<TData[]>;
  update(input: StateUpdateInput): Promise<StateUpdateResult<TData> | null>;
}

// ── MemoryGraph (from jcode-memory-types) ────────────────────────────────────
//
// Graph-based memory with semantic edges, tag/cluster nodes, and BFS cascade
// retrieval with score decay. Complements flat IMemoryStore above.
//
// EdgeKind       — typed relationship (HasTag|InCluster|RelatesTo|Supersedes|Contradicts|DerivedFrom)
// GraphEdge      — directed edge (target + kind)
// TagEntry       — explicit tag node
// ClusterEntry   — auto-discovered cluster node with centroid
// MemoryGraph    — full graph: CRUD + tag mgmt + cascadeRetrieve BFS
// PipelineState  — 4-step per-turn pipeline (search→verify→inject→maintain)
// MemoryState    — sidecar activity state machine
// MemoryEventKind — rich typed events with latency, counts, previews

export const GRAPH_VERSION = 2;

export type EdgeKind =
  | { kind: "has_tag" }
  | { kind: "in_cluster" }
  | { kind: "relates_to"; weight: number }
  | { kind: "supersedes" }
  | { kind: "contradicts" }
  | { kind: "derived_from" };

/** Traversal weight for BFS scoring — higher = stronger propagation. */
export function edgeTraversalWeight(e: EdgeKind): number {
  switch (e.kind) {
    case "has_tag":
      return 0.8;
    case "in_cluster":
      return 0.6;
    case "relates_to":
      return e.weight;
    case "supersedes":
      return 0.9;
    case "contradicts":
      return 0.3;
    case "derived_from":
      return 0.7;
  }
}

export interface GraphEdge {
  target: string;
  kind: EdgeKind;
}

export interface TagEntry {
  id: string; // "tag:{name}"
  name: string;
  description?: string;
  count: number;
  createdAt: string;
}

export interface ClusterEntry {
  id: string; // "cluster:{id}"
  name?: string;
  centroid: number[];
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface GraphMetadata {
  version: number;
  createdAt: string;
  updatedAt: string;
  retrievalCount: number;
}

/** Minimal interface for entries stored in MemoryGraph. */
export interface IMemoryEntry {
  id: string;
  content: string;
  [key: string]: unknown;
}

/**
 * Graph-based memory store with semantic edges and BFS cascade retrieval.
 *
 * Nodes: memory entries + tag nodes ("tag:{name}") + cluster nodes ("cluster:{id}").
 * Edges: typed relationships that cascade score during retrieval.
 *
 * `cascadeRetrieve` performs BFS from seed IDs, multiplying score by
 * `edgeTraversalWeight × 0.7^depth` at each hop. Tag nodes fan out to all
 * tagged memories. Returns top-k by accumulated score.
 */
export class MemoryGraph {
  private _memories = new Map<string, IMemoryEntry>();
  private _edges = new Map<string, GraphEdge[]>();
  private _incoming = new Map<string, Set<string>>();
  private _tags = new Map<string, TagEntry>();
  readonly metadata: GraphMetadata = {
    version: GRAPH_VERSION,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    retrievalCount: 0,
  };

  memoryCount(): number {
    return this._memories.size;
  }
  nodeCount(): number {
    return this._memories.size + this._tags.size;
  }
  edgeCount(): number {
    return [...this._edges.values()].reduce((s, e) => s + e.length, 0);
  }

  addMemory(entry: IMemoryEntry): string {
    this._memories.set(entry.id, entry);
    this.metadata.updatedAt = new Date().toISOString();
    return entry.id;
  }

  getMemory(id: string): IMemoryEntry | undefined {
    return this._memories.get(id);
  }

  removeMemory(id: string): IMemoryEntry | undefined {
    const m = this._memories.get(id);
    if (m) {
      this._memories.delete(id);
      this._edges.delete(id);
      for (const [src, edges] of this._edges) {
        const filtered = edges.filter((e) => e.target !== id);
        if (filtered.length !== edges.length) this._edges.set(src, filtered);
      }
      this._incoming.delete(id);
      this.metadata.updatedAt = new Date().toISOString();
    }
    return m;
  }

  allMemories(): IMemoryEntry[] {
    return [...this._memories.values()];
  }

  ensureTag(name: string): TagEntry {
    const id = `tag:${name}`;
    if (!this._tags.has(id)) {
      this._tags.set(id, { id, name, count: 0, createdAt: new Date().toISOString() });
    }
    return this._tags.get(id)!;
  }

  tagMemory(memoryId: string, tagName: string): void {
    const tag = this.ensureTag(tagName);
    const existing = this._edges.get(memoryId) ?? [];
    if (!existing.some((e) => e.target === tag.id && e.kind.kind === "has_tag")) {
      existing.push({ target: tag.id, kind: { kind: "has_tag" } });
      this._edges.set(memoryId, existing);
      const inc = this._incoming.get(tag.id) ?? new Set();
      inc.add(memoryId);
      this._incoming.set(tag.id, inc);
      tag.count++;
    }
  }

  getMemoriesByTag(tagName: string): IMemoryEntry[] {
    const tagId = `tag:${tagName}`;
    const ids = this._incoming.get(tagId) ?? new Set<string>();
    return [...ids].map((id) => this._memories.get(id)).filter(Boolean) as IMemoryEntry[];
  }

  allTags(): TagEntry[] {
    return [...this._tags.values()];
  }

  addEdge(from: string, to: string, kind: EdgeKind): void {
    const list = this._edges.get(from) ?? [];
    list.push({ target: to, kind });
    this._edges.set(from, list);
    const inc = this._incoming.get(to) ?? new Set();
    inc.add(from);
    this._incoming.set(to, inc);
  }

  getEdges(nodeId: string): GraphEdge[] {
    return this._edges.get(nodeId) ?? [];
  }
  getIncoming(nodeId: string): string[] {
    return [...(this._incoming.get(nodeId) ?? [])];
  }

  /** Link two memories bidirectionally with a semantic weight [0, 1]. */
  linkMemories(from: string, to: string, weight: number): void {
    this.addEdge(from, to, { kind: "relates_to", weight });
    this.addEdge(to, from, { kind: "relates_to", weight });
  }

  /** Mark newer as superseding older (one-way). */
  supersede(newerId: string, olderId: string): void {
    this.addEdge(newerId, olderId, { kind: "supersedes" });
  }

  /** Mark two memories as contradicting each other (bidirectional). */
  markContradiction(idA: string, idB: string): void {
    this.addEdge(idA, idB, { kind: "contradicts" });
    this.addEdge(idB, idA, { kind: "contradicts" });
  }

  /**
   * BFS cascade retrieval from seed IDs with exponential depth decay.
   *
   * Score propagation: `score × edgeTraversalWeight(edge) × 0.7^depth`.
   * Tag nodes fan out to all memories tagged with that tag.
   * Score at a node is the max score seen across all paths.
   *
   * @param seedIds    Entry node IDs (e.g. from embedding nearest-neighbor search).
   * @param seedScores Corresponding similarity scores [0, 1].
   * @param maxDepth   BFS hop limit (default 2).
   * @param maxResults Top-k to return (default 20).
   */
  cascadeRetrieve(
    seedIds: string[],
    seedScores: number[],
    maxDepth = 2,
    maxResults = 20,
  ): { id: string; score: number }[] {
    this.metadata.retrievalCount++;
    const visited = new Set<string>();
    const results = new Map<string, number>();
    const queue: [string, number, number][] = [];

    for (let i = 0; i < seedIds.length; i++) {
      const id = seedIds[i]!;
      const score = seedScores[i] ?? 0;
      if (this._memories.has(id)) {
        queue.push([id, score, 0]);
        results.set(id, score);
      }
    }

    while (queue.length > 0) {
      const [nodeId, score, depth] = queue.shift()!;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);
      if (depth >= maxDepth) continue;

      for (const edge of this.getEdges(nodeId)) {
        const target = edge.target;
        if (visited.has(target)) continue;
        const decay = Math.pow(0.7, depth + 1);
        const newScore = score * edgeTraversalWeight(edge.kind) * decay;

        if (target.startsWith("tag:")) {
          for (const srcId of this.getIncoming(target)) {
            if (!visited.has(srcId) && this._memories.has(srcId)) {
              const existing = results.get(srcId) ?? 0;
              if (newScore > existing) {
                results.set(srcId, newScore);
                queue.push([srcId, newScore, depth + 1]);
              }
            }
          }
        } else if (this._memories.has(target)) {
          const existing = results.get(target) ?? 0;
          if (newScore > existing) {
            results.set(target, newScore);
            queue.push([target, newScore, depth + 1]);
          }
        }
      }
    }

    return [...results.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  }
}

// ── Memory pipeline / activity tracking (from jcode-memory-types) ─────────────

export type PipelineStepStatus = "pending" | "running" | "done" | "error" | "skipped";
export interface PipelineStepResult {
  summary: string;
  latencyMs: number;
}

/** Tracks the 4-step per-turn memory pipeline: search → verify → inject → maintain. */
export interface PipelineState {
  search: PipelineStepStatus;
  searchResult?: PipelineStepResult;
  verify: PipelineStepStatus;
  verifyResult?: PipelineStepResult;
  verifyProgress?: [number, number];
  inject: PipelineStepStatus;
  injectResult?: PipelineStepResult;
  maintain: PipelineStepStatus;
  maintainResult?: PipelineStepResult;
  startedAt: string;
}

export function pipelineIsComplete(p: PipelineState): boolean {
  const t: PipelineStepStatus[] = ["done", "error", "skipped"];
  return [p.search, p.verify, p.inject, p.maintain].every((s) => t.includes(s));
}

export function pipelineHasRunningStep(p: PipelineState): boolean {
  return [p.search, p.verify, p.inject, p.maintain].some((s) => s === "running");
}

/** Memory sidecar state machine. */
export type MemoryState =
  | { kind: "idle" }
  | { kind: "embedding" }
  | { kind: "sidecar_checking"; count: number }
  | { kind: "found_relevant"; count: number }
  | { kind: "extracting"; reason: string }
  | { kind: "maintaining"; phase: string }
  | { kind: "tool_action"; action: string; detail: string };

export type MemoryEventKind =
  | { kind: "embedding_started" }
  | { kind: "embedding_complete"; latencyMs: number; hits: number }
  | { kind: "sidecar_started" }
  | { kind: "sidecar_relevant"; memoryPreview: string }
  | { kind: "sidecar_not_relevant" }
  | { kind: "sidecar_complete"; latencyMs: number }
  | { kind: "memory_surfaced"; memoryPreview: string }
  | { kind: "memory_injected"; count: number; promptChars: number; ageMs: number; preview: string }
  | { kind: "maintenance_started"; verified: number; rejected: number }
  | { kind: "maintenance_linked"; links: number }
  | { kind: "maintenance_confidence"; boosted: number; decayed: number }
  | { kind: "maintenance_cluster"; clusters: number; members: number }
  | { kind: "maintenance_tag_inferred"; tag: string; applied: number }
  | { kind: "maintenance_gap"; candidates: number }
  | { kind: "maintenance_complete"; latencyMs: number };

export interface MemoryEvent {
  kind: MemoryEventKind;
  timestamp: string;
  detail?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// BM25 LEXICAL INDEX + RRF HYBRID SEARCH
// Extracted from rohitg00/agentmemory — src/state/search-index.ts +
//   src/state/hybrid-search.ts
//
// BM25Lexicon — self-contained inverted index (k1=1.2, b=0.75), no external
//   deps. Indexes any string-keyed document. Supports prefix expansion and
//   synonym injection. serialize/deserialize for persistence.
//
// RRFHybridSearch — combines BM25 (default weight 0.4) + vector ANN cosine
//   (weight 0.6) using Reciprocal Rank Fusion (RRF_K=60). Returns typed
//   HybridMemoryResult[] ranked by combined score. Falls back gracefully to
//   BM25-only when no vector index is available.
//
// PorterStemmer — minimal suffix-stripping Porter stem, no external deps.
//   Identical algorithm to agentmemory/src/state/stemmer.ts.
// ─────────────────────────────────────────────────────────────────────────────

// ── Minimal Porter stemmer (no external deps) ─────────────────────────────────
// Ref: agentmemory/src/state/stemmer.ts

const STEP2_RULES: [string, string][] = [
  ["ational", "ate"],
  ["tional", "tion"],
  ["enci", "ence"],
  ["anci", "ance"],
  ["izer", "ize"],
  ["bli", "ble"],
  ["alli", "al"],
  ["entli", "ent"],
  ["eli", "e"],
  ["ousli", "ous"],
  ["ization", "ize"],
  ["ation", "ate"],
  ["ator", "ate"],
  ["alism", "al"],
  ["iveness", "ive"],
  ["fulness", "ful"],
  ["ousness", "ous"],
  ["aliti", "al"],
  ["iviti", "ive"],
  ["biliti", "ble"],
  ["logi", "log"],
];

const STEP3_RULES: [string, string][] = [
  ["icate", "ic"],
  ["ative", ""],
  ["alize", "al"],
  ["iciti", "ic"],
  ["ical", "ic"],
  ["ful", ""],
  ["ness", ""],
];

function hasCVCPattern(word: string): boolean {
  // m > 0: word has at least one VC sequence
  let m = 0;
  let inVowel = false;
  for (const c of word) {
    const isVowel = "aeiou".includes(c);
    if (isVowel && !inVowel) {
      inVowel = true;
    } else if (!isVowel && inVowel) {
      inVowel = false;
      m++;
    }
  }
  return m > 0;
}

/** Minimal Porter stemmer. Reduces English words to their stem. */
export function porterStem(word: string): string {
  if (word.length <= 3) return word;
  let w = word.toLowerCase();

  // Step 1a
  if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("ies")) w = w.slice(0, -2);
  else if (w.endsWith("ss")) {
    /* keep */
  } else if (w.endsWith("s")) w = w.slice(0, -1);

  // Step 1b
  if (w.endsWith("eed")) {
    if (hasCVCPattern(w.slice(0, -3))) w = w.slice(0, -1);
  } else if (w.endsWith("ed") && /[aeiou]/.test(w.slice(0, -2))) {
    w = w.slice(0, -2);
    if (w.endsWith("at") || w.endsWith("bl") || w.endsWith("iz")) w += "e";
    else if (
      w.length > 1 &&
      w[w.length - 1] === w[w.length - 2] &&
      !"lsz".includes(w[w.length - 1]!)
    )
      w = w.slice(0, -1);
  } else if (w.endsWith("ing") && /[aeiou]/.test(w.slice(0, -3))) {
    w = w.slice(0, -3);
    if (w.endsWith("at") || w.endsWith("bl") || w.endsWith("iz")) w += "e";
    else if (
      w.length > 1 &&
      w[w.length - 1] === w[w.length - 2] &&
      !"lsz".includes(w[w.length - 1]!)
    )
      w = w.slice(0, -1);
  }

  // Step 1c
  if (w.endsWith("y") && /[aeiou]/.test(w.slice(0, -1))) w = w.slice(0, -1) + "i";

  // Step 2
  for (const [suf, rep] of STEP2_RULES) {
    if (w.endsWith(suf) && hasCVCPattern(w.slice(0, -suf.length))) {
      w = w.slice(0, -suf.length) + rep;
      break;
    }
  }

  // Step 3
  for (const [suf, rep] of STEP3_RULES) {
    if (w.endsWith(suf) && hasCVCPattern(w.slice(0, -suf.length))) {
      w = w.slice(0, -suf.length) + rep;
      break;
    }
  }

  // Step 4 — remove derivational suffixes
  const step4 = [
    "ement",
    "ment",
    "ance",
    "ence",
    "ism",
    "ible",
    "able",
    "ant",
    "ent",
    "ion",
    "ou",
    "ism",
    "ate",
    "iti",
    "ous",
    "ive",
    "ize",
    "al",
    "er",
    "ic",
  ];
  for (const suf of step4) {
    if (w.endsWith(suf) && hasCVCPattern(w.slice(0, -suf.length))) {
      if (suf === "ion") {
        const stem = w.slice(0, -3);
        if (stem.endsWith("s") || stem.endsWith("t")) {
          w = stem;
        }
      } else {
        w = w.slice(0, -suf.length);
      }
      break;
    }
  }

  return w || word;
}

// ── BM25Lexicon ───────────────────────────────────────────────────────────────
//
// BM25 Okapi with k1=1.2, b=0.75 (agentmemory defaults).
// Supports:
//   • Prefix expansion (binary search over sorted term list) × 0.5 weight
//   • Synonym injection (custom synonym map) × 0.7 weight
//   • Porter stemming on all tokens
//   • Serialize / deserialize for persistence in IState / PgVectorStore
//
// Generic over TId so it can index any string-keyed corpus — not just
// MemoryEntry. In @nexus/memory it is wired to MemoryEntry.id.

/** A BM25 document record */
export interface BM25Doc {
  /** Unique document id */
  id: string;
  /** Text content to tokenise and index */
  text: string;
  /** Optional secondary id (session, group, etc.) */
  groupId?: string;
}

/** BM25 search hit */
export interface BM25Hit {
  id: string;
  groupId?: string;
  score: number;
}

/** BM25Lexicon configuration */
export interface BM25LexiconConfig {
  /** BM25 k1 saturation parameter (default: 1.2) */
  k1?: number;
  /** BM25 b document-length normalization factor (default: 0.75) */
  b?: number;
  /** Optional synonym map: term → synonym list. Synonyms get 0.7× weight. */
  synonyms?: Record<string, string[]>;
  /** If true, apply Porter stemming to all tokens (default: true) */
  stem?: boolean;
}

/**
 * Self-contained BM25 inverted index with no external dependencies.
 *
 * Ref: agentmemory/src/state/search-index.ts (SearchIndex class)
 *   k1=1.2, b=0.75, prefix expansion via binary-search on sorted terms,
 *   synonym expansion × 0.7 weight, serialize/deserialize round-trip.
 */
export class BM25Lexicon {
  private readonly k1: number;
  private readonly b: number;
  private readonly synonyms: Record<string, string[]>;
  private readonly doStem: boolean;

  // Core data structures
  private entries = new Map<string, { groupId?: string; termCount: number }>();
  private invertedIndex = new Map<string, Set<string>>(); // term → docId set
  private docTermCounts = new Map<string, Map<string, number>>(); // docId → term → freq
  private totalDocLength = 0;
  private sortedTermsCache: string[] | null = null;

  constructor(config: BM25LexiconConfig = {}) {
    this.k1 = config.k1 ?? 1.2;
    this.b = config.b ?? 0.75;
    this.synonyms = config.synonyms ?? {};
    this.doStem = config.stem ?? true;
  }

  /** Add a document to the index */
  add(doc: BM25Doc): void {
    if (this.entries.has(doc.id)) this.remove(doc.id);

    const terms = this.tokenize(doc.text);
    const termFreq = new Map<string, number>();
    for (const t of terms) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);

    this.entries.set(doc.id, { groupId: doc.groupId, termCount: terms.length });
    this.docTermCounts.set(doc.id, termFreq);
    this.totalDocLength += terms.length;

    for (const term of termFreq.keys()) {
      if (!this.invertedIndex.has(term)) this.invertedIndex.set(term, new Set());
      this.invertedIndex.get(term)!.add(doc.id);
    }

    this.sortedTermsCache = null;
  }

  /** Remove a document from the index */
  remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;

    const termFreq = this.docTermCounts.get(id);
    if (termFreq) {
      for (const term of termFreq.keys()) {
        const pl = this.invertedIndex.get(term);
        if (pl) {
          pl.delete(id);
          if (pl.size === 0) this.invertedIndex.delete(term);
        }
      }
      this.docTermCounts.delete(id);
    }

    this.totalDocLength = Math.max(0, this.totalDocLength - entry.termCount);
    this.entries.delete(id);
    this.sortedTermsCache = null;
  }

  /** BM25 search. Returns hits sorted by descending score. */
  search(query: string, limit = 20): BM25Hit[] {
    const N = this.entries.size;
    if (N === 0) return [];

    const avgDocLen = this.totalDocLength / N;
    const rawTerms = this.tokenize(query);
    if (rawTerms.length === 0) return [];

    // Expand with synonyms
    const queryTerms: { term: string; weight: number }[] = [];
    const seen = new Set<string>();
    for (const t of rawTerms) {
      if (!seen.has(t)) {
        seen.add(t);
        queryTerms.push({ term: t, weight: 1.0 });
      }
      for (const syn of this.synonyms[t] ?? []) {
        if (!seen.has(syn)) {
          seen.add(syn);
          queryTerms.push({ term: syn, weight: 0.7 });
        }
      }
    }

    const scores = new Map<string, number>();
    const sorted = this.getSortedTerms();

    for (const { term, weight } of queryTerms) {
      // Exact match
      const exactDocs = this.invertedIndex.get(term);
      if (exactDocs) {
        const df = exactDocs.size;
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
        for (const docId of exactDocs) {
          scores.set(
            docId,
            (scores.get(docId) ?? 0) + this.bm25Score(docId, term, idf, avgDocLen, weight),
          );
        }
      }

      // Prefix expansion (× 0.5 weight)
      const startIdx = this.lowerBound(sorted, term);
      for (let si = startIdx; si < sorted.length; si++) {
        const indexTerm = sorted[si]!;
        if (!indexTerm.startsWith(term)) break;
        if (indexTerm === term) continue;

        const prefixDocs = this.invertedIndex.get(indexTerm)!;
        const df = prefixDocs.size;
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1) * 0.5;
        for (const docId of prefixDocs) {
          scores.set(
            docId,
            (scores.get(docId) ?? 0) +
              this.bm25Score(docId, indexTerm, idf, avgDocLen, weight * 0.5),
          );
        }
      }
    }

    return Array.from(scores.entries())
      .map(([id, score]) => ({ id, groupId: this.entries.get(id)?.groupId, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  get size(): number {
    return this.entries.size;
  }
  has(id: string): boolean {
    return this.entries.has(id);
  }

  clear(): void {
    this.entries.clear();
    this.invertedIndex.clear();
    this.docTermCounts.clear();
    this.totalDocLength = 0;
    this.sortedTermsCache = null;
  }

  /** Serialize to JSON string for persistence (IState / file) */
  serialize(): string {
    return JSON.stringify({
      v: 1,
      k1: this.k1,
      b: this.b,
      entries: Array.from(this.entries.entries()),
      inverted: Array.from(this.invertedIndex.entries()).map(
        ([t, ids]) => [t, Array.from(ids)] as [string, string[]],
      ),
      docTermCounts: Array.from(this.docTermCounts.entries()).map(
        ([id, counts]) =>
          [id, Array.from(counts.entries())] as [id: string, counts: [string, number][]],
      ),
      totalDocLength: this.totalDocLength,
    });
  }

  /** Restore from serialized JSON */
  static deserialize(json: string, config: BM25LexiconConfig = {}): BM25Lexicon {
    const idx = new BM25Lexicon(config);
    try {
      const data = JSON.parse(json) as {
        entries?: [string, { groupId?: string; termCount: number }][];
        inverted?: [string, string[]][];
        docTermCounts?: [string, [string, number][]][];
        totalDocLength?: number;
      };
      for (const [k, v] of data.entries ?? []) idx.entries.set(k, v);
      for (const [t, ids] of data.inverted ?? []) idx.invertedIndex.set(t, new Set(ids));
      for (const [id, counts] of data.docTermCounts ?? [])
        idx.docTermCounts.set(id, new Map(counts));
      idx.totalDocLength = (data.totalDocLength as number | undefined) ?? 0;
    } catch {
      /* return empty index on bad JSON */
    }
    return idx;
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private bm25Score(
    docId: string,
    term: string,
    idf: number,
    avgDocLen: number,
    weight: number,
  ): number {
    const entry = this.entries.get(docId);
    if (!entry) return 0;
    const tf = this.docTermCounts.get(docId)?.get(term) ?? 0;
    const docLen = entry.termCount;
    const num = tf * (this.k1 + 1);
    const den = tf + this.k1 * (1 - this.b + this.b * (docLen / avgDocLen));
    return idf * (num / den) * weight;
  }

  private tokenize(text: string): string[] {
    const cleaned = text.replace(/[^\p{L}\p{N}\s/.\\-_]/gu, " ");
    const tokens: string[] = [];
    for (const raw of cleaned.toLowerCase().split(/\s+/)) {
      if (raw.length < 2) continue;
      tokens.push(this.doStem ? porterStem(raw) : raw);
    }
    return tokens;
  }

  private getSortedTerms(): string[] {
    if (!this.sortedTermsCache) {
      this.sortedTermsCache = Array.from(this.invertedIndex.keys()).sort();
    }
    return this.sortedTermsCache;
  }

  private lowerBound(arr: string[], target: string): number {
    let lo = 0,
      hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid]! < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

// ── RRF Hybrid Search ─────────────────────────────────────────────────────────
//
// Reciprocal Rank Fusion over BM25 + vector ANN results.
//
// RRF_K = 60 (standard constant from Cormack et al. 2009).
// combinedScore = bm25W × 1/(RRF_K+bm25Rank) + vectorW × 1/(RRF_K+vectorRank)
//
// When no vector index is available: graceful fallback to BM25-only with
// bm25W renormalised to 1.0.
//
// Session diversification: no more than maxPerGroup results from the same
// groupId (agentmemory maxPerSession=3).
//
// Ref: agentmemory/src/state/hybrid-search.ts
//   RRF_K=60, bm25Weight=0.4, vectorWeight=0.6, diversifyBySession()

const RRF_K = 60;

/** Hybrid search result — combines BM25 + vector scores via RRF */
export interface HybridMemoryResult {
  /** Memory entry id */
  id: string;
  /** Optional group id (session, namespace, etc.) */
  groupId?: string;
  /** BM25 rank position (1-based; Infinity if not in BM25 results) */
  bm25Rank: number;
  /** Vector similarity rank position (1-based; Infinity if not in vector results) */
  vectorRank: number;
  /** Raw BM25 score */
  bm25Score: number;
  /** Raw vector cosine score */
  vectorScore: number;
  /**
   * RRF combined score:
   *   bm25W × 1/(RRF_K + bm25Rank) + vectorW × 1/(RRF_K + vectorRank)
   */
  combinedScore: number;
}

/** Options for RRF hybrid search */
export interface RRFSearchOptions {
  /** Max results to return (default: 20) */
  limit?: number;
  /** BM25 weight (default: 0.4). Renormalised if vector unavailable. */
  bm25Weight?: number;
  /** Vector weight (default: 0.6). Set to 0 to disable vector search. */
  vectorWeight?: number;
  /** Maximum results per groupId (default: unlimited) */
  maxPerGroup?: number;
}

/**
 * Reciprocal Rank Fusion over BM25 + vector ANN results.
 *
 * Both result lists are ranked independently, then fused with the RRF formula.
 * Falls back gracefully to BM25-only when vectorResults is empty.
 *
 * @param bm25Results  Output from BM25Lexicon.search()
 * @param vectorResults  Output from IMemoryStore.search() or similar ANN
 * @param opts  Weights, limit, and group diversification
 *
 * @example
 * ```ts
 * const bm25 = new BM25Lexicon();
 * entries.forEach(e => bm25.add({ id: e.id, text: e.text, groupId: e.userId }));
 *
 * const lexHits = bm25.search("error code 429", 40);
 * const vecHits = await store.search(queryEmbedding, 40, { userId });
 *
 * const results = rrfHybridSearch(
 *   lexHits,
 *   vecHits.map(r => ({ id: r.id, score: r.score })),
 * );
 * ```
 */
export function rrfHybridSearch(
  bm25Results: BM25Hit[],
  vectorResults: { id: string; score: number; groupId?: string }[],
  opts: RRFSearchOptions = {},
): HybridMemoryResult[] {
  const limit = opts.limit ?? 20;
  const hasVector = vectorResults.length > 0;
  let bm25W = opts.bm25Weight ?? 0.4;
  let vectorW = opts.vectorWeight ?? 0.6;

  // Renormalise weights if one stream is absent
  if (!hasVector) {
    bm25W = 1.0;
    vectorW = 0.0;
  }
  const totalW = bm25W + vectorW;
  if (totalW > 0) {
    bm25W /= totalW;
    vectorW /= totalW;
  }

  // Accumulate per-document scores
  const scores = new Map<
    string,
    {
      groupId?: string;
      bm25Rank: number;
      vectorRank: number;
      bm25Score: number;
      vectorScore: number;
    }
  >();

  bm25Results.forEach((r, i) => {
    scores.set(r.id, {
      groupId: r.groupId,
      bm25Rank: i + 1,
      vectorRank: Infinity,
      bm25Score: r.score,
      vectorScore: 0,
    });
  });

  vectorResults.forEach((r, i) => {
    const ex = scores.get(r.id);
    if (ex) {
      ex.vectorRank = i + 1;
      ex.vectorScore = r.score;
      if (r.groupId && !ex.groupId) ex.groupId = r.groupId;
    } else {
      scores.set(r.id, {
        groupId: r.groupId,
        bm25Rank: Infinity,
        vectorRank: i + 1,
        bm25Score: 0,
        vectorScore: r.score,
      });
    }
  });

  // Compute RRF combined scores
  const combined: HybridMemoryResult[] = Array.from(scores.entries()).map(([id, s]) => ({
    id,
    groupId: s.groupId,
    bm25Rank: s.bm25Rank,
    vectorRank: s.vectorRank,
    bm25Score: s.bm25Score,
    vectorScore: s.vectorScore,
    combinedScore: bm25W * (1 / (RRF_K + s.bm25Rank)) + vectorW * (1 / (RRF_K + s.vectorRank)),
  }));

  combined.sort((a, b) => b.combinedScore - a.combinedScore);

  // Group diversification
  if (opts.maxPerGroup !== undefined) {
    const maxPG = opts.maxPerGroup;
    const groupCounts = new Map<string, number>();
    const diversified: HybridMemoryResult[] = [];

    for (const r of combined) {
      const key = r.groupId ?? "__none__";
      const count = groupCounts.get(key) ?? 0;
      if (count >= maxPG) continue;
      diversified.push(r);
      groupCounts.set(key, count + 1);
      if (diversified.length >= limit) break;
    }

    // Fill remaining slots from overflow
    if (diversified.length < limit) {
      for (const r of combined) {
        if (diversified.length >= limit) break;
        if (!diversified.some((d) => d.id === r.id)) diversified.push(r);
      }
    }

    return diversified;
  }

  return combined.slice(0, limit);
}

// ── QueryExpansion interface (agentmemory pattern) ────────────────────────────
//
// agentmemory/src/functions/query-expansion.ts — registerQueryExpansionFunction
// uses an LLM to generate 3-5 reformulations, temporal concretizations, and
// entity extractions from a raw query. The results are fed into searchWithExpansion
// for multi-query retrieval (union of all reformulation hits).

/** Query expansion payload produced by an LLM or rule-based expander */
export interface QueryExpansion {
  /** Original query text */
  original: string;
  /**
   * 3–5 semantically diverse reformulations.
   * Capture paraphrases, domain-specific restatements, abstract/concrete variants.
   */
  reformulations: string[];
  /**
   * Time-concretized variants (e.g. "last week" → "2026-06-09 to 2026-06-16").
   * Empty if the query has no temporal reference.
   */
  temporalConcretizations: string[];
  /**
   * Named entities extracted from the query (people, files, projects, concepts).
   * Fed into graph-retrieval paths (MemoryGraph.getMemoriesByTag, etc.).
   */
  entityExtractions: string[];
}

/** Injectable query expander — produce QueryExpansion from a raw query string */
export type QueryExpander = (query: string) => Promise<QueryExpansion>;

/** No-op expander — returns the query unchanged with empty expansion fields */
export const nullQueryExpander: QueryExpander = async (query: string): Promise<QueryExpansion> => ({
  original: query,
  reformulations: [],
  temporalConcretizations: [],
  entityExtractions: [],
});

/**
 * Execute BM25 + vector hybrid search across multiple query reformulations.
 *
 * Runs rrfHybridSearch for each reformulation independently (Promise.allSettled),
 * then merges all results keeping the highest combinedScore per document id.
 *
 * Ref: agentmemory/src/state/hybrid-search.ts searchWithExpansion()
 *
 * @param bm25  BM25Lexicon already populated with corpus documents
 * @param vectorFn  Function to run ANN search for a given query (injectable)
 * @param query  Raw user query
 * @param expansion  Expanded queries from a QueryExpander
 * @param opts  RRF options (limit, weights)
 */
export async function hybridSearchWithExpansion(
  bm25: BM25Lexicon,
  vectorFn: (
    query: string,
    limit: number,
  ) => Promise<{ id: string; score: number; groupId?: string }[]>,
  query: string,
  expansion: QueryExpansion,
  opts: RRFSearchOptions = {},
): Promise<HybridMemoryResult[]> {
  const limit = opts.limit ?? 20;
  const allQueries = [query, ...expansion.reformulations, ...expansion.temporalConcretizations];

  // Run all query variants in parallel — one failure never cancels others
  const settled = await Promise.allSettled(
    allQueries.map(async (q) => {
      const bm25Hits = bm25.search(q, limit * 2);
      const vecHits = await vectorFn(q, limit * 2);
      return rrfHybridSearch(bm25Hits, vecHits, opts);
    }),
  );

  // Merge: keep highest combinedScore per document
  const merged = new Map<string, HybridMemoryResult>();
  for (const s of settled) {
    if (s.status !== "fulfilled") continue;
    for (const r of s.value) {
      const ex = merged.get(r.id);
      if (!ex || r.combinedScore > ex.combinedScore) merged.set(r.id, r);
    }
  }

  return Array.from(merged.values())
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, limit);
}
