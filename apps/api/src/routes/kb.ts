// SPDX-License-Identifier: Apache-2.0
/**
 * Knowledge bases: a user's named document collections.
 *
 * An uploaded document's text is extracted (text, markdown, CSV, HTML, PDF,
 * DOCX), split into overlapping chunks and stored in the shared memory store
 * tagged with its knowledge base, so it can be searched here and pulled into
 * a chat with an @kb mention.
 *
 *   GET    /api/kb                         — the caller's knowledge bases
 *   POST   /api/kb                         — create
 *   DELETE /api/kb/:id                     — delete, with its chunks
 *   GET    /api/kb/:id/documents           — documents
 *   POST   /api/kb/:id/documents           — upload { name, content | contentBase64 }
 *   DELETE /api/kb/:id/documents/:docId    — remove a document and its chunks
 *   GET    /api/kb/:id/search?q=           — best-matching chunks
 *          &decompose=1                    — search a multi-part question as sub-questions
 *   POST   /api/kb/:id                     — knowledge-graph ingestion of raw text
 *   POST   /api/kb/:id/graph               — start reading the stored chunks into the knowledge graph
 *          { entityTypes?, maxChunks? }      (entityTypes keeps only those kinds of entity)
 *   GET    /api/kb/:id/graph               — progress of the latest build
 *
 * Mounted inside apiBridgeRoutes (same /api/* scope, same auth hooks).
 */

import crypto from "node:crypto";

import { RobotsChecker, type AdaptiveScraper } from "@nexus/adaptive-scraper";
import { chunkText, DocumentConsumer, type DocClass } from "@nexus/doc-pipeline";
import {
  extractGraphFromChunks,
  strictTypeValidator,
  type EntityType,
  type KnowledgeGraph,
} from "@nexus/knowledge-graph";
import type { LlmRole } from "@nexus/llm-drivers";
import type { MemoryManager } from "@nexus/memory";
import { decompositionRetrieve, type SourceRetrieverFn } from "@nexus/retrieval";
import type { FastifyInstance } from "fastify";

import { extractText, isImageType } from "../lib/extract-text.js";
import { createNotification } from "../lib/notifications-store.js";
import { claimable, ownsRow } from "../lib/owner.js";
import { PersistentStore } from "../lib/persistent-store.js";
import { fetchPublic, unsafeUrlReason } from "../lib/public-url.js";
import { emitReaction } from "../lib/reactions.js";
import { importSite } from "../lib/site-import.js";

const now = (): string => new Date().toISOString();

interface KbDoc {
  id: string;
  name: string;
  size: string;
  type: string;
  chunks?: number;
  docClass?: DocClass;
  tags?: string[];
}
interface Kb {
  id: string;
  ownerId?: string | null;
  name: string;
  description: string;
  docCount: number;
  createdAt: string;
  documents: KbDoc[];
}

const _kbStore = new PersistentStore<Kb>("kb");
claimable("kb", _kbStore);

const MAX_DOC_CHARS = 2_000_000;

/** Rule-based: labels every document without a model call. */
const classifier = new DocumentConsumer();

function getDocTypeFromName(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "csv") return "csv";
  if (ext === "txt") return "txt";
  if (ext === "html" || ext === "htm") return "html";
  if (ext && isImageType(ext)) return ext;
  return "md";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Bridge-owned helpers handed in at registration (no circular import). */
interface KbRoutesDeps {
  getKG: () => KnowledgeGraph;
  getMemory: () => MemoryManager;
  /** Fetches through the SSRF guard. */
  getScraper: () => AdaptiveScraper;
  llm: (messages: { role: LlmRole; content: string }[], maxTokens?: number) => Promise<string>;
}

const DECOMPOSE_PROMPT =
  "Split the user's question into the separate questions it asks, one per line, at most four. " +
  "Each must stand alone without the others. If it asks only one thing, repeat it unchanged. " +
  "Reply with the questions only.";

/** Numbered or bulleted model lines as plain questions. */
function parseSubQuestions(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "").trim())
    .filter((l) => l.length > 3)
    .slice(0, 4);
}

