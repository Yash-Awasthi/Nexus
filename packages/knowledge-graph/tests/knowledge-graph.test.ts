// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  InMemoryKGStore,
  NeonKGStore,
  KnowledgeGraph,
  KGError,
  makeNodeId,
  makeEdgeId,
  nullEntityExtractor,
  nullRelationshipExtractor,
  type NeonQueryFn,
  type NeonRow,
  type KGNode,
  type KGEdge,
  type Entity,
  type Relationship,
  type EntityExtractor,
  type RelationshipExtractor,
} from "../src/index.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000;

function node(
  name: string,
  type: KGNode["type"] = "PERSON",
  overrides: Partial<KGNode> = {},
): KGNode {
  return {
    id: makeNodeId(name, type),
    name,
    type,
    confidence: 0.9,
    properties: {},
    sources: ["doc-1"],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function edge(
  subjectId: string,
  predicate: string,
  objectId: string,
  overrides: Partial<KGEdge> = {},
): KGEdge {
  return {
    id: makeEdgeId(subjectId, predicate, objectId),
    subjectId,
    predicate,
    objectId,
    confidence: 0.8,
    sources: ["doc-1"],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeStore(): InMemoryKGStore {
  return new InMemoryKGStore();
}

function makeEntities(...names: string[]): Entity[] {
  return names.map((name) => ({ text: name, type: "PERSON" as const, confidence: 0.9 }));
}

function makeRelationship(subject: string, predicate: string, object: string): Relationship {
  return { subject, predicate, object, confidence: 0.8 };
}

function makeExtractors(entities: Entity[], rels: Relationship[] = []) {
  return {
    entityExtractor: vi.fn().mockResolvedValue(entities) as EntityExtractor,
    relationshipExtractor: vi.fn().mockResolvedValue(rels) as RelationshipExtractor,
  };
}

// ── makeNodeId ────────────────────────────────────────────────────────────────

describe("makeNodeId", () => {
  it("returns a 16-char hex string", () => {
    expect(makeNodeId("Alice", "PERSON")).toHaveLength(16);
    expect(makeNodeId("Alice", "PERSON")).toMatch(/^[0-9a-f]+$/);
  });

  it("is deterministic — same input → same id", () => {
    expect(makeNodeId("Alice", "PERSON")).toBe(makeNodeId("Alice", "PERSON"));
  });

  it("is case-insensitive on name", () => {
    expect(makeNodeId("alice", "PERSON")).toBe(makeNodeId("ALICE", "PERSON"));
  });

  it("differs for different types", () => {
    expect(makeNodeId("Nexus", "ORG")).not.toBe(makeNodeId("Nexus", "PRODUCT"));
  });

  it("differs for different names", () => {
    expect(makeNodeId("Alice", "PERSON")).not.toBe(makeNodeId("Bob", "PERSON"));
  });

  it("trims whitespace before hashing", () => {
    expect(makeNodeId("  Alice  ", "PERSON")).toBe(makeNodeId("Alice", "PERSON"));
  });
});

// ── makeEdgeId ────────────────────────────────────────────────────────────────

describe("makeEdgeId", () => {
  const sId = makeNodeId("Alice", "PERSON");
  const oId = makeNodeId("NIT", "ORG");

  it("returns a 16-char hex string", () => {
    expect(makeEdgeId(sId, "works at", oId)).toHaveLength(16);
  });

  it("is deterministic", () => {
    expect(makeEdgeId(sId, "works at", oId)).toBe(makeEdgeId(sId, "works at", oId));
  });

  it("is case-insensitive on predicate", () => {
    expect(makeEdgeId(sId, "Works At", oId)).toBe(makeEdgeId(sId, "works at", oId));
  });

  it("differs for different predicates", () => {
    expect(makeEdgeId(sId, "works at", oId)).not.toBe(makeEdgeId(sId, "founded", oId));
  });

  it("differs when subject and object are swapped", () => {
    expect(makeEdgeId(sId, "works at", oId)).not.toBe(makeEdgeId(oId, "works at", sId));
  });
});

// ── InMemoryKGStore — nodes ───────────────────────────────────────────────────

describe("InMemoryKGStore — nodes", () => {
  let store: InMemoryKGStore;
  beforeEach(() => {
    store = makeStore();
  });

  it("upsertNode inserts a new node", async () => {
    const n = node("Alice");
    await store.upsertNode(n);
    expect(store.nodeCount).toBe(1);
  });

  it("getNode returns undefined for missing id", async () => {
    expect(await store.getNode("nonexistent")).toBeUndefined();
  });

  it("getNode returns the stored node", async () => {
    const n = node("Alice");
    await store.upsertNode(n);
    const found = await store.getNode(n.id);
    expect(found?.name).toBe("Alice");
  });

  it("upsertNode merges: takes max confidence", async () => {
    const n1 = node("Alice", "PERSON", { confidence: 0.7 });
    const n2 = node("Alice", "PERSON", { confidence: 0.95 });
    await store.upsertNode(n1);
    await store.upsertNode(n2);
    const found = await store.getNode(n1.id);
    expect(found?.confidence).toBeCloseTo(0.95);
    expect(store.nodeCount).toBe(1);
  });

  it("upsertNode merges: unions sources", async () => {
    const n1 = node("Alice", "PERSON", { sources: ["doc-1"] });
    const n2 = node("Alice", "PERSON", { sources: ["doc-2"] });
    await store.upsertNode(n1);
    await store.upsertNode(n2);
    const found = await store.getNode(n1.id);
    expect(found?.sources).toContain("doc-1");
    expect(found?.sources).toContain("doc-2");
    expect(found?.sources).toHaveLength(2);
  });

  it("upsertNode merges: deduplicates sources", async () => {
    const n1 = node("Alice", "PERSON", { sources: ["doc-1"] });
    const n2 = node("Alice", "PERSON", { sources: ["doc-1"] });
    await store.upsertNode(n1);
    await store.upsertNode(n2);
    const found = await store.getNode(n1.id);
    expect(found?.sources).toHaveLength(1);
  });

  it("upsertNode merges: shallow-merges properties", async () => {
    const n1 = node("Alice", "PERSON", { properties: { a: 1 } });
    const n2 = node("Alice", "PERSON", { properties: { b: 2 } });
    await store.upsertNode(n1);
    await store.upsertNode(n2);
    const found = await store.getNode(n1.id);
    expect(found?.properties).toMatchObject({ a: 1, b: 2 });
  });

  it("deleteNode removes the node", async () => {
    const n = node("Alice");
    await store.upsertNode(n);
    await store.deleteNode(n.id);
    expect(await store.getNode(n.id)).toBeUndefined();
  });

  it("deleteNode is a no-op for missing id", async () => {
    await expect(store.deleteNode("missing")).resolves.toBeUndefined();
  });

  it("findNodes with empty query returns all", async () => {
    await store.upsertNode(node("Alice", "PERSON"));
    await store.upsertNode(node("Acme", "ORG"));
    expect(await store.findNodes({})).toHaveLength(2);
  });

  it("findNodes filters by type", async () => {
    await store.upsertNode(node("Alice", "PERSON"));
    await store.upsertNode(node("Acme", "ORG"));
    const result = await store.findNodes({ type: "PERSON" });
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("Alice");
  });

  it("findNodes filters by nameContains (case-insensitive)", async () => {
    await store.upsertNode(node("Alice Wonderland", "PERSON"));
    await store.upsertNode(node("Bob", "PERSON"));
    const result = await store.findNodes({ nameContains: "alice" });
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("Alice Wonderland");
  });

  it("findNodes filters by minConfidence", async () => {
    await store.upsertNode(node("A", "PERSON", { confidence: 0.5 }));
    await store.upsertNode(node("B", "PERSON", { confidence: 0.9 }));
    const result = await store.findNodes({ minConfidence: 0.8 });
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("B");
  });

  it("findNodes respects limit", async () => {
    await store.upsertNode(node("A", "PERSON"));
    await store.upsertNode(node("B", "PERSON"));
    await store.upsertNode(node("C", "PERSON"));
    const result = await store.findNodes({ limit: 2 });
    expect(result).toHaveLength(2);
  });
});

// ── InMemoryKGStore — edges ───────────────────────────────────────────────────

describe("InMemoryKGStore — edges", () => {
  let store: InMemoryKGStore;
  let sId: string;
  let oId: string;

  beforeEach(async () => {
    store = makeStore();
    sId = makeNodeId("Alice", "PERSON");
    oId = makeNodeId("Acme", "ORG");
    await store.upsertNode(node("Alice", "PERSON"));
    await store.upsertNode(node("Acme", "ORG"));
  });

  it("upsertEdge inserts a new edge", async () => {
    await store.upsertEdge(edge(sId, "works at", oId));
    expect(store.edgeCount).toBe(1);
  });

  it("getEdge returns undefined for missing id", async () => {
    expect(await store.getEdge("missing")).toBeUndefined();
  });

  it("getEdge returns the stored edge", async () => {
    const e = edge(sId, "works at", oId);
    await store.upsertEdge(e);
    const found = await store.getEdge(e.id);
    expect(found?.predicate).toBe("works at");
  });

  it("upsertEdge merges: max confidence", async () => {
    await store.upsertEdge(edge(sId, "works at", oId, { confidence: 0.5 }));
    await store.upsertEdge(edge(sId, "works at", oId, { confidence: 0.95 }));
    const e = edge(sId, "works at", oId);
    const found = await store.getEdge(e.id);
    expect(found?.confidence).toBeCloseTo(0.95);
    expect(store.edgeCount).toBe(1);
  });

  it("upsertEdge merges: unions sources", async () => {
    await store.upsertEdge(edge(sId, "works at", oId, { sources: ["doc-1"] }));
    await store.upsertEdge(edge(sId, "works at", oId, { sources: ["doc-2"] }));
    const e = edge(sId, "works at", oId);
    const found = await store.getEdge(e.id);
    expect(found?.sources).toHaveLength(2);
  });

  it("deleteEdge removes the edge", async () => {
    const e = edge(sId, "works at", oId);
    await store.upsertEdge(e);
    await store.deleteEdge(e.id);
    expect(await store.getEdge(e.id)).toBeUndefined();
  });

  it("findEdges by subjectId", async () => {
    await store.upsertEdge(edge(sId, "works at", oId));
    const result = await store.findEdges({ subjectId: sId });
    expect(result).toHaveLength(1);
  });

  it("findEdges by objectId", async () => {
    await store.upsertEdge(edge(sId, "works at", oId));
    const result = await store.findEdges({ objectId: oId });
    expect(result).toHaveLength(1);
  });

  it("findEdges by predicate (case-insensitive)", async () => {
    await store.upsertEdge(edge(sId, "Works At", oId));
    const result = await store.findEdges({ predicate: "works at" });
    expect(result).toHaveLength(1);
  });

  it("findEdges by minConfidence", async () => {
    await store.upsertEdge(edge(sId, "works at", oId, { confidence: 0.3 }));
    const oId2 = makeNodeId("London", "LOCATION");
    await store.upsertNode(node("London", "LOCATION"));
    await store.upsertEdge(edge(sId, "lives in", oId2, { confidence: 0.9 }));
    const result = await store.findEdges({ minConfidence: 0.8 });
    expect(result).toHaveLength(1);
  });

  it("findEdges respects limit", async () => {
    const oId2 = makeNodeId("London", "LOCATION");
    await store.upsertNode(node("London", "LOCATION"));
    await store.upsertEdge(edge(sId, "works at", oId));
    await store.upsertEdge(edge(sId, "lives in", oId2));
    const result = await store.findEdges({ subjectId: sId, limit: 1 });
    expect(result).toHaveLength(1);
  });
});

// ── InMemoryKGStore — stats ───────────────────────────────────────────────────

describe("InMemoryKGStore — stats", () => {
  it("returns zeros for empty store", async () => {
    const s = await makeStore().stats();
    expect(s.nodes).toBe(0);
    expect(s.edges).toBe(0);
    expect(s.nodesByType).toEqual({});
  });

  it("counts nodes and edges correctly", async () => {
    const store = makeStore();
    const sId = makeNodeId("Alice", "PERSON");
    const oId = makeNodeId("Acme", "ORG");
    await store.upsertNode(node("Alice", "PERSON"));
    await store.upsertNode(node("Acme", "ORG"));
    await store.upsertEdge(edge(sId, "works at", oId));
    const s = await store.stats();
    expect(s.nodes).toBe(2);
    expect(s.edges).toBe(1);
  });

  it("nodesByType groups correctly", async () => {
    const store = makeStore();
    await store.upsertNode(node("Alice", "PERSON"));
    await store.upsertNode(node("Bob", "PERSON"));
    await store.upsertNode(node("Acme", "ORG"));
    const s = await store.stats();
    expect(s.nodesByType["PERSON"]).toBe(2);
    expect(s.nodesByType["ORG"]).toBe(1);
  });
});

// ── Null extractors ───────────────────────────────────────────────────────────

describe("null extractors", () => {
  it("nullEntityExtractor returns []", async () => {
    expect(await nullEntityExtractor("any text")).toEqual([]);
  });

  it("nullRelationshipExtractor returns []", async () => {
    expect(await nullRelationshipExtractor("any text", [])).toEqual([]);
  });
});

// ── KnowledgeGraph.ingest ──────────────────────────────────────────────────────

describe("KnowledgeGraph.ingest", () => {
  it("returns zero result for empty text", async () => {
    const kg = new KnowledgeGraph(makeStore());
    const result = await kg.ingest("   ");
    expect(result).toMatchObject({ nodesAdded: 0, nodesMerged: 0, edgesAdded: 0, edgesMerged: 0 });
  });

  it("does not call extractors for empty text", async () => {
    const { entityExtractor, relationshipExtractor } = makeExtractors([]);
    const kg = new KnowledgeGraph(makeStore(), entityExtractor, relationshipExtractor);
    await kg.ingest("");
    expect(entityExtractor).not.toHaveBeenCalled();
    expect(relationshipExtractor).not.toHaveBeenCalled();
  });

  it("adds nodes for each extracted entity", async () => {
    const store = makeStore();
    const { entityExtractor, relationshipExtractor } = makeExtractors(makeEntities("Alice", "Bob"));
    const kg = new KnowledgeGraph(store, entityExtractor, relationshipExtractor);
    const result = await kg.ingest("Alice and Bob met.", { source: "doc-1" });
    expect(result.nodesAdded).toBe(2);
    expect(store.nodeCount).toBe(2);
  });

  it("sets source on nodes when provided", async () => {
    const store = makeStore();
    const { entityExtractor, relationshipExtractor } = makeExtractors(makeEntities("Alice"));
    const kg = new KnowledgeGraph(store, entityExtractor, relationshipExtractor);
    await kg.ingest("Alice.", { source: "profile.txt" });
    const id = makeNodeId("Alice", "PERSON");
    const n = await store.getNode(id);
    expect(n?.sources).toContain("profile.txt");
  });

  it("merges nodes for duplicate entities across calls", async () => {
    const store = makeStore();
    const { entityExtractor, relationshipExtractor } = makeExtractors(makeEntities("Alice"));
    const kg = new KnowledgeGraph(store, entityExtractor, relationshipExtractor);
    await kg.ingest("First doc.", { source: "doc-1" });
    const result2 = await kg.ingest("Second doc.", { source: "doc-2" });
    expect(result2.nodesMerged).toBe(1);
    expect(store.nodeCount).toBe(1);
  });

  it("adds edges for extracted relationships", async () => {
    const store = makeStore();
    const entities = makeEntities("Alice", "Acme");
    const rels = [makeRelationship("Alice", "works at", "Acme")];
    const { entityExtractor, relationshipExtractor } = makeExtractors(entities, rels);
    const kg = new KnowledgeGraph(store, entityExtractor, relationshipExtractor);
    const result = await kg.ingest("Alice works at Acme.", { source: "doc-1" });
    expect(result.edgesAdded).toBe(1);
    expect(store.edgeCount).toBe(1);
  });

  it("skips relationship when subject not in entity list", async () => {
    const store = makeStore();
    const entities = makeEntities("Alice");
    const rels = [makeRelationship("Unknown", "works at", "Alice")];
    const { entityExtractor, relationshipExtractor } = makeExtractors(entities, rels);
    const kg = new KnowledgeGraph(store, entityExtractor, relationshipExtractor);
    const result = await kg.ingest("Alice did something.", { source: "doc-1" });
    expect(result.edgesAdded).toBe(0);
  });

  it("does not call relationshipExtractor for single-entity documents", async () => {
    const { entityExtractor, relationshipExtractor } = makeExtractors(makeEntities("Alice"));
    const kg = new KnowledgeGraph(makeStore(), entityExtractor, relationshipExtractor);
    await kg.ingest("Only Alice.", {});
    expect(relationshipExtractor).not.toHaveBeenCalled();
  });

  it("per-call extractor overrides default", async () => {
    const defaultExt: EntityExtractor = vi.fn().mockResolvedValue([]);
    const callExt: EntityExtractor = vi.fn().mockResolvedValue(makeEntities("Alice"));
    const kg = new KnowledgeGraph(makeStore(), defaultExt);
    await kg.ingest("text", { entityExtractor: callExt });
    expect(defaultExt).not.toHaveBeenCalled();
    expect(callExt).toHaveBeenCalled();
  });

  it("returns entities and relationships in result", async () => {
    const entities = makeEntities("Alice", "Bob");
    const rels = [makeRelationship("Alice", "knows", "Bob")];
    const { entityExtractor, relationshipExtractor } = makeExtractors(entities, rels);
    const kg = new KnowledgeGraph(makeStore(), entityExtractor, relationshipExtractor);
    const result = await kg.ingest("Alice knows Bob.", {});
    expect(result.entities).toHaveLength(2);
    expect(result.relationships).toHaveLength(1);
  });
});

// ── KnowledgeGraph.queryNodes / queryEdges / getNode / getEdge ────────────────

describe("KnowledgeGraph queries", () => {
  let kg: KnowledgeGraph;
  let store: InMemoryKGStore;

  beforeEach(async () => {
    store = makeStore();
    const entities = [
      { text: "Alice", type: "PERSON" as const, confidence: 0.9 },
      { text: "Acme", type: "ORG" as const, confidence: 0.85 },
    ];
    const rels = [makeRelationship("Alice", "works at", "Acme")];
    const { entityExtractor, relationshipExtractor } = makeExtractors(entities, rels);
    kg = new KnowledgeGraph(store, entityExtractor, relationshipExtractor);
    await kg.ingest("Alice works at Acme.", { source: "s1" });
  });

  it("queryNodes returns all nodes by default", async () => {
    expect(await kg.queryNodes()).toHaveLength(2);
  });

  it("queryNodes filters by type", async () => {
    const result = await kg.queryNodes({ type: "ORG" });
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("Acme");
  });

  it("queryEdges returns all edges by default", async () => {
    expect(await kg.queryEdges()).toHaveLength(1);
  });

  it("getNode returns the node by id", async () => {
    const id = makeNodeId("Alice", "PERSON");
    const n = await kg.getNode(id);
    expect(n?.name).toBe("Alice");
  });

  it("getNode returns undefined for unknown id", async () => {
    expect(await kg.getNode("unknown")).toBeUndefined();
  });

  it("getEdge returns the edge by id", async () => {
    const edges = await kg.queryEdges();
    const e = await kg.getEdge(edges[0]!.id);
    expect(e?.predicate).toBe("works at");
  });
});

// ── KnowledgeGraph.findRelated ────────────────────────────────────────────────

describe("KnowledgeGraph.findRelated", () => {
  let kg: KnowledgeGraph;
  let aliceId: string;
  let acmeId: string;

  beforeEach(async () => {
    const store = makeStore();
    const entities = [
      { text: "Alice", type: "PERSON" as const, confidence: 0.9 },
      { text: "Acme", type: "ORG" as const, confidence: 0.85 },
    ];
    const rels = [makeRelationship("Alice", "works at", "Acme")];
    const { entityExtractor, relationshipExtractor } = makeExtractors(entities, rels);
    kg = new KnowledgeGraph(store, entityExtractor, relationshipExtractor);
    await kg.ingest("Alice works at Acme.", { source: "s1" });
    aliceId = makeNodeId("Alice", "PERSON");
    acmeId = makeNodeId("Acme", "ORG");
  });

  it("returns the requested node", async () => {
    const result = await kg.findRelated(aliceId);
    expect(result.node?.name).toBe("Alice");
  });

  it("returns undefined node for unknown id", async () => {
    const result = await kg.findRelated("unknown");
    expect(result.node).toBeUndefined();
  });

  it("direction=outbound returns outbound neighbors only", async () => {
    const result = await kg.findRelated(aliceId, { direction: "outbound" });
    expect(result.neighbors).toHaveLength(1);
    expect(result.neighbors[0]?.direction).toBe("outbound");
    expect(result.neighbors[0]?.node.name).toBe("Acme");
  });

  it("direction=inbound returns inbound neighbors only", async () => {
    const result = await kg.findRelated(acmeId, { direction: "inbound" });
    expect(result.neighbors).toHaveLength(1);
    expect(result.neighbors[0]?.direction).toBe("inbound");
    expect(result.neighbors[0]?.node.name).toBe("Alice");
  });

  it("direction=both (default) returns all neighbors", async () => {
    const result = await kg.findRelated(aliceId);
    expect(result.neighbors).toHaveLength(1);
  });

  it("respects limit option", async () => {
    const result = await kg.findRelated(aliceId, { limit: 0 });
    expect(result.neighbors).toHaveLength(0);
  });

  it("returns empty neighbors for isolated node", async () => {
    const store2 = new InMemoryKGStore();
    await store2.upsertNode(node("Solo", "PERSON"));
    const soloId = makeNodeId("Solo", "PERSON");
    const kg2 = new KnowledgeGraph(store2);
    const result = await kg2.findRelated(soloId);
    expect(result.neighbors).toHaveLength(0);
  });
});

// ── KnowledgeGraph.stats ──────────────────────────────────────────────────────

describe("KnowledgeGraph.stats", () => {
  it("returns stats from the store", async () => {
    const kg = new KnowledgeGraph(makeStore());
    const s = await kg.stats();
    expect(s.nodes).toBe(0);
    expect(s.edges).toBe(0);
  });
});

// ── KGError ───────────────────────────────────────────────────────────────────

describe("KGError", () => {
  it("has name 'KGError'", () => expect(new KGError("m", "C").name).toBe("KGError"));
  it("stores code", () => expect(new KGError("m", "CODE").code).toBe("CODE"));
  it("is instanceof Error", () => expect(new KGError("x", "Y")).toBeInstanceOf(Error));
  it("stores context", () => expect(new KGError("m", "C", { k: 1 }).context).toEqual({ k: 1 }));
});

// ── NeonKGStore ───────────────────────────────────────────────────────────────
//
// We test NeonKGStore with an in-memory SQL mock that intercepts the exact SQL
// patterns generated by the implementation, maintaining in-memory maps for
// nodes and edges.  This exercises all application-layer merge logic without
// needing a real Postgres/Neon connection.

/** Build an in-memory NeonQueryFn that implements the subset of SQL used by NeonKGStore */
function createInMemoryNeonQuery(tablePrefix = "kg_"): NeonQueryFn {
  const nodesTable = `${tablePrefix}nodes`;
  const edgesTable = `${tablePrefix}edges`;
  const nodesMap = new Map<string, NeonRow>();
  const edgesMap = new Map<string, NeonRow>();

  return async (sql: string, params: unknown[] = []): Promise<{ rows: NeonRow[] }> => {
    const s = sql.trim().toUpperCase();

    // ── DDL ─────────────────────────────────────────────────────────────────
    if (s.startsWith("CREATE TABLE")) return { rows: [] };

    // ── Nodes ────────────────────────────────────────────────────────────────
    if (sql.includes(nodesTable)) {
      // SELECT * FROM kg_nodes WHERE id=$1  (getNode)
      if (/^SELECT \* FROM .+ WHERE id=\$1$/i.test(sql.trim())) {
        const row = nodesMap.get(params[0] as string);
        return { rows: row ? [row] : [] };
      }

      // INSERT INTO kg_nodes (id, name, …) VALUES (…)
      if (/^INSERT INTO/i.test(sql.trim())) {
        const [id, name, type, confidence, properties, sources, created_at, updated_at] = params;
        nodesMap.set(id as string, {
          id,
          name,
          type,
          confidence,
          properties,
          sources,
          created_at,
          updated_at,
        });
        return { rows: [] };
      }

      // UPDATE kg_nodes SET confidence=$1, sources=$2, properties=$3, updated_at=$4 WHERE id=$5
      if (/^UPDATE/i.test(sql.trim())) {
        const [confidence, sources, properties, updated_at, id] = params;
        const existing = nodesMap.get(id as string);
        if (existing) {
          nodesMap.set(id as string, { ...existing, confidence, sources, properties, updated_at });
        }
        return { rows: [] };
      }

      // DELETE FROM kg_nodes WHERE id=$1
      if (/^DELETE/i.test(sql.trim())) {
        nodesMap.delete(params[0] as string);
        return { rows: [] };
      }

      // SELECT type, COUNT(*) AS cnt FROM kg_nodes GROUP BY type  (stats)
      if (/GROUP BY type/i.test(sql)) {
        const counts = new Map<string, number>();
        for (const row of nodesMap.values()) {
          const t = row["type"] as string;
          counts.set(t, (counts.get(t) ?? 0) + 1);
        }
        return { rows: Array.from(counts.entries()).map(([type, cnt]) => ({ type, cnt })) };
      }

      // SELECT * FROM kg_nodes [WHERE ...] [LIMIT N]  (findNodes)
      if (/^SELECT \* FROM/i.test(sql.trim())) {
        let results = Array.from(nodesMap.values());

        // Apply WHERE conditions based on params and SQL text
        const whereMatch = sql.match(/WHERE (.+?)(?:\s+LIMIT|$)/i);
        if (whereMatch) {
          let paramIdx = 0;
          const conditions = whereMatch[1]!.split(/\s+AND\s+/i);
          for (const cond of conditions) {
            const p = params[paramIdx++];
            if (/^type=/i.test(cond.trim())) {
              results = results.filter((r) => r["type"] === p);
            } else if (/LOWER\(name\) LIKE/i.test(cond)) {
              const pat = (p as string).replace(/%/g, "").toLowerCase();
              results = results.filter((r) => (r["name"] as string).toLowerCase().includes(pat));
            } else if (/confidence>=/i.test(cond)) {
              results = results.filter((r) => Number(r["confidence"]) >= Number(p));
            }
          }
        }

        const limitMatch = sql.match(/LIMIT\s+(\d+)/i);
        if (limitMatch) results = results.slice(0, parseInt(limitMatch[1]!, 10));
        return { rows: results };
      }
    }

    // ── Edges ────────────────────────────────────────────────────────────────
    if (sql.includes(edgesTable)) {
      // SELECT * FROM kg_edges WHERE id=$1  (getEdge)
      if (/^SELECT \* FROM .+ WHERE id=\$1$/i.test(sql.trim())) {
        const row = edgesMap.get(params[0] as string);
        return { rows: row ? [row] : [] };
      }

      // INSERT INTO kg_edges (id, subject_id, …) VALUES (…)
      if (/^INSERT INTO/i.test(sql.trim())) {
        const [id, subject_id, predicate, object_id, confidence, sources, created_at, updated_at] =
          params;
        edgesMap.set(id as string, {
          id,
          subject_id,
          predicate,
          object_id,
          confidence,
          sources,
          created_at,
          updated_at,
        });
        return { rows: [] };
      }

      // UPDATE kg_edges SET confidence=$1, sources=$2, updated_at=$3 WHERE id=$4
      if (/^UPDATE/i.test(sql.trim())) {
        const [confidence, sources, updated_at, id] = params;
        const existing = edgesMap.get(id as string);
        if (existing) {
          edgesMap.set(id as string, { ...existing, confidence, sources, updated_at });
        }
        return { rows: [] };
      }

      // DELETE FROM kg_edges WHERE id=$1
      if (/^DELETE/i.test(sql.trim())) {
        edgesMap.delete(params[0] as string);
        return { rows: [] };
      }

      // SELECT COUNT(*) AS cnt FROM kg_edges  (stats edge count)
      if (/COUNT\(\*\)/i.test(sql)) {
        return { rows: [{ cnt: edgesMap.size }] };
      }

      // SELECT * FROM kg_edges [WHERE ...] [LIMIT N]  (findEdges)
      if (/^SELECT \* FROM/i.test(sql.trim())) {
        let results = Array.from(edgesMap.values());

        const whereMatch = sql.match(/WHERE (.+?)(?:\s+LIMIT|$)/i);
        if (whereMatch) {
          let paramIdx = 0;
          const conditions = whereMatch[1]!.split(/\s+AND\s+/i);
          for (const cond of conditions) {
            const p = params[paramIdx++];
            if (/^subject_id=/i.test(cond.trim())) {
              results = results.filter((r) => r["subject_id"] === p);
            } else if (/^object_id=/i.test(cond.trim())) {
              results = results.filter((r) => r["object_id"] === p);
            } else if (/LOWER\(predicate\)=/i.test(cond)) {
              results = results.filter(
                (r) => (r["predicate"] as string).toLowerCase() === (p as string),
              );
            } else if (/confidence>=/i.test(cond)) {
              results = results.filter((r) => Number(r["confidence"]) >= Number(p));
            }
          }
        }

        const limitMatch = sql.match(/LIMIT\s+(\d+)/i);
        if (limitMatch) results = results.slice(0, parseInt(limitMatch[1]!, 10));
        return { rows: results };
      }
    }

    return { rows: [] };
  };
}

/** Build a fresh NeonKGStore with in-memory SQL mock */
async function makeNeonStore(tablePrefix?: string): Promise<NeonKGStore> {
  const store = new NeonKGStore({ query: createInMemoryNeonQuery(tablePrefix) });
  await store.init();
  return store;
}

describe("NeonKGStore — init()", () => {
  it("calls CREATE TABLE for both nodes and edges tables", async () => {
    const queryFn: NeonQueryFn = vi.fn().mockResolvedValue({ rows: [] });
    const store = new NeonKGStore({ query: queryFn });
    await store.init();
    const calls = (queryFn as ReturnType<typeof vi.fn>).mock.calls as [string, unknown[]][];
    const sqls = calls.map(([sql]) => sql.toUpperCase());
    expect(sqls.some((s) => s.includes("CREATE TABLE") && s.includes("KG_NODES"))).toBe(true);
    expect(sqls.some((s) => s.includes("CREATE TABLE") && s.includes("KG_EDGES"))).toBe(true);
  });

  it("uses custom tablePrefix", async () => {
    const queryFn: NeonQueryFn = vi.fn().mockResolvedValue({ rows: [] });
    const store = new NeonKGStore({ query: queryFn, tablePrefix: "nexus_" });
    await store.init();
    const calls = (queryFn as ReturnType<typeof vi.fn>).mock.calls as [string, unknown[]][];
    const sqls = calls.map(([sql]) => sql);
    expect(sqls.some((s) => s.includes("nexus_nodes"))).toBe(true);
    expect(sqls.some((s) => s.includes("nexus_edges"))).toBe(true);
  });
});

describe("NeonKGStore — node operations", () => {
  let store: NeonKGStore;

  beforeEach(async () => {
    store = await makeNeonStore();
  });

  it("upsertNode returns the node and getNode retrieves it", async () => {
    const n = node("Alice");
    await store.upsertNode(n);
    const fetched = await store.getNode(n.id);
    expect(fetched?.name).toBe("Alice");
    expect(fetched?.type).toBe("PERSON");
  });

  it("getNode returns undefined for unknown id", async () => {
    expect(await store.getNode("not-a-real-id")).toBeUndefined();
  });

  it("upsertNode merges confidence (max) on second call", async () => {
    const n = node("Alice", "PERSON", { confidence: 0.5 });
    await store.upsertNode(n);
    await store.upsertNode({ ...n, confidence: 0.9, updatedAt: NOW + 1 });
    const fetched = await store.getNode(n.id);
    expect(Number(fetched?.confidence)).toBe(0.9);
  });

  it("upsertNode unions sources across calls", async () => {
    const n = node("Alice", "PERSON", { sources: ["doc-1"] });
    await store.upsertNode(n);
    await store.upsertNode({ ...n, sources: ["doc-2"] });
    const fetched = await store.getNode(n.id);
    const srcs =
      typeof fetched?.sources === "string"
        ? (JSON.parse(fetched.sources as string) as string[])
        : (fetched?.sources as string[]);
    expect(srcs).toContain("doc-1");
    expect(srcs).toContain("doc-2");
  });

  it("deleteNode removes the node", async () => {
    const n = node("Alice");
    await store.upsertNode(n);
    await store.deleteNode(n.id);
    expect(await store.getNode(n.id)).toBeUndefined();
  });

  it("deleteNode is a no-op for unknown id", async () => {
    await expect(store.deleteNode("ghost")).resolves.not.toThrow();
  });
});

describe("NeonKGStore — findNodes", () => {
  let store: NeonKGStore;

  beforeEach(async () => {
    store = await makeNeonStore();
    await store.upsertNode(node("Alice", "PERSON", { confidence: 0.9 }));
    await store.upsertNode(node("Bob", "PERSON", { confidence: 0.5 }));
    await store.upsertNode(node("Acme Corp", "ORG", { confidence: 0.8 }));
  });

  it("returns all nodes when query is empty", async () => {
    const results = await store.findNodes({});
    expect(results.length).toBe(3);
  });

  it("filters by type", async () => {
    const results = await store.findNodes({ type: "ORG" });
    expect(results.length).toBe(1);
    expect(results[0]?.name).toBe("Acme Corp");
  });

  it("filters by nameContains (case-insensitive)", async () => {
    const results = await store.findNodes({ nameContains: "alice" });
    expect(results.length).toBe(1);
  });

  it("filters by minConfidence", async () => {
    const results = await store.findNodes({ minConfidence: 0.8 });
    expect(results.length).toBe(2); // Alice (0.9) + Acme (0.8)
  });

  it("respects limit", async () => {
    const results = await store.findNodes({ limit: 1 });
    expect(results.length).toBe(1);
  });
});

describe("NeonKGStore — edge operations", () => {
  let store: NeonKGStore;
  let sId: string;
  let oId: string;

  beforeEach(async () => {
    store = await makeNeonStore();
    sId = makeNodeId("Alice", "PERSON");
    oId = makeNodeId("Acme", "ORG");
    await store.upsertNode(node("Alice"));
    await store.upsertNode(node("Acme", "ORG"));
  });

  it("upsertEdge returns the edge and getEdge retrieves it", async () => {
    const e = edge(sId, "works at", oId);
    await store.upsertEdge(e);
    const fetched = await store.getEdge(e.id);
    expect(fetched?.predicate).toBe("works at");
    expect(fetched?.subjectId).toBe(sId);
  });

  it("getEdge returns undefined for unknown id", async () => {
    expect(await store.getEdge("ghost-edge")).toBeUndefined();
  });

  it("upsertEdge merges confidence (max) on second call", async () => {
    const e = edge(sId, "works at", oId, { confidence: 0.4 });
    await store.upsertEdge(e);
    await store.upsertEdge({ ...e, confidence: 0.9 });
    const fetched = await store.getEdge(e.id);
    expect(Number(fetched?.confidence)).toBe(0.9);
  });

  it("deleteEdge removes the edge", async () => {
    const e = edge(sId, "works at", oId);
    await store.upsertEdge(e);
    await store.deleteEdge(e.id);
    expect(await store.getEdge(e.id)).toBeUndefined();
  });
});

describe("NeonKGStore — findEdges", () => {
  let store: NeonKGStore;
  let sId: string;
  let oId: string;
  let oId2: string;

  beforeEach(async () => {
    store = await makeNeonStore();
    sId = makeNodeId("Alice", "PERSON");
    oId = makeNodeId("Acme", "ORG");
    oId2 = makeNodeId("London", "LOCATION");
    await store.upsertNode(node("Alice"));
    await store.upsertNode(node("Acme", "ORG"));
    await store.upsertNode(node("London", "LOCATION"));
    await store.upsertEdge(edge(sId, "works at", oId, { confidence: 0.9 }));
    await store.upsertEdge(edge(sId, "lives in", oId2, { confidence: 0.6 }));
  });

  it("returns all edges when query is empty", async () => {
    expect(await store.findEdges({})).toHaveLength(2);
  });

  it("filters by subjectId", async () => {
    const results = await store.findEdges({ subjectId: sId });
    expect(results).toHaveLength(2);
  });

  it("filters by objectId", async () => {
    const results = await store.findEdges({ objectId: oId });
    expect(results).toHaveLength(1);
    expect(results[0]?.predicate).toBe("works at");
  });

  it("filters by predicate (case-insensitive)", async () => {
    const results = await store.findEdges({ predicate: "WORKS AT" });
    expect(results).toHaveLength(1);
  });

  it("filters by minConfidence", async () => {
    const results = await store.findEdges({ minConfidence: 0.8 });
    expect(results).toHaveLength(1);
    expect(results[0]?.predicate).toBe("works at");
  });

  it("respects limit", async () => {
    const results = await store.findEdges({ limit: 1 });
    expect(results).toHaveLength(1);
  });
});

describe("NeonKGStore — stats()", () => {
  it("returns zeros for empty store", async () => {
    const store = await makeNeonStore();
    const s = await store.stats();
    expect(s.nodes).toBe(0);
    expect(s.edges).toBe(0);
    expect(s.nodesByType).toEqual({});
  });

  it("counts nodes by type correctly", async () => {
    const store = await makeNeonStore();
    await store.upsertNode(node("Alice", "PERSON"));
    await store.upsertNode(node("Bob", "PERSON"));
    await store.upsertNode(node("Acme", "ORG"));
    const s = await store.stats();
    expect(s.nodes).toBe(3);
    expect(s.nodesByType["PERSON"]).toBe(2);
    expect(s.nodesByType["ORG"]).toBe(1);
  });

  it("counts edges correctly", async () => {
    const store = await makeNeonStore();
    const sId = makeNodeId("Alice", "PERSON");
    const oId = makeNodeId("Acme", "ORG");
    await store.upsertNode(node("Alice"));
    await store.upsertNode(node("Acme", "ORG"));
    await store.upsertEdge(edge(sId, "works at", oId));
    const s = await store.stats();
    expect(s.edges).toBe(1);
  });
});

describe("NeonKGStore — KnowledgeGraph integration", () => {
  it("can be used as a KGStore inside KnowledgeGraph", async () => {
    const store = await makeNeonStore();
    const entities: ReturnType<typeof makeEntities> = [
      { text: "Yash", type: "PERSON" as const, confidence: 0.95 },
      { text: "NIT Raipur", type: "ORG" as const, confidence: 0.9 },
    ];
    const rels = [makeRelationship("Yash", "studies at", "NIT Raipur")];
    const { entityExtractor, relationshipExtractor } = makeExtractors(entities, rels);
    const kg = new KnowledgeGraph(store, entityExtractor, relationshipExtractor);
    const result = await kg.ingest("Yash studies at NIT Raipur.", { source: "profile" });
    expect(result.nodesAdded).toBe(2);
    expect(result.edgesAdded).toBe(1);
    const nodes = await kg.queryNodes({ type: "PERSON" });
    expect(nodes[0]?.name).toBe("Yash");
  });
});
