// SPDX-License-Identifier: Apache-2.0
/**
 * Memory routes — long-term agent vector memory via @nexus/memory.
 *
 * GET    /api/v1/memory           — recall entries matching a semantic query
 * POST   /api/v1/memory           — remember a new text entry
 * DELETE /api/v1/memory/:id       — forget a single entry by id
 * GET    /api/v1/memory/list      — list all entries (no embedding, fast path)
 * POST   /api/v1/memory/compact      — compact memory, keep newest N entries
 * DELETE /api/v1/memory/entries      — bulk-delete entries by ID list
 *
 * Backing store:
 *   PgVectorStore  — when DATABASE_URL is set (pgvector + Neon serverless)
 *   InMemoryStore  — otherwise (local dev / CI)
 *
 * Embedder:
 *   GroqEmbedder   — when GROQ_API_KEY is set (768-dim nomic-embed-text-v1.5)
 *   FixedEmbedder  — otherwise (deterministic pseudo-embedding, no API calls)
 */

import { globalHooks } from "@nexus/hooks";
import { InMemoryStore, MemoryManager, PgVectorStore, createBestEmbedder } from "@nexus/memory";
import {
  RagtimeRetriever,
  type IEmbedder as IRagtimeEmbedder,
  type IMemoryStore as IRagtimeMemoryStore,
  type MemoryFilter as RetrievalMemoryFilter,
} from "@nexus/retrieval";
import type { FastifyInstance } from "fastify";

import { requireAuthWithTier } from "../middleware/auth.js";

// ── Singleton ─────────────────────────────────────────────────────────────────

const store = process.env.DATABASE_URL
  ? new PgVectorStore({ databaseUrl: process.env.DATABASE_URL })
  : new InMemoryStore();

const embedder = createBestEmbedder();

const manager = new MemoryManager({ store, embedder });

