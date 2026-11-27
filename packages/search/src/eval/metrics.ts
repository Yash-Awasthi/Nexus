// SPDX-License-Identifier: Apache-2.0
/**
 * A deterministic, dependency-free embedder and the retrieval metrics, so the evaluation runs
 * offline and gives the same answer on every machine.
 *
 * The embedder is the hashing trick over words and word pairs. It is deliberately weak: it sees
 * shared vocabulary, not meaning. That is the point of publishing it — the numbers are a floor for
 * the *retrieval stack* (BM25, fusion, reranking, chunking), and a model-backed embedder can only
 * improve on them. An evaluation that silently used a different embedder than the tree ships would
 * not tell anyone what this tree does offline.
 */

import type { SearchHit, VectorSearchAdapter } from "../hybrid-search/index.ts";

const DIMENSIONS = 256;

/** FNV-1a: small, stable across platforms, and good enough to spread terms over 256 buckets. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Bag of words *and* word pairs, L2-normalised. Bigrams give phrases a little weight. */
export function hashEmbed(text: string, dimensions = DIMENSIONS): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = tokenize(text);
  const add = (term: string, weight: number) => {
    const hash = fnv1a(term);
    const index = hash % dimensions;
    // The sign bit from a second slice of the hash keeps collisions from only ever adding.
    const sign = (hash >>> 16) % 2 === 0 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + sign * weight;
  };
  for (const token of tokens) add(token, 1);
  for (let i = 0; i + 1 < tokens.length; i++) add(`${tokens[i]} ${tokens[i + 1]}`, 0.6);
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? vector : vector.map((value) => value / norm);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

/** Indexes documents by their hashed vector and answers nearest-neighbour queries. */
export class HashVectorAdapter implements VectorSearchAdapter {
  private readonly vectors: { id: string; text: string; vector: number[] }[];

  constructor(documents: { id: string; text: string }[]) {
    this.vectors = documents.map((d) => ({ ...d, vector: hashEmbed(d.text) }));
  }

  async search(query: string, limit: number): Promise<SearchHit[]> {
    const q = hashEmbed(query);
    return this.vectors
      .map((doc) => ({ id: doc.id, text: doc.text, score: cosine(q, doc.vector) }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

// ── Metrics ──────────────────────────────────────────────────────────────────

/** Fraction of the acceptable documents that appear in the first `k` results. */
export function recallAt(ranked: string[], relevant: string[], k: number): number {
  if (relevant.length === 0) return 0;
  const top = new Set(ranked.slice(0, k));
  return relevant.filter((id) => top.has(id)).length / relevant.length;
}

/** Reciprocal rank of the first acceptable document; 0 when none was returned. */
export function reciprocalRank(ranked: string[], relevant: string[]): number {
  const wanted = new Set(relevant);
  const index = ranked.findIndex((id) => wanted.has(id));
  return index === -1 ? 0 : 1 / (index + 1);
}

/** Did the first result name the document that answers the question? */
export function citedAnswer(ranked: string[], answer: string): boolean {
  return ranked[0] === answer;
}

export interface Aggregate {
  n: number;
  recall1: number;
  recall5: number;
  mrr: number;
  citation: number;
}

export function aggregate(
  rows: { ranked: string[]; relevant: string[]; answer: string }[],
): Aggregate {
  const n = rows.length;
  if (n === 0) return { n: 0, recall1: 0, recall5: 0, mrr: 0, citation: 0 };
  const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
  return {
    n,
    recall1: mean(rows.map((r) => recallAt(r.ranked, r.relevant, 1))),
    recall5: mean(rows.map((r) => recallAt(r.ranked, r.relevant, 5))),
    mrr: mean(rows.map((r) => reciprocalRank(r.ranked, r.relevant))),
    citation: mean(rows.map((r) => (citedAnswer(r.ranked, r.answer) ? 1 : 0))),
  };
}
