// SPDX-License-Identifier: Apache-2.0
// graphrag LOCAL search (entity-anchored) parity, pass 54: GraphRAGQueryEngine
// is the community map-reduce GLOBAL variant; these tests pin the local-search
// engine — lexical query→entity anchoring, hop expansion, graphrag's two-tier
// relationship filter (in-network first, mutual-link priority outside), token-
// budgeted tables, report attachment, single-pass answer.
import { describe, it, expect } from "vitest";
import { LocalSearchEngine } from "../src/index.js";
import type { QueryRouter } from "../src/index.js";
import type { IndexedEntity, IndexedRelation } from "../src/index-graphrag.js";

function stubRouter(contents: string[] = ["synthesized answer"]): {
  router: QueryRouter;
  calls: number;
} {
  let calls = 0;
  return {
    router: {
      async complete(_p: { model: string; messages: Array<{ role: string; content: string }> }) {
        calls++;
        return { content: contents[Math.min(calls - 1, contents.length - 1)]! };
      },
    },
    get calls() {
      return calls;
    },
  };
}

const ent = (name: string, descriptions: string[], mentions = 1): IndexedEntity => ({
  name,
  type: "entity",
  descriptions,
  mentions,
});
const rel = (source: string, target: string, type = "rel", mentions = 1): IndexedRelation => ({
  source,
  target,
  type,
  descriptions: [`${source} ${type} ${target}`],
  mentions,
});

describe("LocalSearchEngine query→entity anchoring", () => {
  it("anchors on token-overlapping entity names and answers in one pass", async () => {
    const stub = stubRouter(["acme builds rockets."]);
    const engine = new LocalSearchEngine(
      [ent("acme aerospace", ["builds rockets"], 5), ent("green energy", ["solar panels"], 2)],
      [rel("acme aerospace", "rocket engine")],
      stub.router,
      "gpt-test",
    );
    const r = await engine.search("acme aerospace");
    expect(stub.calls).toBe(1); // single-pass, no map-reduce
    expect(r.answer).toBe("acme builds rockets.");
    expect(r.entitiesUsed[0]).toBe("acme aerospace");
    expect(r.entitiesUsed).not.toContain("green energy");
    expect(r.context).toContain("-----Entities-----");
    expect(r.context).toContain("-----Relationships-----");
    expect(r.context).toContain("acme aerospace|entity|builds rockets|1");
  });

  it("returns a no-match result without calling the model", async () => {
    const stub = stubRouter();
    const engine = new LocalSearchEngine(
      [ent("acme aerospace", ["builds rockets"])],
      [],
      stub.router,
      "gpt-test",
    );
    const r = await engine.search("quantum computing");
    expect(stub.calls).toBe(0);
    expect(r.entitiesUsed).toEqual([]);
    expect(r.answer).toMatch(/No entities/);
  });
});

describe("LocalSearchEngine neighbor expansion", () => {
  const GRAPH = {
    entities: [
      ent("acme aerospace", ["builds rockets"], 3),
      ent("rocket engine", ["combustion chamber"], 2),
      ent("titanium alloy", ["lightweight metal"], 1),
    ],
    relations: [
      rel("acme aerospace", "rocket engine", "produces"),
      rel("rocket engine", "titanium alloy", "uses"),
    ],
  };

  it("levels=0 keeps only the anchored entity", async () => {
    const stub = stubRouter();
    const engine = new LocalSearchEngine(GRAPH.entities, GRAPH.relations, stub.router, "gpt-test");
    const r = await engine.search("acme aerospace", { levels: 0 });
    expect(r.entitiesUsed).toEqual(["acme aerospace"]);
  });

  it("levels=1 pulls one-hop neighbors into the entity table", async () => {
    const stub = stubRouter();
    const engine = new LocalSearchEngine(GRAPH.entities, GRAPH.relations, stub.router, "gpt-test");
    const r = await engine.search("acme aerospace", { levels: 1 });
    expect(r.entitiesUsed).toEqual(expect.arrayContaining(["acme aerospace", "rocket engine"]));
    expect(r.entitiesUsed).not.toContain("titanium alloy"); // two hops away
  });

  it("levels=2 reaches the two-hop entity", async () => {
    const stub = stubRouter();
    const engine = new LocalSearchEngine(GRAPH.entities, GRAPH.relations, stub.router, "gpt-test");
    const r = await engine.search("acme aerospace", { levels: 2 });
    expect(r.entitiesUsed).toContain("titanium alloy");
  });
});

