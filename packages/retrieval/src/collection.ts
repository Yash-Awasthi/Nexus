// SPDX-License-Identifier: Apache-2.0
/**
 * collection — chroma-shaped vector collection facade (pass 76, row 60).
 *
 * Row 60 (chroma) names a collection add/query facade with include/projection
 * as its honest remainder: @nexus/retrieval's stores and where-ops (pass 50)
 * are primitives, but nobody composes them into chroma's ergonomic NAMED API —
 * `add(ids, documents, metadatas)` → embed + persist in one call, `query`
 * returning the per-query result envelope with `include` projection
 * (documents/metadatas/distances/embeddings), `get` by ids/where with the same
 * projection, plus `count`/`delete`. This module is that facade over the
 * package's existing store + embedder + pass-50 where vocabulary — no new
 * storage or scoring machinery.
 *
 * Faithful shape: chroma result envelopes are PARALLEL arrays keyed by query
 * position (ids[i], documents[i], … for query i), and `include` selects which
 * projections are populated. Honest divergences (documented, not dropped):
 * `add` upserts on a duplicate id (chroma's `add` errors and reserves that for
 * `upsert`); the metric is the store's cosine similarity surfaced as chroma's
 * `distances` = 1 − cosine (chroma defaults to squared-L2 — engine metric
 * differs, noted); persistence/server semantics are the store's (in-memory
 * here), not chroma's server.
 */
import { InMemoryRagtimeStore } from "./index.js";
import type { IEmbedder, IMemoryStore } from "./index.js";
import type { WhereClause, WhereDocumentClause } from "./where.js";

export type CollectionInclude = "documents" | "metadatas" | "distances" | "embeddings";

/** Chroma's default query include set: documents + metadatas + distances. */
const DEFAULT_QUERY_INCLUDE: readonly CollectionInclude[] = [
  "documents",
  "metadatas",
  "distances",
];

export interface CollectionAddInput {
  /** One id per document. Duplicate ids upsert. */
  ids: string[];
  /** One document per id. Empty documents are rejected. */
  documents: string[];
  /** Optional per-id metadata (null entries stored as {}). */
  metadatas?: Array<Record<string, unknown> | null>;
}

export interface CollectionQueryOptions {
  /** Results per query (default 10). */
  nResults?: number;
  /** Chroma-style metadata filter (pass-50 where vocabulary). */
  where?: WhereClause;
  /** Document-text filter ($contains/$not_contains). */
  whereDocument?: WhereDocumentClause;
  /** Which projections to populate (default: documents, metadatas, distances). */
  include?: readonly CollectionInclude[];
}

export interface CollectionGetOptions {
  ids?: string[];
  where?: WhereClause;
  whereDocument?: WhereDocumentClause;
  /** Which projections to populate (default: documents + metadatas). */
  include?: readonly CollectionInclude[];
}

/** One query's row in a chroma-style result — parallel arrays per query text. */
export interface CollectionQueryRow {
  ids: string[];
  documents: string[];
  metadatas: Array<Record<string, unknown>>;
  distances: number[];
  embeddings: number[][];
}

export interface CollectionGetResult {
  ids: string[];
  documents: string[];
  metadatas: Array<Record<string, unknown>>;
  embeddings: number[][];
}

/**
 * A chroma-shaped collection over an {@link IMemoryStore} + {@link IEmbedder}.
 * Construction is pure — no I/O until add/query/get/count/delete.
 */
export class VectorCollection {
  private readonly store: IMemoryStore;
  private readonly embedder: IEmbedder;

  constructor(opts: { embedder: IEmbedder; store?: IMemoryStore }) {
    this.embedder = opts.embedder;
    this.store = opts.store ?? new InMemoryRagtimeStore();
  }

  /** Number of documents currently in the collection. */
  async count(): Promise<number> {
    return (await this.store.list({ excludeExpired: false })).length;
  }

