// SPDX-License-Identifier: Apache-2.0
/**
 * researcher — Web and document-corpus research agents.
 *
 * Provides:
 *   • SearchResult      — a single search hit
 *   • WebResearcher     — query → fetch → synthesise pipeline (injectable fetch)
 *   • CorpusResearcher  — query against an in-memory doc corpus
 *   • ResearchPlan      — multi-step research plan with sub-queries
 *   • ResearchSession   — combines web + corpus with dedup + citation tracking
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
  score: number;
  source: "web" | "corpus";
}

export interface ResearchFinding {
  query: string;
  results: SearchResult[];
  synthesis: string;
  citations: string[];
  durationMs: number;
}

export interface CorpusDocument {
  id: string;
  title: string;
  content: string;
  url?: string;
  metadata?: Record<string, unknown>;
}

// ── Injectable interfaces ─────────────────────────────────────────────────────

export type WebSearchFn = (query: string) => Promise<SearchResult[]>;
export type SynthesizeFn = (query: string, results: SearchResult[]) => Promise<string>;

const DEFAULT_SEARCH: WebSearchFn = async (query) => [
  {
    url: `https://example.com/search?q=${encodeURIComponent(query)}`,
    title: `Results for: ${query}`,
    snippet: `Relevant content about ${query} from the web.`,
    score: 0.8,
    source: "web",
  },
];

const DEFAULT_SYNTHESIZE: SynthesizeFn = async (query, results) =>
  `Based on ${results.length} source(s) about "${query}": ${results.map((r) => r.snippet).join(" ")}`;

// ── WebResearcher ─────────────────────────────────────────────────────────────

export interface WebResearcherOptions {
  searchFn?: WebSearchFn;
  synthesizeFn?: SynthesizeFn;
  maxResults?: number;
}

export class WebResearcher {
  private searchFn: WebSearchFn;
  private synthesizeFn: SynthesizeFn;
  private maxResults: number;

  constructor(opts: WebResearcherOptions = {}) {
    this.searchFn = opts.searchFn ?? DEFAULT_SEARCH;
    this.synthesizeFn = opts.synthesizeFn ?? DEFAULT_SYNTHESIZE;
    this.maxResults = opts.maxResults ?? 10;
  }

  async research(query: string): Promise<ResearchFinding> {
    const t0 = Date.now();
    const all = await this.searchFn(query);
    const results = all.slice(0, this.maxResults);
    const synthesis = await this.synthesizeFn(query, results);
    const citations = results.map((r) => r.url);
    return { query, results, synthesis, citations, durationMs: Date.now() - t0 };
  }
}

// ── CorpusResearcher ──────────────────────────────────────────────────────────

function tokenizeSimple(text: string): Set<string> {
  const stop = new Set(["the", "a", "an", "is", "and", "or", "in", "of", "to", "for", "with", "on", "at", "be", "it"]);
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !stop.has(w)),
  );
}

export class CorpusResearcher {
  private docs: CorpusDocument[] = [];
  private synthesizeFn: SynthesizeFn;

  constructor(opts: { synthesizeFn?: SynthesizeFn } = {}) {
    this.synthesizeFn = opts.synthesizeFn ?? DEFAULT_SYNTHESIZE;
  }

  addDocument(doc: CorpusDocument): this {
    this.docs.push(doc);
    return this;
  }

  addDocuments(docs: CorpusDocument[]): this {
    this.docs.push(...docs);
    return this;
  }

  search(query: string, limit = 10): SearchResult[] {
    const qKw = tokenizeSimple(query);
    const scored: Array<{ doc: CorpusDocument; score: number }> = [];

    for (const doc of this.docs) {
      const dKw = tokenizeSimple(`${doc.title} ${doc.content}`);
      let overlap = 0;
      for (const kw of qKw) if (dKw.has(kw)) overlap++;
      if (overlap > 0) {
        const score = overlap / Math.sqrt(qKw.size * dKw.size);
        scored.push({ doc, score });
      }
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ doc, score }) => ({
        url: doc.url ?? `corpus://${doc.id}`,
        title: doc.title,
        snippet: doc.content.slice(0, 200),
        score,
        source: "corpus" as const,
      }));
  }

  async research(query: string): Promise<ResearchFinding> {
    const t0 = Date.now();
    const results = this.search(query);
    const synthesis = await this.synthesizeFn(query, results);
    const citations = results.map((r) => r.url);
    return { query, results, synthesis, citations, durationMs: Date.now() - t0 };
  }

  docCount(): number { return this.docs.length; }
}

// ── ResearchPlan ──────────────────────────────────────────────────────────────

export interface ResearchStep {
  subQuery: string;
  rationale: string;
  finding?: ResearchFinding;
}

export class ResearchPlan {
  private steps: ResearchStep[] = [];

  addStep(subQuery: string, rationale: string): this {
    this.steps.push({ subQuery, rationale });
    return this;
  }

  getSteps(): ResearchStep[] { return [...this.steps]; }

  setFinding(index: number, finding: ResearchFinding): void {
    const step = this.steps[index];
    if (step) step.finding = finding;
  }

  isComplete(): boolean {
    return this.steps.length > 0 && this.steps.every((s) => s.finding !== undefined);
  }

  summarize(): string {
    return this.steps
      .filter((s) => s.finding)
      .map((s, i) => `Step ${i + 1} [${s.subQuery}]: ${s.finding!.synthesis}`)
      .join("\n\n");
  }
}

// ── ResearchSession ───────────────────────────────────────────────────────────

export interface ResearchSessionOptions {
  webResearcher?: WebResearcher;
  corpusResearcher?: CorpusResearcher;
  dedupByUrl?: boolean;
}

export interface CombinedFinding {
  query: string;
  webFindings: ResearchFinding | null;
  corpusFindings: ResearchFinding | null;
  allResults: SearchResult[];
  citations: string[];
  durationMs: number;
}

export class ResearchSession {
  private web: WebResearcher | null;
  private corpus: CorpusResearcher | null;
  private dedupByUrl: boolean;
  private history: CombinedFinding[] = [];

  constructor(opts: ResearchSessionOptions = {}) {
    this.web = opts.webResearcher ?? null;
    this.corpus = opts.corpusResearcher ?? null;
    this.dedupByUrl = opts.dedupByUrl ?? true;
  }

  async research(query: string): Promise<CombinedFinding> {
    const t0 = Date.now();
    const [webFindings, corpusFindings] = await Promise.all([
      this.web ? this.web.research(query) : Promise.resolve(null),
      this.corpus ? this.corpus.research(query) : Promise.resolve(null),
    ]);

    let allResults = [
      ...(webFindings?.results ?? []),
      ...(corpusFindings?.results ?? []),
    ];

    if (this.dedupByUrl) {
      const seen = new Set<string>();
      allResults = allResults.filter((r) => {
        if (seen.has(r.url)) return false;
        seen.add(r.url);
        return true;
      });
    }

    allResults.sort((a, b) => b.score - a.score);

    const citations = [...new Set(allResults.map((r) => r.url))];
    const finding: CombinedFinding = {
      query,
      webFindings,
      corpusFindings,
      allResults,
      citations,
      durationMs: Date.now() - t0,
    };
    this.history.push(finding);
    return finding;
  }

  getHistory(): CombinedFinding[] { return [...this.history]; }

  clearHistory(): void { this.history = []; }
}
