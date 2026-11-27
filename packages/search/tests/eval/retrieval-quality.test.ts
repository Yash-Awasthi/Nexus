// SPDX-License-Identifier: Apache-2.0
/**
 * The retrieval and merge evaluations as a gate (plan M5.2.1, M5.2.2, M5.2.4, M5.2.5).
 *
 * Floors, not targets: the numbers below were measured on this corpus and the assertions leave room
 * for the honest noise of a hashed embedder while still failing if ranking behaviour regresses. The
 * ablation assertions are set so that "the default silently lost ten points" fails the build instead
 * of being discovered in a review.
 */
import { describe, it, expect } from "vite-plus/test";

import { EVAL_DOCS, EVAL_KBS, EVAL_QUERIES } from "../../src/eval/dataset.ts";
import { citedAnswer } from "../../src/eval/metrics.ts";
import {
  CHUNK_STRATEGIES,
  NAME_PAIRS,
  evaluateChunking,
  evaluateMerge,
} from "../../src/eval/quality.ts";
import {
  DEFAULT_CONFIG,
  bestConfig,
  runAblation,
  runRetrieval,
  worstQueries,
} from "../../src/eval/runner.ts";
import { renderEvalReport } from "../../src/eval/cli.ts";

describe("the labelled retrieval set", () => {
  it("is fifty queries over three knowledge bases, and every label points at a real document", () => {
    expect(EVAL_QUERIES).toHaveLength(50);
    expect(EVAL_KBS).toHaveLength(3);
    const ids = new Set(EVAL_DOCS.map((doc) => doc.id));
    expect(ids.size).toBe(EVAL_DOCS.length);
    const queryIds = new Set(EVAL_QUERIES.map((query) => query.id));
    expect(queryIds.size).toBe(EVAL_QUERIES.length);
    for (const query of EVAL_QUERIES) {
      expect(ids.has(query.answer), `${query.id} answer ${query.answer}`).toBe(true);
      expect(query.relevant, `${query.id} must include its answer`).toContain(query.answer);
      for (const id of query.relevant) expect(ids.has(id), `${query.id} relevant ${id}`).toBe(true);
    }
    // Every knowledge base is really covered, not just named.
    for (const kb of EVAL_KBS) {
      expect(EVAL_QUERIES.filter((q) => q.kb === kb).length).toBeGreaterThanOrEqual(16);
      expect(EVAL_DOCS.filter((d) => d.kb === kb).length).toBeGreaterThanOrEqual(12);
    }
  });
});

describe("retrieval quality", () => {
  it("the default configuration clears the measured floors", async () => {
    const report = await runRetrieval(DEFAULT_CONFIG);
    expect(report.overall.n).toBe(50);
    expect(report.overall.recall5).toBeGreaterThanOrEqual(0.8);
    expect(report.overall.recall1).toBeGreaterThanOrEqual(0.45);
    expect(report.overall.mrr).toBeGreaterThanOrEqual(0.65);
    expect(report.overall.citation).toBeGreaterThanOrEqual(0.45);
    // Every KB is measured, and none is carried by the others.
    expect(Object.keys(report.byKb)).toEqual([...EVAL_KBS]);
    for (const kb of EVAL_KBS) expect(report.byKb[kb]!.n).toBeGreaterThan(0);
  });

  it("the ablation covers both fusions and the rerank switch, and no setting hides a collapse", async () => {
    const rows = await runAblation();
    expect(rows).toHaveLength(8);
    expect(new Set(rows.map((row) => row.config.fusion))).toEqual(new Set(["rrf", "alpha"]));
    expect(rows.some((row) => row.config.rerank)).toBe(true);
    expect(rows.some((row) => !row.config.rerank)).toBe(true);

    const base = rows.find((row) => row.label.includes("default"))!;
    const best = bestConfig(rows);
    // The default may lose, but not by so much that the table is measuring a different task.
    expect(base.report.overall.citation).toBeGreaterThanOrEqual(
      best.report.overall.citation - 0.15,
    );
    for (const row of rows) {
      expect(row.report.overall.recall5, row.label).toBeGreaterThanOrEqual(0.75);
    }
  });

  it("reranking wins more queries than it loses on citation, and the docs say it is not yet a default", async () => {
    const base = await runRetrieval(DEFAULT_CONFIG);
    const reranked = await runRetrieval({ ...DEFAULT_CONFIG, rerank: true });
    const wins = base.queries.filter(
      (query, i) =>
        !citedAnswer(query.ranked, query.answer) &&
        citedAnswer(reranked.queries[i]!.ranked, query.answer),
    ).length;
    const losses = base.queries.filter(
      (query, i) =>
        citedAnswer(query.ranked, query.answer) &&
        !citedAnswer(reranked.queries[i]!.ranked, query.answer),
    ).length;

    expect(wins).toBeGreaterThan(losses);
    expect(reranked.overall.citation).toBeGreaterThan(base.overall.citation);
    // Six discordant queries cannot settle it; the doc records the sign test rather than a verdict.
    expect(wins + losses).toBeLessThan(10);
  });
});

