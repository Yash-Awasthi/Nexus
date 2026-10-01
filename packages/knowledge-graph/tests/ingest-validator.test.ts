// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  extractGraphFromChunks,
  InMemoryKGStore,
  KnowledgeGraph,
  strictTypeValidator,
  type Entity,
  type Relationship,
} from "../src/index.js";

const entities: Entity[] = [
  { text: "Ada", type: "PERSON", confidence: 0.9 },
  { text: "Acme", type: "ORG", confidence: 0.9 },
  { text: "Paris", type: "LOCATION", confidence: 0.9 },
];
const relationships: Relationship[] = [
  { subject: "Ada", predicate: "works at", object: "Acme", confidence: 0.9 },
  { subject: "Ada", predicate: "lives in", object: "Paris", confidence: 0.9 },
];

const graph = () =>
  new KnowledgeGraph(
    new InMemoryKGStore(),
    async () => entities,
    async () => relationships,
  );

describe("ingest with an ontology validator", () => {
  it("keeps only the entity types the validator allows, and the edges between them", async () => {
    const kg = graph();
    const res = await kg.ingest("Ada works at Acme in Paris.", {
      validator: strictTypeValidator(["PERSON", "ORG"]),
    });
    expect(res.entities.map((e) => e.text)).toEqual(["Ada", "Acme"]);
    expect(res.nodesAdded).toBe(2);
    expect(res.edgesAdded).toBe(1);
  });

  it("keeps everything without a validator", async () => {
    const res = await graph().ingest("Ada works at Acme in Paris.");
    expect(res.nodesAdded).toBe(3);
    expect(res.edgesAdded).toBe(2);
  });
});

describe("extractGraphFromChunks", () => {
  it("labels every chunk's nodes with the batch source and applies the validator", async () => {
    const kg = graph();
    const res = await extractGraphFromChunks(
      kg,
      [
        { id: "c1", text: "one" },
        { id: "c2", text: "two" },
      ],
      { source: "kb-1", validator: strictTypeValidator(["ORG"]) },
    );
    expect(res.chunksProcessed).toBe(2);
    expect(res.totalNodesAdded).toBe(1);
    const nodes = await kg.queryNodes({});
    expect(nodes.map((n) => n.name)).toEqual(["Acme"]);
    expect(nodes[0]!.sources).toEqual(["kb-1"]);
  });
});
