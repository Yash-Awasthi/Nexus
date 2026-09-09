// SPDX-License-Identifier: Apache-2.0
/**
 * Cypher-subset query engine — focused tests against the InMemory store and
 * the KnowledgeGraph convenience method.
 */
import { describe, expect, it } from "vitest";
import {
  InMemoryKGStore,
  KGError,
  KnowledgeGraph,
  makeEdgeId,
  makeNodeId,
  parseCypher,
  runCypher,
  type KGEdge,
  type KGNode,
} from "./index.js";

function seedStore(): InMemoryKGStore {
  const store = new InMemoryKGStore();
  const now = 1_700_000_000;
  const mk = (
    name: string,
    type: KGNode["type"],
    properties: Record<string, unknown> = {},
  ): KGNode => ({
    id: makeNodeId(name, type),
    name,
    type,
    confidence: 0.9,
    properties,
    sources: ["test"],
    createdAt: now,
    updatedAt: now,
  });
  const alice = mk("Alice", "PERSON", { age: 30, team: "platform" });
  const bob = mk("Bob", "PERSON", { age: 25, team: "platform" });
  const carol = mk("Carol", "PERSON", { age: 41, team: "research" });
  const acme = mk("Acme", "ORG", { founded: 1999 });
  const globex = mk("Globex", "ORG", { founded: 2005 });
  const edge = (s: KGNode, pred: string, o: KGNode): KGEdge => ({
    id: makeEdgeId(s.id, pred, o.id),
    subjectId: s.id,
    predicate: pred,
    objectId: o.id,
    confidence: 0.8,
    sources: ["test"],
    createdAt: now,
    updatedAt: now,
  });
  void store.upsertNode(alice);
  void store.upsertNode(bob);
  void store.upsertNode(carol);
  void store.upsertNode(acme);
  void store.upsertNode(globex);
  void store.upsertEdge(edge(alice, "works_at", acme));
  void store.upsertEdge(edge(bob, "works_at", acme));
  void store.upsertEdge(edge(carol, "works_at", globex));
  void store.upsertEdge(edge(alice, "knows", bob));
  return store;
}

describe("parseCypher", () => {
  it("parses a bare MATCH with variables only", () => {
    const q = parseCypher("MATCH (a)-[]->(b)");
    expect(q.step.subject).toBe("a");
    expect(q.step.object).toBe("b");
    expect(q.step.subjectLabel).toBeUndefined();
    expect(q.step.predicate).toBeUndefined();
  });

  it("parses labels, predicate, WHERE, RETURN, LIMIT", () => {
    const q = parseCypher(
      "MATCH (a:PERSON)-[:works_at]->(org:ORG) WHERE a.age > 30 AND org.founded >= 2000 RETURN a.name AS person, org.name LIMIT 5",
    );
    expect(q.step.subjectLabel).toBe("PERSON");
    expect(q.step.predicate).toBe("WORKS_AT"); // normalized uppercase
    expect(q.step.objectLabel).toBe("ORG");
    expect(q.where).toEqual([
      { variable: "a", field: "age", operator: ">", value: 30 },
      { variable: "org", field: "founded", operator: ">=", value: 2000 },
    ]);
    expect(q.projections).toEqual([
      { variable: "a", field: "name", alias: "person" },
      { variable: "org", field: "name", alias: "org.name" },
    ]);
    expect(q.limit).toBe(5);
  });

  it("rejects unsupported syntax with KGError(QUERY_SYNTAX)", () => {
    expect(() => parseCypher("MATCH (a)-[:works_at]->(b)-[:knows]->(c)")).toThrow(KGError);
    expect(() => parseCypher("MATCH (a)-[]->(b) RETURN a ORDER BY a.name")).toThrow(/Unsupported/);
    expect(() => parseCypher("MATCH (a) WHERE a.age LIKE 'x'")).toThrow(/Unsupported WHERE/);
  });
});

describe("runCypher", () => {
  it("returns rows for a label + predicate hop", async () => {
    const res = await runCypher(seedStore(), "MATCH (a:PERSON)-[:works_at]->(org)");
    expect(res.columns).toEqual(["a", "org"]);
    expect(res.rows).toHaveLength(3);
  });

  it("filters with WHERE equality and CONTAINS on names", async () => {
    const res = await runCypher(
      seedStore(),
      "MATCH (a)-[:works_at]->(org) WHERE org.name CONTAINS 'acme'",
    );
    expect(res.rows).toHaveLength(2); // Alice + Bob at Acme, not Carol
  });

  it("filters a node scan on properties and type", async () => {
    const byAge = await runCypher(seedStore(), "MATCH (a:PERSON) WHERE a.age < 30");
    expect(byAge.rows).toHaveLength(1);
    expect((byAge.rows[0]!["a"] as KGNode).name).toBe("Bob");

    const byTeam = await runCypher(
      seedStore(),
      "MATCH (a:PERSON) WHERE a.team = 'platform' RETURN a.name AS name",
    );
    expect(byTeam.rows.map((r) => r.name).sort()).toEqual(["Alice", "Bob"]);

    const byType = await runCypher(seedStore(), "MATCH (a)-[]->(b) WHERE b.type = 'ORG'");
    expect(byType.rows).toHaveLength(3);
  });

  it("projects fields with aliases and dedupes", async () => {
    const res = await runCypher(
      seedStore(),
      "MATCH (a:PERSON)-[:works_at]->(org) RETURN org.name AS employer",
    );
    expect(res.columns).toEqual(["employer"]);
    expect(res.rows.map((r) => r.employer).sort()).toEqual(["Acme", "Globex"]);
  });

  it("applies LIMIT", async () => {
    const res = await runCypher(seedStore(), "MATCH (a:PERSON)-[:works_at]->(org) LIMIT 2");
    expect(res.rows).toHaveLength(2);
  });

  it("returns empty rows for a label with no matches", async () => {
    const res = await runCypher(seedStore(), "MATCH (a:LOCATION)-[]->(b)");
    expect(res.rows).toHaveLength(0);
  });

  it("is case-insensitive for keywords, labels, and predicates", async () => {
    const res = await runCypher(seedStore(), "match (a:person)-[:WORKS_AT]->(org:org)");
    expect(res.rows).toHaveLength(3);
  });
});

describe("KnowledgeGraph.query", () => {
  it("exposes the query engine as a convenience method", async () => {
    const kg = new KnowledgeGraph(seedStore());
    const res = await kg.query("MATCH (a:PERSON)-[:knows]->(b) RETURN b.name AS peer");
    expect(res.rows).toEqual([{ peer: "Bob" }]);
  });
});
