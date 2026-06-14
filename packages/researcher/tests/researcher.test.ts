// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  WebResearcher,
  CorpusResearcher,
  ResearchPlan,
  ResearchSession,
  type SearchResult,
  type WebSearchFn,
} from "../src/index.js";

// ── WebResearcher ─────────────────────────────────────────────────────────────

const mockSearch: WebSearchFn = async (query) => [
  { url: "https://a.com", title: "A Result", snippet: `snippet for ${query}`, score: 0.9, source: "web" },
  { url: "https://b.com", title: "B Result", snippet: `another ${query} result`, score: 0.7, source: "web" },
];

describe("WebResearcher", () => {
  it("returns a finding with results and synthesis", async () => {
    const r = new WebResearcher({ searchFn: mockSearch });
    const finding = await r.research("TypeScript");
    expect(finding.query).toBe("TypeScript");
    expect(finding.results).toHaveLength(2);
    expect(finding.synthesis).toBeTruthy();
    expect(finding.citations).toContain("https://a.com");
    expect(finding.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("respects maxResults limit", async () => {
    const r = new WebResearcher({ searchFn: mockSearch, maxResults: 1 });
    const finding = await r.research("q");
    expect(finding.results).toHaveLength(1);
  });

  it("uses custom synthesize function", async () => {
    const r = new WebResearcher({
      searchFn: mockSearch,
      synthesizeFn: async (_q, results) => `Custom: ${results.length} results`,
    });
    const finding = await r.research("q");
    expect(finding.synthesis).toBe("Custom: 2 results");
  });
});

// ── CorpusResearcher ──────────────────────────────────────────────────────────

describe("CorpusResearcher", () => {
  let corpus: CorpusResearcher;

  beforeEach(() => {
    corpus = new CorpusResearcher();
    corpus
      .addDocument({ id: "d1", title: "TypeScript Handbook", content: "TypeScript is a typed superset of JavaScript with strong type system features and interfaces" })
      .addDocument({ id: "d2", title: "Python Tutorial", content: "Python is a dynamic language used for data science machine learning and web development" })
      .addDocument({ id: "d3", title: "TypeScript Performance", content: "Optimise TypeScript compilation performance with project references and incremental builds" });
  });

  it("searches and returns ranked results", () => {
    const results = corpus.search("TypeScript");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.source).toBe("corpus");
    // TypeScript docs should rank first
    for (const r of results) {
      expect(r.title.toLowerCase() + r.snippet.toLowerCase()).toContain("typescript");
    }
  });

  it("returns empty for no matches", () => {
    expect(corpus.search("quantum computing blockchain")).toHaveLength(0);
  });

  it("respects limit", () => {
    expect(corpus.search("typescript", 1)).toHaveLength(1);
  });

  it("generates corpus:// URL when doc has no url", () => {
    const results = corpus.search("TypeScript");
    const noUrl = results.find((r) => r.url.startsWith("corpus://"));
    expect(noUrl).toBeDefined();
  });

  it("uses doc url when provided", () => {
    corpus.addDocument({ id: "d4", title: "TS docs", content: "TypeScript official documentation guide", url: "https://typescriptlang.org" });
    const results = corpus.search("TypeScript documentation");
    const withUrl = results.find((r) => r.url === "https://typescriptlang.org");
    expect(withUrl).toBeDefined();
  });

  it("research returns a full finding", async () => {
    const finding = await corpus.research("TypeScript");
    expect(finding.query).toBe("TypeScript");
    expect(finding.results.length).toBeGreaterThan(0);
    expect(finding.synthesis).toBeTruthy();
    expect(finding.citations.length).toBeGreaterThan(0);
  });

  it("docCount returns correct count", () => {
    expect(corpus.docCount()).toBe(3);
    corpus.addDocuments([
      { id: "d5", title: "Go", content: "Go is fast" },
      { id: "d6", title: "Rust", content: "Rust is safe" },
    ]);
    expect(corpus.docCount()).toBe(5);
  });

  it("addDocuments supports chaining", () => {
    const c = new CorpusResearcher();
    expect(c.addDocument({ id: "x", title: "t", content: "c" })).toBe(c);
  });
});

// ── ResearchPlan ──────────────────────────────────────────────────────────────

describe("ResearchPlan", () => {
  it("adds steps and tracks completion", () => {
    const plan = new ResearchPlan();
    plan.addStep("What is TypeScript?", "Need basic definition");
    plan.addStep("TypeScript vs JavaScript", "Compare features");
    expect(plan.getSteps()).toHaveLength(2);
    expect(plan.isComplete()).toBe(false);
  });

  it("isComplete once all steps have findings", async () => {
    const plan = new ResearchPlan();
    plan.addStep("q1", "r1");
    const finding = await new WebResearcher({ searchFn: mockSearch }).research("q1");
    plan.setFinding(0, finding);
    expect(plan.isComplete()).toBe(true);
  });

  it("summarize includes all step syntheses", async () => {
    const plan = new ResearchPlan();
    plan.addStep("sub query one", "rationale");
    const finding = await new WebResearcher({ searchFn: mockSearch }).research("sub query one");
    plan.setFinding(0, finding);
    const summary = plan.summarize();
    expect(summary).toContain("Step 1");
    expect(summary).toContain("sub query one");
  });

  it("supports chaining addStep", () => {
    const plan = new ResearchPlan();
    expect(plan.addStep("q", "r")).toBe(plan);
  });

  it("isComplete false for empty plan", () => {
    expect(new ResearchPlan().isComplete()).toBe(false);
  });
});

// ── ResearchSession ───────────────────────────────────────────────────────────

describe("ResearchSession", () => {
  it("combines web and corpus results", async () => {
    const web = new WebResearcher({ searchFn: mockSearch });
    const corp = new CorpusResearcher();
    corp.addDocument({ id: "d1", title: "TypeScript Guide", content: "TypeScript typed javascript superset features" });

    const session = new ResearchSession({ webResearcher: web, corpusResearcher: corp });
    const finding = await session.research("TypeScript");

    expect(finding.webFindings).not.toBeNull();
    expect(finding.corpusFindings).not.toBeNull();
    expect(finding.allResults.length).toBeGreaterThan(0);
    expect(finding.query).toBe("TypeScript");
  });

  it("deduplicates by URL", async () => {
    const dupSearch: WebSearchFn = async () => [
      { url: "https://same.com", title: "A", snippet: "s", score: 0.9, source: "web" },
      { url: "https://same.com", title: "B", snippet: "s", score: 0.8, source: "web" },
    ];
    const session = new ResearchSession({
      webResearcher: new WebResearcher({ searchFn: dupSearch }),
      dedupByUrl: true,
    });
    const finding = await session.research("q");
    const urls = finding.allResults.map((r) => r.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("works with only web researcher", async () => {
    const session = new ResearchSession({ webResearcher: new WebResearcher({ searchFn: mockSearch }) });
    const finding = await session.research("q");
    expect(finding.corpusFindings).toBeNull();
    expect(finding.webFindings).not.toBeNull();
  });

  it("tracks history", async () => {
    const session = new ResearchSession({ webResearcher: new WebResearcher({ searchFn: mockSearch }) });
    await session.research("q1");
    await session.research("q2");
    expect(session.getHistory()).toHaveLength(2);
  });

  it("clearHistory empties history", async () => {
    const session = new ResearchSession({ webResearcher: new WebResearcher({ searchFn: mockSearch }) });
    await session.research("q");
    session.clearHistory();
    expect(session.getHistory()).toHaveLength(0);
  });

  it("sorts results by score descending", async () => {
    const lowHighSearch: WebSearchFn = async () => [
      { url: "https://low.com", title: "Low", snippet: "s", score: 0.2, source: "web" },
      { url: "https://high.com", title: "High", snippet: "s", score: 0.9, source: "web" },
    ];
    const session = new ResearchSession({ webResearcher: new WebResearcher({ searchFn: lowHighSearch }) });
    const finding = await session.research("q");
    expect(finding.allResults[0]!.score).toBeGreaterThanOrEqual(finding.allResults[1]!.score);
  });
});