describe("LocalSearchEngine relationship filtering (graphrag two-tier)", () => {
  it("lists in-network relationships ahead of out-of-network ones", async () => {
    // query matches acme + rocket engine → their edge is in-network and must
    // surface before the acme→titanium out-of-network edge
    const stub = stubRouter();
    const engine = new LocalSearchEngine(
      [
        ent("acme aerospace", ["builds rockets"], 5),
        ent("rocket engine", ["engine"], 4),
        ent("titanium alloy", ["metal"], 1),
      ],
      [
        rel("acme aerospace", "rocket engine", "produces"),
        rel("acme aerospace", "titanium alloy", "contracts"),
      ],
      stub.router,
      "gpt-test",
    );
    const r = await engine.search("acme aerospace rocket");
    const iIn = r.relationshipsUsed.findIndex(
      (x) => x.source === "acme aerospace" && x.target === "rocket engine",
    );
    const iOut = r.relationshipsUsed.findIndex(
      (x) => x.source === "acme aerospace" && x.target === "titanium alloy",
    );
    expect(iIn).toBe(0);
    expect(iIn).toBeLessThan(iOut);
  });

  it("orders out-of-network edges by mutual-link count (shared selected entities)", async () => {
    const stub = stubRouter();
    const engine = new LocalSearchEngine(
      [
        ent("acme aerospace", ["a"], 5),
        ent("partner corp", ["p"], 4),
        ent("shared supplier", ["s"], 1),
        ent("private vendor", ["v"], 1),
      ],
      [
        rel("acme aerospace", "shared supplier"),
        rel("partner corp", "shared supplier"), // 2 selected link to supplier
        rel("acme aerospace", "private vendor"), // 1 selected links to vendor
      ],
      stub.router,
      "gpt-test",
    );
    const r = await engine.search("acme aerospace partner");
    const iShared = r.relationshipsUsed.findIndex((x) => x.target === "shared supplier");
    const iPrivate = r.relationshipsUsed.findIndex((x) => x.target === "private vendor");
    // both are out-of-network (third parties); supplier ranks above vendor
    expect(iShared).toBeGreaterThanOrEqual(0);
    expect(iPrivate).toBeGreaterThan(iShared);
  });

  it("caps out-of-network relationships at topK × selected entities", async () => {
    const stub = stubRouter();
    const many: IndexedRelation[] = [];
    for (let i = 0; i < 25; i++) many.push(rel("acme aerospace", `vendor ${i}`));
    const engine = new LocalSearchEngine(
      [
        ent("acme aerospace", ["a"], 5),
        ...Array.from({ length: 25 }, (_, i) => ent(`vendor ${i}`, ["v"])),
      ],
      many,
      stub.router,
      "gpt-test",
    );
    const r = await engine.search("acme aerospace", { topKRelationships: 2 });
    // budget = 2 × 1 selected = 2 out-of-network relationships
    expect(r.relationshipsUsed.length).toBeLessThanOrEqual(2);
  });
});

describe("LocalSearchEngine context budget + report attachment", () => {
  const report = {
    id: "c1",
    communityId: "comm-1",
    level: 0,
    title: "Acme cluster",
    summary: "Acme builds rockets and contracts suppliers.",
    fullContent: "full",
    rank: 1,
    rating: 0.9,
    findings: ["finding"],
    entities: ["acme aerospace", "rocket engine"],
    createdAt: 1,
  };

  it("attaches community reports whose entities intersect the selected set", async () => {
    const stub = stubRouter();
    const engine = new LocalSearchEngine(
      [ent("acme aerospace", ["builds rockets"], 5), ent("green energy", ["solar"], 1)],
      [rel("acme aerospace", "rocket engine")],
      stub.router,
      "gpt-test",
      [report],
    );
    const r = await engine.search("acme aerospace");
    expect(r.reportsUsed.map((x) => x.id)).toEqual(["c1"]);
    expect(r.context).toContain("-----Reports-----");
    expect(r.context).toContain("Acme builds rockets");
  });

  it("skips report attachment when disabled", async () => {
    const stub = stubRouter();
    const engine = new LocalSearchEngine(
      [ent("acme aerospace", ["builds rockets"], 5)],
      [],
      stub.router,
      "gpt-test",
      [report],
    );
    const r = await engine.search("acme aerospace", { includeReports: false });
    expect(r.reportsUsed).toEqual([]);
    expect(r.context).not.toContain("-----Reports-----");
  });

  it("truncates entity rows to the token budget", async () => {
    const stub = stubRouter();
    const entities = [ent("acme aerospace", ["builds rockets"], 5)];
    for (let i = 0; i < 40; i++)
      entities.push(ent(`acme vendor ${i}`, ["supplier with a rather long description"], 1));
    const engine = new LocalSearchEngine(entities, [], stub.router, "gpt-test");
    const r = await engine.search("acme", { maxContextTokens: 300, levels: 1 });
    // tiny budget → only a prefix of the expanded entities fits the table
    expect(r.entitiesUsed.length).toBeGreaterThan(0);
    expect(r.entitiesUsed.length).toBeLessThan(entities.length);
  });
});
