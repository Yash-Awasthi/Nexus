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

export type EntityType =
  | "PERSON"
  | "ORG"
  | "LOCATION"
  | "DATE"
  | "PRODUCT"
  | "EVENT"
  | "OTHER";

export interface Entity {
  text: string;
  type: EntityType;
  confidence: number;
}

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
export type RelationshipExtractor = (
  text: string,
  entities: Entity[],
) => Promise<Relationship[]>;

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

export interface EdgeQuery {
  subjectId?: string;
  objectId?: string;
  /** Case-insensitive exact match on edge.predicate */
  predicate?: string;
  minConfidence?: number;
  limit?: number;
}

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
export function makeEdgeId(
  subjectId: string,
  predicate: string,
  objectId: string,
): string {
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

export interface IngestResult {
  nodesAdded: number;
  nodesMerged: number;
  edgesAdded: number;
  edgesMerged: number;
  entities: Entity[];
  relationships: Relationship[];
}

export type TraversalDirection = "outbound" | "inbound" | "both";

export interface RelatedOptions {
  direction?: TraversalDirection;
  limit?: number;
}

export interface RelatedEdge {
  node: KGNode;
  edge: KGEdge;
  direction: "outbound" | "inbound";
}

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
