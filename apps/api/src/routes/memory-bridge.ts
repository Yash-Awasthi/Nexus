// SPDX-License-Identifier: Apache-2.0
/**
 * Bridge memory surface OWNER — extracted from api-bridge.ts (§16.7).
 *
 * The legacy `/api/memory/*` surface (distinct from the v1
 * `/api/v1/memory` surface in routes/memory.ts): user-scoped entries,
 * stats, backend config, compact (lossless dedup) and delete-all — with
 * byte-identical response shapes. All memory is scoped to the authenticated
 * user (nexusUserId, "local" fallback), so account A never sees account B's
 * chunks.
 *
 * The memory manager (`getMemory`) is injected rather than imported — it
 * stays bridge-owned because the embedder warmup lives there.
 *
 * Mounted inside apiBridgeRoutes (same /api/* scope, same auth hooks).
 */

import type { MemoryManager } from "@nexus/memory";
import type { FastifyInstance } from "fastify";

import { requireAuthWithTier } from "../middleware/auth.js";

/** Bridge-owned memory manager handed in at registration (no circular import). */
export interface MemoryBridgeRoutesDeps {
  getMemory: () => MemoryManager;
}

/** Register the /memory bridge surface. Called from apiBridgeRoutes. */
export async function memoryBridgeRoutes(
  app: FastifyInstance,
  deps: MemoryBridgeRoutesDeps,
): Promise<void> {
  app.get<{ Querystring: { limit?: number; query?: string } }>(
    "/memory/entries",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const mem = deps.getMemory();
      const uid = request.nexusUserId ?? "local";
      const { limit = 20, query } = request.query;
      if (query) {
        const results = await mem.recall(query, limit, { userId: uid });
        const entries = results.map((r) => ({ ...r.entry, score: r.score }));
        return reply.send({ entries, total: entries.length });
      }
      const entries = await mem.list({ userId: uid });
      // Surface the fields the Memory page actually renders: the store returns
      // raw text/createdAt (epoch seconds) while the UI expects topic/chunks/
      // date/source — without this mapping the page showed NaN/undefined.
      // Embeddings (768 floats/entry) are stripped: the UI never renders them
      // and they dominated the payload (observed via curl, round 4).
      return reply.send({
        entries: entries.slice(0, limit).map((e) => ({
          id: e.id,
          text: e.text,
          metadata: e.metadata,
          createdAt: e.createdAt,
          topic: (e.text ?? "").slice(0, 80) || "Untitled memory",
          chunks: Math.max(1, Math.ceil((e.text?.length ?? 0) / 1000)),
          date: e.createdAt ? new Date(e.createdAt * 1000).toLocaleDateString() : "",
          source: typeof e.metadata?.category === "string" ? e.metadata.category : "memory",
        })),
        total: entries.length,
      });
    },
  );

  app.post<{ Body: { content: string; category?: string; tags?: string[] } }>(
    "/memory/entries",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const mem = deps.getMemory();
      const { content, category, tags } = request.body;
      // Missing/empty content previously flowed into the embedder as undefined
      // and surfaced as a raw 500 EMBED_FAILED (observed via curl, round 4).
      // The v1 surface rejects this as 400 EMPTY_TEXT — match it.
      if (typeof content !== "string" || content.trim().length === 0) {
        return reply.code(400).send({
          code: "EMPTY_TEXT",
          message: "content is required and must be non-empty",
        });
      }
      const entry = await mem.remember(content, {
        metadata: { category, tags },
        userId: request.nexusUserId ?? "local",
      });
      return reply.code(201).send(entry);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/memory/entries/:id",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const mem = deps.getMemory();
      const uid = request.nexusUserId ?? "local";
      // Ownership check — users can only delete their own entries.
      const owned = await mem.list({ userId: uid });
      if (!owned.some((e) => e.id === request.params.id)) {
        return reply.code(404).send({ error: "memory entry not found" });
      }
      await mem.forget(request.params.id);
      return reply.code(204).send();
    },
  );

  app.get("/memory/stats", { preHandler: requireAuthWithTier }, async (request, reply) => {
    const mem = deps.getMemory();
    const stats = await mem.stats({ userId: request.nexusUserId ?? "local" });
    return reply.send(stats);
  });

  // Memory backend config (single-engine display for now — the selector is
  // cosmetic until a second backend ships, but it must at least round-trip).
  app.post("/memory/backend", async (_req, reply) => reply.send({ ok: true }));
  app.put("/memory/backend", async (_req, reply) => reply.send({ ok: true }));

  // Compact: lossless dedup of the caller's memories (same normalized text).
  // Previously a stub returning {ok:true, compacted:0} while the UI faked a
  // local merge — the store was never touched.
  app.post("/memory/compact", { preHandler: requireAuthWithTier }, async (request, reply) => {
    const mem = deps.getMemory();
    const uid = request.nexusUserId ?? "local";
    const entries = await mem.list({ userId: uid });
    const seen = new Map<string, string>();
    let compacted = 0;
    for (const e of entries) {
      const key = (e.text ?? "").trim().replace(/\s+/g, " ").toLowerCase();
      if (!key) continue;
      if (seen.has(key)) {
        await mem.forget(e.id);
        compacted++;
      } else {
        seen.set(key, e.id);
      }
    }
    return reply.send({ ok: true, compacted });
  });

  // Memory delete-all (user-scoped). Previously a stub returning
  // {ok:true, deleted:0} — the UI emptied its list while the store kept
  // every entry, so they reappeared on the next load.
  app.delete("/memory/entries", { preHandler: requireAuthWithTier }, async (request, reply) => {
    const mem = deps.getMemory();
    const uid = request.nexusUserId ?? "local";
    const owned = await mem.list({ userId: uid });
    for (const e of owned) await mem.forget(e.id);
    return reply.send({ ok: true, deleted: owned.length });
  });
}