const MAX_CRAWL_PAGES = 25;

const ENTITY_TYPES: EntityType[] = [
  "PERSON",
  "ORG",
  "LOCATION",
  "DATE",
  "PRODUCT",
  "EVENT",
  "OTHER",
];
/** Each chunk costs two model calls, so a graph build reads a bounded slice of the base. */
const DEFAULT_GRAPH_CHUNKS = 50;
const MAX_GRAPH_CHUNKS = 200;

interface GraphJob {
  state: "running" | "done" | "error";
  chunksDone: number;
  chunksTotal: number;
  /** Chunks the base holds, of which `chunksTotal` are read */
  of: number;
  entities: number;
  relationships: number;
  failed: number;
  error?: string;
  startedAt: string;
}
/** The latest graph build of each knowledge base; a restart forgets them, the graph itself stays. */
const graphJobs = new Map<string, GraphJob>();

/** The knowledge bases a caller can see. */
export function listKbsFor(userId: string | undefined): Kb[] {
  return [..._kbStore.values()].filter((kb) => ownsRow({ nexusUserId: userId }, kb));
}

/** Top chunks from the caller's knowledge base(s) for a query. */
export async function searchKb(
  mem: MemoryManager,
  userId: string | undefined,
  query: string,
  kbId?: string,
  limit = 5,
): Promise<{ id: string; kbId: string; docName: string; text: string; score: number }[]> {
  const hits = await mem.recall(query, limit * 3, {
    userId: userId ?? "local",
    metadata: kbId ? { category: "kb", kbId } : { category: "kb" },
  });
  return hits.slice(0, limit).map((h) => ({
    id: h.entry.id,
    kbId: String(h.entry.metadata.kbId ?? ""),
    docName: String(h.entry.metadata.docName ?? ""),
    text: h.entry.text,
    score: h.score,
  }));
}

/** The caller's knowledge base with this name, created when missing. */
export function ensureKb(userId: string | undefined, name: string, description = ""): Kb {
  const found = listKbsFor(userId).find(
    (kb) => kb.ownerId === (userId ?? null) && kb.name === name,
  );
  if (found) return found;
  const kb: Kb = {
    id: crypto.randomUUID(),
    ownerId: userId ?? null,
    name: name.slice(0, 200),
    description: description.slice(0, 2000),
    docCount: 0,
    createdAt: now(),
    documents: [],
  };
  _kbStore.set(kb.id, kb);
  return kb;
}

/**
 * Chunk `text` into a knowledge base as one document. With `replace`, an
 * existing document of the same name is dropped first, so a re-sync updates.
 */
export async function putKbText(
  mem: MemoryManager,
  userId: string | undefined,
  kbId: string,
  name: string,
  text: string,
  opts: { size?: string; type?: string; replace?: boolean } = {},
): Promise<KbDoc | null> {
  const kb = _kbStore.get(kbId);
  if (!kb) return null;
  const owner = userId ?? "local";
  if (opts.replace) {
    const old = kb.documents.filter((d) => d.name === name);
    for (const d of old) {
      const rows = await mem.list({
        userId: owner,
        metadata: { category: "kb", kbId, docId: d.id },
      });
      await Promise.all(rows.map((r) => mem.forget(r.id)));
    }
    kb.documents = kb.documents.filter((d) => d.name !== name);
  }
  const { docClass, tags } = await classifier.consume({
    format: "text",
    content: text,
    source: name,
  });
  const doc: KbDoc = {
    id: "doc_" + crypto.randomUUID(),
    name,
    size: opts.size ?? formatSize(Buffer.byteLength(text)),
    type: opts.type ?? getDocTypeFromName(name),
    docClass,
    tags,
  };
  const chunks = chunkText(text.slice(0, MAX_DOC_CHARS), { maxTokens: 400, overlapTokens: 50 });
  for (const c of chunks) {
    await mem.remember(c.text, {
      metadata: { category: "kb", kbId, docId: doc.id, docName: name, chunk: c.index },
      userId: owner,
    });
  }
  doc.chunks = chunks.length;
  kb.documents.push(doc);
  _kbStore.set(kb.id, kb);
  return doc;
}

