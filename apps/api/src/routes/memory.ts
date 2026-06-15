// SPDX-License-Identifier: Apache-2.0
/**
 * Memory routes — long-term agent vector memory via @nexus/memory.
 *
 * GET    /api/v1/memory           — recall entries matching a semantic query
 * POST   /api/v1/memory           — remember a new text entry
 * DELETE /api/v1/memory/:id       — forget a single entry by id
 * GET    /api/v1/memory/list      — list all entries (no embedding, fast path)
 *
 * Backing store:
 *   PgVectorStore  — when DATABASE_URL is set (pgvector + Neon serverless)
 *   InMemoryStore  — otherwise (local dev / CI)
 *
 * Embedder:
 *   GroqEmbedder   — when GROQ_API_KEY is set (768-dim nomic-embed-text-v1.5)
 *   FixedEmbedder  — otherwise (deterministic pseudo-embedding, no API calls)
 */

import {
  FixedEmbedder,
  GroqEmbedder,
  InMemoryStore,
  MemoryManager,
  PgVectorStore,
} from "@nexus/memory";
import {
  RagtimeRetriever,
  type IEmbedder as IRagtimeEmbedder,
  type IMemoryStore as IRagtimeMemoryStore,
  type MemoryFilter as RagtimeMemoryFilter,
} from "@nexus/ragtime";
import { globalHooks } from "@nexus/hooks";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── Singleton ─────────────────────────────────────────────────────────────────

const store = process.env.DATABASE_URL
  ? new PgVectorStore({ databaseUrl: process.env.DATABASE_URL })
  : new InMemoryStore();

const embedder = process.env.GROQ_API_KEY
  ? new GroqEmbedder({ apiKey: process.env.GROQ_API_KEY })
  : new FixedEmbedder();

const manager = new MemoryManager({ store, embedder });

// RagtimeRetriever — two-stage recall+rerank for the GET /memory endpoint.
// Store and embedder from @nexus/memory are structurally compatible with
// @nexus/ragtime's IMemoryStore / IEmbedder interfaces.
const retriever = new RagtimeRetriever({
  store:   store   as unknown as IRagtimeMemoryStore,
  embedder: embedder as unknown as IRagtimeEmbedder,
  config: { poolSize: 20, finalK: 50 }, // finalK=50 so callers can slice via limit param
});

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function memoryRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /memory?query=<text>&limit=<n>&userId=<id>
   *
   * Semantic recall — embed `query` and return the k-nearest entries.
   * When `query` is omitted an empty string is used (returns random-ish results
   * for InMemoryStore; for PgVectorStore this returns the first k rows by
   * similarity to the zero vector — callers should prefer /memory/list in that case).
   */
  app.get<{
    Querystring: { query?: string; limit?: string; userId?: string };
  }>("/memory", { preHandler: requireAuth }, async (request, reply) => {
    const { query = "", limit: limitStr, userId } = request.query;
    const limit = Math.min(parseInt(limitStr ?? "10", 10) || 10, 100);

    // RagtimeRetriever: two-stage recall (cosine pool) + composite rerank
    // (α·relevance + β·importance + γ·recency_decay).
    // Filter by metadata.userId for multi-tenant isolation.
    const ragtimeFilter: RagtimeMemoryFilter | undefined = userId
      ? { metadata: { userId } }
      : undefined;

    const results = await retriever.retrieve(query, limit, ragtimeFilter);

    return reply.send({
      results: results.map((r) => ({
        id:          r.entry.id,
        text:        r.entry.text,
        score:       r.composite,
        relevance:   r.relevance,
        importance:  r.importance,
        recencyDecay: r.recencyDecay,
        metadata:    r.entry.metadata,
        createdAt:   r.entry.createdAt,
        userId:      r.entry.metadata?.["userId"] as string | undefined,
      })),
      total: results.length,
    });
  });

  /**
   * POST /memory
   *
   * Remember a new text entry.  Returns the stored MemoryEntry with its
   * server-assigned id.
   *
   * Body: { text, metadata?, ttl?, userId? }
   *   text     — the content to embed and persist
   *   metadata — arbitrary key-value pairs attached to the entry
   *   ttl      — TTL in seconds; entry is logically expired after now+ttl
   *   userId   — owning user (stored in metadata for multi-tenant filtering)
   */
  app.post<{
    Body: {
      text: string;
      metadata?: Record<string, unknown>;
      ttl?: number;
      userId?: string;
    };
  }>("/memory", { preHandler: requireAuth }, async (request, reply) => {
    const { text, metadata = {}, ttl, userId } = request.body;

    // userId is stored inside metadata so InMemoryStore can filter it.
    // PgVectorStore uses the entry.userId column set by the store.save() path.
    const combinedMeta: Record<string, unknown> = {
      ...metadata,
      ...(userId ? { userId } : {}),
    };

    // Dedup: if a highly-similar entry already exists (cosine similarity ≥ 0.92)
    // return it immediately instead of storing a near-duplicate.
    const dedupFilter = userId ? { userId } : undefined;
    const nearMatches = await manager.recall(text, 1, dedupFilter);
    if (nearMatches.length > 0 && nearMatches[0]!.score >= 0.92) {
      const dup = nearMatches[0]!.entry;
      return reply.code(200).send({
        id:        dup.id,
        text:      dup.text,
        metadata:  dup.metadata,
        createdAt: dup.createdAt,
        userId:    dup.userId ?? (dup.metadata?.userId as string | undefined),
        duplicate: true,
      });
    }

    // Hook: memory.before_write
    globalHooks.emit("memory.before_write", { text, metadata: combinedMeta }).catch(() => {});

    const entry = await manager.remember(text, { metadata: combinedMeta, ttl });

    // Hook: memory.after_write
    globalHooks.emit("memory.after_write", {
      entryId:  entry.id,
      text:     entry.text,
      metadata: entry.metadata,
    }).catch(() => {});

    return reply.code(201).send({
      id:        entry.id,
      text:      entry.text,
      metadata:  entry.metadata,
      createdAt: entry.createdAt,
      userId:    entry.userId ?? (entry.metadata?.userId as string | undefined),
    });
  });

  /**
   * DELETE /memory/:id
   *
   * Forget (remove) a single entry.  Always returns 204, even if the id did
   * not exist (the forget operation is idempotent).
   */
  app.delete<{ Params: { id: string } }>(
    "/memory/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      await manager.forget(request.params.id);
      return reply.code(204).send();
    },
  );

  /**
   * GET /memory/list?userId=<id>&limit=<n>
   *
   * List all entries without performing an embedding (fast path).
   * For multi-tenant filtering pass `userId`; entries are matched against
   * both entry.userId (PgVectorStore) and metadata.userId (InMemoryStore).
   */
  app.get<{
    Querystring: { userId?: string; limit?: string };
  }>("/memory/list", { preHandler: requireAuth }, async (request, reply) => {
    const { userId, limit: limitStr } = request.query;
    const limit = Math.min(parseInt(limitStr ?? "100", 10) || 100, 500);

    // Dual-filter: userId column for PgVectorStore; metadata.userId for InMemoryStore.
    const filter = userId
      ? { userId, metadata: { userId } }
      : undefined;

    const entries = (await manager.list(filter)).slice(0, limit);

    return reply.send({
      entries: entries.map((e) => ({
        id:        e.id,
        text:      e.text,
        metadata:  e.metadata,
        createdAt: e.createdAt,
        userId:    e.userId ?? (e.metadata?.userId as string | undefined),
      })),
      total: entries.length,
    });
  });
}
