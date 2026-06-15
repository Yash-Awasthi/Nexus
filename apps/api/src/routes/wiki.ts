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
import {
  WikiCommentStore,
  WikiDraftStore,
  WikiAcl,
  WikiSearch,
  WikiNotifier,
} from "@nexus/wiki";
import type { FastifyInstance } from "fastify";

import { requireAuth } from "../middleware/auth.js";

// ── Singletons ────────────────────────────────────────────────────────────────

// In-memory store for the pipeline (sync BM25 search)
const wikiStore = new WikiStore();
const wikiPipeline = new WikiUpdatePipeline({ store: wikiStore, autoCreate: true });

// ── @nexus/wiki — comments, drafts, ACL ──────────────────────────────────────
const wikiComments = new WikiCommentStore();
const wikiDrafts   = new WikiDraftStore();
const wikiAcl      = new WikiAcl();
const _wikiSearch  = new WikiSearch(); // supplementary full-text across comments
const _wikiNotifier = new WikiNotifier();

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
    reply.header("Cache-Control", "private, max-age=60, stale-while-revalidate=300");
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

  // ── Comments ──────────────────────────────────────────────────────────────

  /**
   * GET /wiki/articles/:id/comments
   * List all comments for a page (thread-ordered).
   */
  app.get<{ Params: { id: string } }>(
    "/wiki/articles/:id/comments",
    { preHandler: requireAuth },
    async (request, reply) => {
      const comments = wikiComments.listForPage(request.params.id);
      return reply.send({ comments, total: comments.length });
    },
  );

  /**
   * POST /wiki/articles/:id/comments
   * Body: { authorId, content, parentId? }
   */
  app.post<{
    Params: { id: string };
    Body: { authorId: string; content: string; parentId?: string };
  }>(
    "/wiki/articles/:id/comments",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { authorId, content, parentId } = request.body;
      if (!authorId || !content) {
        return reply.code(400).send({ error: "authorId and content are required" });
      }
      const comment = wikiComments.add(request.params.id, authorId, content, parentId);
      _wikiNotifier.notify({
        event:        "comment_added",
        pageId:       request.params.id,
        actorId:      authorId,
        recipientIds: [],
        payload:      { commentId: comment.id },
      });
      return reply.code(201).send(comment);
    },
  );

  /**
   * PATCH /wiki/comments/:commentId — edit content
   * Body: { content }
   */
  app.patch<{
    Params: { commentId: string };
    Body: { content: string };
  }>(
    "/wiki/comments/:commentId",
    { preHandler: requireAuth },
    async (request, reply) => {
      try {
        const updated = wikiComments.update(request.params.commentId, request.body.content);
        return reply.send(updated);
      } catch {
        return reply.code(404).send({ error: "Comment not found" });
      }
    },
  );

  /**
   * POST /wiki/comments/:commentId/resolve — mark resolved
   */
  app.post<{ Params: { commentId: string } }>(
    "/wiki/comments/:commentId/resolve",
    { preHandler: requireAuth },
    async (request, reply) => {
      try {
        const resolved = wikiComments.resolve(request.params.commentId);
        return reply.send(resolved);
      } catch {
        return reply.code(404).send({ error: "Comment not found" });
      }
    },
  );

  /**
   * DELETE /wiki/comments/:commentId
   */
  app.delete<{ Params: { commentId: string } }>(
    "/wiki/comments/:commentId",
    { preHandler: requireAuth },
    async (request, reply) => {
      try {
        wikiComments.delete(request.params.commentId);
        return reply.code(204).send();
      } catch {
        return reply.code(404).send({ error: "Comment not found" });
      }
    },
  );

  // ── Drafts ────────────────────────────────────────────────────────────────

  /**
   * GET /wiki/drafts?authorId=<id>
   * List drafts for an author.
   */
  app.get<{ Querystring: { authorId?: string } }>(
    "/wiki/drafts",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { authorId = "" } = request.query;
      const drafts = authorId ? wikiDrafts.listFor(authorId) : [];
      return reply.send({ drafts, total: drafts.length });
    },
  );

  /**
   * POST /wiki/drafts
   * Save a new draft (or overwrite existing draft for pageId+authorId).
   * Body: { authorId, title, content, pageId? }
   */
  app.post<{
    Body: { authorId: string; title: string; content: string; pageId?: string };
  }>(
    "/wiki/drafts",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { authorId, title, content, pageId } = request.body;
      if (!authorId || !title || content === undefined) {
        return reply.code(400).send({ error: "authorId, title, and content are required" });
      }
      const draft = wikiDrafts.save(authorId, title, content, pageId);
      _wikiNotifier.notify({
        event:        "draft_saved",
        pageId:       pageId ?? "",
        actorId:      authorId,
        recipientIds: [],
        payload:      { draftId: draft.id },
      });
      return reply.code(201).send(draft);
    },
  );

  /**
   * GET /wiki/drafts/:draftId
   */
  app.get<{ Params: { draftId: string } }>(
    "/wiki/drafts/:draftId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const draft = wikiDrafts.get(request.params.draftId);
      if (!draft) return reply.code(404).send({ error: "Draft not found" });
      return reply.send(draft);
    },
  );

  /**
   * DELETE /wiki/drafts/:draftId
   */
  app.delete<{ Params: { draftId: string } }>(
    "/wiki/drafts/:draftId",
    { preHandler: requireAuth },
    async (request, reply) => {
      try {
        wikiDrafts.delete(request.params.draftId);
        return reply.code(204).send();
      } catch {
        return reply.code(404).send({ error: "Draft not found" });
      }
    },
  );

  // ── ACL ───────────────────────────────────────────────────────────────────

  /**
   * GET /wiki/articles/:id/acl
   * List ACL entries for a page.
   */
  app.get<{ Params: { id: string } }>(
    "/wiki/articles/:id/acl",
    { preHandler: requireAuth },
    async (request, reply) => {
      const entries = wikiAcl.listEntries(request.params.id);
      return reply.send({ pageId: request.params.id, entries });
    },
  );

  /**
   * POST /wiki/articles/:id/acl
   * Grant a role to a user.
   * Body: { userId, role, grantedBy }
   */
  app.post<{
    Params: { id: string };
    Body: { userId: string; role: "owner" | "editor" | "viewer"; grantedBy: string };
  }>(
    "/wiki/articles/:id/acl",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { userId, role, grantedBy } = request.body;
      if (!userId || !role || !grantedBy) {
        return reply.code(400).send({ error: "userId, role, and grantedBy are required" });
      }
      const entry = wikiAcl.grant(request.params.id, userId, role, grantedBy);
      return reply.code(201).send(entry);
    },
  );

  /**
   * DELETE /wiki/articles/:id/acl/:userId
   * Revoke a user's access to a page.
   */
  app.delete<{ Params: { id: string; userId: string } }>(
    "/wiki/articles/:id/acl/:userId",
    { preHandler: requireAuth },
    async (request, reply) => {
      wikiAcl.revoke(request.params.id, request.params.userId);
      return reply.code(204).send();
    },
  );

  /**
   * GET /wiki/articles/:id/acl/:userId/role
   * Check a user's effective role on a page.
   */
  app.get<{ Params: { id: string; userId: string } }>(
    "/wiki/articles/:id/acl/:userId/role",
    { preHandler: requireAuth },
    async (request, reply) => {
      const role = wikiAcl.getRole(request.params.id, request.params.userId);
      return reply.send({ pageId: request.params.id, userId: request.params.userId, role });
    },
  );
}
