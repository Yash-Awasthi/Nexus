// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/shared — vector math + deterministic RNG primitives.
 *
 * Single home for the low-level helpers several packages previously
 * re-declared locally (retrieval, retrieval/hnsw-index, council):
 *
 *   dot(a, b)               — inner product (zero-pads the shorter operand)
 *   magnitude(v)            — euclidean norm
 *   normalize(v)            — unit vector (zero vector returned as-is)
 *   cosineSimilarity(a, b)  — clamped to [0, 1]
 *   mulberry32(seed)        — small deterministic PRNG for reproducible ops
 */

/** Inner product; zero-pads the shorter operand (ragged-vector safe). */
export function dot(a: number[], b: number[]): number {
  let sum = 0;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

/** Euclidean norm. */
export function magnitude(v: number[]): number {
  return Math.sqrt(dot(v, v));
}

/** Unit vector; the zero vector is returned unchanged. */
export function normalize(v: number[]): number[] {
  const mag = magnitude(v);
  if (mag === 0) return v;
  return v.map((x) => x / mag);
}

/** Cosine similarity clamped to [0, 1]. */
export function cosineSimilarity(a: number[], b: number[]): number {
  const magA = magnitude(a);
  const magB = magnitude(b);
  if (magA === 0 || magB === 0) return 0;
  return Math.max(0, Math.min(1, dot(a, b) / (magA * magB)));
}

/**
 * Deterministic 32-bit PRNG (mulberry32). Same seed ⇒ same sequence.
 * Used wherever an operation must be reproducible (HNSW level draws,
 * seeded anonymization shuffles).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
