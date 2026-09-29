// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";

import { detectCommunities, type CommunityOptions } from "./community.js";
import { isDeleted, mergeEdge, mergeNode, tombstoneEdge, tombstoneNode } from "./merge.js";
import { runCypher, type CypherResult } from "./query.js";
/**
 * @nexus/knowledge-graph — entity/relationship graph over agent memory.
 *
 * Zero external dependencies.  Entity and relationship extraction is fully
 * injectable — wire in @nexus/nlp-utils extractEntities / extractRelationships
 * (backed by an NlpLlmClient) in production; use nullEntityExtractor and
 * nullRelationshipExtractor in tests.
 *
 * Node identities are deterministic: sha256(name.lower()|type).slice(0,16)
 * so the same entity always hashes to the same ID regardless of which document
 * it was extracted from.  Upsert merges duplicate nodes (max confidence,
 * union sources, shallow-merge properties) rather than creating duplicates.
 *
 * Same determinism applies to edges: sha256(subjectId|predicate.lower()|objectId).
 *
 * The injectable KGStore interface lets InMemoryKGStore be swapped for a
 * Postgres-backed store (pgvector + Drizzle) when the graph needs to scale.
 *
 * Consumers:
 *   KG (this)   — ingests documents after doc-pipeline extracts text
 *   Agents (9)  — query nodes/edges to answer "who knows whom" questions
 *   Context-pack — future: include high-confidence entities in system prompt
 */

// ── Entity / Relationship types (re-declared; compatible with @nexus/nlp-utils) ─

export type EntityType = "PERSON" | "ORG" | "LOCATION" | "DATE" | "PRODUCT" | "EVENT" | "OTHER";

/** Entity interface definition. */
export interface Entity {
  text: string;
  type: EntityType;
  confidence: number;
}

/** Relationship interface definition. */
export interface Relationship {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
}

// ── Injectable extractor types ────────────────────────────────────────────────

/**
 * Extract named entities from raw text.
 * Compatible with @nexus/nlp-utils extractEntities (pass directly).
 */
export type EntityExtractor = (text: string) => Promise<Entity[]>;

/**
 * Extract subject-predicate-object triples.
 * Compatible with @nexus/nlp-utils extractRelationships (pass directly).
 */
export type RelationshipExtractor = (text: string, entities: Entity[]) => Promise<Relationship[]>;

/** No-op entity extractor — returns [] without calling any LLM */
export const nullEntityExtractor: EntityExtractor = async () => [];

/** No-op relationship extractor — returns [] without calling any LLM */
export const nullRelationshipExtractor: RelationshipExtractor = async () => [];

/** Row clocks are whole seconds, as `KnowledgeGraph.ingest` writes them. */
const nowSeconds = () => Math.floor(Date.now() / 1000);

// ── Graph node / edge ─────────────────────────────────────────────────────────

export interface KGNode {
  /** Deterministic id: sha256(name.lower()|type).slice(0,16) */
  id: string;
  name: string;
  type: EntityType;
  /** Max confidence across all extractions that produced this node */
  confidence: number;
  /** Arbitrary properties from metadata or enrichment */
  properties: Record<string, unknown>;
  /**
   * Per-key last-write time. A key here with no entry in {@link KGNode.properties}
   * is a tombstone — it is how a deleted property stays deleted across a sync
   * with a peer that still holds the value. Absent on rows written before
   * per-field clocks existed; the merge falls back to `updatedAt` for those.
   */
  propertyClocks?: Record<string, number>;
  /** Source labels (document IDs / URLs) from which this node was extracted */
  sources: string[];
  createdAt: number;
  updatedAt: number;
  /** Set when the node was deleted; the node is gone while this is at or after `updatedAt`. */
  deletedAt?: number;
}

/** Kg edge interface definition. */
export interface KGEdge {
  /** Deterministic id: sha256(subjectId|predicate.lower()|objectId).slice(0,16) */
  id: string;
  subjectId: string;
  predicate: string;
  objectId: string;
  /** Max confidence across all extractions */
  confidence: number;
  sources: string[];
  createdAt: number;
  updatedAt: number;
  /** Set when the edge was deleted; the edge is gone while this is at or after `updatedAt`. */
  deletedAt?: number;
}

// ── Store query types ─────────────────────────────────────────────────────────

export interface NodeQuery {
  type?: EntityType;
  /** Case-insensitive substring match on node.name */
  nameContains?: string;
  minConfidence?: number;
  limit?: number;
  /** Also return deleted rows (tombstones), which federation sync must pass on. */
  includeDeleted?: boolean;
}

/** Edge query interface definition. */
export interface EdgeQuery {
  subjectId?: string;
  objectId?: string;
  /** Case-insensitive exact match on edge.predicate */
  predicate?: string;
  minConfidence?: number;
  limit?: number;
  /** Also return deleted rows (tombstones), which federation sync must pass on. */
  includeDeleted?: boolean;
}

/** Kg stats interface definition. */
export interface KGStats {
  nodes: number;
  edges: number;
  nodesByType: Partial<Record<EntityType, number>>;
}

// ── KGStore interface ─────────────────────────────────────────────────────────

/**
 * Injectable backing store for graph nodes and edges.
 *
 * Upsert semantics for both nodes and edges: when the id already exists the
 * implementation MUST merge (max confidence, union sources, merge properties)
 * rather than overwrite.
 */
export interface KGStore {
  // Nodes
  upsertNode(node: KGNode): Promise<KGNode>;
  getNode(id: string): Promise<KGNode | undefined>;
  findNodes(query: NodeQuery): Promise<KGNode[]>;
  deleteNode(id: string): Promise<void>;
  // Edges
  upsertEdge(edge: KGEdge): Promise<KGEdge>;
  getEdge(id: string): Promise<KGEdge | undefined>;
  findEdges(query: EdgeQuery): Promise<KGEdge[]>;
  deleteEdge(id: string): Promise<void>;
  // Meta
  stats(): Promise<KGStats>;
}

// ── InMemoryKGStore ───────────────────────────────────────────────────────────

/**
 * In-memory KGStore.  Use for tests and local development.
 * Not suitable for production (no persistence, single-process).
 */
export class InMemoryKGStore implements KGStore {
  private readonly nodes = new Map<string, KGNode>();
  private readonly edges = new Map<string, KGEdge>();

  // ── Nodes ────────────────────────────────────────────────────────────────

  async upsertNode(node: KGNode): Promise<KGNode> {
    const existing = this.nodes.get(node.id);
    if (existing) {
      const merged = mergeNode(existing, node);
      this.nodes.set(node.id, merged);
      return merged;
    }
    this.nodes.set(node.id, { ...node });
    return node;
  }

  async getNode(id: string): Promise<KGNode | undefined> {
    const found = this.nodes.get(id);
    return found && !isDeleted(found) ? found : undefined;
  }

  async findNodes(query: NodeQuery): Promise<KGNode[]> {
    let results = Array.from(this.nodes.values());
    if (!query.includeDeleted) results = results.filter((n) => !isDeleted(n));

    if (query.type !== undefined) {
      results = results.filter((n) => n.type === query.type);
    }
    if (query.nameContains !== undefined) {
      const q = query.nameContains.toLowerCase();
      results = results.filter((n) => n.name.toLowerCase().includes(q));
    }
    if (query.minConfidence !== undefined) {
      results = results.filter((n) => n.confidence >= query.minConfidence!);
    }
    if (query.limit !== undefined) {
      results = results.slice(0, query.limit);
    }

    return results;
  }

