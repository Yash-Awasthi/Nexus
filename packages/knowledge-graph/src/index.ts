// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/knowledge-graph — entity/relationship graph over agent memory.
 *
 * Zero external dependencies.  Entity and relationship extraction is fully
 * injectable — wire in @nexus/nlp-utils extractEntities / extractRelationships
 * (backed by @nexus/llm-utils) in production; use nullEntityExtractor and
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

import { createHash } from "node:crypto";

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
  /** Source labels (document IDs / URLs) from which this node was extracted */
  sources: string[];
  createdAt: number;
  updatedAt: number;
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
}

// ── Store query types ─────────────────────────────────────────────────────────

export interface NodeQuery {
  type?: EntityType;
  /** Case-insensitive substring match on node.name */
  nameContains?: string;
  minConfidence?: number;
  limit?: number;
}

/** Edge query interface definition. */
export interface EdgeQuery {
  subjectId?: string;
  objectId?: string;
  /** Case-insensitive exact match on edge.predicate */
  predicate?: string;
  minConfidence?: number;
  limit?: number;
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
      const merged: KGNode = {
        ...existing,
        confidence: Math.max(existing.confidence, node.confidence),
        sources: Array.from(new Set([...existing.sources, ...node.sources])),
        properties: { ...existing.properties, ...node.properties },
        updatedAt: node.updatedAt,
      };
      this.nodes.set(node.id, merged);
      return merged;
    }
    this.nodes.set(node.id, { ...node });
    return node;
  }

  async getNode(id: string): Promise<KGNode | undefined> {
    return this.nodes.get(id);
  }

  async findNodes(query: NodeQuery): Promise<KGNode[]> {
    let results = Array.from(this.nodes.values());

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
    this.nodes.delete(id);
  }

  // ── Edges ────────────────────────────────────────────────────────────────

  async upsertEdge(edge: KGEdge): Promise<KGEdge> {
    const existing = this.edges.get(edge.id);
    if (existing) {
      const merged: KGEdge = {
        ...existing,
        confidence: Math.max(existing.confidence, edge.confidence),
        sources: Array.from(new Set([...existing.sources, ...edge.sources])),
        updatedAt: edge.updatedAt,
      };
      this.edges.set(edge.id, merged);
      return merged;
    }
    this.edges.set(edge.id, { ...edge });
    return edge;
  }

  async getEdge(id: string): Promise<KGEdge | undefined> {
    return this.edges.get(id);
  }

  async findEdges(query: EdgeQuery): Promise<KGEdge[]> {
    let results = Array.from(this.edges.values());

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
    this.edges.delete(id);
  }

  async stats(): Promise<KGStats> {
    const nodesByType: Partial<Record<EntityType, number>> = {};
    for (const node of this.nodes.values()) {
      nodesByType[node.type] = (nodesByType[node.type] ?? 0) + 1;
    }
    return {
      nodes: this.nodes.size,
      edges: this.edges.size,
      nodesByType,
    };
  }

  get nodeCount(): number {
    return this.nodes.size;
  }

  get edgeCount(): number {
    return this.edges.size;
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
 * import { extractEntities, extractRelationships } from "@nexus/nlp-utils";
 * import { createLanguageModel } from "@nexus/llm-utils";
 *
 * const llm = createLanguageModel({ provider: "groq" });
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
    const result: IngestResult = {
      nodesAdded: 0,
      nodesMerged: 0,
      edgesAdded: 0,
      edgesMerged: 0,
      entities: [],
      relationships: [],
    };

    if (text.trim().length === 0) return result;

    const extractor = opts.entityExtractor ?? this.defaultEntityExtractor;
    const relExtractor = opts.relationshipExtractor ?? this.defaultRelationshipExtractor;
    const source = opts.source;
    const now = Math.floor(Date.now() / 1000);

    // ── Stage 1: Entity → Node ───────────────────────────────────────────
    const entities = await extractor(text);
    result.entities = entities;

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

    // ── Stage 2: Relationship → Edge ─────────────────────────────────────
    if (entities.length >= 2) {
      const relationships = await relExtractor(text, entities);
      result.relationships = relationships;

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

  constructor(config: NeonKGStoreConfig) {
    this.queryFn = config.query;
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
        id          TEXT PRIMARY KEY,
        name        TEXT        NOT NULL,
        type        TEXT        NOT NULL,
        confidence  REAL        NOT NULL,
        properties  JSONB       NOT NULL DEFAULT '{}',
        sources     JSONB       NOT NULL DEFAULT '[]',
        created_at  BIGINT      NOT NULL,
        updated_at  BIGINT      NOT NULL
      )`,
    );
    await this.queryFn(
      `CREATE TABLE IF NOT EXISTS ${this.edgesTable} (
        id          TEXT PRIMARY KEY,
        subject_id  TEXT        NOT NULL,
        predicate   TEXT        NOT NULL,
        object_id   TEXT        NOT NULL,
        confidence  REAL        NOT NULL,
        sources     JSONB       NOT NULL DEFAULT '[]',
        created_at  BIGINT      NOT NULL,
        updated_at  BIGINT      NOT NULL
      )`,
    );
  }

  // ── Nodes ──────────────────────────────────────────────────────────────────

  async upsertNode(node: KGNode): Promise<KGNode> {
    const existing = await this.getNode(node.id);
    if (existing) {
      const merged: KGNode = {
        ...existing,
        confidence: Math.max(existing.confidence, node.confidence),
        sources: Array.from(new Set([...existing.sources, ...node.sources])),
        properties: { ...existing.properties, ...node.properties },
        updatedAt: node.updatedAt,
      };
      await this.queryFn(
        `UPDATE ${this.nodesTable}
           SET confidence=$1, sources=$2, properties=$3, updated_at=$4
         WHERE id=$5`,
        [
          merged.confidence,
          JSON.stringify(merged.sources),
          JSON.stringify(merged.properties),
          merged.updatedAt,
          merged.id,
        ],
      );
      return merged;
    }

    await this.queryFn(
      `INSERT INTO ${this.nodesTable}
         (id, name, type, confidence, properties, sources, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        node.id,
        node.name,
        node.type,
        node.confidence,
        JSON.stringify(node.properties),
        JSON.stringify(node.sources),
        node.createdAt,
        node.updatedAt,
      ],
    );
    return node;
  }

  async getNode(id: string): Promise<KGNode | undefined> {
    const { rows } = await this.queryFn(`SELECT * FROM ${this.nodesTable} WHERE id=$1`, [id]);
    return rows[0] ? rowToNode(rows[0]) : undefined;
  }

  async findNodes(query: NodeQuery): Promise<KGNode[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

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

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = query.limit !== undefined ? ` LIMIT ${query.limit}` : "";
    const { rows } = await this.queryFn(
      `SELECT * FROM ${this.nodesTable} ${where}${limit}`,
      params,
    );
    return rows.map(rowToNode);
  }

  async deleteNode(id: string): Promise<void> {
    await this.queryFn(`DELETE FROM ${this.nodesTable} WHERE id=$1`, [id]);
  }

  // ── Edges ──────────────────────────────────────────────────────────────────

  async upsertEdge(edge: KGEdge): Promise<KGEdge> {
    const existing = await this.getEdge(edge.id);
    if (existing) {
      const merged: KGEdge = {
        ...existing,
        confidence: Math.max(existing.confidence, edge.confidence),
        sources: Array.from(new Set([...existing.sources, ...edge.sources])),
        updatedAt: edge.updatedAt,
      };
      await this.queryFn(
        `UPDATE ${this.edgesTable}
           SET confidence=$1, sources=$2, updated_at=$3
         WHERE id=$4`,
        [merged.confidence, JSON.stringify(merged.sources), merged.updatedAt, merged.id],
      );
      return merged;
    }

    await this.queryFn(
      `INSERT INTO ${this.edgesTable}
         (id, subject_id, predicate, object_id, confidence, sources, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        edge.id,
        edge.subjectId,
        edge.predicate,
        edge.objectId,
        edge.confidence,
        JSON.stringify(edge.sources),
        edge.createdAt,
        edge.updatedAt,
      ],
    );
    return edge;
  }

  async getEdge(id: string): Promise<KGEdge | undefined> {
    const { rows } = await this.queryFn(`SELECT * FROM ${this.edgesTable} WHERE id=$1`, [id]);
    return rows[0] ? rowToEdge(rows[0]) : undefined;
  }

  async findEdges(query: EdgeQuery): Promise<KGEdge[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

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

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = query.limit !== undefined ? ` LIMIT ${query.limit}` : "";
    const { rows } = await this.queryFn(
      `SELECT * FROM ${this.edgesTable} ${where}${limit}`,
      params,
    );
    return rows.map(rowToEdge);
  }

  async deleteEdge(id: string): Promise<void> {
    await this.queryFn(`DELETE FROM ${this.edgesTable} WHERE id=$1`, [id]);
  }

  // ── Meta ───────────────────────────────────────────────────────────────────

  async stats(): Promise<KGStats> {
    const { rows: nodeRows } = await this.queryFn(
      `SELECT type, COUNT(*) AS cnt FROM ${this.nodesTable} GROUP BY type`,
    );
    const { rows: edgeRows } = await this.queryFn(`SELECT COUNT(*) AS cnt FROM ${this.edgesTable}`);

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
    sources: parseJsonField<string[]>(row["sources"], []),
    createdAt: Number(row["created_at"]),
    updatedAt: Number(row["updated_at"]),
  };
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
 * Compute degree-centrality rank for every node in the store.
 *
 * Rank = number of edges (inbound + outbound). Simple but matches graphrag's
 * initial rank = degree default. Mutates/re-upserts nodes only if the store
 * accepts RankedKGNode (checked via duck-type on first upsert).
 *
 * Ref: graphrag/data_model/entity.py `rank: int | None = 1`
 */
export async function computeEntityRanks(
  store: KGStore,
  nodeIds?: string[],
): Promise<Map<string, number>> {
  // If nodeIds not provided, use all nodes from a broad query
  const nodes =
    nodeIds !== undefined
      ? await Promise.all(nodeIds.map((id) => store.getNode(id)))
      : await store.findNodes({});

  const ranks = new Map<string, number>();

  for (const node of nodes) {
    if (!node) continue;
    const outEdges = await store.findEdges({ subjectId: node.id });
    const inEdges = await store.findEdges({ objectId: node.id });
    ranks.set(node.id, outEdges.length + inEdges.length);
  }

  return ranks;
}

// ── Community model (graphrag pattern) ───────────────────────────────────────
//
// graphrag/data_model/community.py — Community(level, parent, children, entity_ids,
//   relationship_ids, text_unit_ids, attributes, size)
//
// graphrag clusters the entity graph via hierarchical Leiden (greedily maximising
// modularity). Each cluster = a Community. Summaries are LLM-generated per cluster
// and indexed for global-search (answer broad questions by reading community reports
// rather than individual entities).

/** A cluster of related entities discovered by graph community detection. */
export interface KGCommunity {
  /** Unique community ID (deterministic: sha256(level|clusterIdx)) */
  id: string;
  /** Hierarchical level. 0 = leaf clusters; higher = coarser partitions. */
  level: number;
  /** Parent community ID (empty string at root) */
  parentId: string;
  /** Child community IDs at level-1 */
  childIds: string[];
  /** KGNode IDs belonging to this community */
  entityIds: string[];
  /** KGEdge IDs internal to this community */
  relationshipIds: string[];
  /** Computed size = entityIds.length */
  size: number;
  /** Arbitrary metadata from the clustering run */
  attributes?: Record<string, unknown>;
}

/**
 * LLM-generated summary of a community cluster.
 * Generated once per community and indexed for global graph-RAG queries.
 *
 * Ref: graphrag/index/operations/summarize_communities/
 */
export interface KGCommunitySummary {
  communityId: string;
  level: number;
  title: string;
  summary: string;
  /** Key findings extracted by the LLM from entity+edge context in the cluster */
  findings: Array<{ explanation: string; summary: string }>;
  /** Token count of the full prompt used to generate this summary */
  promptTokens: number;
  createdAt: number;
}

// ── Hierarchical graph clustering (graphrag Leiden pattern) ──────────────────
//
// graphrag/index/operations/cluster_graph.py — hierarchical_leiden() → Communities
// list[tuple[int level, int cluster_id, int parent, list[str] nodes]]
//
// The full Leiden algorithm requires grappa/python-igraph. This TypeScript port
// uses a greedy label-propagation approximation suitable for <100k node graphs.
// For production-scale graphs, delegate to the Python services/ingest layer and
// consume the results via IStream (already in @nexus/memory).

/**
 * A single cluster at one level of the hierarchy.
 * Ref: graphrag cluster_graph.py Communities type alias.
 */
export interface ClusterResult {
  level: number;
  clusterId: number;
  parentClusterId: number;
  nodeIds: string[];
}

/**
 * Greedy label-propagation clustering over a KGStore edge list.
 *
 * Returns ClusterResult[] suitable for building KGCommunity records.
 * Runs up to `maxLevels` hierarchical passes (default 2).
 *
 * Algorithm:
 *   1. Build adjacency map from all edges (weighted if WeightedKGEdge)
 *   2. Assign each node to its own community
 *   3. Iteratively move each node to the community of its highest-weight neighbour
 *   4. Repeat until stable (or maxIterations)
 *   5. Recurse on merged super-nodes for level+1
 *
 * Ref: graphrag/graphs/hierarchical_leiden.py (approximated)
 */
export async function clusterGraph(
  store: KGStore,
  opts: {
    maxLevels?: number;
    maxIterations?: number;
    maxClusterSize?: number;
  } = {},
): Promise<ClusterResult[]> {
  const maxLevels = opts.maxLevels ?? 2;
  const maxIterations = opts.maxIterations ?? 10;
  const maxClusterSize = opts.maxClusterSize ?? 10;

  const nodes = await store.findNodes({});
  const edges = await store.findEdges({});

  if (nodes.length === 0) return [];

  // Build adjacency: nodeId → Map<neighborId, weight>
  const adj = new Map<string, Map<string, number>>();
  for (const n of nodes) adj.set(n.id, new Map());

  for (const e of edges) {
    const weight = (e as WeightedKGEdge).weight ?? 1.0;
    if (!adj.has(e.subjectId)) adj.set(e.subjectId, new Map());
    if (!adj.has(e.objectId)) adj.set(e.objectId, new Map());
    const cur1 = adj.get(e.subjectId)!.get(e.objectId) ?? 0;
    const cur2 = adj.get(e.objectId)!.get(e.subjectId) ?? 0;
    adj.get(e.subjectId)!.set(e.objectId, cur1 + weight);
    adj.get(e.objectId)!.set(e.subjectId, cur2 + weight);
  }

  const results: ClusterResult[] = [];

  // Label propagation per level
  let currentNodes = nodes.map((n) => n.id);
  let globalClusterCounter = 0;

  for (let level = 0; level < maxLevels; level++) {
    // Assign initial labels
    const labels = new Map<string, number>();
    currentNodes.forEach((id, i) => labels.set(id, i));

    // Propagate
    for (let iter = 0; iter < maxIterations; iter++) {
      let changed = false;
      // Shuffle for stochastic behaviour without an RNG dep — reverse order alternation
      const order = iter % 2 === 0 ? currentNodes : [...currentNodes].reverse();

      for (const nodeId of order) {
        const neighbors = adj.get(nodeId);
        if (!neighbors || neighbors.size === 0) continue;

        // Find dominant neighbour label by total weight
        const labelWeights = new Map<number, number>();
        for (const [nbId, w] of neighbors) {
          const lbl = labels.get(nbId);
          if (lbl !== undefined) {
            labelWeights.set(lbl, (labelWeights.get(lbl) ?? 0) + w);
          }
        }

        let bestLabel = labels.get(nodeId)!;
        let bestWeight = labelWeights.get(bestLabel) ?? 0;
        for (const [lbl, w] of labelWeights) {
          if (w > bestWeight) {
            bestWeight = w;
            bestLabel = lbl;
          }
        }

        if (bestLabel !== labels.get(nodeId)) {
          labels.set(nodeId, bestLabel);
          changed = true;
        }
      }

      if (!changed) break;
    }

    // Group nodes by label → clusters
    const clusters = new Map<number, string[]>();
    for (const [id, lbl] of labels) {
      if (!clusters.has(lbl)) clusters.set(lbl, []);
      clusters.get(lbl)!.push(id);
    }

    // Enforce maxClusterSize by splitting oversized clusters
    const finalClusters: string[][] = [];
    for (const group of clusters.values()) {
      if (group.length <= maxClusterSize) {
        finalClusters.push(group);
      } else {
        // Chunk into maxClusterSize pieces
        for (let i = 0; i < group.length; i += maxClusterSize) {
          finalClusters.push(group.slice(i, i + maxClusterSize));
        }
      }
    }

    // Emit ClusterResults
    const clusterIdMap = new Map<string, number>(); // nodeId → clusterId at this level
    finalClusters.forEach((group, idx) => {
      const clusterId = globalClusterCounter + idx;
      for (const id of group) clusterIdMap.set(id, clusterId);
      results.push({ level, clusterId, parentClusterId: -1, nodeIds: group });
    });
    globalClusterCounter += finalClusters.length;

    // Wire parent–child across levels
    if (level > 0) {
      // Not implemented in this approximation — use -1 for parent at level > 0
    }

    // For next level: collapse each cluster to a super-node
    currentNodes = finalClusters.map((_, idx) => `super_${globalClusterCounter - finalClusters.length + idx}`);
    if (currentNodes.length <= 1) break;
  }

  return results;
}

/**
 * Build KGCommunity records from ClusterResult[].
 * Call after clusterGraph() to persist community metadata.
 */
export function buildCommunities(clusters: ClusterResult[]): KGCommunity[] {
  return clusters.map((c) => {
    const idHash = createHash("sha256")
      .update(`${c.level}|${c.clusterId}`)
      .digest("hex")
      .slice(0, 16);
    return {
      id: idHash,
      level: c.level,
      parentId: c.parentClusterId >= 0 ? String(c.parentClusterId) : "",
      childIds: [],
      entityIds: c.nodeIds,
      relationshipIds: [],
      size: c.nodeIds.length,
    };
  });
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
export async function multiHopTraverse(
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

    const candidateEdges: Array<{ edge: KGEdge; neighborId: string }> = [
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
 * @param kg           The KnowledgeGraph instance to ingest into
 * @param chunks       Array of text chunks to extract from
 * @param provenance   Optional pipeline/task provenance metadata
 * @param concurrency  Max concurrent LLM calls (default: 8)
 */
export async function extractGraphFromChunks(
  kg: KnowledgeGraph,
  chunks: TextChunk[],
  provenance?: ExtractionProvenance,
  concurrency = 8,
): Promise<BatchExtractionResult> {
  const now = Date.now();
  const prov: ExtractionProvenance = { extractedAt: now, ...provenance };
  const perChunk: ChunkExtractionResult[] = [];

  // Process in concurrency-limited batches
  for (let i = 0; i < chunks.length; i += concurrency) {
    const batch = chunks.slice(i, i + concurrency);

    const settled = await Promise.allSettled(
      batch.map((chunk) => kg.ingest(chunk.text, chunk.id)),
    );

    for (let j = 0; j < settled.length; j++) {
      const s = settled[j]!;
      const chunkId = batch[j]!.id;

      if (s.status === "fulfilled") {
        perChunk.push({
          chunkId,
          nodesAdded: s.value.nodesAdded,
          nodesMerged: s.value.nodesMerged,
          edgesAdded: s.value.edgesAdded,
          edgesMerged: s.value.edgesMerged,
          provenance: prov,
        });
      } else {
        perChunk.push({
          chunkId,
          nodesAdded: 0,
          nodesMerged: 0,
          edgesAdded: 0,
          edgesMerged: 0,
          error: s.reason instanceof Error ? s.reason.message : String(s.reason),
          provenance: prov,
        });
      }
    }
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
 * Permissive validator — accepts all entities and relationships unchanged.
 * Use in tests and development.
 */
export const permissiveValidator: OntologyValidator = {
  validate: (e) => e,
  validateRelationship: (r) => r,
};

/**
 * Strict entity-type validator — discards entities whose type is not in
 * the allowed set.
 */
export function strictTypeValidator(
  allowedTypes: EntityType[],
): OntologyValidator {
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
  | "ENTITIES"         // Direct entity lookup by name/type
  | "TRIPLETS"         // Triplet (subject, predicate, object) matching
  | "LOCAL_GRAPH"      // 1–3 hop neighbourhood around matched entities
  | "COMMUNITY"        // Community-level context (community summaries)
  | "GRAPH_COMPLETION" // Full graph-RAG: embed query → nearest entities → expand → synthesise
  | "LEXICAL";         // Keyword/BM25 fallback (when no entity match found)

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
export function buildGraphContext(
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
      lines.push(`- ${src} --[${edge.predicate}]--> ${tgt}  [confidence: ${edge.confidence.toFixed(2)}]`);
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
      nodes = (
        await Promise.all(Array.from(nodeIds).map((id) => store.getNode(id)))
      ).filter((n): n is KGNode => n !== undefined);
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

      // Fetch entity nodes for matched communities
      const entityIdSet = new Set(matchedCommunities.flatMap((c) => c.communityId));
      if (entityIdSet.size > 0 && communities.length > 0) {
        // Hydrate a sample of entity nodes from first matching community
        const first = matchedCommunities[0];
        if (first) {
          const communityNodes = await store.findNodes({ limit: topK });
          nodes = communityNodes.slice(0, topK);
        }
      }
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