// RagtimeRetriever — two-stage recall+rerank for the GET /memory endpoint.
// Store and embedder from @nexus/memory are structurally compatible with
// @nexus/retrieval's IMemoryStore / IEmbedder interfaces.
const retriever = new RagtimeRetriever({
  store: store as unknown as IRagtimeMemoryStore,
  embedder: embedder as unknown as IRagtimeEmbedder,
  config: { poolSize: 20, finalK: 50 }, // finalK=50 so callers can slice via limit param
});

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function memoryRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /memory?query=<text>&limit=<n>
   *
   * Semantic recall — embed `query` and return the k-nearest entries.
   * Scoped to the authenticated caller (nexusUserId, "local" fallback) — the
   * client-supplied userId was previously honored, letting callers read any
   * tenant's entries (playtest e2e round). When `query` is omitted an empty
   * string is used (returns random-ish results for InMemoryStore; for
   * PgVectorStore this returns the first k rows by similarity to the zero
   * vector — callers should prefer /memory/list in that case).
   */
  app.get<{
    Querystring: { query?: string; limit?: string };
  }>("/memory", { preHandler: requireAuthWithTier }, async (request, reply) => {
    reply.header("Cache-Control", "private, max-age=60, stale-while-revalidate=300");
    const { query = "", limit: limitStr } = request.query;
    const limit = Math.min(parseInt(limitStr ?? "10", 10) || 10, 100);
    const uid = request.nexusUserId ?? "local";

    // Filter by metadata.userId for multi-tenant isolation.
    const retrievalFilter: RetrievalMemoryFilter = { metadata: { userId: uid } };

    // No query → list recent entries (no embedding). Embedding an empty string
    // makes some backends (Ollama) return an empty vector → EMBED_FAILED 500.
    if (!query.trim()) {
      const entries = (await manager.list({ metadata: { userId: uid } })).slice(0, limit);
      return reply.send({
        results: entries.map((e) => ({
          id: e.id,
          text: e.text,
          score: 0,
          metadata: e.metadata,
          createdAt: e.createdAt,
          userId: e.metadata?.["userId"] as string | undefined,
        })),
        total: entries.length,
      });
    }

    // RagtimeRetriever: two-stage recall (cosine pool) + composite rerank
    // (α·relevance + β·importance + γ·recency_decay).
    const results = await retriever.retrieve(query, limit, retrievalFilter);

    return reply.send({
      results: results.map((r) => ({
        id: r.entry.id,
        text: r.entry.text,
        score: r.composite,
        relevance: r.relevance,
        importance: r.importance,
        recencyDecay: r.recencyDecay,
        metadata: r.entry.metadata,
        createdAt: r.entry.createdAt,
        userId: r.entry.metadata?.["userId"] as string | undefined,
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
   * Body: { text, metadata?, ttl? }
   *   text     — the content to embed and persist
   *   metadata — arbitrary key-value pairs attached to the entry
   *   ttl      — TTL in seconds; entry is logically expired after now+ttl
   *
   * Ownership comes from the authenticated caller (nexusUserId, "local"
   * fallback) — the client-supplied userId was previously honored, so entries
   * written without it were globally visible and could be attributed to any
   * tenant (playtest e2e round).
   */
  app.post<{
    Body: {
      text: string;
      metadata?: Record<string, unknown>;
      ttl?: number;
    };
  }>("/memory", { preHandler: requireAuthWithTier }, async (request, reply) => {
    const { text, metadata = {}, ttl } = request.body;
    const uid = request.nexusUserId ?? "local";

    // Empty/whitespace text cannot be embedded (some backends 500 with
    // EMBED_FAILED) and would only ever be noise on recall — reject with an
    // explicit client error instead of a raw 500 (observed via curl).
    if (typeof text !== "string" || text.trim().length === 0) {
      return reply.code(400).send({
        code: "EMPTY_TEXT",
        message: "text is required and must be non-empty",
      });
    }

    // userId is stored inside metadata so InMemoryStore can filter it.
    // PgVectorStore uses the entry.userId column set by the store.save() path.
    const combinedMeta: Record<string, unknown> = { ...metadata, userId: uid };

    // Dedup: if a highly-similar entry already exists (cosine similarity ≥ 0.92)
    // return it immediately instead of storing a near-duplicate.
    const dedupFilter: RetrievalMemoryFilter = { metadata: { userId: uid } };
    const nearMatches = await manager.recall(text, 1, dedupFilter);
    if (nearMatches.length > 0 && nearMatches[0]!.score >= 0.92) {
      const dup = nearMatches[0]!.entry;
      return reply.code(200).send({
        id: dup.id,
        text: dup.text,
        metadata: dup.metadata,
        createdAt: dup.createdAt,
        userId: dup.metadata?.["userId"] as string | undefined,
        duplicate: true,
      });
    }

    // Hook: memory.before_write
    globalHooks.emit("memory.before_write", { text, metadata: combinedMeta }).catch(() => {});

    const entry = await manager.remember(text, { metadata: combinedMeta, ttl });

    // Hook: memory.after_write
    globalHooks
      .emit("memory.after_write", {
        id: entry.id,
        text: entry.text,
        metadata: entry.metadata,
        createdAt:
          typeof entry.createdAt === "number"
            ? entry.createdAt
            : new Date(entry.createdAt as string).getTime() / 1000,
      })
      .catch(() => {});

    return reply.code(201).send({
      id: entry.id,
      text: entry.text,
      metadata: entry.metadata,
      createdAt: entry.createdAt,
      userId: entry.metadata?.["userId"] as string | undefined,
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
    {
      schema: {
        response: { 200: { type: "object", additionalProperties: true }, 204: { type: "null" } },
      },
      preHandler: requireAuthWithTier,
    },
    async (request, reply) => {
      // Ownership check (matches the bridge surface): only the owning user may
      // forget an entry — previously any id was forgettable by any caller.
      const uid = request.nexusUserId ?? "local";
      const owned = await manager.list({ metadata: { userId: uid } });
      if (!owned.some((e) => e.id === request.params.id)) {
        return reply.code(404).send({ error: "memory entry not found" });
      }
      await manager.forget(request.params.id);
      return reply.code(204).send();
    },
  );

  /**
   * GET /memory/list?limit=<n>
   *
   * List the caller's entries without performing an embedding (fast path).
   * Scoped to the authenticated caller (nexusUserId, "local" fallback) — the
   * client-supplied userId was previously honored, letting callers list any
   * tenant's entries (playtest e2e round).
   */
  app.get<{
    Querystring: { limit?: string };
  }>("/memory/list", { preHandler: requireAuthWithTier }, async (request, reply) => {
    const { limit: limitStr } = request.query;
    const limit = Math.min(parseInt(limitStr ?? "100", 10) || 100, 500);
    const uid = request.nexusUserId ?? "local";

    // Dual-filter: userId column for PgVectorStore; metadata.userId for InMemoryStore.
    const filter: RetrievalMemoryFilter = { metadata: { userId: uid } };

    const entries = (await manager.list(filter)).slice(0, limit);

    return reply.send({
      entries: entries.map((e) => ({
        id: e.id,
        text: e.text,
        metadata: e.metadata,
        createdAt: e.createdAt,
        userId: e.metadata?.["userId"] as string | undefined,
      })),
      total: entries.length,
    });
  });

  /**
   * DELETE /memory/entries
   *
   * Bulk-delete memory entries by ID list.
   * Body: { ids: string[] }
   * Returns: { deleted: number, errors: string[] }
   */
  app.delete<{ Body: { ids: string[] } }>(
    "/memory/entries",
    {
      schema: {
        body: {
          type: "object",
          required: ["ids"],
          properties: { ids: { type: "array", items: { type: "string" }, maxItems: 500 } },
        },
        response: {
          200: {
            type: "object",
            properties: {
              deleted: { type: "number" },
              errors: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
      preHandler: requireAuthWithTier,
    },
    async (request, reply) => {
      const { ids } = request.body;
      // Only the caller's own entries are forgettable (playtest e2e round).
      const uid = request.nexusUserId ?? "local";
      const ownedIds = new Set(
        (await manager.list({ metadata: { userId: uid } })).map((e) => e.id),
      );
      let deleted = 0;
      const errors: string[] = [];
      await Promise.all(
        ids.map(async (id) => {
          if (!ownedIds.has(id)) {
            errors.push(`${id}: not owned`);
            return;
          }
          try {
            await manager.forget(id);
            deleted++;
          } catch (e) {
            errors.push(`${id}: ${String(e)}`);
          }
        }),
      );
      return reply.send({ deleted, errors });
    },
  );

  /**
   * POST /memory/compact
   *
   * Compacts the CALLER'S memory by retaining only the newest `keepLast`
   * entries (default 200) and deleting older entries. Scoped to the
   * authenticated caller — the client-supplied userId was previously honored,
   * letting callers compact another tenant's entries (playtest e2e round).
   * Entries are sorted by createdAt descending.
   * Returns: { compacted: number, kept: number }
   */
  app.post<{ Body: { keepLast?: number } }>(
    "/memory/compact",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            keepLast: { type: "number", minimum: 1, maximum: 2000, default: 200 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: { compacted: { type: "number" }, kept: { type: "number" } },
          },
        },
      },
      preHandler: requireAuthWithTier,
    },
    async (request, reply) => {
      const keepLast = request.body?.keepLast ?? 200;
      const uid = request.nexusUserId ?? "local";
      const filter: RetrievalMemoryFilter = { metadata: { userId: uid } };
      const all = await manager.list(filter);

      // Sort by createdAt descending — newest first
      all.sort((a, b) => {
        const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return tb - ta;
      });

      const toDelete = all.slice(keepLast);
      let compacted = 0;
      await Promise.all(
        toDelete.map(async (entry) => {
          try {
            await manager.forget(entry.id);
            compacted++;
          } catch {
            /* non-fatal */
          }
        }),
      );
      return reply.send({ compacted, kept: all.length - compacted });
    },
  );
}
