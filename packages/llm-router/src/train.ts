// SPDX-License-Identifier: Apache-2.0
/**
 * Train the KNN, MLP, SVM and matrix-factorisation routers from routing
 * samples: a question, a model that answered it, and whether that answer was
 * a good one (in Nexus: the model agreed with the council's position).
 *
 * All four read the same hashed bag-of-words embedding, so no embedding model
 * or network call is needed. Training is deterministic for a given seed.
 */

import { KNNRouter } from "./knn-router.js";
import { MFBilinearRouter } from "./mf-router.js";
import { MLPRouter } from "./mlp-router.js";
import { SVMRouter } from "./svm-router.js";

export interface RoutingSample {
  query: string;
  model: string;
  agreed: boolean;
}

export interface TrainedRouters {
  models: string[];
  knn: KNNRouter;
  mlp: MLPRouter;
  svm: SVMRouter;
  mf: MFBilinearRouter;
  /** Each router's pick for `query`, and the majority (ties go to the KNN pick). */
  route(query: string): { model: string; votes: Record<"knn" | "mlp" | "svm" | "mf", string> };
}

export interface TrainOptions {
  dim?: number;
  seed?: number;
  epochs?: number;
}

/** L2-normalised hashed bag of words. */
export function hashEmbed(text: string, dim = 128): number[] {
  const vec = new Array<number>(dim).fill(0);
  for (const word of text.toLowerCase().split(/\W+/)) {
    if (!word) continue;
    let h = 2166136261;
    for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
    vec[(h >>> 0) % dim]! += 1;
  }
  const norm = Math.hypot(...vec);
  return norm > 0 ? vec.map((v) => v / norm) : vec;
}