describe("chunking", () => {
  it("measures every shipped strategy and recommends whole documents on this corpus", async () => {
    const base = await runRetrieval(DEFAULT_CONFIG);
    const rows = CHUNK_STRATEGIES.map((strategy) => evaluateChunking(strategy, EVAL_QUERIES));
    expect(rows.map((row) => row.strategy)).toEqual([...CHUNK_STRATEGIES]);
    for (const row of rows) {
      expect(row.chunks).toBeGreaterThan(0);
      expect(row.meanChunkTokens).toBeGreaterThan(0);
    }

    // The comparison's conclusion: chunking these documents loses recall against whole documents.
    const bestChunked = Math.max(...rows.map((row) => row.recall5));
    expect(bestChunked).toBeLessThanOrEqual(base.overall.recall5);

    // And the two segment strategies beat the fixed window, which is the recommendation's reason.
    const fixed = rows.find((row) => row.strategy === "fixed")!;
    const paragraph = rows.find((row) => row.strategy === "paragraph")!;
    expect(paragraph.recall5).toBeGreaterThanOrEqual(fixed.recall5);
    // Semantic produced the most chunks here, at the worst precision: stated, and gated loosely.
    const semantic = rows.find((row) => row.strategy === "semantic")!;
    expect(semantic.chunks).toBeGreaterThan(paragraph.chunks);
  });
});

describe("entity merge quality", () => {
  it("has no false positives and merges case, whitespace and trailing punctuation", () => {
    const quality = evaluateMerge();
    expect(quality.pairs).toBe(NAME_PAIRS.length);
    expect(quality.falsePositives).toBe(0);
    expect(quality.precision).toBe(1);
    // The one known miss is a synonym, not a spelling: documented, not hidden.
    expect(quality.falseNegatives).toBe(1);
    expect(quality.recall).toBeGreaterThanOrEqual(0.85);

    const byNote = (note: string) => NAME_PAIRS.find((pair) => pair.note === note)!;
    expect(quality.pairs).toBeGreaterThanOrEqual(18);
    for (const pair of NAME_PAIRS) {
      expect(pair.note.length, `${pair.a}/${pair.b} has a reason`).toBeGreaterThan(8);
    }
    expect(byNote("extra whitespace").same).toBe(true);
    expect(byNote("trailing period").same).toBe(true);
  });
});

/**
 * `cli.ts` is the generator behind `docs/EVALS.md` and nothing else imports it, so it sat at 0% until this
 * test: a generator nobody runs is a page that drifts until someone regenerates it and reviews the diff.
 * The headings are asserted rather than the numbers — the numbers have their own tests above.
 */
describe("the eval report generator", () => {
  it("renders every section the page claims to have", async () => {
    const markdown = await renderEvalReport();
    for (const heading of [
      "### Retrieval, default configuration",
      "### Ablation",
      "### Chunking",
      "### Entity merge quality",
      "### Weakest queries (default configuration)",
    ])
      expect(markdown, heading).toContain(heading);
    // The first line says where the numbers come from, so a reader cannot mistake them for a live measurement.
    expect(markdown).toContain("deterministic offline embedder");
    expect(markdown).toContain(`${EVAL_QUERIES.length} labelled queries`);
  }, 120_000);

  it("names the weakest queries, and asks for no more than exist", async () => {
    const report = await runRetrieval(DEFAULT_CONFIG);
    const worst = worstQueries(report, 5);
    expect(worst.length).toBe(5);
    // Worst first: the page prints the top of this list, so the order is the message.
    expect(worst[0]!.id).toBeTruthy();
    expect(worst[0]!.relevant.length).toBeGreaterThan(0);
    const all = worstQueries(report, 10_000);
    expect(all.length).toBe(report.queries.length);
    expect(new Set(all.map((query) => query.id)).size).toBe(all.length);
  });

  it("picks the best ablation row by citation, with MRR breaking a tie", async () => {
    const rows = await runAblation();
    expect(rows.length).toBeGreaterThan(5);
    const best = bestConfig(rows);
    const maxCitation = Math.max(...rows.map((row) => row.report.overall.citation));
    expect(best.report.overall.citation).toBeCloseTo(maxCitation, 10);
    const tied = rows.filter(
      (row) => Math.abs(row.report.overall.citation - best.report.overall.citation) < 1e-9,
    );
    expect(best.report.overall.mrr).toBeGreaterThanOrEqual(
      Math.max(...tied.map((row) => row.report.overall.mrr)) - 1e-9,
    );
  });
});