  async deleteNode(id: string): Promise<void> {
    const found = this.nodes.get(id);
    if (found) this.nodes.set(id, tombstoneNode(found, nowSeconds()));
  }

  // ── Edges ────────────────────────────────────────────────────────────────

  async upsertEdge(edge: KGEdge): Promise<KGEdge> {
    const existing = this.edges.get(edge.id);
    if (existing) {
      const merged = mergeEdge(existing, edge);
      this.edges.set(edge.id, merged);
      return merged;
    }
    this.edges.set(edge.id, { ...edge });
    return edge;
  }

  async getEdge(id: string): Promise<KGEdge | undefined> {
    const found = this.edges.get(id);
    return found && !isDeleted(found) ? found : undefined;
  }

  async findEdges(query: EdgeQuery): Promise<KGEdge[]> {
    let results = Array.from(this.edges.values());
    if (!query.includeDeleted) results = results.filter((e) => !isDeleted(e));

    if (query.subjectId !== undefined) {
      results = results.filter((e) => e.subjectId === query.subjectId);
    }
    if (query.objectId !== undefined) {
      results = results.filter((e) => e.objectId === query.objectId);
    }
    if (query.predicate !== undefined) {
      const p = query.predicate.toLowerCase();
      results = results.filter((e) => e.predicate.toLowerCase() === p);
    }
    if (query.minConfidence !== undefined) {
      results = results.filter((e) => e.confidence >= query.minConfidence!);
    }
    if (query.limit !== undefined) {
      results = results.slice(0, query.limit);
    }

    return results;
  }

  async deleteEdge(id: string): Promise<void> {
    const found = this.edges.get(id);
    if (found) this.edges.set(id, tombstoneEdge(found, nowSeconds()));
  }

  async stats(): Promise<KGStats> {
    const nodesByType: Partial<Record<EntityType, number>> = {};
    for (const node of this.nodes.values()) {
      if (isDeleted(node)) continue;
      nodesByType[node.type] = (nodesByType[node.type] ?? 0) + 1;
    }
    return {
      nodes: this.nodeCount,
      edges: this.edgeCount,
      nodesByType,
    };
  }

  get nodeCount(): number {
    return [...this.nodes.values()].filter((n) => !isDeleted(n)).length;
  }

  get edgeCount(): number {
    return [...this.edges.values()].filter((e) => !isDeleted(e)).length;
  }
}

// ── Deterministic ID helpers ──────────────────────────────────────────────────

/**
 * Deterministic node id: sha256(name.lower().trim()|type).slice(0,16).
 *
 * The same entity text + type always produces the same id, enabling
 * cross-document deduplication without a lookup table.
 */