/** mulberry32: small seeded PRNG so a retrain gives the same routers. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0);

/** Null when there is nothing to learn: fewer than two models, or no good answer at all. */
export function trainRouters(
  samples: RoutingSample[],
  opts: TrainOptions = {},
): TrainedRouters | null {
  const dim = opts.dim ?? 128;
  const epochs = opts.epochs ?? 60;
  const rand = rng(opts.seed ?? 1);
  const models = [...new Set(samples.map((s) => s.model))];
  const good = samples.filter((s) => s.agreed);
  if (models.length < 2 || good.length === 0) return null;
  const index = new Map(models.map((m, i) => [m, i]));
  const embed = new Map<string, number[]>();
  const x = (q: string) => embed.get(q) ?? embed.set(q, hashEmbed(q, dim)).get(q)!;
  const init = (n: number, fanIn: number, fanOut: number) =>
    Array.from({ length: n }, () => (rand() * 2 - 1) * Math.sqrt(6 / (fanIn + fanOut)));

  // KNN: each model's profile is the centre of the questions it answered well.
  const knn = new KNNRouter({
    k: Math.max(1, Math.ceil(models.length / 2)),
    embed: (q) => hashEmbed(q, dim),
    models: models.map((m) => {
      const mine = samples.filter((s) => s.model === m);
      const wins = mine.filter((s) => s.agreed);
      const centre = new Array<number>(dim).fill(0);
      for (const s of wins.length ? wins : mine) x(s.query).forEach((v, i) => (centre[i]! += v));
      return { alias: m, embedding: centre, avgScore: wins.length / mine.length };
    }),
  });

  // Classifiers learn "which model answered this well" from the good answers.
  const labelled = good.map((s) => ({ v: x(s.query), y: index.get(s.model)! }));

  // MLP: one ReLU hidden layer, softmax cross-entropy, plain SGD.
  const H = 16;
  const W1 = Array.from({ length: H }, () => init(dim, dim, H));
  const b1 = new Array<number>(H).fill(0);
  const W2 = Array.from({ length: models.length }, () => init(H, H, models.length));
  const b2 = new Array<number>(models.length).fill(0);
  for (let e = 0; e < epochs; e++) {
    for (const { v, y } of labelled) {
      const h = W1.map((row, i) => Math.max(0, dot(row, v) + b1[i]!));
      const z = W2.map((row, k) => dot(row, h) + b2[k]!);
      const m = Math.max(...z);
      const ex = z.map((q) => Math.exp(q - m));
      const sum = ex.reduce((s, q) => s + q, 0);
      const dz = ex.map((q, k) => q / sum - (k === y ? 1 : 0));
      const dh = h.map((hv, i) => (hv > 0 ? dz.reduce((s, g, k) => s + g * W2[k]![i]!, 0) : 0));
      const lr = 0.1;
      dz.forEach((g, k) => {
        W2[k] = W2[k]!.map((w, i) => w - lr * g * h[i]!);
        b2[k]! -= lr * g;
      });
      dh.forEach((g, i) => {
        if (g === 0) return;
        W1[i] = W1[i]!.map((w, j) => w - lr * g * v[j]!);
        b1[i]! -= lr * g;
      });
    }
  }
  const mlp = new MLPRouter({
    inputDim: dim,
    hiddenLayers: [H],
    numClasses: models.length,
    classes: [...models],
    weights: [W1, W2],
    biases: [b1, b2],
  });

  // SVM: one-vs-rest kernel perceptron over the RBF kernel; its mistakes are the dual coefficients.
  const gamma = 1;
  const vectors = [...new Set(labelled.map((l) => l.v))];
  const K = vectors.map((a) =>
    vectors.map((b) => Math.exp(-gamma * a.reduce((s, v, i) => s + (v - b[i]!) ** 2, 0))),
  );
  const labelsOf = vectors.map((v) => new Set(labelled.filter((l) => l.v === v).map((l) => l.y)));
  const alpha = models.map(() => new Array<number>(vectors.length).fill(0));
  const bias = new Array<number>(models.length).fill(0);
  for (let e = 0; e < 20; e++) {
    for (let k = 0; k < models.length; k++) {
      for (let i = 0; i < vectors.length; i++) {
        const y = labelsOf[i]!.has(k) ? 1 : -1;
        const f = alpha[k]!.reduce((s, a, j) => s + a * K[j]![i]!, bias[k]!);
        if (y * f <= 0) {
          alpha[k]![i]! += y;
          bias[k]! += y * 0.1;
        }
      }
    }
  }
  const svm = new SVMRouter({
    classes: [...models],
    supportVectors: vectors,
    dualCoefficients: alpha,
    intercepts: bias,
    gamma,
  });

  // MF: score = w2 · (v_model ⊙ (P · x)), logistic loss on every sample, good or not.
  const L = 8;
  const P = Array.from({ length: L }, () => init(dim, dim, L));
  const w2 = init(L, L, 1);
  const unit = (v: number[]) => {
    const n = Math.hypot(...v) || 1;
    return v.map((q) => q / n);
  };
  const V = models.map(() => unit(init(L, L, 1)));
  for (let e = 0; e < epochs; e++) {
    for (const s of samples) {
      const q = x(s.query);
      const k = index.get(s.model)!;
      const p = P.map((row) => dot(row, q));
      const hdm = p.map((pv, i) => V[k]![i]! * pv);
      const score = dot(w2, hdm);
      const g = 1 / (1 + Math.exp(-score)) - (s.agreed ? 1 : 0);
      const lr = 0.2;
      const oldW2 = [...w2];
      for (let i = 0; i < L; i++) w2[i]! -= lr * g * hdm[i]!;
      V[k] = unit(V[k]!.map((vv, i) => vv - lr * g * oldW2[i]! * p[i]!));
      for (let i = 0; i < L; i++) {
        const gi = g * oldW2[i]! * V[k]![i]!;
        P[i] = P[i]!.map((w, j) => w - lr * gi * q[j]!);
      }
    }
  }
  const mf = new MFBilinearRouter({
    latentDim: L,
    models: models.map((m, k) => ({ alias: m, embedding: V[k]! })),
    textProjection: P,
    outputWeights: w2,
  });

  return {
    models: [...models],
    knn,
    mlp,
    svm,
    mf,
    route(query) {
      const v = hashEmbed(query, dim);
      const votes = {
        knn: knn.route(query).chosenAlias,
        mlp: mlp.route(v).chosenAlias,
        svm: svm.route(v).chosenAlias,
        mf: mf.route(v).chosenAlias,
      };
      const tally = new Map<string, number>();
      for (const m of Object.values(votes)) tally.set(m, (tally.get(m) ?? 0) + 1);
      const top = Math.max(...tally.values());
      const leaders = [...tally].filter(([, n]) => n === top).map(([m]) => m);
      return { model: leaders.includes(votes.knn) ? votes.knn : leaders[0]!, votes };
    },
  };
}
