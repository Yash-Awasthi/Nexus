// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  AdrStore,
  renderAdr,
  parseAdrNumber,
  canTransition,
  type CreateAdrInput,
} from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<CreateAdrInput> = {}): CreateAdrInput {
  return {
    title: "Use TypeScript for all packages",
    context: "We need type safety across the monorepo.",
    decision: "All packages will use TypeScript.",
    consequences: "Better IDE support and type safety. Requires compilation step.",
    ...overrides,
  };
}

// ── AdrStore ──────────────────────────────────────────────────────────────────

describe("AdrStore — create", () => {
  let store: AdrStore;
  beforeEach(() => {
    store = new AdrStore();
  });

  it("creates an ADR with auto-incrementing id", () => {
    const a = store.create(makeInput());
    const b = store.create(makeInput({ title: "Another" }));
    expect(a.id).toBe(1);
    expect(b.id).toBe(2);
  });

  it("defaults status to proposed", () => {
    const a = store.create(makeInput());
    expect(a.status).toBe("proposed");
  });

  it("accepts provided status", () => {
    const a = store.create(makeInput({ status: "accepted" }));
    expect(a.status).toBe("accepted");
  });

  it("stores all fields", () => {
    const input = makeInput({
      title: "Use Vitest",
      deciders: ["Yash", "Alice"],
      tags: ["testing", "tooling"],
      alternatives: "Jest, Mocha",
    });
    const a = store.create(input);
    expect(a.deciders).toContain("Yash");
    expect(a.tags).toContain("testing");
    expect(a.alternatives).toBe("Jest, Mocha");
  });

  it("sets createdAt and updatedAt", () => {
    const a = store.create(makeInput());
    expect(a.createdAt).toBeTruthy();
    expect(a.updatedAt).toBeTruthy();
  });
});

describe("AdrStore — get/delete/count", () => {
  let store: AdrStore;
  beforeEach(() => {
    store = new AdrStore();
  });

  it("get retrieves by id", () => {
    const a = store.create(makeInput());
    expect(store.get(a.id)).toEqual(a);
  });

  it("get returns undefined for unknown id", () => {
    expect(store.get(999)).toBeUndefined();
  });

  it("delete removes ADR", () => {
    const a = store.create(makeInput());
    expect(store.delete(a.id)).toBe(true);
    expect(store.get(a.id)).toBeUndefined();
  });

  it("delete returns false for unknown id", () => {
    expect(store.delete(999)).toBe(false);
  });

  it("count reflects stored ADRs", () => {
    store.create(makeInput());
    store.create(makeInput());
    expect(store.count()).toBe(2);
  });
});

describe("AdrStore — update", () => {
  let store: AdrStore;
  beforeEach(() => {
    store = new AdrStore();
  });

  it("updates status", () => {
    const a = store.create(makeInput());
    const updated = store.update(a.id, { status: "accepted" });
    expect(updated?.status).toBe("accepted");
  });

  it("preserves id and createdAt", () => {
    const a = store.create(makeInput());
    const updated = store.update(a.id, { status: "accepted" })!;
    expect(updated.id).toBe(a.id);
    expect(updated.createdAt).toBe(a.createdAt);
  });

  it("updates updatedAt", async () => {
    const a = store.create(makeInput());
    await new Promise((r) => setTimeout(r, 2));
    const updated = store.update(a.id, { status: "accepted" })!;
    expect(updated.updatedAt).not.toBe(a.updatedAt);
  });

  it("returns undefined for unknown id", () => {
    expect(store.update(999, { status: "accepted" })).toBeUndefined();
  });
});

describe("AdrStore — list and search", () => {
  let store: AdrStore;
  beforeEach(() => {
    store = new AdrStore();
    // Use unique content per ADR so search tests are unambiguous
    store.create({
      title: "Use TypeScript",
      context: "We need strong typing in the codebase.",
      decision: "Adopt TypeScript across all packages.",
      consequences: "Compilation step required for all packages.",
      status: "accepted",
      tags: ["lang"],
    });
    store.create({
      title: "Use PostgreSQL",
      context: "We need a relational database for persistence.",
      decision: "Use PostgreSQL for all relational data.",
      consequences: "Managed schema migrations required.",
      status: "proposed",
      tags: ["db"],
    });
    store.create({
      title: "Use Redis",
      context: "We need a fast caching layer.",
      decision: "Use Redis for caching and pub/sub.",
      consequences: "Adds operational complexity to deployments.",
      status: "rejected",
      tags: ["db"],
    });
  });

  it("list returns all sorted by id", () => {
    const list = store.list();
    expect(list).toHaveLength(3);
    expect(list[0]!.id).toBeLessThan(list[1]!.id);
  });

  it("list filters by status", () => {
    expect(store.list({ status: "accepted" })).toHaveLength(1);
    expect(store.list({ status: "proposed" })).toHaveLength(1);
  });

  it("list filters by tag", () => {
    expect(store.list({ tag: "db" })).toHaveLength(2);
    expect(store.list({ tag: "lang" })).toHaveLength(1);
  });

  it("search finds by title", () => {
    expect(store.search("TypeScript")).toHaveLength(1);
  });

  it("search finds by context", () => {
    const r = store.search("relational database");
    expect(r).toHaveLength(1);
  });

  it("search is case-insensitive", () => {
    expect(store.search("typescript")).toHaveLength(1);
  });

  it("search returns empty for no match", () => {
    expect(store.search("nosuchterm")).toHaveLength(0);
  });
});