export function makeNodeId(name: string, type: EntityType): string {
  return createHash("sha256")
    .update(`${name.toLowerCase().trim()}|${type}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Deterministic edge id: sha256(subjectId|predicate.lower().trim()|objectId).slice(0,16).
 */
export function makeEdgeId(subjectId: string, predicate: string, objectId: string): string {
  return createHash("sha256")
    .update(`${subjectId}|${predicate.toLowerCase().trim()}|${objectId}`)
    .digest("hex")
    .slice(0, 16);
}

// ── KnowledgeGraph ────────────────────────────────────────────────────────────

export interface IngestOptions {
  /** Source label attached to nodes/edges extracted from this text */
  source?: string;
  /** Override the default entity extractor for this call */
  entityExtractor?: EntityExtractor;
  /** Override the default relationship extractor for this call */
  relationshipExtractor?: RelationshipExtractor;
  /** Drops or normalises extracted entities and relationships before they are stored */
  validator?: OntologyValidator;
}

/** Ingest result interface definition. */
export interface IngestResult {
  nodesAdded: number;
  nodesMerged: number;
  edgesAdded: number;
  edgesMerged: number;
  entities: Entity[];
  relationships: Relationship[];
}

/** Traversal direction type alias. */
export type TraversalDirection = "outbound" | "inbound" | "both";

/** Related options interface definition. */
export interface RelatedOptions {
  direction?: TraversalDirection;
  limit?: number;
}

/** Related edge interface definition. */
export interface RelatedEdge {
  node: KGNode;
  edge: KGEdge;
  direction: "outbound" | "inbound";
}

/** Related result interface definition. */
export interface RelatedResult {
  node: KGNode | undefined;
  neighbors: RelatedEdge[];
}

/**
 * High-level Knowledge Graph API.
 *
 * Inject a KGStore and optionally default extractors.  All three are
 * swappable per-call via IngestOptions for maximum flexibility.
 *
 * @example
 * ```ts
 * import { extractEntities, extractRelationships, type NlpLlmClient } from "@nexus/nlp-utils";
 *
 * const llm: NlpLlmClient = async (messages) => myDriver.chat(messages);
 * const kg = new KnowledgeGraph(
 *   new InMemoryKGStore(),
 *   (text) => extractEntities(text, llm),
 *   (text, entities) => extractRelationships(text, entities, llm),
 * );
 * await kg.ingest("Yash works at NIT Raipur.", { source: "profile.txt" });
 * ```
 */
export class KnowledgeGraph {
  constructor(
    private readonly store: KGStore,
    private readonly defaultEntityExtractor: EntityExtractor = nullEntityExtractor,
    private readonly defaultRelationshipExtractor: RelationshipExtractor = nullRelationshipExtractor,
  ) {}

  /**
   * Ingest a text document:
   *  1. Extract entities → upsert as KGNodes
   *  2. Extract relationships between entities → upsert as KGEdges
   *
   * Returns counts of nodes/edges added vs merged (pre-existing id).
   * Returns zeroes immediately for blank text without calling extractors.
   */
  async ingest(text: string, opts: IngestOptions = {}): Promise<IngestResult> {
    return this.save(await this.extract(text, opts), opts.source);
  }

  /**
   * Run the extractors (and the validator) without touching the store, so many texts can be
   * extracted at once and stored one after another.
   */
  async extract(
    text: string,
    opts: IngestOptions = {},
  ): Promise<{ entities: Entity[]; relationships: Relationship[] }> {
    if (text.trim().length === 0) return { entities: [], relationships: [] };
    const extractor = opts.entityExtractor ?? this.defaultEntityExtractor;
    const relExtractor = opts.relationshipExtractor ?? this.defaultRelationshipExtractor;
    const validator = opts.validator;

    const entities = (await extractor(text)).flatMap((e) => {
      const kept = validator ? validator.validate(e) : e;
      return kept ? [kept] : [];
    });
    if (entities.length < 2) return { entities, relationships: [] };

    const relationships = (await relExtractor(text, entities)).flatMap((r) => {
      const kept = validator?.validateRelationship ? validator.validateRelationship(r) : r;
      return kept ? [kept] : [];
    });
    return { entities, relationships };
  }

  /** Upsert extracted entities as nodes and relationships as edges. */
  async save(
    extracted: { entities: Entity[]; relationships: Relationship[] },
    source?: string,
  ): Promise<IngestResult> {
    const { entities, relationships } = extracted;
    const result: IngestResult = {
      nodesAdded: 0,
      nodesMerged: 0,
      edgesAdded: 0,
      edgesMerged: 0,
      entities,
      relationships,
    };
    const now = Math.floor(Date.now() / 1000);

    const entityNodeMap = new Map<string, string>(); // entity.text.lower() → nodeId

    for (const entity of entities) {
      const id = makeNodeId(entity.text, entity.type);
      const wasPresent = (await this.store.getNode(id)) !== undefined;

      const node: KGNode = {
        id,
        name: entity.text,
        type: entity.type,
        confidence: entity.confidence,
        properties: {},
        sources: source ? [source] : [],
        createdAt: now,
        updatedAt: now,
      };

      await this.store.upsertNode(node);
      entityNodeMap.set(entity.text.toLowerCase(), id);

      if (wasPresent) {
        result.nodesMerged++;
      } else {
        result.nodesAdded++;
      }
    }

    for (const rel of relationships) {
      const subjectId = entityNodeMap.get(rel.subject.toLowerCase());
      const objectId = entityNodeMap.get(rel.object.toLowerCase());

      // Skip if either endpoint was not found in the entity list
      if (!subjectId || !objectId || subjectId === objectId) continue;

      const id = makeEdgeId(subjectId, rel.predicate, objectId);
      const wasPresent = (await this.store.getEdge(id)) !== undefined;

      const edge: KGEdge = {
        id,
        subjectId,
        predicate: rel.predicate,
        objectId,
        confidence: rel.confidence,
        sources: source ? [source] : [],
        createdAt: now,
        updatedAt: now,
      };

      await this.store.upsertEdge(edge);

      if (wasPresent) {
        result.edgesMerged++;
      } else {
        result.edgesAdded++;
      }
    }

    return result;
  }

  // ── Query ─────────────────────────────────────────────────────────────────

  async queryNodes(query: NodeQuery = {}): Promise<KGNode[]> {
    return this.store.findNodes(query);
  }

  async queryEdges(query: EdgeQuery = {}): Promise<KGEdge[]> {
    return this.store.findEdges(query);
  }

  async getNode(id: string): Promise<KGNode | undefined> {
    return this.store.getNode(id);
  }

  async getEdge(id: string): Promise<KGEdge | undefined> {
    return this.store.getEdge(id);
  }

  // ── Traversal ─────────────────────────────────────────────────────────────

  /**
   * Return all nodes directly connected to `nodeId` via one edge hop.
   *
   * direction:
   *   "outbound" — edges where subjectId === nodeId
   *   "inbound"  — edges where objectId === nodeId
   *   "both"     — union of both (default)
   */
  async findRelated(nodeId: string, opts: RelatedOptions = {}): Promise<RelatedResult> {
    const direction = opts.direction ?? "both";
    const limit = opts.limit;

    const node = await this.store.getNode(nodeId);
    const neighbors: RelatedEdge[] = [];

    if (direction === "outbound" || direction === "both") {
      const outEdges = await this.store.findEdges({ subjectId: nodeId });
      for (const edge of outEdges) {
        const neighbor = await this.store.getNode(edge.objectId);
        if (neighbor) neighbors.push({ node: neighbor, edge, direction: "outbound" });
      }
    }

    if (direction === "inbound" || direction === "both") {
      const inEdges = await this.store.findEdges({ objectId: nodeId });
      for (const edge of inEdges) {
        const neighbor = await this.store.getNode(edge.subjectId);
        if (neighbor) neighbors.push({ node: neighbor, edge, direction: "inbound" });
      }
    }

    const limited = limit !== undefined ? neighbors.slice(0, limit) : neighbors;

    return { node, neighbors: limited };
  }

  async stats(): Promise<KGStats> {
    return this.store.stats();
  }

  /**
   * Cluster the stored graph into communities (Leiden algorithm over the
   * undirected projection of all edges). Returns node id → community id.
   */
  async detectCommunities(options: CommunityOptions = {}): Promise<Map<string, number>> {
    const nodes = await this.store.findNodes({});
    const edges = await this.store.findEdges({});
    const adjacency = new Map<string, Set<string>>(nodes.map((n) => [n.id, new Set()]));
    for (const e of edges) {
      adjacency.get(e.subjectId)?.add(e.objectId);
      adjacency.get(e.objectId)?.add(e.subjectId);
    }
    return detectCommunities(adjacency, options);
  }

  /**
   * Run a Cypher-subset query against the stored graph (single directed hop,
   * optional WHERE / RETURN / LIMIT). See {@link runCypher} for the grammar.
   */
  async query(cypher: string): Promise<CypherResult> {
    return runCypher(this.store, cypher);
  }
}

// ── NeonKGStore ───────────────────────────────────────────────────────────────
//
// Postgres-backed KGStore via Neon HTTP API (or any pg-compatible executor).
//
// Uses an injectable NeonQueryFn so the store can be tested without a real DB:
//
//   const store = new NeonKGStore({ query: myMockFn });
//   await store.init();           // CREATE TABLE IF NOT EXISTS ...
//   await store.upsertNode(node); // INSERT ... ON CONFLICT DO UPDATE
//
// Production wiring (example with @neondatabase/serverless):
//
//   import { neon } from "@neondatabase/serverless";
//   const sql = neon(process.env.DATABASE_URL!);
//   const store = new NeonKGStore({
//     query: (q, p) => sql(q, ...(p ?? [])).then(rows => ({ rows })),
//   });

/** Row shape returned from SQL queries */
export type NeonRow = Record<string, unknown>;

/**
 * Injectable SQL executor — structurally compatible with @neondatabase/serverless
 * and any pg-compatible driver.
 *
 * @param sql    Parameterised SQL string using $1, $2, … placeholders
 * @param params Bound parameter values (may be omitted for DDL)
 */
export type NeonQueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: NeonRow[] }>;

/** Neon kg store config interface definition. */
export interface NeonKGStoreConfig {
  /** Injectable SQL executor (see NeonQueryFn) */
  query: NeonQueryFn;
  /**
   * Table name prefix.  Default: "kg_".
   * Resulting tables: {prefix}nodes, {prefix}edges.
   */
  tablePrefix?: string;
  /** Whose graph this store reads and writes. Rows of other owners are invisible. Default "". */
  owner?: string;
}

/**
 * Postgres-backed KGStore that persists graph nodes and edges in two tables.
 *
 * Upsert semantics:
 *  • Nodes — on conflict, take GREATEST(confidence), union sources/properties
 *    in application code (read → merge → write).
 *  • Edges — same: GREATEST(confidence), union sources.
 *
 * Schema is managed by `init()` (CREATE TABLE IF NOT EXISTS).  Call `init()`
 * once at startup before any read/write operations.
 *
 * @example
 * ```ts
 * const store = new NeonKGStore({ query: neonQueryFn });
 * await store.init();
 * const kg = new KnowledgeGraph(store, extractEntities, extractRelationships);
 * ```
 */
export class NeonKGStore implements KGStore {
  private readonly queryFn: NeonQueryFn;
  private readonly nodesTable: string;
  private readonly edgesTable: string;
  private readonly owner: string;

  constructor(config: NeonKGStoreConfig) {
    this.queryFn = config.query;
    this.owner = config.owner ?? "";
    const prefix = config.tablePrefix ?? "kg_";
    this.nodesTable = `${prefix}nodes`;
    this.edgesTable = `${prefix}edges`;
  }

  /**
   * Create tables if they don't exist.  Call once at application startup.
   */
  async init(): Promise<void> {
    await this.queryFn(
      `CREATE TABLE IF NOT EXISTS ${this.nodesTable} (
        owner       TEXT        NOT NULL DEFAULT '',
        id          TEXT        NOT NULL,
        name        TEXT        NOT NULL,
        type        TEXT        NOT NULL,
        confidence  REAL        NOT NULL,
        properties  JSONB       NOT NULL DEFAULT '{}',
        property_clocks JSONB   NOT NULL DEFAULT '{}',
        sources     JSONB       NOT NULL DEFAULT '[]',
        created_at  BIGINT      NOT NULL,
        updated_at  BIGINT      NOT NULL
      )`,
    );
    // Tables created before per-field clocks existed have no column for them,
    // and CREATE TABLE IF NOT EXISTS above will not add one.
    await this.queryFn(
      `ALTER TABLE ${this.nodesTable}
         ADD COLUMN IF NOT EXISTS property_clocks JSONB NOT NULL DEFAULT '{}'`,
    );
    await this.queryFn(
      `CREATE TABLE IF NOT EXISTS ${this.edgesTable} (
        owner       TEXT        NOT NULL DEFAULT '',
        id          TEXT        NOT NULL,
        subject_id  TEXT        NOT NULL,
        predicate   TEXT        NOT NULL,
        object_id   TEXT        NOT NULL,
        confidence  REAL        NOT NULL,
        sources     JSONB       NOT NULL DEFAULT '[]',
        created_at  BIGINT      NOT NULL,
        updated_at  BIGINT      NOT NULL
      )`,
    );
    // Tables from before owners keyed rows by id alone; the same entity in two graphs needs both.
    for (const table of [this.nodesTable, this.edgesTable]) {
      await this.queryFn(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS owner TEXT NOT NULL DEFAULT ''`,
      );
      // A deleted row stays as a tombstone so the delete outranks a peer still holding the fact.
      await this.queryFn(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS deleted_at BIGINT`);
      await this.queryFn(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_pkey`);
      await this.queryFn(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${table}_owner_id ON ${table} (owner, id)`,
      );
    }
  }

  // ── Nodes ──────────────────────────────────────────────────────────────────

  private async writeNode(merged: KGNode): Promise<void> {
    await this.queryFn(
      `UPDATE ${this.nodesTable}
         SET name=$1, type=$2, confidence=$3, sources=$4, properties=$5,
             property_clocks=$6, created_at=$7, updated_at=$8, deleted_at=$11
       WHERE owner=$10 AND id=$9`,
      [
        merged.name,
        merged.type,
        merged.confidence,
        JSON.stringify(merged.sources),
        JSON.stringify(merged.properties),
        JSON.stringify(merged.propertyClocks ?? {}),
        merged.createdAt,
        merged.updatedAt,
        merged.id,
        this.owner,
        merged.deletedAt ?? null,
      ],
    );
  }

  async upsertNode(node: KGNode): Promise<KGNode> {
    const existing = await this.getNodeRow(node.id);
    if (existing) {
      const merged = mergeNode(existing, node);
      await this.writeNode(merged);
      return merged;
    }

    await this.queryFn(
      `INSERT INTO ${this.nodesTable}
         (id, name, type, confidence, properties, property_clocks, sources, created_at, updated_at, owner, deleted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        node.id,
        node.name,
        node.type,
        node.confidence,
        JSON.stringify(node.properties),
        JSON.stringify(node.propertyClocks ?? {}),
        JSON.stringify(node.sources),
        node.createdAt,
        node.updatedAt,
        this.owner,
        node.deletedAt ?? null,
      ],
    );
    return node;
  }

  /** The stored row, tombstone or not. */
  private async getNodeRow(id: string): Promise<KGNode | undefined> {
    const { rows } = await this.queryFn(
      `SELECT * FROM ${this.nodesTable} WHERE owner=$1 AND id=$2`,
      [this.owner, id],
    );
    return rows[0] ? rowToNode(rows[0]) : undefined;
  }

  async getNode(id: string): Promise<KGNode | undefined> {
    const found = await this.getNodeRow(id);
    return found && !isDeleted(found) ? found : undefined;
  }

  async findNodes(query: NodeQuery): Promise<KGNode[]> {
    const conditions: string[] = ["owner=$1"];
    const params: unknown[] = [this.owner];

    if (query.type !== undefined) {
      params.push(query.type);
      conditions.push(`type=$${params.length}`);
    }
    if (query.nameContains !== undefined) {
      params.push(`%${query.nameContains.toLowerCase()}%`);
      conditions.push(`LOWER(name) LIKE $${params.length}`);
    }
    if (query.minConfidence !== undefined) {
      params.push(query.minConfidence);
      conditions.push(`confidence>=$${params.length}`);
    }
    if (!query.includeDeleted) conditions.push("(deleted_at IS NULL OR deleted_at < updated_at)");

    const where = `WHERE ${conditions.join(" AND ")}`;
    const limit = query.limit !== undefined ? ` LIMIT ${query.limit}` : "";
    const { rows } = await this.queryFn(
      `SELECT * FROM ${this.nodesTable} ${where}${limit}`,
      params,
    );
    return rows.map(rowToNode);
  }

  async deleteNode(id: string): Promise<void> {
    const found = await this.getNodeRow(id);
    if (found) await this.writeNode(tombstoneNode(found, nowSeconds()));
  }

  // ── Edges ──────────────────────────────────────────────────────────────────

  private async writeEdge(merged: KGEdge): Promise<void> {
    await this.queryFn(
      `UPDATE ${this.edgesTable}
         SET confidence=$1, sources=$2, created_at=$3, updated_at=$4, deleted_at=$7
       WHERE owner=$6 AND id=$5`,
      [
        merged.confidence,
        JSON.stringify(merged.sources),
        merged.createdAt,
        merged.updatedAt,
        merged.id,
        this.owner,
        merged.deletedAt ?? null,
      ],
    );
  }

  async upsertEdge(edge: KGEdge): Promise<KGEdge> {
    const existing = await this.getEdgeRow(edge.id);
    if (existing) {
      const merged = mergeEdge(existing, edge);
      await this.writeEdge(merged);
      return merged;
    }

    await this.queryFn(
      `INSERT INTO ${this.edgesTable}
         (id, subject_id, predicate, object_id, confidence, sources, created_at, updated_at, owner, deleted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        edge.id,
        edge.subjectId,
        edge.predicate,
        edge.objectId,
        edge.confidence,
        JSON.stringify(edge.sources),
        edge.createdAt,
        edge.updatedAt,
        this.owner,
        edge.deletedAt ?? null,
      ],
    );
    return edge;
  }

  /** The stored row, tombstone or not. */
  private async getEdgeRow(id: string): Promise<KGEdge | undefined> {
    const { rows } = await this.queryFn(
      `SELECT * FROM ${this.edgesTable} WHERE owner=$1 AND id=$2`,
      [this.owner, id],
    );
    return rows[0] ? rowToEdge(rows[0]) : undefined;
  }

  async getEdge(id: string): Promise<KGEdge | undefined> {
    const found = await this.getEdgeRow(id);
    return found && !isDeleted(found) ? found : undefined;
  }

  async findEdges(query: EdgeQuery): Promise<KGEdge[]> {
    const conditions: string[] = ["owner=$1"];
    const params: unknown[] = [this.owner];

    if (query.subjectId !== undefined) {
      params.push(query.subjectId);
      conditions.push(`subject_id=$${params.length}`);
    }
    if (query.objectId !== undefined) {
      params.push(query.objectId);
      conditions.push(`object_id=$${params.length}`);
    }
    if (query.predicate !== undefined) {
      params.push(query.predicate.toLowerCase());
      conditions.push(`LOWER(predicate)=$${params.length}`);
    }
    if (query.minConfidence !== undefined) {
      params.push(query.minConfidence);
      conditions.push(`confidence>=$${params.length}`);
    }
    if (!query.includeDeleted) conditions.push("(deleted_at IS NULL OR deleted_at < updated_at)");

    const where = `WHERE ${conditions.join(" AND ")}`;
    const limit = query.limit !== undefined ? ` LIMIT ${query.limit}` : "";
    const { rows } = await this.queryFn(
      `SELECT * FROM ${this.edgesTable} ${where}${limit}`,
      params,
    );
    return rows.map(rowToEdge);
  }

  async deleteEdge(id: string): Promise<void> {
    const found = await this.getEdgeRow(id);
    if (found) await this.writeEdge(tombstoneEdge(found, nowSeconds()));
  }

  // ── Meta ───────────────────────────────────────────────────────────────────

  async stats(): Promise<KGStats> {
    const { rows: nodeRows } = await this.queryFn(
      `SELECT type, COUNT(*) AS cnt FROM ${this.nodesTable} WHERE owner=$1 AND (deleted_at IS NULL OR deleted_at < updated_at) GROUP BY type`,
      [this.owner],
    );
    const { rows: edgeRows } = await this.queryFn(
      `SELECT COUNT(*) AS cnt FROM ${this.edgesTable} WHERE owner=$1 AND (deleted_at IS NULL OR deleted_at < updated_at)`,
      [this.owner],
    );

    const nodesByType: Partial<Record<EntityType, number>> = {};
    let totalNodes = 0;
    for (const row of nodeRows) {
      const t = row["type"] as EntityType;
      const count = Number(row["cnt"]);
      nodesByType[t] = count;
      totalNodes += count;
    }

    return {
      nodes: totalNodes,
      edges: Number(edgeRows[0]?.["cnt"] ?? 0),
      nodesByType,
    };
  }
}

// ── Row → domain object helpers ───────────────────────────────────────────────

function parseJsonField<T>(value: unknown, fallback: T): T {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  // Neon HTTP driver may return already-parsed objects
  if (value !== null && value !== undefined) return value as T;
  return fallback;
}

function rowToNode(row: NeonRow): KGNode {
  return {
    id: row["id"] as string,
    name: row["name"] as string,
    type: row["type"] as EntityType,
    confidence: Number(row["confidence"]),
    properties: parseJsonField<Record<string, unknown>>(row["properties"], {}),
    ...clocksFromRow(row),
    sources: parseJsonField<string[]>(row["sources"], []),
    createdAt: Number(row["created_at"]),
    updatedAt: Number(row["updated_at"]),
    ...deletedFromRow(row),
  };
}

function deletedFromRow(row: NeonRow): { deletedAt?: number } {
  return row["deleted_at"] == null ? {} : { deletedAt: Number(row["deleted_at"]) };
}

/**
 * An empty clock map is dropped rather than stored on the node, so a row that
 * predates per-field clocks compares equal to the node it was written from.
 */
function clocksFromRow(row: NeonRow): { propertyClocks?: Record<string, number> } {
  const clocks = parseJsonField<Record<string, number>>(row["property_clocks"], {});
  return Object.keys(clocks).length > 0 ? { propertyClocks: clocks } : {};
}

function rowToEdge(row: NeonRow): KGEdge {
  return {
    id: row["id"] as string,
    subjectId: row["subject_id"] as string,
    predicate: row["predicate"] as string,
    objectId: row["object_id"] as string,
    confidence: Number(row["confidence"]),
    sources: parseJsonField<string[]>(row["sources"], []),
    createdAt: Number(row["created_at"]),
    updatedAt: Number(row["updated_at"]),
    ...deletedFromRow(row),
  };
}

// ── Error ─────────────────────────────────────────────────────────────────────

export class KGError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "KGError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ADDITIONS — from cognee (topoteretes/cognee) + graphrag (microsoft/graphrag)
// ─────────────────────────────────────────────────────────────────────────────

// ── Entity rank + relationship weight (graphrag patterns) ─────────────────────
//
// graphrag/data_model/entity.py  — Entity.rank (degree centrality; higher = more important)
// graphrag/data_model/relationship.py — Relationship.weight (edge weight for Leiden clustering)
//
// Augments KGNode/KGEdge without changing existing types. Add these to nodes/edges
// when building graphs from document corpora; the graph traversal and clustering
// paths below use them to prioritise high-value results.

/** Ranked entity — augments KGNode with degree centrality score */
export interface RankedKGNode extends KGNode {
  /** Degree centrality rank. Higher = more important. Set by computeEntityRanks(). */
  rank: number;
  /** Optional description embedding for vector similarity during graph-RAG query */
  descriptionEmbedding?: number[];
}

/** Weighted KGEdge — augments KGEdge with float edge weight */
export interface WeightedKGEdge extends KGEdge {
  /** Edge weight [0..1]. Used by Leiden clustering and ranked traversal. Default: 1.0 */
  weight: number;
}

/**
 * Degree-centrality rank for every node: edges touching it, in or out.
 * Matches graphrag's initial `rank = degree`.
 */
export async function computeEntityRanks(
  store: KGStore,
  nodeIds?: string[],
): Promise<Map<string, number>> {
  const ids = nodeIds ?? (await store.findNodes({})).map((n) => n.id);
  const ranks = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const e of await store.findEdges({})) {
    for (const id of [e.subjectId, e.objectId]) {
      const r = ranks.get(id);
      if (r !== undefined) ranks.set(id, r + 1);
    }
  }
  return ranks;
}

// ── Community summaries (graphrag pattern) ───────────────────────────────────
//
// graphrag reads community reports to answer broad questions. Communities come
// from Leiden (./community.ts); the report is built from the graph itself, so
// it costs no model call.

/** Summary of one community, matched by COMMUNITY and GRAPH_COMPLETION search. */
export interface KGCommunitySummary {
  communityId: string;
  level: number;
  title: string;
  summary: string;
  findings: { explanation: string; summary: string }[];
  promptTokens: number;
  createdAt: number;
  /** Member node ids; COMMUNITY search returns these nodes. */
  entityIds?: string[];
}

/** A community with its members ranked by degree, highest first. */
export interface KGCommunityReport extends KGCommunitySummary {
  entities: { id: string; name: string; type: EntityType; rank: number }[];
  entityIds: string[];
  relationshipIds: string[];
}

/**
 * Leiden communities of the stored graph, largest first. Nodes without a
 * neighbour in their community are dropped: a community of one says nothing.
 */
export async function summarizeCommunities(
  store: KGStore,
  options: CommunityOptions = {},
): Promise<KGCommunityReport[]> {
  const nodes = await store.findNodes({});
  const edges = await store.findEdges({});
  const ranks = await computeEntityRanks(store);
  const adjacency = new Map<string, Set<string>>(nodes.map((n) => [n.id, new Set()]));
  for (const e of edges) {
    adjacency.get(e.subjectId)?.add(e.objectId);
    adjacency.get(e.objectId)?.add(e.subjectId);
  }
  const groups = new Map<number, KGNode[]>();
  const membership = detectCommunities(adjacency, options);
  for (const n of nodes) {
    const c = membership.get(n.id)!;
    groups.set(c, [...(groups.get(c) ?? []), n]);
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const reports: KGCommunityReport[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const ids = new Set(members.map((m) => m.id));
    const internal = edges.filter((e) => ids.has(e.subjectId) && ids.has(e.objectId));
    const entities = members
      .map((m) => ({ id: m.id, name: m.name, type: m.type, rank: ranks.get(m.id) ?? 0 }))
      .sort((x, y) => y.rank - x.rank || x.name.localeCompare(y.name));
    const sortedIds = entities.map((e) => e.id).sort();
    reports.push({
      communityId: createHash("sha256").update(sortedIds.join("|")).digest("hex").slice(0, 16),
      level: 0,
      title: entities
        .slice(0, 3)
        .map((e) => e.name)
        .join(" · "),
      summary: `${entities.length} entities: ${entities.map((e) => `${e.name} (${e.type})`).join(", ")}.`,
      findings: internal.slice(0, 20).map((e) => ({
        summary: `${byId.get(e.subjectId)!.name} ${e.predicate} ${byId.get(e.objectId)!.name}`,
        explanation: `confidence ${e.confidence.toFixed(2)}`,
      })),
      promptTokens: 0,
      createdAt: Date.now(),
      entities,
      entityIds: sortedIds,
      relationshipIds: internal.map((e) => e.id),
    });
  }
  return reports.sort((x, y) => y.entities.length - x.entities.length);
}

// ── Multi-hop BFS traversal (cognee CogneeGraph pattern) ─────────────────────
//
// cognee/modules/graph/cognee_graph/CogneeGraph.py — uses priority queue for
// graph search. triplet_distance_penalty=6.5 accumulates along hops.
// cascadeRetrieve (in @nexus/memory MemoryGraph) does BFS within the memory
// layer; this MultiHopTraversal operates on KGNode/KGEdge in the knowledge graph.

/** A single node + the path taken to reach it during BFS */
export interface HopResult {
  node: KGNode;
  /** The edge traversed to reach this node */
  viaEdge: KGEdge;
  /** How many hops from the seed node */
  depth: number;
  /**
   * Accumulated traversal score.
   * Starts at 1.0; multiplied by edgeWeight × DEPTH_DECAY per hop.
   * Matches MemoryGraph.cascadeRetrieve() decay pattern from @nexus/memory.
   */
  score: number;
}

/** Options for multi-hop BFS */
export interface MultiHopOptions {
  /** Maximum number of edge hops (default: 3) */
  maxDepth?: number;
  /** Only traverse edges matching this predicate (case-insensitive, exact) */
  predicateFilter?: string;
  /** Minimum per-hop edge weight to follow (default: 0) */
  minEdgeWeight?: number;
  /** Maximum total results (default: 50) */
  topK?: number;
  /**
   * Decay factor per hop. Score = score × DEPTH_DECAY per level.
   * Default 0.7 — same as MemoryGraph.cascadeRetrieve().
   */
  depthDecay?: number;
  /** Edge traversal direction (default: "both") */
  direction?: "outbound" | "inbound" | "both";
}

/**
 * Multi-hop BFS traversal from a seed node through the KGStore.
 *
 * Explores the graph up to `maxDepth` hops. Nodes are scored by
 * accumulated `edgeWeight × depthDecay^depth`. Results are returned
 * in descending score order (highest-relevance first).
 *
 * This is the graph-traversal counterpart to MemoryGraph.cascadeRetrieve()
 * in @nexus/memory. While cascadeRetrieve() operates on MemoryEntry nodes
 * (embeddings + tags), multiHopTraverse() operates on typed KGNode/KGEdge
 * pairs from structured entity extraction.
 *
 * Ref: cognee/modules/graph/cognee_graph/CogneeGraph.py (CogneeGraph BFS,
 *      triplet_distance_penalty per hop accumulation)
 */
async function multiHopTraverse(
  store: KGStore,
  seedNodeId: string,
  opts: MultiHopOptions = {},
): Promise<HopResult[]> {
  const maxDepth = opts.maxDepth ?? 3;
  const predicateFilter = opts.predicateFilter?.toLowerCase();
  const minEdgeWeight = opts.minEdgeWeight ?? 0;
  const topK = opts.topK ?? 50;
  const depthDecay = opts.depthDecay ?? 0.7;
  const direction = opts.direction ?? "both";

  const visited = new Set<string>([seedNodeId]);
  const results: HopResult[] = [];

  // BFS queue: [nodeId, depth, score]
  type QueueEntry = { nodeId: string; depth: number; score: number };
  const queue: QueueEntry[] = [{ nodeId: seedNodeId, depth: 0, score: 1.0 }];

  while (queue.length > 0 && results.length < topK) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;

    // Fetch edges based on direction
    const outEdges =
      direction === "outbound" || direction === "both"
        ? await store.findEdges({ subjectId: current.nodeId })
        : [];
    const inEdges =
      direction === "inbound" || direction === "both"
        ? await store.findEdges({ objectId: current.nodeId })
        : [];

    const candidateEdges: { edge: KGEdge; neighborId: string }[] = [
      ...outEdges.map((e) => ({ edge: e, neighborId: e.objectId })),
      ...inEdges.map((e) => ({ edge: e, neighborId: e.subjectId })),
    ];

    for (const { edge, neighborId } of candidateEdges) {
      if (visited.has(neighborId)) continue;

      // Apply predicate filter
      if (predicateFilter && edge.predicate.toLowerCase() !== predicateFilter) continue;

      // Apply edge weight filter
      const edgeWeight = (edge as WeightedKGEdge).weight ?? 1.0;
      if (edgeWeight < minEdgeWeight) continue;

      const neighbor = await store.getNode(neighborId);
      if (!neighbor) continue;

      visited.add(neighborId);

      // Score decays by edgeWeight × depthDecay per hop
      const hopScore = current.score * edgeWeight * depthDecay;

      results.push({
        node: neighbor,
        viaEdge: edge,
        depth: current.depth + 1,
        score: hopScore,
      });

      queue.push({ nodeId: neighborId, depth: current.depth + 1, score: hopScore });
    }
  }

  // Sort by descending score
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}

// ── Parallel chunk graph extraction (cognee pattern) ─────────────────────────
//
// cognee/tasks/graph/extract_graph_from_data.py — extract_graph_from_data()
//   Accepts list[DocumentChunk], asyncio.gather over extract_content_graph()
//   per chunk, then integrate_chunk_graphs() to merge into backing store.
//
// Provenance tracking: _stamp_provenance_deep() stamps pipeline_name + task_name
// on every extracted DataPoint.

/** A text chunk to extract entities and relationships from */
export interface TextChunk {
  /** Unique identifier for this chunk (document ID, URL, etc.) */
  id: string;
  /** The raw text content */
  text: string;
  /** Optional metadata attached to all nodes/edges extracted from this chunk */
  metadata?: Record<string, unknown>;
}

/** Provenance metadata for an extraction run */
export interface ExtractionProvenance {
  /** The pipeline or workflow name (e.g. "doc-ingestion", "email-adapter") */
  pipelineName?: string;
  /** The specific task name (e.g. "extract_graph_from_email") */
  taskName?: string;
  /** ISO timestamp of the extraction run */
  extractedAt?: number;
}

/** Result of extracting and ingesting a single text chunk */
export interface ChunkExtractionResult {
  chunkId: string;
  nodesAdded: number;
  nodesMerged: number;
  edgesAdded: number;
  edgesMerged: number;
  /** Populated if extraction failed for this chunk (other chunks proceed) */
  error?: string;
  provenance?: ExtractionProvenance;
}

/** Options for {@link extractGraphFromChunks}. */
export interface ExtractChunksOptions {
  provenance?: ExtractionProvenance;
  /** Max concurrent LLM calls (default 8) */
  concurrency?: number;
  /** Source label stamped on every node and edge; defaults to each chunk's id */
  source?: string;
  validator?: OntologyValidator;
  /** Called after each batch of chunks is stored */
  onProgress?: (done: number, total: number) => void;
}

/** Aggregate result across all chunks */
export interface BatchExtractionResult {
  chunksProcessed: number;
  chunksErrored: number;
  totalNodesAdded: number;
  totalNodesMerged: number;
  totalEdgesAdded: number;
  totalEdgesMerged: number;
  perChunk: ChunkExtractionResult[];
  provenance?: ExtractionProvenance;
}

/**
 * Extract and ingest a knowledge graph from multiple text chunks in parallel.
 *
 * Runs LLM entity + relationship extraction concurrently (Promise.allSettled —
 * one failing chunk never cancels others). Each result is upserted into the
 * KnowledgeGraph's backing KGStore.
 *
 * Ref: cognee extract_graph_from_data() + integrate_chunk_graphs() pattern.
 *
 * @param kg      The KnowledgeGraph instance to ingest into
 * @param chunks  Array of text chunks to extract from
 * @param opts    Provenance, concurrency (default 8), a source label for every chunk (default
 *                the chunk id) and an ontology validator
 */
export async function extractGraphFromChunks(
  kg: KnowledgeGraph,
  chunks: TextChunk[],
  opts: ExtractChunksOptions = {},
): Promise<BatchExtractionResult> {
  const { concurrency = 8, source, validator, onProgress } = opts;
  const now = Date.now();
  const prov: ExtractionProvenance = { extractedAt: now, ...opts.provenance };
  const perChunk: ChunkExtractionResult[] = [];

  // Process in concurrency-limited batches
  for (let i = 0; i < chunks.length; i += concurrency) {
    const batch = chunks.slice(i, i + concurrency);

    const settled = await Promise.allSettled(
      batch.map((chunk) => kg.extract(chunk.text, { validator })),
    );

    for (let j = 0; j < settled.length; j++) {
      const s = settled[j]!;
      const chunkId = batch[j]!.id;

      // Storing one chunk at a time keeps added/merged counts true when chunks share entities.
      const stored =
        s.status === "fulfilled"
          ? await kg.save(s.value, source ?? chunkId).then(
              (value) => ({ value }),
              (reason: unknown) => ({ reason }),
            )
          : { reason: s.reason as unknown };
      if ("value" in stored) {
        perChunk.push({
          chunkId,
          nodesAdded: stored.value.nodesAdded,
          nodesMerged: stored.value.nodesMerged,
          edgesAdded: stored.value.edgesAdded,
          edgesMerged: stored.value.edgesMerged,
          provenance: prov,
        });
      } else {
        perChunk.push({
          chunkId,
          nodesAdded: 0,
          nodesMerged: 0,
          edgesAdded: 0,
          edgesMerged: 0,
          error: stored.reason instanceof Error ? stored.reason.message : String(stored.reason),
          provenance: prov,
        });
      }
    }
    onProgress?.(perChunk.length, chunks.length);
  }

  // Aggregate
  let totalNodesAdded = 0,
    totalNodesMerged = 0,
    totalEdgesAdded = 0,
    totalEdgesMerged = 0,
    chunksErrored = 0;

  for (const r of perChunk) {
    totalNodesAdded += r.nodesAdded;
    totalNodesMerged += r.nodesMerged;
    totalEdgesAdded += r.edgesAdded;
    totalEdgesMerged += r.edgesMerged;
    if (r.error) chunksErrored++;
  }

  return {
    chunksProcessed: chunks.length,
    chunksErrored,
    totalNodesAdded,
    totalNodesMerged,
    totalEdgesAdded,
    totalEdgesMerged,
    perChunk,
    provenance: prov,
  };
}

// ── Ontology validator interface (cognee pattern) ─────────────────────────────
//
// cognee/modules/ontology/base_ontology_resolver.py — BaseOntologyResolver with
// get_subgraph(entity_name, entity_type). validate_entity() is called before
// upsertNode to ensure extracted types match a known ontology.
//
// In practice: inject a PermissiveOntologyValidator in dev/tests, a
// StrictOntologyValidator in production pipelines that require ontology compliance.

/**
 * Validates extracted entities against an ontology before they are stored.
 *
 * Ref: cognee BaseOntologyResolver + validate strategy pattern
 */
export interface OntologyValidator {
  /**
   * Validate a single entity.
   * Returns the entity (possibly with type normalised) if valid.
   * Returns null to discard the entity.
   */
  validate(entity: Entity): Entity | null;

  /**
   * Validate a relationship after both endpoints have been validated.
   * Returns the relationship (possibly with predicate normalised) if valid.
   * Returns null to discard.
   */
  validateRelationship?(rel: Relationship): Relationship | null;
}

/**
 * Strict entity-type validator — discards entities whose type is not in
 * the allowed set.
 */
export function strictTypeValidator(allowedTypes: EntityType[]): OntologyValidator {
  const allowed = new Set<EntityType>(allowedTypes);
  return {
    validate: (e) => (allowed.has(e.type) ? e : null),
    validateRelationship: (r) => r,
  };
}

// ── KGSearchType + graph-RAG query (graphrag pattern) ─────────────────────────
//
// cognee/modules/search/types/SearchType.py — SearchType enum:
//   CHUNKS | CHUNKS_LEXICAL | TRIPLET_COMPLETION | GRAPH_COMPLETION |
//   GRAPH_COMPLETION_COT | GRAPH_SUMMARY_COMPLETION | SUMMARIES
//
// graphrag/query/structured_search — LocalSearch (entity neighbourhood context)
//   + GlobalSearch (community-level summaries context)
//
// Typed discriminated union for the query path to use against the knowledge graph.

export type KGSearchType =
  | "ENTITIES" // Direct entity lookup by name/type
  | "TRIPLETS" // Triplet (subject, predicate, object) matching
  | "LOCAL_GRAPH" // 1–3 hop neighbourhood around matched entities
  | "COMMUNITY" // Community-level context (community summaries)
  | "GRAPH_COMPLETION" // Full graph-RAG: embed query → nearest entities → expand → synthesise
  | "LEXICAL"; // Keyword/BM25 fallback (when no entity match found)

/** A single graph search result item */
export interface KGSearchResult {
  searchType: KGSearchType;
  /** Matched or retrieved nodes, ranked by relevance */
  nodes: KGNode[];
  /** Edges connecting the returned nodes */
  edges: KGEdge[];
  /** Community summaries (populated for COMMUNITY and GRAPH_COMPLETION modes) */
  communities?: KGCommunitySummary[];
  /**
   * Assembled context string ready to inject into an LLM system/user prompt.
   * Format: "Entity: {name} ({type})\nDescription: ...\nRelationships: ..."
   */
  contextText: string;
  /** Token estimate for the context text (rough: chars / 4) */
  contextTokenEstimate: number;
}

/**
 * Build a context string from graph search results suitable for LLM injection.
 *
 * Ref: graphrag/query/context_builder/builders.py ContextBuilderResult.context_chunks
 */
function buildGraphContext(
  nodes: KGNode[],
  edges: KGEdge[],
  communities?: KGCommunitySummary[],
  opts: { maxTokens?: number } = {},
): string {
  const maxTokens = opts.maxTokens ?? 4000;
  const lines: string[] = [];

  // Entity section
  if (nodes.length > 0) {
    lines.push("## Entities");
    for (const node of nodes) {
      lines.push(`- ${node.name} (${node.type})  [confidence: ${node.confidence.toFixed(2)}]`);
      if (node.properties["description"]) {
        lines.push(`  ${node.properties["description"]}`);
      }
    }
  }

  // Relationships section
  if (edges.length > 0) {
    lines.push("\n## Relationships");
    for (const edge of edges) {
      const src = nodes.find((n) => n.id === edge.subjectId)?.name ?? edge.subjectId;
      const tgt = nodes.find((n) => n.id === edge.objectId)?.name ?? edge.objectId;
      lines.push(
        `- ${src} --[${edge.predicate}]--> ${tgt}  [confidence: ${edge.confidence.toFixed(2)}]`,
      );
    }
  }

  // Community summaries section (global graph-RAG)
  if (communities && communities.length > 0) {
    lines.push("\n## Community Summaries");
    for (const c of communities) {
      lines.push(`### ${c.title}`);
      lines.push(c.summary);
      if (c.findings.length > 0) {
        lines.push("Key findings:");
        for (const f of c.findings) {
          lines.push(`  - ${f.summary}`);
        }
      }
    }
  }

  const raw = lines.join("\n");
  // Rough token budget enforcement: truncate by char estimate (4 chars ≈ 1 token)
  const charBudget = maxTokens * 4;
  const truncated = raw.length > charBudget ? raw.slice(0, charBudget) + "\n[truncated]" : raw;

  return truncated;
}

