// SPDX-License-Identifier: Apache-2.0
/**
 * Wiki-updater routes — LLM-driven wiki reconciliation.
 *
 * GET  /api/v1/wiki/articles        — list all articles
 * GET  /api/v1/wiki/articles/:id    — get article by id
 * GET  /api/v1/wiki/search          — search articles (?q=)
 * POST /api/v1/wiki/update          — run WikiUpdatePipeline on a document
 * DELETE /api/v1/wiki/articles/:id  — delete article
 * POST /api/v1/wiki/reindex         — force re-index
 *
 * When DATABASE_URL is set, articles are persisted in Postgres (wiki_articles
 * table) via PgWikiStore. The WikiUpdatePipeline always uses the in-memory
 * WikiStore for its sync BM25 search; after a successful pipeline run the
 * resulting article is synced to PgWikiStore.
 *
 * CRUD reads (list, get, search) prefer PgWikiStore when available so they
 * see articles from previous server restarts.
 */

import { WikiStore, WikiUpdatePipeline, PgWikiStore } from "@nexus/wiki-updater";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── Singletons ────────────────────────────────────────────────────────────────

// In-memory store for the pipeline (sync BM25 search)
const wikiStore = new WikiStore();
const wikiPipeline = new WikiUpdatePipeline({ store: wikiStore, autoCreate: true });

// Postgres-backed store — activated when DATABASE_URL is set
const pgWiki = process.env.DATABASE_URL
  ? new PgWikiStore(process.env.DATABASE_URL)
  : null;

// Pre-warm: create table + seed in-memory store from Postgres on startup
if (pgWiki) {
  pgWiki.init()
    .then(async () => {
      const articles = await pgWiki.getAll();
      for (const a of articles) wikiStore.set(a);
    })
    .catch(() => { /* non-fatal — wiki falls back to in-memory */ });
}

// ── Route plugin ──────────────────────────────────────────────────────────────

export async function wikiRoutes(app: FastifyInstance): Promise<void> {
  /** GET /wiki/articles */
  app.get("/wiki/articles", { preHandler: requireAuth }, async (_req, reply) => {
    const articles = pgWiki
      ? await pgWiki.getAll().catch(() => wikiStore.all())
      : wikiStore.all();
    return reply.send({ articles, total: articles.length });
  });

  /** GET /wiki/articles/:id */
  app.get<{ Params: { id: string } }>(
    "/wiki/articles/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const article = pgWiki
        ? await pgWiki.getById(request.params.id).catch(() => wikiStore.get(request.params.id))
        : wikiStore.get(request.params.id);
      if (!article) return reply.code(404).send({ error: "Article not found" });
      return reply.send(article);
    },
  );

  /** GET /wiki/search?q=&limit= */
  app.get<{ Querystring: { q?: string; limit?: string } }>(
    "/wiki/search",
    { preHandler: requireAuth },
    async (request, reply) => {
      const q = request.query.q ?? "";
      const limit = Math.min(parseInt(request.query.limit ?? "10"), 50);
      if (!q.trim()) return reply.send({ articles: [], total: 0 });

      const articles = pgWiki
        ? await pgWiki.search(q, limit).catch(() => wikiStore.search(q, limit))
        : wikiStore.search(q, limit);
      return reply.send({ articles, total: articles.length });
    },
  );

  /** POST /wiki/update — run update pipeline on a document */
  app.post<{
    Body: {
      document: { id: string; content: string; source?: string };
      dryRun?: boolean;
      sessionId?: string;
    };
  }>("/wiki/update", { preHandler: requireAuth }, async (request, reply) => {
    const result = await wikiPipeline.run({
      document: request.body.document,
      dryRun: request.body.dryRun ?? false,
      sessionId: request.body.sessionId,
    });

    // Sync committed article to Postgres if available
    if (pgWiki && !result.dryRun && result.articleId) {
      const article = wikiStore.get(result.articleId);
      if (article) {
        pgWiki.upsert(article).catch(() => { /* best-effort */ });
      }
    }

    return reply.send(result);
  });

  /** DELETE /wiki/articles/:id */
  app.delete<{ Params: { id: string } }>(
    "/wiki/articles/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const deletedMem = wikiStore.delete(request.params.id);
      if (pgWiki) {
        await pgWiki.delete(request.params.id).catch(() => { /* best-effort */ });
      }
      if (!deletedMem && !pgWiki) return reply.code(404).send({ error: "Article not found" });
      wikiStore.reindex();
      return reply.code(204).send();
    },
  );

  /** POST /wiki/reindex */
  app.post("/wiki/reindex", { preHandler: requireAuth }, async (_req, reply) => {
    const terms = wikiStore.reindex();
    const total = pgWiki
      ? await pgWiki.count().catch(() => wikiStore.size())
      : wikiStore.size();
    return reply.send({ terms, articles: total });
  });
}
