// SPDX-License-Identifier: Apache-2.0
// LightRAG merge graph-ops parity (pass 55): buildGraphRagIndex dedupes by
// normalized name at build time, but merging two DISTINCT nodes (the operation
// an LLM/caller applies once it decides "J. Doe" == "Jane Doe") is deterministic
// graph surgery — rewire relations off the sources, collapse redirected
// duplicates (mentions max, descriptions join), drop self-loops. Inputs are
// not mutated.
import { describe, it, expect } from "vitest";
import { mergeGraphEntities } from "../src/index.js";
import type { IndexedEntity, IndexedRelation } from "../src/index-graphrag.js";

const ent = (name: string, descriptions: string[], mentions = 1, type = "person"): IndexedEntity => ({
  name,
  type,
  descriptions,
  mentions,
});
const rel = (source: string, target: string, type = "works_with", mentions = 1): IndexedRelation => ({
  source,
  target,
  type,
  descriptions: [`${source} ${type} ${target}`],
  mentions,
});

describe("mergeGraphEntities graph surgery", () => {
  it("merges source descriptions and mentions onto the target, dropping sources", () => {
    const { entities } = mergeGraphEntities(
      [
        ent("J. Doe", ["leads the rocket team"], 3),
        ent("Jane Doe", ["co-authored the turbine paper"], 2),
        ent("Bob", ["unrelated"], 1),
      ],
      [],
      ["J. Doe"],
      "Jane Doe",
    );
    expect(entities).toHaveLength(2);
    const jane = entities.find((e) => e.name === "Jane Doe")!;
    expect(jane.descriptions).toEqual(
      expect.arrayContaining(["leads the rocket team", "co-authored the turbine paper"]),
    );
    expect(jane.mentions).toBe(5);
    expect(entities.some((e) => e.name === "J. Doe")).toBe(false);
  });

  it("rewires relations touching either source onto the target", () => {
    const { relations } = mergeGraphEntities(
      [ent("J. Doe", []), ent("Jane Doe", []), ent("Acme", []), ent("Partner", [])],
      [
        rel("J. Doe", "Acme", "works_at"),
        rel("Partner", "Jane Doe", "funds"),
        rel("J. Doe", "Partner", "collaborates"), // untouched shape
      ],
      ["J. Doe"],
      "Jane Doe",
    );
    expect(relations).toHaveLength(3);
    expect(relations.some((r) => r.source === "J. Doe" || r.target === "J. Doe")).toBe(false);
    expect(relations.some((r) => r.source === "Jane Doe" && r.target === "Acme")).toBe(true);
    expect(relations.some((r) => r.source === "Partner" && r.target === "Jane Doe")).toBe(true);
  });

  it("collapses redirected duplicates onto an existing same-typed edge (mentions max)", () => {
    // A→X and B→X both rewire to Jane→X; the existing Jane→X edge absorbs it
    const { relations } = mergeGraphEntities(
      [ent("Jane Doe", []), ent("J. Doe", []), ent("X Corp", [])],
      [
        rel("J. Doe", "X Corp", "works_at", 4),
        rel("Jane Doe", "X Corp", "works_at", 2),
      ],
      ["J. Doe"],
      "Jane Doe",
    );
    expect(relations).toHaveLength(1);
    expect(relations[0]).toMatchObject({ source: "Jane Doe", target: "X Corp", type: "works_at" });
    expect(relations[0]!.mentions).toBe(4); // max of 4 and 2 (LightRAG weight=max)
    expect(relations[0]!.descriptions).toHaveLength(2); // joined unique
  });

  it("drops self-loops created when both ends merge into the target", () => {
    const { relations } = mergeGraphEntities(
      [ent("A Corp", []), ent("B Corp", []), ent("C Corp", [])],
      [rel("A Corp", "B Corp", "partner_of"), rel("C Corp", "A Corp", "supplies")],
      ["A Corp", "B Corp"],
      "AB Corp",
    );
    expect(relations).toHaveLength(1);
    expect(relations[0]!.source).toBe("C Corp");
    expect(relations[0]!.target).toBe("AB Corp");
  });

  it("merging a source that already links to the existing target drops the self-loop", () => {
    const { relations } = mergeGraphEntities(
      [ent("Jane Doe", []), ent("J. Doe", [])],
      [rel("J. Doe", "Jane Doe", "same_as")],
      ["J. Doe"],
      "Jane Doe",
    );
    expect(relations).toEqual([]);
  });

  it("supports a brand-new target name (rename merge) and appends it", () => {
    const { entities, relations } = mergeGraphEntities(
      [ent("A Corp", ["makes widgets"], 1), ent("B Corp", ["makes gadgets"], 2)],
      [rel("A Corp", "C Corp")],
      ["A Corp", "B Corp"],
      "AB Industries",
    );
    const merged = entities.find((e) => e.name === "AB Industries")!;
    expect(merged.descriptions).toEqual(expect.arrayContaining(["makes widgets", "makes gadgets"]));
    expect(merged.mentions).toBe(3);
    expect(entities.some((e) => e.name === "A Corp" || e.name === "B Corp")).toBe(false);
    expect(relations[0]!.source).toBe("AB Industries");
  });

  it("keep_first description strategy takes the first non-empty source block", () => {
    const { entities } = mergeGraphEntities(
      [ent("first", [], 1), ent("second", ["second desc"], 1)],
      [],
      ["first", "second"],
      "merged",
      { descriptionStrategy: "keep_first" },
    );
    expect(entities.find((e) => e.name === "merged")!.descriptions).toEqual([]);
    const keepFirst = mergeGraphEntities(
      [ent("first", ["first desc"], 1), ent("second", ["second desc"], 1)],
      [],
      ["first", "second"],
      "merged",
      { descriptionStrategy: "keep_first" },
    );
    expect(keepFirst.entities.find((e) => e.name === "merged")!.descriptions).toEqual(["first desc"]);
  });

  it("max mentions strategy takes the max rather than summing", () => {
    const { entities } = mergeGraphEntities(
      [ent("a", [], 3), ent("b", [], 7)],
      [],
      ["a", "b"],
      "ab",
      { mentionsStrategy: "max" },
    );
    expect(entities.find((e) => e.name === "ab")!.mentions).toBe(7);
  });

  it("errors on missing or self source entities", () => {
    const base = [ent("a", [])];
    expect(() => mergeGraphEntities(base, [], ["ghost"], "a")).toThrow(/Source entity 'ghost' does not exist/);
    expect(() => mergeGraphEntities(base, [], ["a"], "a")).toThrow(/cannot be merged into itself/);
  });

  it("does not mutate the inputs", () => {
    const entities = [ent("A Corp", ["d1"], 1), ent("B Corp", ["d2"], 2)];
    const relations = [rel("A Corp", "B Corp"), rel("A Corp", "C Corp", "s1", 1)];
    const snapshotE = JSON.stringify(entities);
    const snapshotR = JSON.stringify(relations);
    mergeGraphEntities(entities, relations, ["A Corp"], "A+B Corp");
    expect(JSON.stringify(entities)).toBe(snapshotE);
    expect(JSON.stringify(relations)).toBe(snapshotR);
  });
});