/**
 * Execute a graph search and return structured KGSearchResult.
 *
 * searchType determines the retrieval strategy:
 *   ENTITIES     — findNodes({ nameContains: query })
 *   TRIPLETS     — findEdges matching query as predicate, then fetch endpoints
 *   LOCAL_GRAPH  — entity lookup + multiHopTraverse(depth=2)
 *   COMMUNITY    — return provided communities whose summaries contain the query
 *   GRAPH_COMPLETION — LOCAL_GRAPH + community context combined
 *   LEXICAL      — broad nameContains fallback
 *
 * Ref: cognee SearchType dispatch + graphrag LocalSearch/GlobalSearch context builders
 */
export async function graphSearch(
  store: KGStore,
  query: string,
  searchType: KGSearchType,
  opts: {
    topK?: number;
    maxHops?: number;
    communities?: KGCommunitySummary[];
    maxContextTokens?: number;
  } = {},
): Promise<KGSearchResult> {
  const topK = opts.topK ?? 10;
  const maxHops = opts.maxHops ?? 2;
  const communities = opts.communities ?? [];

  let nodes: KGNode[] = [];
  let edges: KGEdge[] = [];
  let matchedCommunities: KGCommunitySummary[] = [];

  const queryLower = query.toLowerCase();

  switch (searchType) {
    case "ENTITIES":
    case "LEXICAL": {
      nodes = await store.findNodes({ nameContains: query, limit: topK });
      break;
    }

    case "TRIPLETS": {
      // Search edges whose predicate matches the query
      const matchingEdges = await store.findEdges({ predicate: query, limit: topK });
      edges = matchingEdges;
      const nodeIds = new Set<string>();
      for (const e of matchingEdges) {
        nodeIds.add(e.subjectId);
        nodeIds.add(e.objectId);
      }
      nodes = (await Promise.all(Array.from(nodeIds).map((id) => store.getNode(id)))).filter(
        (n): n is KGNode => n !== undefined,
      );
      break;
    }

    case "LOCAL_GRAPH":
    case "GRAPH_COMPLETION": {
      // Phase 1: entity lookup
      const seedNodes = await store.findNodes({ nameContains: query, limit: 5 });
      nodes = [...seedNodes];
      const seenIds = new Set(seedNodes.map((n) => n.id));

      // Phase 2: multi-hop expansion
      for (const seed of seedNodes.slice(0, 3)) {
        const hops = await multiHopTraverse(store, seed.id, { maxDepth: maxHops, topK });
        for (const hop of hops) {
          if (!seenIds.has(hop.node.id)) {
            nodes.push(hop.node);
            seenIds.add(hop.node.id);
          }
          edges.push(hop.viaEdge);
        }
      }

      // Phase 3 (GRAPH_COMPLETION only): add community summaries
      if (searchType === "GRAPH_COMPLETION") {
        matchedCommunities = communities.filter(
          (c) =>
            c.summary.toLowerCase().includes(queryLower) ||
            c.title.toLowerCase().includes(queryLower),
        );
      }

      nodes = nodes.slice(0, topK);
      break;
    }

    case "COMMUNITY": {
      matchedCommunities = communities.filter(
        (c) =>
          c.summary.toLowerCase().includes(queryLower) ||
          c.title.toLowerCase().includes(queryLower) ||
          c.findings.some((f) => f.summary.toLowerCase().includes(queryLower)),
      );

      const ids = new Set(matchedCommunities.flatMap((c) => c.entityIds ?? []));
      const found = await Promise.all([...ids].map((id) => store.getNode(id)));
      nodes = found.filter((n): n is KGNode => n !== undefined).slice(0, topK);
      const kept = new Set(nodes.map((n) => n.id));
      edges = (await store.findEdges({})).filter(
        (e) => kept.has(e.subjectId) && kept.has(e.objectId),
      );
      break;
    }
  }

  const contextText = buildGraphContext(nodes, edges, matchedCommunities, {
    maxTokens: opts.maxContextTokens,
  });

  return {
    searchType,
    nodes,
    edges,
    communities: matchedCommunities.length > 0 ? matchedCommunities : undefined,
    contextText,
    contextTokenEstimate: Math.ceil(contextText.length / 4),
  };
}

export * from "./community.js";
export * from "./merge.js";
export * from "./query.js";
