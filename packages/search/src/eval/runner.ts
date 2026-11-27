// SPDX-License-Identifier: Apache-2.0
/**
 * The evaluation runner: real retrieval, labelled queries, one table.
 *
 * Everything below the labels is the code the product ships — `InMemoryBM25`, `rrfFusion` /
 * `weightedAlphaFusion` through `HybridSearchEngine`, and `BM25Reranker`. Nothing is simulated except
 * the embedder, which is the deterministic hashed one in `metrics.ts`.
 *
 * Two questions are answered here:
 *   1. how good is the default offline retrieval on a labelled set (M5.2.1), and
 *   2. does any other fusion/weight/rerank setting beat it (M5.2.2) — because the plan says the
 *      default may only stay the default if it wins.
 */
import { HybridSearchEngine, InMemoryBM25 } from "../hybrid-search/index.ts";
import { BM25Reranker } from "../reranker/index.ts";

import { EVAL_DOCS, EVAL_KBS, EVAL_QUERIES, type EvalDoc, type EvalQuery } from "./dataset.ts";
import {
  HashVectorAdapter,
  aggregate,
  recallAt,
  reciprocalRank,
  type Aggregate,
} from "./metrics.ts";

export interface RetrievalConfig {
  /** "rrf" (the default) or "alpha" (weighted, max-normalised score blend). */
  fusion: "rrf" | "alpha";
  /** Dense-side weight: RRF weightA for `rrf`, alpha for `alpha`. */
  denseWeight: number;
  /** Sparse-side weight, for RRF only. */
  sparseWeight?: number;
  /** Run the BM25 cross-encoder over the fused candidates. */
  rerank: boolean;
  /** How many results to keep. */
  limit?: number;
}

export interface QueryOutcome {
  id: string;
  kb: string;
  query: string;
  answer: string;
  relevant: string[];
  ranked: string[];
}

export interface RetrievalReport {
  config: RetrievalConfig;
  queries: QueryOutcome[];
  overall: Aggregate;
  byKb: Record<string, Aggregate>;
}

/** The configuration the product uses offline today. */
export const DEFAULT_CONFIG: RetrievalConfig = {
  fusion: "rrf",
  denseWeight: 0.5,
  sparseWeight: 0.5,
  rerank: false,
  limit: 10,
};

function docsFor(kb: string): EvalDoc[] {
  return EVAL_DOCS.filter((doc) => doc.kb === kb);
}

function queriesFor(kb: string): EvalQuery[] {
  return EVAL_QUERIES.filter((query) => query.kb === kb);
}

/** Build one engine per knowledge base, exactly as a KB-scoped search would. */
function engineFor(docs: EvalDoc[], config: RetrievalConfig): HybridSearchEngine {
  const bm25 = new InMemoryBM25();
  bm25.index(docs.map((doc) => ({ id: doc.id, text: `${doc.title}\n${doc.text}` })));
  const reranker = config.rerank ? new BM25Reranker() : undefined;
  void reranker;
  return new HybridSearchEngine(
    new HashVectorAdapter(docs.map((doc) => ({ id: doc.id, text: `${doc.title}\n${doc.text}` }))),
    bm25,
  );
}

export async function runRetrieval(
  config: RetrievalConfig = DEFAULT_CONFIG,
): Promise<RetrievalReport> {
  const limit = config.limit ?? 10;
  const reranker = config.rerank ? new BM25Reranker() : undefined;
  const queries: QueryOutcome[] = [];

  for (const kb of EVAL_KBS) {
    const docs = docsFor(kb);
    const engine = engineFor(docs, config);
    for (const query of queriesFor(kb)) {
      const result = await engine.search({
        query: query.query,
        limit,
        fusion: config.fusion,
        vectorWeight: config.denseWeight,
        bm25Weight: config.sparseWeight ?? 1 - config.denseWeight,
        ...(reranker ? { reranker } : {}),
      });
      queries.push({
        id: query.id,
        kb,
        query: query.query,
        answer: query.answer,
        relevant: query.relevant,
        ranked: result.hits.map((hit) => hit.id),
      });
    }
  }

  const byKb: Record<string, Aggregate> = {};
  for (const kb of EVAL_KBS) {
    byKb[kb] = aggregate(queries.filter((q) => q.kb === kb));
  }
  return { config, queries, overall: aggregate(queries), byKb };
}

