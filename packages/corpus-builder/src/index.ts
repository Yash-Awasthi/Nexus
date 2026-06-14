// SPDX-License-Identifier: Apache-2.0
/**
 * corpus-builder — Corpus assembly, storage, and knowledge-driven answering.
 *
 * Provides:
 *   • CorpusDocument      — typed document with content + metadata
 *   • CorpusFilter        — topic/source/date filter
 *   • CorpusBuilder       — assembles filtered document set from search backend
 *   • CorpusStore         — serialized corpus registry
 *   • CorpusRenderer      — renders to markdown or plain text
 *   • KnowledgeAgent      — answers questions from a corpus
 *   • MockSearchBackend   — injectable in-memory search double
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type DocumentSource = "web" | "pdf" | "database" | "upload" | "mock";

export interface CorpusDocument {
  id: string;
  title: string;
  content: string;
  source: DocumentSource;
  url?: string;
  publishedAt?: string;
  topics: string[];
  wordCount: number;
  score?: number;
}

export interface CorpusFilter {
  topics?: string[];
  sources?: DocumentSource[];
  maxDocuments?: number;
  minWordCount?: number;
  after?: string;     // ISO-8601
  minScore?: number;
}

export interface Corpus {
  id: string;
  query: string;
  filter: CorpusFilter;
  documents: CorpusDocument[];
  builtAt: string;
  totalWords: number;
}

// ── MockSearchBackend ─────────────────────────────────────────────────────────

export interface CorpusSearchResult {
  documents: CorpusDocument[];
  query: string;
}

export interface CorpusSearchBackend {
  search(query: string, filter?: CorpusFilter): Promise<CorpusSearchResult>;
}

let _cdSeq = 0;

export class MockCorpusSearchBackend implements CorpusSearchBackend {
  private documents: CorpusDocument[];
  readonly calls: string[] = [];

  constructor(documents?: CorpusDocument[]) {
    this.documents = documents ?? [
      {
        id: "doc-1",
        title: "Introduction to AI",
        content: "Artificial intelligence is the simulation of human intelligence in machines.",
        source: "web",
        topics: ["ai", "technology"],
        wordCount: 12,
        score: 0.9,
      },
      {
        id: "doc-2",
        title: "Machine Learning Fundamentals",
        content: "Machine learning is a subset of AI that allows systems to learn automatically.",
        source: "pdf",
        topics: ["ml", "ai"],
        wordCount: 14,
        score: 0.8,
      },
      {
        id: "doc-3",
        title: "Neural Networks",
        content: "Neural networks are computing systems inspired by biological neural networks.",
        source: "web",
        topics: ["neural-networks", "ai"],
        wordCount: 11,
        score: 0.75,
      },
    ];
  }

  async search(query: string, filter?: CorpusFilter): Promise<CorpusSearchResult> {
    this.calls.push(query);
    let docs = [...this.documents];

    if (filter?.topics && filter.topics.length > 0) {
      docs = docs.filter((d) => filter.topics!.some((t) => d.topics.includes(t)));
    }
    if (filter?.sources && filter.sources.length > 0) {
      docs = docs.filter((d) => filter.sources!.includes(d.source));
    }
    if (filter?.minWordCount !== undefined) {
      docs = docs.filter((d) => d.wordCount >= filter.minWordCount!);
    }
    if (filter?.minScore !== undefined) {
      docs = docs.filter((d) => (d.score ?? 0) >= filter.minScore!);
    }
    if (filter?.maxDocuments !== undefined) {
      docs = docs.slice(0, filter.maxDocuments);
    }

    return { documents: docs, query };
  }
}

// ── CorpusBuilder ─────────────────────────────────────────────────────────────

let _corpSeq = 0;

export class CorpusBuilder {
  private backend: CorpusSearchBackend;

  constructor(backend: CorpusSearchBackend) {
    this.backend = backend;
  }

  async build(query: string, filter: CorpusFilter = {}): Promise<Corpus> {
    const result = await this.backend.search(query, filter);
    const totalWords = result.documents.reduce((sum, d) => sum + d.wordCount, 0);
    return {
      id: `corpus-${++_corpSeq}`,
      query,
      filter,
      documents: result.documents,
      builtAt: new Date().toISOString(),
      totalWords,
    };
  }
}

// ── CorpusStore ───────────────────────────────────────────────────────────────

export class CorpusStore {
  private corpora = new Map<string, Corpus>();

  save(corpus: Corpus): void {
    this.corpora.set(corpus.id, corpus);
  }

  get(id: string): Corpus | undefined { return this.corpora.get(id); }
  has(id: string): boolean { return this.corpora.has(id); }
  list(): Corpus[] { return [...this.corpora.values()]; }
  delete(id: string): boolean { return this.corpora.delete(id); }
  clear(): void { this.corpora.clear(); }
  count(): number { return this.corpora.size; }

  /** Find corpus by query string */
  findByQuery(query: string): Corpus | undefined {
    for (const c of this.corpora.values()) {
      if (c.query === query) return c;
    }
    return undefined;
  }
}

// ── CorpusRenderer ────────────────────────────────────────────────────────────

export type RenderFormat = "markdown" | "text";

export class CorpusRenderer {
  renderMarkdown(corpus: Corpus): string {
    const lines: string[] = [
      `# Corpus: ${corpus.query}`,
      `Built at: ${corpus.builtAt}`,
      `Documents: ${corpus.documents.length} | Words: ${corpus.totalWords}`,
      "",
    ];
    for (const doc of corpus.documents) {
      lines.push(`## ${doc.title}`);
      lines.push(`*Source: ${doc.source}*${doc.url ? ` | [link](${doc.url})` : ""}`);
      if (doc.topics.length > 0) lines.push(`Topics: ${doc.topics.join(", ")}`);
      lines.push("");
      lines.push(doc.content);
      lines.push("");
    }
    return lines.join("\n");
  }

  renderText(corpus: Corpus): string {
    const lines: string[] = [
      `CORPUS: ${corpus.query}`,
      `Built: ${corpus.builtAt}`,
      `---`,
    ];
    for (const doc of corpus.documents) {
      lines.push(`[${doc.title}]`);
      lines.push(doc.content);
      lines.push("");
    }
    return lines.join("\n");
  }

  render(corpus: Corpus, format: RenderFormat = "markdown"): string {
    return format === "markdown" ? this.renderMarkdown(corpus) : this.renderText(corpus);
  }
}

// ── KnowledgeAgent ────────────────────────────────────────────────────────────

export interface KnowledgeAnswer {
  question: string;
  answer: string;
  sourceDocuments: string[];  // document IDs used
  confidence: number;
  corpusId: string;
}

export type AnswerFn = (question: string, context: string) => Promise<string>;

export class KnowledgeAgent {
  private builder: CorpusBuilder;
  private renderer: CorpusRenderer;
  private answerFn: AnswerFn;

  constructor(builder: CorpusBuilder, answerFn: AnswerFn) {
    this.builder = builder;
    this.renderer = new CorpusRenderer();
    this.answerFn = answerFn;
  }

  async answer(
    question: string,
    filter: CorpusFilter = {},
  ): Promise<KnowledgeAnswer> {
    const corpus = await this.builder.build(question, filter);
    const context = this.renderer.renderText(corpus);
    const answer = await this.answerFn(question, context);

    return {
      question,
      answer,
      sourceDocuments: corpus.documents.map((d) => d.id),
      confidence: corpus.documents.length > 0 ? 0.8 : 0.2,
      corpusId: corpus.id,
    };
  }
}
