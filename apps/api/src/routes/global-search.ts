// SPDX-License-Identifier: Apache-2.0
/**
 * One search box for everything this account owns.
 *
 * The surfaces that hold something worth finding are separate stores with separate shapes:
 * chat sessions (`threads-store`), council discussions, knowledge bases and their documents,
 * workflows, and the knowledge-graph nodes extracted from them. Each has its own query
 * language or none; joining them per surface would mean the client calling five endpoints
 * and merging five orderings badly.
 *
 *   GET /api/v1/search?q=<text>&types=session,discussion&limit=20
 *     → { query, total, results: Hit[], counts: Record<type, number>, notes: string[] }
 *
 * `counts` is per type *before* the global limit, so a result list can say "3 more in
 * workflows" and a client can fetch that type alone. `notes` says what could not be searched
 * — an empty knowledge graph, a search backend that is not configured — because a silent
 * zero is indistinguishable from "you own nothing".
 *
 * Ranking is deliberately simple and explainable: a match in the title or name scores three,
 * a match in the body scores one, and ties break on recency. No embeddings, no cross-encoder,
 * no reranker: those exist on `/api/search` for documents, and mixing two scoring scales in
 * one list would make the order meaningless.
 */
import type { FastifyInstance } from "fastify";

import { getKGStore } from "../lib/knowledge-graph-store.ts";
import { ownerIdFor } from "../lib/owner.ts";
import { searchThreads } from "../lib/threads-store.ts";
import { requireAuthWithTier } from "../middleware/auth.ts";

import { listDiscussionsFor, readDiscussion } from "./discussion.ts";
import { listKbsFor } from "./kb.ts";
import { listWorkflowsFor } from "./workflows.ts";

/** The names a caller can pass in `types`. */
export const SEARCH_TYPES = [
  "session",
  "discussion",
  "knowledge_base",
  "document",
  "workflow",
  "graph_node",
] as const;

export type SearchType = (typeof SEARCH_TYPES)[number];

export interface SearchHit {
  type: SearchType;
  id: string;
  title: string;
  /** A short, single-line extract around the match; never the whole body. */
  snippet: string;
  /** Where the UI opens it. */
  link: string;
  /** Higher is better; see the module comment for the three rules. */
  score: number;
  updatedAt: string;
}

const TITLE_MATCH = 3;
const BODY_MATCH = 1;
const SNIPPET_CHARS = 160;

