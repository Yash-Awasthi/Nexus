// SPDX-License-Identifier: Apache-2.0
/**
 * Shared knowledge-graph wiring: the per-user store, the extractors and name search.
 * routes/kb.ts ingests documents into the graph; the librarian agent searches it.
 *
 * Store selection: pg-backed (NeonKGStore) when DATABASE_URL is set, else the
 * in-memory store. Either way each caller gets their own graph: the store is
 * resolved per call from the request's user, anonymous callers sharing one.
 *
 * Extraction: the default KnowledgeGraph runs the @nexus/nlp-utils LLM
 * extractors over the default driver. Both fail soft — no driver configured, or
 * a driver that errors, yields zero entities rather than a failed ingest,
 * because the caller asked to store a document and the graph is an enrichment of it.
 */

import {
  InMemoryKGStore,
  NeonKGStore,
  KnowledgeGraph,
  type KGStore,
  type NeonRow,
  type NeonQueryFn,
  type EntityExtractor,
  type RelationshipExtractor,
} from "@nexus/knowledge-graph";
import type { LlmDriver, LlmRole } from "@nexus/llm-drivers";
import { extractEntities, extractRelationships, type NlpLlmClient } from "@nexus/nlp-utils";

import { ANON_OWNER, claimable } from "./owner.js";
import { getPgPool } from "./pg-pool.js";
import { getCacheUserId } from "./user-context.js";

// ponytail: only used without a database, where nothing outlives the process anyway.
const _memory = new Map<string, InMemoryKGStore>();
let _schema: Promise<void> | null = null;

/** Queries against the graph tables, once they exist; null without a database. */
function graphQuery(): NeonQueryFn | null {
  const pool = getPgPool();
  if (!pool) return null;
  const raw: NeonQueryFn = (sql, params) =>
    pool.query(sql, params ?? []).then((r) => ({ rows: r.rows as NeonRow[] }));
  _schema ??= new NeonKGStore({ query: raw }).init().catch((err: unknown) => {
    _schema = null;
    throw err;
  });
  const schema = _schema;
  return (sql, params) => schema.then(() => raw(sql, params));
}

/** The calling user's graph. */
export function getKGStore(): KGStore {
  const owner = getCacheUserId() ?? ANON_OWNER;
  const query = graphQuery();
  if (query) return new NeonKGStore({ query, owner });
  let store = _memory.get(owner);
  if (!store) _memory.set(owner, (store = new InMemoryKGStore()));
  return store;
}

// Rows written before graphs had owners carry "". An id the account already holds stays behind.
claimable("knowledge_graph", {
  count: async () =>
    Number(
      (await graphQuery()?.("SELECT count(*)::int AS n FROM kg_nodes WHERE owner=''"))?.rows[0]
        ?.n ?? 0,
    ),
  assign: async (userId) => {
    const query = graphQuery();
    if (!query) return 0;
    let moved = 0;
    for (const table of ["kg_nodes", "kg_edges"]) {
      const { rows } = await query(
        `UPDATE ${table} SET owner=$1 WHERE owner='' AND id NOT IN (SELECT id FROM ${table} WHERE owner=$1) RETURNING id`,
        [userId],
      );
      if (table === "kg_nodes") moved = rows.length;
    }
    return moved;
  },
});

/** Adapt an LlmDriver to the minimal client @nexus/nlp-utils expects. */
export function nlpClientFromDriver(driver: LlmDriver, model?: string): NlpLlmClient {
  return async (messages, opts) => {
    const res = await driver.complete({
      model: model ?? (driver.model || "default"),
      messages: messages.map((m) => ({ role: m.role as LlmRole, content: m.content })),
      temperature: opts?.temperature,
      maxTokens: opts?.maxTokens,
    });
    // Extraction parses JSON, so a blank or truncated answer must fail loudly, not read as no entities.
    if (res.finishReason === "length") {
      throw new Error("The model's answer was cut off at its token limit. Try another model.");
    }
    if (!res.content.trim()) throw new Error("The model returned an empty answer.");
    return { content: res.content, model: res.model };
  };
}

/**
 * Extraction is two model calls per document or chunk, so NEXUS_EXTRACT_MODEL ("provider/model")
 * can name a cheap one. A provider the caller has no key for falls back to the default chain.
 */
export async function extractionClient(): Promise<NlpLlmClient | null> {
  // Deferred: api-bridge imports this module, so a static import would cycle.
  const { getDefaultDriver, getPinnedDriver } = await import("../routes/api-bridge.js");
  const { resolveMemberModel } = await import("../routes/council.js");
  const choice = process.env.NEXUS_EXTRACT_MODEL?.trim();
  const wanted = choice ? resolveMemberModel(choice) : null;
  const pinned = wanted ? getPinnedDriver(wanted.provider) : undefined;
  if (wanted && pinned) return nlpClientFromDriver(pinned, wanted.model);
  const driver = getDefaultDriver();
  return driver ? nlpClientFromDriver(driver) : null;
}

async function modelClient(): Promise<NlpLlmClient> {
  const llm = await extractionClient();
  if (!llm) throw new Error("No model is configured. Add a provider key in Settings.");
  return llm;
}

const entityExtractor: EntityExtractor = async (text) => extractEntities(text, await modelClient());

const relationshipExtractor: RelationshipExtractor = async (text, entities) =>
  extractRelationships(text, entities, await modelClient());

/** The same extractors, answering with no entities when the model cannot. */
const soft =
  <A extends unknown[], R>(run: (...args: A) => Promise<R[]>) =>
  async (...args: A): Promise<R[]> => {
    try {
      return await run(...args);
    } catch {
      return [];
    }
  };

/**
 * The calling user's graph, with the shared extractors. They fail soft by default, because a
 * document upload should not fail over its enrichment; `strict` lets a model error through so a
 * background build can report it.
 */
export function getKG(strict = false): KnowledgeGraph {
  return new KnowledgeGraph(
    getKGStore(),
    strict ? entityExtractor : soft(entityExtractor),
    strict ? relationshipExtractor : soft(relationshipExtractor),
  );
}

const QUESTION_WORDS = new Set(["what", "who", "which", "does", "know", "about", "the", "and"]);

/** Nodes named by `q` or by any of its words, with the edges running between them. */
export async function searchGraph(store: KGStore, q: string, k: number) {
  const words = q
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length >= 3 && !QUESTION_WORDS.has(w));
  const found = await Promise.all(
    [q, ...words].map((w) => store.findNodes({ nameContains: w, limit: k })),
  );
  const nodes = [...new Map(found.flat().map((n) => [n.id, n])).values()].slice(0, k);
  const ids = new Set(nodes.map((n) => n.id));
  const out = await Promise.all(nodes.map((n) => store.findEdges({ subjectId: n.id })));
  return { nodes, edges: out.flat().filter((e) => ids.has(e.objectId)) };
}
