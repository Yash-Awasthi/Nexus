// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import { ARCHETYPES, SUMMONS, summonArchetypes, type TaskCategory } from "../src/archetypes.js";

describe("ARCHETYPES registry", () => {
  it("has 14 entries", () => {
    expect(Object.keys(ARCHETYPES)).toHaveLength(14);
  });

  it("every archetype has required fields", () => {
    for (const [key, a] of Object.entries(ARCHETYPES)) {
      expect(a.id, `${key}.id`).toBe(key);
      expect(typeof a.name, `${key}.name`).toBe("string");
      expect(a.name.length, `${key}.name non-empty`).toBeGreaterThan(0);
      expect(typeof a.systemPrompt, `${key}.systemPrompt`).toBe("string");
      expect(a.systemPrompt.length, `${key}.systemPrompt non-empty`).toBeGreaterThan(0);
    }
  });

  it("specific archetypes have expected names", () => {
    expect(ARCHETYPES.architect.name).toBe("The Architect");
    expect(ARCHETYPES.contrarian.name).toBe("The Contrarian");
    expect(ARCHETYPES.ethicist.name).toBe("The Ethicist");
    expect(ARCHETYPES.judge.name).toBe("The Judge");
    expect(ARCHETYPES.devils_advocate.name).toBe("Devil's Advocate");
  });
});

describe("SUMMONS mapping", () => {
  const categories: TaskCategory[] = [
    "debate",
    "research",
    "business",
    "technical",
    "personal",
    "creative",
    "ethical",
    "strategy",
    "default",
  ];

  it.each(categories)("category %s maps to 5 archetypes", (cat) => {
    expect(SUMMONS[cat]).toHaveLength(5);
  });

  it("every archetype ID in SUMMONS exists in ARCHETYPES", () => {
    for (const ids of Object.values(SUMMONS)) {
      for (const id of ids) {
        expect(ARCHETYPES[id as keyof typeof ARCHETYPES], `${id} should exist`).toBeDefined();
      }
    }
  });

  it("technical category leads with architect", () => {
    expect(SUMMONS.technical[0]).toBe("architect");
  });

  it("ethical category leads with ethicist", () => {
    expect(SUMMONS.ethical[0]).toBe("ethicist");
  });
});

describe("summonArchetypes()", () => {
  it("returns 5 archetypes by default", () => {
    const result = summonArchetypes("technical");
    expect(result).toHaveLength(5);
  });

  it("respects count parameter", () => {
    expect(summonArchetypes("technical", 3)).toHaveLength(3);
    expect(summonArchetypes("technical", 1)).toHaveLength(1);
  });

  it("returns Archetype objects with id and systemPrompt", () => {
    const archetypes = summonArchetypes("business");
    for (const a of archetypes) {
      expect(typeof a.id).toBe("string");
      expect(typeof a.systemPrompt).toBe("string");
    }
  });

  it("falls back to default for unknown category", () => {
    const defaultArchetypes = summonArchetypes("default");
    const unknownArchetypes = summonArchetypes("unknown_category_xyz");
    expect(unknownArchetypes.map((a) => a.id)).toEqual(defaultArchetypes.map((a) => a.id));
  });

  it("returns correct archetypes for debate category", () => {
    const archetypes = summonArchetypes("debate");
    expect(archetypes[0].id).toBe("contrarian");
    expect(archetypes[1].id).toBe("strategist");
  });

  it("handles count=0 returning empty array", () => {
    expect(summonArchetypes("research", 0)).toHaveLength(0);
  });
});