function snippet(text: string, needle: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const at = needle ? flat.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  if (at === -1) return flat.slice(0, SNIPPET_CHARS);
  const start = Math.max(0, at - Math.floor(SNIPPET_CHARS / 3));
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + SNIPPET_CHARS)}`.trim();
}

/** Case-insensitive substring, which is what a person typing into a box expects. */
const hit = (haystack: string | undefined, needle: string): boolean =>
  !!haystack && haystack.toLowerCase().includes(needle.toLowerCase());

function scoreOf(title: string, body: string, needle: string): number {
  return (hit(title, needle) ? TITLE_MATCH : 0) + (hit(body, needle) ? BODY_MATCH : 0);
}

export async function globalSearchRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: { q?: string; types?: string; limit?: string };
  }>("/search", { preHandler: requireAuthWithTier }, async (request, reply) => {
    const query = (request.query.q ?? "").trim();
    if (query.length < 2) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "q must be at least 2 characters",
      });
    }
    const limit = Math.min(Math.max(parseInt(request.query.limit ?? "20", 10) || 20, 1), 100);
    const requested = (request.query.types ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value): value is SearchType => (SEARCH_TYPES as readonly string[]).includes(value));
    const wants = (type: SearchType): boolean => requested.length === 0 || requested.includes(type);

    const userId = request.nexusUserId;
    const owner = ownerIdFor(request);
    const notes: string[] = [];
    const hits: SearchHit[] = [];
    const counts: Record<string, number> = {};
    const note = (type: SearchType, found: number): void => {
      counts[type] = found;
    };

    // ── chat sessions ───────────────────────────────────────────────────────
    if (wants("session")) {
      const threads = await searchThreads(userId, query, limit * 2);
      const found = threads.map((thread) => {
        const body = (thread as { snippet?: string }).snippet ?? "";
        return {
          type: "session" as const,
          id: thread.id,
          title: thread.title || "Untitled session",
          snippet: snippet(body, query),
          link: `/chat/${thread.id}`,
          score: scoreOf(thread.title, body, query),
          updatedAt: thread.updatedAt,
        };
      });
      found.forEach((entry) => hits.push(entry));
      note("session", found.length);
    }

    // ── council discussions ─────────────────────────────────────────────────
    if (wants("discussion")) {
      const discussions = await listDiscussionsFor(owner);
      const matched: SearchHit[] = [];
      for (const discussion of discussions) {
        if (!hit(discussion.topic, query)) continue;
        // The digest is the part worth showing; reading the whole ledger for every match
        // would make a search of a hundred discussions as expensive as opening all of them.
        const record = await readDiscussion(discussion.id);
        const body = record?.digest ?? "";
        matched.push({
          type: "discussion",
          id: discussion.id,
          title: discussion.topic,
          snippet: snippet(body, query) || `${discussion.contributions} contributions`,
          link: `/discussion?id=${discussion.id}`,
          score: scoreOf(discussion.topic, body, query),
          updatedAt: discussion.finishedAt ?? discussion.startedAt,
        });
      }
      matched.forEach((entry) => hits.push(entry));
      note("discussion", matched.length);
    }

    // ── knowledge bases and their documents ─────────────────────────────────
    if (wants("knowledge_base") || wants("document")) {
      const kbs = listKbsFor(userId);
      const bases: SearchHit[] = [];
      const documents: SearchHit[] = [];
      for (const kb of kbs) {
        if (wants("knowledge_base") && (hit(kb.name, query) || hit(kb.description, query))) {
          bases.push({
            type: "knowledge_base",
            id: kb.id,
            title: kb.name,
            snippet: snippet(kb.description, query) || `${kb.docCount} documents`,
            link: `/knowledge?kb=${kb.id}`,
            score: scoreOf(kb.name, kb.description, query),
            updatedAt: kb.createdAt,
          });
        }
        if (!wants("document")) continue;
        for (const doc of kb.documents ?? []) {
          if (!hit(doc.name, query)) continue;
          documents.push({
            type: "document",
            id: `${kb.id}:${doc.name}`,
            title: doc.name,
            snippet: `in ${kb.name}`,
            link: `/knowledge?kb=${kb.id}&doc=${encodeURIComponent(doc.name)}`,
            score: TITLE_MATCH,
            updatedAt: kb.createdAt,
          });
        }
      }
      bases.forEach((entry) => hits.push(entry));
      documents.forEach((entry) => hits.push(entry));
      note("knowledge_base", bases.length);
      note("document", documents.length);
    }

    // ── workflows ───────────────────────────────────────────────────────────
    if (wants("workflow")) {
      const workflows = listWorkflowsFor(userId)
        .filter((workflow) => hit(workflow.name, query))
        .map((workflow) => ({
          type: "workflow" as const,
          id: workflow.id,
          title: workflow.name,
          snippet: `${workflow.steps} steps · ${workflow.status}`,
          link: `/workflows?id=${workflow.id}`,
          score: TITLE_MATCH,
          updatedAt: workflow.updatedAt,
        }));
      workflows.forEach((entry) => hits.push(entry));
      note("workflow", workflows.length);
    }

    // ── knowledge-graph nodes ───────────────────────────────────────────────
    if (wants("graph_node")) {
      try {
        const nodes = await getKGStore().findNodes({ nameContains: query, limit: limit * 2 });
        const found = nodes.map((node) => ({
          type: "graph_node" as const,
          id: node.id,
          title: node.name,
          snippet: `${node.type} · ${Math.round(node.confidence * 100)}% confidence`,
          link: `/knowledge-graph?node=${node.id}`,
          score: TITLE_MATCH,
          updatedAt: new Date(node.updatedAt).toISOString(),
        }));
        found.forEach((entry) => hits.push(entry));
        note("graph_node", found.length);
        if (found.length === 0) notes.push("the knowledge graph holds no node matching this query");
      } catch {
        counts.graph_node = 0;
        notes.push("the knowledge graph could not be read");
      }
    }

    hits.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt));
    const results = hits.slice(0, limit);
    return {
      query,
      total: hits.length,
      results,
      counts,
      notes,
      /** True when the caller asked for fewer types than exist, so the UI can offer "all". */
      filteredBy: requested.length ? requested : null,
    };
  });
}
