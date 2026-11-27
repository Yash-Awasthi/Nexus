// SPDX-License-Identifier: Apache-2.0
/**
 * Two measurements that sit under the retrieval table (plan M5.2.4 and M5.2.5).
 *
 * CHUNKING — the shipped chunker (`@nexus/nlp-utils chunkByStrategy`) at each of its four strategies,
 * over the same documents and the same labelled queries, with the same fixed hash embedder. Chunks
 * inherit their source document's id, so the score is "did the right document come back", which is
 * what a citation needs even when the unit indexed was a chunk.
 *
 * MERGE QUALITY — the knowledge graph decides that two entity mentions are the same node by hashing
 * `name.lower()|type`. Here that rule is scored against labelled name pairs: how many true duplicates
 * it merges, and — the number this test exists for — how many distinct entities it wrongly merges.
 * A false positive here silently fuses two different people into one node; a false negative only
 * leaves two nodes that should be one.
 */
import { chunkByStrategy, type ChunkStrategy } from "@nexus/nlp-utils";

import { makeNodeId } from "../knowledge-graph/index.ts";
import type { EntityType } from "../knowledge-graph/index.ts";

import { EVAL_DOCS } from "./dataset.ts";
import { hashEmbed } from "./metrics.ts";

// ── Chunking ─────────────────────────────────────────────────────────────────

export interface ChunkingRow {
  strategy: ChunkStrategy;
  chunks: number;
  meanChunkTokens: number;
  /** Document-level recall@1 of the query set under this strategy. */
  recall1: number;
  recall5: number;
  mrr: number;
}

export const CHUNK_STRATEGIES: ChunkStrategy[] = ["fixed", "sentence", "paragraph", "semantic"];

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

/**
 * Index each document's chunks, answer the labelled queries, and score at document level. Ties
 * between chunks of the same document collapse to that document's best rank — the user sees a
 * citation, not a chunk id.
 */