describe("AdrStore — supersede", () => {
  it("marks old ADR as superseded with reference to new", () => {
    const store = new AdrStore();
    const old = store.create(makeInput({ title: "Old decision", status: "accepted" }));
    const newer = store.create(makeInput({ title: "New decision" }));
    const result = store.supersede(old.id, newer.id)!;
    expect(result.status).toBe("superseded");
    expect(result.supersededBy).toBe(newer.id);
  });
});

// ── renderAdr ─────────────────────────────────────────────────────────────────

describe("renderAdr", () => {
  it("includes title with padded id", () => {
    const store = new AdrStore();
    const adr = store.create(makeInput());
    const md = renderAdr(adr);
    expect(md).toContain("# 0001 Use TypeScript");
  });

  it("includes status and date", () => {
    const store = new AdrStore();
    const adr = store.create(makeInput());
    const md = renderAdr(adr);
    expect(md).toContain("**Status:** proposed");
    expect(md).toContain("**Date:**");
  });

  it("includes Context, Decision, Consequences sections", () => {
    const store = new AdrStore();
    const adr = store.create(makeInput());
    const md = renderAdr(adr);
    expect(md).toContain("## Context");
    expect(md).toContain("## Decision");
    expect(md).toContain("## Consequences");
  });

  it("includes Alternatives section when present", () => {
    const store = new AdrStore();
    const adr = store.create(makeInput({ alternatives: "Jest, Mocha" }));
    const md = renderAdr(adr);
    expect(md).toContain("## Alternatives Considered");
    expect(md).toContain("Jest, Mocha");
  });

  it("includes supersededBy reference", () => {
    const store = new AdrStore();
    const old = store.create(makeInput({ status: "accepted" }));
    const newer = store.create(makeInput());
    const updated = store.supersede(old.id, newer.id)!;
    const md = renderAdr(updated);
    expect(md).toContain("Superseded by");
    expect(md).toContain("ADR-0002");
  });

  it("includes tags", () => {
    const store = new AdrStore();
    const adr = store.create(makeInput({ tags: ["arch", "lang"] }));
    const md = renderAdr(adr);
    expect(md).toContain("`arch`");
    expect(md).toContain("`lang`");
  });

  it("includes deciders", () => {
    const store = new AdrStore();
    const adr = store.create(makeInput({ deciders: ["Alice", "Bob"] }));
    const md = renderAdr(adr);
    expect(md).toContain("Alice, Bob");
  });
});

// ── parseAdrNumber ────────────────────────────────────────────────────────────

describe("parseAdrNumber", () => {
  it("parses number from filename format", () => {
    expect(parseAdrNumber("0012-use-typescript.md")).toBe(12);
  });

  it("parses number from ADR-XXXX format", () => {
    expect(parseAdrNumber("ADR-0042")).toBe(42);
  });

  it("parses single digit", () => {
    expect(parseAdrNumber("1-something")).toBe(1);
  });

  it("returns null for no number", () => {
    expect(parseAdrNumber("no-numbers-here")).toBeNull();
  });
});

// ── canTransition ─────────────────────────────────────────────────────────────

describe("canTransition", () => {
  it("proposed → accepted is allowed", () => {
    expect(canTransition("proposed", "accepted")).toBe(true);
  });

  it("proposed → rejected is allowed", () => {
    expect(canTransition("proposed", "rejected")).toBe(true);
  });

  it("accepted → deprecated is allowed", () => {
    expect(canTransition("accepted", "deprecated")).toBe(true);
  });

  it("rejected → anything is not allowed", () => {
    expect(canTransition("rejected", "accepted")).toBe(false);
    expect(canTransition("rejected", "proposed")).toBe(false);
  });

  it("deprecated → anything is not allowed", () => {
    expect(canTransition("deprecated", "accepted")).toBe(false);
  });

  it("superseded → anything is not allowed", () => {
    expect(canTransition("superseded", "accepted")).toBe(false);
  });
});
