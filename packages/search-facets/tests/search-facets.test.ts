// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  highlight,
  excerptSnippet,
  buildFacets,
  applyFacets,
  rankByRelevance,
  type SearchDoc,
} from "../src/index.js";

// ── Sample data ───────────────────────────────────────────────────────────────

const docs: SearchDoc[] = [
  {
    id: "1",
    content: "TypeScript is a strongly typed language.",
    metadata: { lang: "TypeScript", level: "advanced" },
  },
  {
    id: "2",
    content: "JavaScript is the language of the web.",
    metadata: { lang: "JavaScript", level: "beginner" },
  },
  {
    id: "3",
    content: "Python is great for data science.",
    metadata: { lang: "Python", level: "beginner" },
  },
  {
    id: "4",
    content: "TypeScript extends JavaScript with types.",
    metadata: { lang: ["TypeScript", "JavaScript"], level: "advanced" },
  },
];

// ── highlight ─────────────────────────────────────────────────────────────────

describe("highlight", () => {
  it("wraps a single term in <mark>", () => {
    expect(highlight("hello world", "world")).toBe("hello <mark>world</mark>");
  });

  it("is case-insensitive by default", () => {
    expect(highlight("Hello World", "hello")).toContain("<mark>Hello</mark>");
  });

  it("case-sensitive when specified", () => {
    const r = highlight("Hello hello", "hello", { caseSensitive: true });
    expect(r).toContain("<mark>hello</mark>");
    expect(r).not.toContain("<mark>Hello</mark>");
  });

  it("supports custom tag", () => {
    expect(highlight("foo bar", "foo", { tag: "em" })).toBe("<em>foo</em> bar");
  });

  it("supports className attribute", () => {
    const r = highlight("foo", "foo", { className: "hl" });
    expect(r).toBe('<mark class="hl">foo</mark>');
  });

  it("highlights multiple terms", () => {
    const r = highlight("TypeScript and JavaScript", "TypeScript JavaScript");
    expect(r).toContain("<mark>TypeScript</mark>");
    expect(r).toContain("<mark>JavaScript</mark>");
  });

  it("returns original text when query is empty", () => {
    expect(highlight("hello", "")).toBe("hello");
  });

  it("returns original text when no match", () => {
    expect(highlight("hello", "xyz")).toBe("hello");
  });
});

// ── excerptSnippet ────────────────────────────────────────────────────────────

describe("excerptSnippet", () => {
  const text = "The quick brown fox jumps over the lazy dog near the river bank.";

  it("returns excerpt around first match", () => {
    const s = excerptSnippet(text, "fox", { window: 10 });
    expect(s).toContain("fox");
  });

  it("prepends ellipsis when not at start", () => {
    const long = "a".repeat(200) + "TARGET" + "a".repeat(200);
    const s = excerptSnippet(long, "TARGET", { window: 10 });
    expect(s.startsWith("…")).toBe(true);
  });

  it("appends ellipsis when not at end", () => {
    const long = "TARGET" + "a".repeat(200);
    const s = excerptSnippet(long, "TARGET", { window: 10 });
    expect(s.endsWith("…")).toBe(true);
  });

  it("returns beginning of text when no match", () => {
    const s = excerptSnippet("short text", "nomatch", { window: 50 });
    expect(s).toContain("short text");
  });

  it("custom ellipsis", () => {
    const long = "a".repeat(200) + "X" + "a".repeat(200);
    const s = excerptSnippet(long, "X", { window: 5, ellipsis: "..." });
    expect(s).toContain("...");
  });
});

// ── buildFacets ───────────────────────────────────────────────────────────────

describe("buildFacets", () => {
  it("counts values for a field", () => {
    const facets = buildFacets(docs, ["lang"]);
    const langFacet = facets.find((f) => f.field === "lang");
    expect(langFacet).toBeDefined();
    const ts = langFacet!.buckets.find((b) => b.value === "TypeScript");
    expect(ts!.count).toBe(2); // doc 1 and doc 4
  });

  it("handles multi-value metadata fields (arrays)", () => {
    const facets = buildFacets(docs, ["lang"]);
    const langFacet = facets[0]!;
    const js = langFacet.buckets.find((b) => b.value === "JavaScript");
    expect(js!.count).toBe(2); // doc 2 and doc 4
  });

  it("sorts buckets by count descending", () => {
    const facets = buildFacets(docs, ["level"]);
    const levelFacet = facets[0]!;
    expect(levelFacet.buckets[0]!.count).toBeGreaterThanOrEqual(levelFacet.buckets[1]!.count);
  });

  it("builds multiple facets", () => {
    const facets = buildFacets(docs, ["lang", "level"]);
    expect(facets).toHaveLength(2);
    expect(facets.map((f) => f.field)).toContain("lang");
    expect(facets.map((f) => f.field)).toContain("level");
  });

  it("returns empty buckets for unknown field", () => {
    const facets = buildFacets(docs, ["nonexistent"]);
    expect(facets[0]!.buckets).toHaveLength(0);
  });
});

// ── applyFacets ───────────────────────────────────────────────────────────────

describe("applyFacets", () => {
  it("filters by single facet", () => {
    const r = applyFacets(docs, [{ field: "lang", values: ["Python"] }]);
    expect(r).toHaveLength(1);
    expect(r[0]!.id).toBe("3");
  });

  it("OR within a facet field", () => {
    const r = applyFacets(docs, [{ field: "lang", values: ["Python", "JavaScript"] }]);
    // doc 2 (JS), doc 3 (Python), doc 4 (TS+JS)
    expect(r.length).toBeGreaterThanOrEqual(2);
  });

  it("AND between facets", () => {
    const r = applyFacets(docs, [
      { field: "lang", values: ["TypeScript"] },
      { field: "level", values: ["advanced"] },
    ]);
    // doc 1 and doc 4 both match TypeScript AND advanced
    expect(r.length).toBe(2);
    for (const d of r) {
      expect(d.metadata?.["level"]).toBe("advanced");
    }
  });

  it("returns all docs when no filters", () => {
    expect(applyFacets(docs, [])).toHaveLength(docs.length);
  });

  it("returns empty when no docs match", () => {
    const r = applyFacets(docs, [{ field: "lang", values: ["Ruby"] }]);
    expect(r).toHaveLength(0);
  });
});

// ── rankByRelevance ───────────────────────────────────────────────────────────

describe("rankByRelevance", () => {
  it("ranks by term frequency", () => {
    const testDocs: SearchDoc[] = [
      { id: "a", content: "TypeScript TypeScript TypeScript" },
      { id: "b", content: "TypeScript once" },
    ];
    const r = rankByRelevance(testDocs, "TypeScript");
    expect(r[0]!.doc.id).toBe("a");
  });

  it("scores are non-negative", () => {
    const r = rankByRelevance(docs, "language");
    for (const { score } of r) {
      expect(score).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns all docs regardless of match", () => {
    expect(rankByRelevance(docs, "nomatch")).toHaveLength(docs.length);
  });

  it("returns zero scores for empty query", () => {
    const r = rankByRelevance(docs, "");
    expect(r.every((d) => d.score === 0)).toBe(true);
  });

  it("higher score for more term occurrences", () => {
    const testDocs: SearchDoc[] = [
      { id: "high", content: "cat cat cat cat" },
      { id: "low", content: "cat" },
    ];
    const r = rankByRelevance(testDocs, "cat");
    expect(r[0]!.score).toBeGreaterThan(r[1]!.score);
  });
});