/** Drop the documents whose names are not in `keep`; returns how many went. */
export async function pruneKbDocs(
  mem: MemoryManager,
  userId: string | undefined,
  kbId: string,
  keep: Set<string>,
): Promise<number> {
  const kb = _kbStore.get(kbId);
  if (!kb) return 0;
  const gone = kb.documents.filter((d) => !keep.has(d.name));
  for (const d of gone) {
    const rows = await mem.list({
      userId: userId ?? "local",
      metadata: { category: "kb", kbId, docId: d.id },
    });
    await Promise.all(rows.map((r) => mem.forget(r.id)));
  }
  kb.documents = kb.documents.filter((d) => keep.has(d.name));
  _kbStore.set(kb.id, kb);
  return gone.length;
}

/** Text from HTML, for pages fetched rather than uploaded. */
export const htmlToText = (html: string): Promise<string> =>
  extractText("html", Buffer.from(html, "utf8"));

/** Register the /kb surface. Called from apiBridgeRoutes. */
export async function kbRoutes(app: FastifyInstance, deps: KbRoutesDeps): Promise<void> {
  await _kbStore.load();
  // Rows written before documents were tracked have no list.
  for (const kb of _kbStore.values()) {
    if (!Array.isArray(kb.documents)) _kbStore.set(kb.id, { ...kb, documents: [] });
  }

  const mine = (req: { nexusUserId?: string }, id: string) => {
    const kb = _kbStore.get(id);
    return kb && ownsRow(req, kb) ? kb : undefined;
  };
  const dropChunks = (req: { nexusUserId?: string }, filter: Record<string, unknown>) =>
    deps
      .getMemory()
      .list({ userId: req.nexusUserId ?? "local", metadata: { category: "kb", ...filter } })
      .then((rows) => Promise.all(rows.map((r) => deps.getMemory().forget(r.id))))
      .catch(() => undefined);

  app.get("/kb", async (request, reply) => {
    const kbs = [..._kbStore.values()]
      .filter((kb) => mine(request, kb.id))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((kb) => ({ ...kb, docCount: kb.documents.length }));
    return reply.send({ kbs, total: kbs.length });
  });

  app.post<{ Params: { id: string }; Body: { text?: string } }>(
    "/kb/:id",
    async (request, reply) => {
      const text = request.body?.text?.trim();
      if (!text) return reply.code(400).send({ error: "text is required" });
      const result = await deps.getKG().ingest(text, { source: request.params.id });
      return reply.code(201).send(result);
    },
  );

  app.post<{ Body: { name?: string; description?: string } }>("/kb", async (request, reply) => {
    const name = request.body?.name?.trim();
    if (!name) return reply.code(400).send({ error: "name is required" });
    const kb: Kb = {
      id: crypto.randomUUID(),
      ownerId: request.nexusUserId ?? null,
      name: name.slice(0, 200),
      description: (request.body.description ?? "").slice(0, 2000),
      docCount: 0,
      createdAt: now(),
      documents: [],
    };
    _kbStore.set(kb.id, kb);
    return reply.code(201).send(kb);
  });

  app.delete<{ Params: { id: string } }>("/kb/:id", async (request, reply) => {
    if (!mine(request, request.params.id)) return reply.code(404).send({ error: "not_found" });
    _kbStore.delete(request.params.id);
    graphJobs.delete(request.params.id);
    await dropChunks(request, { kbId: request.params.id });
    return reply.code(204).send();
  });

  /** POST /kb/:id/crawl — import a website: each same-site page, robots.txt permitting, becomes a document. */
  app.post<{ Params: { id: string }; Body: { url?: string; maxPages?: number } }>(
    "/kb/:id/crawl",
    async (request, reply) => {
      const kb = mine(request, request.params.id);
      if (!kb) return reply.code(404).send({ error: "knowledge base not found" });
      const url = request.body?.url?.trim() ?? "";
      const why = /^https?:\/\//i.test(url) ? unsafeUrlReason(url) : "an http(s) URL is required";
      if (why) return reply.code(400).send({ error: why });
      const maxPages = Math.min(
        MAX_CRAWL_PAGES,
        Math.max(1, Math.floor(request.body?.maxPages ?? 10)),
      );
      const { pages, disallowed } = await importSite(url, {
        scraper: deps.getScraper(),
        robots: new RobotsChecker({ fetch: (u, init) => fetchPublic(String(u), init) }),
        maxPages,
      });
      for (const page of pages) {
        await putKbText(deps.getMemory(), request.nexusUserId, kb.id, page.title, page.text, {
          type: "html",
          replace: true,
        });
      }
      emitReaction(request.nexusUserId, "kb.document.added", { kbId: kb.id, name: url });
      return reply.code(201).send({
        added: pages.length,
        disallowed,
        documents: pages.map((p) => ({ name: p.title, url: p.url })),
      });
    },
  );

  /**
   * POST /kb/:id/graph — extract entities and relationships from the base's chunks into the graph.
   * Each chunk costs two model calls, so this runs in the background: 202 with the job, then poll GET.
   */
  app.post<{
    Params: { id: string };
    Body: { entityTypes?: string[]; maxChunks?: number };
  }>("/kb/:id/graph", async (request, reply) => {
    const kb = mine(request, request.params.id);
    if (!kb) return reply.code(404).send({ error: "knowledge base not found" });
    const running = graphJobs.get(kb.id);
    if (running?.state === "running") return reply.code(202).send(running);
    const types = request.body?.entityTypes;
    if (types && !types.every((t) => ENTITY_TYPES.includes(t as EntityType))) {
      return reply.code(400).send({ error: `entityTypes are ${ENTITY_TYPES.join(", ")}` });
    }
    const rows = await deps.getMemory().list({
      userId: request.nexusUserId ?? "local",
      metadata: { category: "kb", kbId: kb.id },
    });
    if (rows.length === 0) return reply.code(400).send({ error: "add documents first" });
    const limit = Math.min(
      MAX_GRAPH_CHUNKS,
      Math.max(1, Math.floor(request.body?.maxChunks ?? DEFAULT_GRAPH_CHUNKS)),
    );
    const key = (r: (typeof rows)[number]) =>
      `${r.metadata.docId}:${String(r.metadata.chunk).padStart(6, "0")}`;
    const chunks = rows
      .sort((a, b) => key(a).localeCompare(key(b)))
      .slice(0, limit)
      .map((r) => ({ id: r.id, text: r.text }));

    const job: GraphJob = {
      state: "running",
      chunksDone: 0,
      chunksTotal: chunks.length,
      of: rows.length,
      entities: 0,
      relationships: 0,
      failed: 0,
      startedAt: now(),
    };
    graphJobs.set(kb.id, job);
    const userId = request.nexusUserId;
    extractGraphFromChunks(deps.getKG(), chunks, {
      source: kb.id,
      concurrency: 4,
      validator: types?.length ? strictTypeValidator(types as EntityType[]) : undefined,
      onProgress: (done) => {
        job.chunksDone = done;
      },
    })
      .then((result) => {
        Object.assign(job, {
          state: "done",
          entities: result.totalNodesAdded + result.totalNodesMerged,
          relationships: result.totalEdgesAdded + result.totalEdgesMerged,
          failed: result.chunksErrored,
        });
      })
      .catch((err: unknown) => {
        job.state = "error";
        job.error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        void createNotification(userId, {
          type: "knowledge",
          title:
            job.state === "done"
              ? `Graph built for ${kb.name}`
              : `Graph build failed for ${kb.name}`,
          message:
            job.state === "done"
              ? `${job.entities} entities and ${job.relationships} relationships.`
              : job.error,
          link: "/knowledge-graph",
        });
      });
    return reply.code(202).send(job);
  });

  app.get<{ Params: { id: string } }>("/kb/:id/graph", async (request, reply) => {
    if (!mine(request, request.params.id)) {
      return reply.code(404).send({ error: "knowledge base not found" });
    }
    return reply.send(graphJobs.get(request.params.id) ?? { state: "idle" });
  });

  app.get<{ Params: { id: string } }>("/kb/:id/documents", async (request, reply) => {
    const kb = mine(request, request.params.id);
    if (!kb) return reply.code(404).send({ error: "knowledge base not found" });
    return reply.send({ documents: kb.documents, total: kb.documents.length });
  });

  app.post<{
    Params: { id: string };
    Body: { name?: string; size?: string; content?: string; contentBase64?: string };
  }>("/kb/:id/documents", { bodyLimit: 30 * 1024 * 1024 }, async (request, reply) => {
    const kb = mine(request, request.params.id);
    if (!kb) return reply.code(404).send({ error: "knowledge base not found" });
    const name = request.body?.name?.trim() || "untitled";
    const type = getDocTypeFromName(name);
    const bytes =
      typeof request.body?.contentBase64 === "string"
        ? Buffer.from(request.body.contentBase64, "base64")
        : typeof request.body?.content === "string"
          ? Buffer.from(request.body.content, "utf8")
          : null;
    if (!bytes || bytes.length === 0) {
      return reply.code(400).send({ error: "content or contentBase64 is required" });
    }
    let text: string;
    try {
      text = (await extractText(type, bytes)).slice(0, MAX_DOC_CHARS).trim();
    } catch (err) {
      return reply.code(422).send({
        error: `Could not read ${name}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    if (!text) return reply.code(422).send({ error: `${name} contains no readable text` });

    const doc = await putKbText(deps.getMemory(), request.nexusUserId, kb.id, name, text, {
      size: formatSize(bytes.length),
      type,
    });
    emitReaction(request.nexusUserId, "kb.document.added", { kbId: kb.id, name });
    return reply.code(201).send(doc);
  });

  app.delete<{ Params: { id: string; docId: string } }>(
    "/kb/:id/documents/:docId",
    async (request, reply) => {
      const kb = mine(request, request.params.id);
      if (!kb) return reply.code(404).send({ error: "knowledge base not found" });
      kb.documents = kb.documents.filter((d) => d.id !== request.params.docId);
      _kbStore.set(kb.id, kb);
      await dropChunks(request, { kbId: kb.id, docId: request.params.docId });
      return reply.code(204).send();
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { q?: string; limit?: string; decompose?: string };
  }>("/kb/:id/search", async (request, reply) => {
    if (!mine(request, request.params.id)) {
      return reply.code(404).send({ error: "knowledge base not found" });
    }
    const q = request.query.q?.trim();
    if (!q) return reply.code(400).send({ error: "q is required" });
    const limit = Math.min(20, Math.max(1, parseInt(request.query.limit ?? "5", 10) || 5));
    const search = (query: string, n: number) =>
      searchKb(deps.getMemory(), request.nexusUserId, query, request.params.id, n);
    if (request.query.decompose !== "1") return reply.send({ results: await search(q, limit) });

    const subQuestions: string[] = [];
    const hits = new Map<string, Awaited<ReturnType<typeof search>>[number]>();
    const retriever: SourceRetrieverFn = async (query, n) =>
      (await search(query, n)).map((h) => {
        hits.set(h.id, h);
        return { ...h, docId: h.docName, source: "knowledge_base" as const };
      });
    const merged = await decompositionRetrieve(
      q,
      retriever,
      async (query) => {
        const subs = parseSubQuestions(
          await deps.llm(
            [
              { role: "system", content: DECOMPOSE_PROMPT },
              { role: "user", content: query },
            ],
            300,
          ),
        );
        subQuestions.push(...subs);
        return subs;
      },
      // One level: the question itself, then its sub-questions.
      { maxDepth: 1, limitPerQuery: limit, sufficiencyCheck: async (query) => query !== q },
    );
    const cap = Math.min(20, limit * Math.max(1, subQuestions.length));
    return reply.send({
      subQuestions,
      results: merged.chunks.slice(0, cap).map((c) => hits.get(c.id)!),
    });
  });
}