export function evaluateChunking(
  strategy: ChunkStrategy,
  queries: { kb: string; query: string; answer: string; relevant: string[] }[],
  docs = EVAL_DOCS,
): ChunkingRow {
  const chunks: { docId: string; text: string; vector: number[] }[] = [];
  let tokens = 0;
  for (const doc of docs) {
    for (const chunk of chunkByStrategy(`${doc.title}\n${doc.text}`, strategy, {
      maxTokens: 96,
      overlapTokens: 16,
    })) {
      chunks.push({ docId: doc.id, text: chunk.text, vector: hashEmbed(chunk.text) });
      tokens += chunk.tokenEstimate;
    }
  }

  let recall1 = 0;
  let recall5 = 0;
  let mrr = 0;
  for (const query of queries) {
    const q = hashEmbed(query.query);
    const byDoc = new Map<string, number>();
    for (const chunk of chunks) {
      const score = cosine(q, chunk.vector);
      if (score <= 0) continue;
      byDoc.set(chunk.docId, Math.max(byDoc.get(chunk.docId) ?? 0, score));
    }
    const ranked = [...byDoc.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    const relevant = new Set(query.relevant);
    const rank = ranked.findIndex((id) => relevant.has(id));
    recall1 += ranked[0] !== undefined && relevant.has(ranked[0]) ? 1 : 0;
    recall5 += rank !== -1 && rank < 5 ? 1 : 0;
    mrr += rank === -1 ? 0 : 1 / (rank + 1);
  }

  const n = queries.length || 1;
  return {
    strategy,
    chunks: chunks.length,
    meanChunkTokens: Math.round(tokens / Math.max(1, chunks.length)),
    recall1: recall1 / n,
    recall5: recall5 / n,
    mrr: mrr / n,
  };
}

export function renderChunkingTable(rows: ChunkingRow[]): string {
  const lines = [
    "| Strategy | Chunks | Mean chunk (tokens) | Recall@1 | Recall@5 | MRR |",
    "| -------- | ------ | ------------------- | -------- | -------- | --- |",
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.strategy} | ${row.chunks} | ${row.meanChunkTokens} | ${pct(row.recall1)} | ${pct(row.recall5)} | ${pct(row.mrr)} |`,
    );
  }
  return lines.join("\n");
}

const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

// ── Merge quality ────────────────────────────────────────────────────────────

export interface NamePair {
  a: string;
  b: string;
  type: EntityType;
  /** Type of `b` when the pair is testing that two types stay apart. Defaults to `type`. */
  typeB?: EntityType;
  /** The label: do these two mentions name the same entity? */
  same: boolean;
  /** Why, so a reviewer can disagree with the label rather than with the code. */
  note: string;
}

/**
 * Labelled pairs. The positives are the same entity written differently (case, spacing, punctuation).
 * The negatives are different entities that a careless normaliser would fuse — the same word as two
 * types, a company and its division, a city on two continents, pluralisation, a quarter apart. One
 * negative is a known miss on purpose (`St. Louis` vs `Saint Louis`): an abbreviation is a synonym,
 * not a spelling, and the hash rule does not guess synonyms. Publishing that ceiling is the point.
 */
export const NAME_PAIRS: NamePair[] = [
  { a: "Nexus", b: "nexus", type: "PRODUCT", same: true, note: "same word, different case" },
  { a: "Ada Lovelace", b: "ada  lovelace", type: "PERSON", same: true, note: "extra whitespace" },
  { a: "Acme Corp.", b: "Acme Corp", type: "ORG", same: true, note: "trailing period" },
  { a: "San Francisco", b: "san francisco", type: "LOCATION", same: true, note: "case only" },
  { a: "Billing Service", b: "billing service", type: "PRODUCT", same: true, note: "case only" },
  { a: "Grace Hopper", b: "Grace Hopper", type: "PERSON", same: true, note: "identical" },
  { a: "Q3 Launch", b: "q3 launch", type: "EVENT", same: true, note: "case only" },
  { a: "Widgets Inc", b: "WIDGETS  INC", type: "ORG", same: true, note: "case and spacing" },
  { a: "Nexus", b: "Nexus Labs", type: "ORG", same: false, note: "the product is not the company" },
  {
    a: "Ada Lovelace",
    b: "Ada Byron",
    type: "PERSON",
    same: false,
    note: "a historical alias the hash rule does not know",
  },
  {
    a: "Acme",
    b: "Acme Health",
    type: "ORG",
    same: false,
    note: "a division with its own records",
  },
  { a: "Paris", b: "Paris, Texas", type: "LOCATION", same: false, note: "different places" },
  {
    a: "Atlas",
    b: "Atlas",
    type: "PERSON",
    typeB: "PRODUCT",
    same: false,
    note: "a person and a product share the word — the type keeps them apart",
  },
  {
    a: "Mercury",
    b: "Mercury",
    type: "PRODUCT",
    typeB: "LOCATION",
    same: false,
    note: "the metal and the planet",
  },
  {
    a: "Billing Service",
    b: "Billing Services",
    type: "PRODUCT",
    same: false,
    note: "plural names a different product",
  },
  { a: "Q3 Launch", b: "Q4 Launch", type: "EVENT", same: false, note: "different quarters" },
  {
    a: "Grace Hopper",
    b: "Grace Hopper Conference",
    type: "PERSON",
    same: false,
    note: "the event is not the person",
  },
  {
    a: "St. Louis",
    b: "Saint Louis",
    type: "LOCATION",
    same: true,
    note: "a known miss on purpose: an abbreviation is a synonym, and this rule does not guess synonyms",
  },
];

export interface MergeQuality {
  pairs: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  precision: number;
  recall: number;
}

/**
 * Score the merge rule: two mentions merge when their ids are equal and their types match. The type
 * is part of the id in production, so a type mismatch is a different node by construction.
 */
export function evaluateMerge(pairs: NamePair[] = NAME_PAIRS): MergeQuality {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const pair of pairs) {
    const merged = makeNodeId(pair.a, pair.type) === makeNodeId(pair.b, pair.typeB ?? pair.type);
    if (merged && pair.same) tp++;
    else if (merged && !pair.same) fp++;
    else if (!merged && pair.same) fn++;
    else tn++;
  }
  return {
    pairs: pairs.length,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    trueNegatives: tn,
    precision: tp / Math.max(1, tp + fp),
    recall: tp / Math.max(1, tp + fn),
  };
}
