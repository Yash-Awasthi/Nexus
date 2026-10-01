// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  InMemoryKGStore,
  computeEntityRanks,
  graphSearch,
  makeEdgeId,
  makeNodeId,
  summarizeCommunities,
  type KGNode,
} from "../src/index.js";

const NOW = 1_700_000_000;

async function seed() {
  const store = new InMemoryKGStore();
  const add = (name: string, type: KGNode["type"] = "CONCEPT") =>
    store.upsertNode({
      id: makeNodeId(name, type),
      name,
      type,
      confidence: 0.9,
      properties: {},
      sources: ["doc"],
      createdAt: NOW,
      updatedAt: NOW,
    });
  const link = async (a: KGNode, p: string, b: KGNode) =>
    store.upsertEdge({
      id: makeEdgeId(a.id, p, b.id),
      subjectId: a.id,
      predicate: p,
      objectId: b.id,
      confidence: 0.8,
      sources: ["doc"],
      createdAt: NOW,
      updatedAt: NOW,
    });
  // Two dense clusters joined by one bridge, plus an isolated node.
  const [pg, redis, kafka] = [await add("Postgres"), await add("Redis"), await add("Kafka")];
  const [ada, bob, cy] = [
    await add("Ada", "PERSON"),
    await add("Bob", "PERSON"),
    await add("Cy", "PERSON"),
  ];
  await link(pg, "replicates_to", redis);
  await link(redis, "feeds", kafka);
  await link(kafka, "archives_to", pg);
  await link(pg, "backs_up", kafka);
  await link(ada, "mentors", bob);
  await link(bob, "pairs_with", cy);
  await link(cy, "reviews", ada);
  await link(ada, "manages", cy);
  await link(kafka, "owned_by", ada);
  await add("Lonely");
  return { store, pg, ada };
}

describe("summarizeCommunities", () => {
  it("finds each dense cluster, ranks its entities and drops singletons", async () => {
    const { store } = await seed();
    const communities = await summarizeCommunities(store);
    expect(communities).toHaveLength(2);
    const names = communities.map((c) => c.entities.map((e) => e.name).sort());
    expect(names).toContainEqual(["Kafka", "Postgres", "Redis"]);
    expect(names).toContainEqual(["Ada", "Bob", "Cy"]);
    for (const c of communities) {
      const ranks = c.entities.map((e) => e.rank);
      expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
      expect(c.title).toContain(c.entities[0]!.name);
      expect(c.findings.length).toBeGreaterThan(0);
    }
  });
});

describe("computeEntityRanks", () => {
  it("counts every edge touching a node", async () => {
    const { store, pg, ada } = await seed();
    const ranks = await computeEntityRanks(store);
    expect(ranks.get(pg.id)).toBe(3);
    expect(ranks.get(ada.id)).toBe(4);
  });
});

describe("graphSearch COMMUNITY", () => {
  it("returns the nodes of the community that matched, not arbitrary ones", async () => {
    const { store } = await seed();
    const communities = await summarizeCommunities(store);
    const res = await graphSearch(store, "redis", "COMMUNITY", { communities });
    expect(res.communities).toHaveLength(1);
    expect(res.nodes.map((n) => n.name).sort()).toEqual(["Kafka", "Postgres", "Redis"]);
    expect(res.edges.length).toBe(4);
  });
});
