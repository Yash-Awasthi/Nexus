// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/mf-router — Bilinear Matrix Factorization LLM router.
 *
 * Inspired by LLMRouter's MFRouter / RouteLLM's matrix-factorization approach.
 * Learns latent embeddings for both queries and models, then scores each
 * model-query pair via bilinear interaction:
 *
 *   δ(model, query) = w2^T · (v_model ⊙ (W1 · v_query))
 *
 * Where ⊙ is element-wise multiplication, W1 projects query embeddings into
 * latent space, v_model is a learned model embedding, and w2 is the output
 * projection.
 *
 * Usage
 * ─────
 * ```ts
 * const router = new MFBilinearRouter({
 *   latentDim: 64,
 *   models: [
 *     { alias: "claude-opus", embedding: [0.9, 0.1, ...] },
 *     { alias: "gpt-4o",     embedding: [0.8, 0.2, ...] },
 *   ],
 * });
 * const route = router.route(queryEmbedding);
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface MFModelProfile {
  alias: string;
  embedding: number[];
}

export interface MFRouteResult {
  chosenAlias: string;
  score: number;
  allScores: { alias: string; score: number }[];
}

export interface MFBilinearRouterConfig {
  latentDim: number;
  models: MFModelProfile[];
  /** Pre-trained weight matrices. If omitted, uses Xavier initialization. */
  textProjection?: number[][]; // W1: latentDim x inputDim
  outputWeights?: number[]; // w2: latentDim
}

// ── Xavier initialization ────────────────────────────────────────────────────

function xavierInit(rows: number, cols: number): number[][] {
  const limit = Math.sqrt(6 / (rows + cols));
  const mat: number[][] = [];
  for (let i = 0; i < rows; i++) {
    const row: number[] = [];
    for (let j = 0; j < cols; j++) {
      row.push((Math.random() * 2 - 1) * limit);
    }
    mat.push(row);
  }
  return mat;
}

// ── Vector operations ────────────────────────────────────────────────────────

function matVecMul(mat: number[][], vec: number[]): number[] {
  return mat.map((row) => {
    let sum = 0;
    for (let j = 0; j < Math.min(row.length, vec.length); j++) {
      sum += row[j]! * vec[j]!;
    }
    return sum;
  });
}

function l2Normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

function hadamard(a: number[], b: number[]): number[] {
  const len = Math.min(a.length, b.length);
  const result: number[] = [];
  for (let i = 0; i < len; i++) {
    result.push(a[i]! * b[i]!);
  }
  return result;
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    sum += a[i]! * b[i]!;
  }
  return sum;
}

// ── Bilinear MF Router ───────────────────────────────────────────────────────

export class MFBilinearRouter {
  private readonly latentDim: number;
  private readonly models: MFModelProfile[];
  private readonly textProjection: number[][]; // W1
  private readonly outputWeights: number[]; // w2
  private readonly modelEmbeddings: Map<string, number[]>;

  constructor(config: MFBilinearRouterConfig) {
    this.latentDim = config.latentDim;
    this.models = config.models;

    const inputDim = config.models[0]?.embedding.length ?? 128;

    // W1: project query embedding into latent space
    this.textProjection = config.textProjection ?? xavierInit(config.latentDim, inputDim);

    // w2: output scoring weights
    this.outputWeights =
      config.outputWeights ??
      (() => {
        const limit = Math.sqrt(6 / (config.latentDim + 1));
        return Array.from({ length: config.latentDim }, () => (Math.random() * 2 - 1) * limit);
      })();

    // Normalize and store model embeddings
    this.modelEmbeddings = new Map();
    for (const m of config.models) {
      this.modelEmbeddings.set(m.alias, l2Normalize(m.embedding));
    }
  }

  /**
   * Score a single model against a query embedding.
   * δ(model, query) = w2 · (v_model ⊙ (W1 · v_query))
   */
  scoreModel(queryEmb: number[], modelAlias: string): number {
    const vModel = this.modelEmbeddings.get(modelAlias);
    if (!vModel) return 0;

    // Project query to latent space
    const projectedQuery = matVecMul(this.textProjection, queryEmb);

    // Hadamard product with model embedding
    const interaction = hadamard(vModel, projectedQuery);

    // Final score via output weights
    return dot(this.outputWeights, interaction);
  }

  /**
   * Route a query to the best model.
   * Scores all models and returns the highest.
   */
  route(queryEmb: number[]): MFRouteResult {
    const allScores = this.models.map((m) => ({
      alias: m.alias,
      score: this.scoreModel(queryEmb, m.alias),
    }));

    allScores.sort((a, b) => b.score - a.score);
    const best = allScores[0]!;

    return {
      chosenAlias: best.alias,
      score: best.score,
      allScores,
    };
  }

  /**
   * Score a query against a specific pair of models (for pairwise comparison).
   * Returns the margin: positive means model A is preferred over model B.
   */
  pairwiseScore(
    queryEmb: number[],
    modelA: string,
    modelB: string,
  ): { margin: number; preferred: string } {
    const scoreA = this.scoreModel(queryEmb, modelA);
    const scoreB = this.scoreModel(queryEmb, modelB);
    const margin = scoreA - scoreB;

    return {
      margin,
      preferred: margin >= 0 ? modelA : modelB,
    };
  }

  /** Export learned parameters for persistence. */
  exportParams(): {
    textProjection: number[][];
    outputWeights: number[];
    modelEmbeddings: Record<string, number[]>;
  } {
    const embeddings: Record<string, number[]> = {};
    for (const [alias, emb] of this.modelEmbeddings) {
      embeddings[alias] = emb;
    }
    return {
      textProjection: this.textProjection,
      outputWeights: this.outputWeights,
      modelEmbeddings: embeddings,
    };
  }
}

export default MFBilinearRouter;
