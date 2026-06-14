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
 */

import { WikiStore, WikiUpdatePipeline } from "@nexus/wiki-updater";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// Singletons — in-memory for now; swap for persistent adapter later
const wikiStore = new WikiStore();
const wikiPipeline = new WikiUpdatePipeline({ store: wikiStore, autoCreate: true });

export async function wikiRoutes(app: FastifyInstance): Promise<void> {
  /** GET /wiki/articles */
  app.get("/wiki/articles", { preHandler: requireAuth }, async (_req, reply) => {
    const articles = wikiStore.all();
    return reply.send({ articles, total: articles.length });
  });

  /** GET /wiki/articles/:id */
  app.get<{ Params: { id: string } }>(
    "/wiki/articles/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const article = wikiStore.get(request.params.id);
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
      const articles = wikiStore.search(q, limit);
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
    return reply.send(result);
  });

  /** DELETE /wiki/articles/:id */
  app.delete<{ Params: { id: string } }>(
    "/wiki/articles/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const deleted = wikiStore.delete(request.params.id);
      if (!deleted) return reply.code(404).send({ error: "Article not found" });
      wikiStore.reindex();
      return reply.code(204).send();
    },
  );

  /** POST /wiki/reindex */
  app.post("/wiki/reindex", { preHandler: requireAuth }, async (_req, reply) => {
    const terms = wikiStore.reindex();
    return reply.send({ terms, articles: wikiStore.size() });
  });
}