  /**
   * Embed and persist documents in one call (chroma `collection.add`). The
   * lengths of ids / documents / metadatas must agree and no document may be
   * empty. Duplicate ids upsert.
   */
  async add(input: CollectionAddInput): Promise<void> {
    const { ids, documents, metadatas } = input;
    if (ids.length !== documents.length) {
      throw new Error(`ids (${ids.length}) and documents (${documents.length}) lengths differ`);
    }
    if (metadatas && metadatas.length !== ids.length) {
      throw new Error(`metadatas (${metadatas.length}) and ids (${ids.length}) lengths differ`);
    }
    const now = Math.floor(Date.now() / 1000);
    const embeddings = await Promise.all(documents.map((d) => this.embedder.embed(d)));
    for (let i = 0; i < ids.length; i++) {
      const text = documents[i] ?? "";
      if (!text.trim()) throw new Error(`document ${i} is empty`);
      const embedding = embeddings[i] ?? [];
      if (embedding.length === 0) throw new Error(`no embedding produced for document ${i}`);
      await this.store.save({
        id: ids[i]!,
        text,
        embedding,
        metadata: metadatas?.[i] ?? {},
        createdAt: now,
      });
    }
  }

  /**
   * Query by text (chroma `collection.query`): embed each query, search the
   * store with the optional where/whereDocument filter, and return chroma's
   * parallel-array envelope — one row per query text.
   */
  async query(queryTexts: string[], opts: CollectionQueryOptions = {}): Promise<CollectionQueryRow[]> {
    const include = opts.include ?? DEFAULT_QUERY_INCLUDE;
    const filter =
      opts.where || opts.whereDocument
        ? {
            ...(opts.where ? { where: opts.where } : {}),
            ...(opts.whereDocument ? { whereDocument: opts.whereDocument } : {}),
          }
        : undefined;
    const rows: CollectionQueryRow[] = [];
    for (const text of queryTexts) {
      const vec = await this.embedder.embed(text);
      const hits = await this.store.search(vec, opts.nResults ?? 10, filter);
      const empty: CollectionQueryRow = {
        ids: [],
        documents: [],
        metadatas: [],
        distances: [],
        embeddings: [],
      };
      const row = hits.reduce((acc, hit) => {
        const entry = hit.entry;
        acc.ids.push(entry.id);
        if (include.includes("documents")) acc.documents.push(entry.text);
        if (include.includes("metadatas")) acc.metadatas.push(entry.metadata ?? {});
        if (include.includes("distances")) acc.distances.push(1 - hit.score); // cosine → distance
        if (include.includes("embeddings")) acc.embeddings.push(entry.embedding);
        return acc;
      }, empty);
      rows.push(row);
    }
    return rows;
  }

  /**
   * Get documents by ids and/or where filter (chroma `collection.get`), with
   * the same include projection. When neither ids nor a filter is given,
   * returns everything (bounded by `limit`).
   */
  async get(opts: CollectionGetOptions = {}): Promise<CollectionGetResult> {
    const include = opts.include ?? (["documents", "metadatas"] as const);
    const all = await this.store.list(
      opts.where || opts.whereDocument
        ? {
            ...(opts.where ? { where: opts.where } : {}),
            ...(opts.whereDocument ? { whereDocument: opts.whereDocument } : {}),
          }
        : { excludeExpired: false },
    );
    const wanted = opts.ids ? new Set(opts.ids) : undefined;
    const entries = all.filter((e) => (wanted ? wanted.has(e.id) : true));
    const out: CollectionGetResult = { ids: [], documents: [], metadatas: [], embeddings: [] };
    for (const e of entries) {
      out.ids.push(e.id);
      if (include.includes("documents")) out.documents.push(e.text);
      if (include.includes("metadatas")) out.metadatas.push(e.metadata ?? {});
      if (include.includes("embeddings")) out.embeddings.push(e.embedding);
    }
    return out;
  }

  /** Delete documents by id (chroma `collection.delete`). Unknown ids are no-ops. */
  async delete(ids: string[]): Promise<void> {
    for (const id of ids) await this.store.delete(id);
  }
}