// ── Ablation (M5.2.2) ────────────────────────────────────────────────────────

export interface AblationRow {
  label: string;
  config: RetrievalConfig;
  report: RetrievalReport;
}

/** The settings under test: both fusions, three weights each, rerank off and on. */
export const ABLATION_CONFIGS: { label: string; config: RetrievalConfig }[] = [
  { label: "rrf 0.5/0.5 (default)", config: DEFAULT_CONFIG },
  { label: "rrf 0.5/0.5 + rerank", config: { ...DEFAULT_CONFIG, rerank: true } },
  {
    label: "rrf 0.7 dense / 0.3 sparse",
    config: { ...DEFAULT_CONFIG, denseWeight: 0.7, sparseWeight: 0.3 },
  },
  {
    label: "rrf 0.3 dense / 0.7 sparse",
    config: { ...DEFAULT_CONFIG, denseWeight: 0.3, sparseWeight: 0.7 },
  },
  { label: "alpha 0.5", config: { ...DEFAULT_CONFIG, fusion: "alpha", denseWeight: 0.5 } },
  { label: "alpha 0.7", config: { ...DEFAULT_CONFIG, fusion: "alpha", denseWeight: 0.7 } },
  { label: "alpha 0.3", config: { ...DEFAULT_CONFIG, fusion: "alpha", denseWeight: 0.3 } },
  {
    label: "alpha 0.7 + rerank",
    config: { ...DEFAULT_CONFIG, fusion: "alpha", denseWeight: 0.7, rerank: true },
  },
];

export async function runAblation(): Promise<AblationRow[]> {
  const rows: AblationRow[] = [];
  for (const entry of ABLATION_CONFIGS) {
    rows.push({
      label: entry.label,
      config: entry.config,
      report: await runRetrieval(entry.config),
    });
  }
  return rows;
}

/**
 * Which configuration wins on the metric that matters for a cited answer, with ties broken by MRR.
 * The default is only kept when it is in the winning set.
 */
export function bestConfig(rows: AblationRow[]): AblationRow {
  return [...rows].sort(
    (a, b) =>
      b.report.overall.citation - a.report.overall.citation ||
      b.report.overall.mrr - a.report.overall.mrr,
  )[0]!;
}

// ── Markdown table for docs/EVALS.md ─────────────────────────────────────────

export function renderAblationTable(rows: AblationRow[]): string {
  const lines = [
    "| Configuration | n | Recall@1 | Recall@5 | MRR | Citation accuracy |",
    "| ------------- | - | -------- | -------- | --- | ----------------- |",
  ];
  for (const row of rows) {
    const o = row.report.overall;
    lines.push(
      `| ${row.label} | ${o.n} | ${fmt(o.recall1)} | ${fmt(o.recall5)} | ${fmt(o.mrr)} | ${fmt(o.citation)} |`,
    );
  }
  return lines.join("\n");
}

export function renderPerKbTable(report: RetrievalReport): string {
  const lines = [
    "| Knowledge base | n | Recall@1 | Recall@5 | MRR | Citation accuracy |",
    "| -------------- | - | -------- | -------- | --- | ----------------- |",
  ];
  for (const [kb, agg] of Object.entries(report.byKb)) {
    lines.push(
      `| ${kb} | ${agg.n} | ${fmt(agg.recall1)} | ${fmt(agg.recall5)} | ${fmt(agg.mrr)} | ${fmt(agg.citation)} |`,
    );
  }
  return lines.join("\n");
}

const fmt = (value: number) => `${(value * 100).toFixed(1)}%`;

/** Per-query detail, so a regression can be traced to the query that moved. */
export function worstQueries(report: RetrievalReport, count = 5): QueryOutcome[] {
  return [...report.queries]
    .sort(
      (a, b) =>
        reciprocalRank(a.ranked, a.relevant) - reciprocalRank(b.ranked, b.relevant) ||
        recallAt(a.ranked, a.relevant, 1) - recallAt(b.ranked, b.relevant, 1),
    )
    .slice(0, count);
}
