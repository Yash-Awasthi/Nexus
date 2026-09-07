// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/mlp-router — MLP (Multi-Layer Perceptron) classifier for LLM routing.
 *
 * Inspired by LLMRouter's MLPClassifierNN. Uses a feedforward neural network
 * to classify queries into the best model. Supports configurable hidden layers,
 * activation functions, and softmax output.
 *
 * Usage
 * ─────
 * ```ts
 * const router = new MLPRouter({
 *   inputDim: 128,
 *   hiddenLayers: [64, 32],
 *   numClasses: 3,
 *   classes: ["claude-opus", "gpt-4o", "llama-70b"],
 *   weights: { /* pre-trained weights *\/ },
 * });
 * const route = router.route(queryEmbedding);
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type ActivationFn = "relu" | "tanh" | "sigmoid" | "linear";

export interface MLPRouterConfig {
  inputDim: number;
  hiddenLayers: number[];
  numClasses: number;
  classes: string[];
  activation?: ActivationFn;
  /** Pre-trained weights: array of weight matrices + bias vectors per layer. */
  weights?: number[][][];
  biases?: number[][];
}

export interface MLPRouteResult {
  chosenClass: string;
  chosenAlias: string;
  probabilities: number[];
  logits: number[];
}

// ── Activation functions ─────────────────────────────────────────────────────

function activate(x: number, fn: ActivationFn): number {
  switch (fn) {
    case "relu":
      return Math.max(0, x);
    case "tanh":
      return Math.tanh(x);
    case "sigmoid":
      return 1 / (1 + Math.exp(-x));
    case "linear":
      return x;
  }
}

// ── Softmax ──────────────────────────────────────────────────────────────────

function softmax(logits: number[]): number[] {
  const maxLogit = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - maxLogit));
  const sum = exps.reduce((s, e) => s + e, 0);
  return exps.map((e) => e / sum);
}

// ── Default Xavier initialization ────────────────────────────────────────────

function xavierInit(fanIn: number, fanOut: number): number[][] {
  const limit = Math.sqrt(6 / (fanIn + fanOut));
  const weights: number[][] = [];
  for (let i = 0; i < fanOut; i++) {
    const row: number[] = [];
    for (let j = 0; j < fanIn; j++) {
      row.push((Math.random() * 2 - 1) * limit);
    }
    weights.push(row);
  }
  return weights;
}

// ── MLP Router ───────────────────────────────────────────────────────────────

export class MLPRouter {
  private readonly inputDim: number;
  private readonly numClasses: number;
  private readonly classes: string[];
  private readonly activation: ActivationFn;
  private readonly weights: number[][][];
  private readonly biases: number[][];

  constructor(config: MLPRouterConfig) {
    this.inputDim = config.inputDim;
    this.numClasses = config.numClasses;
    this.classes = config.classes;
    this.activation = config.activation ?? "relu";

    if (config.weights && config.biases) {
      this.weights = config.weights;
      this.biases = config.biases;
    } else {
      // Initialize with Xavier
      const layerDims = [config.inputDim, ...config.hiddenLayers, config.numClasses];
      this.weights = [];
      this.biases = [];
      for (let i = 0; i < layerDims.length - 1; i++) {
        this.weights.push(xavierInit(layerDims[i]!, layerDims[i + 1]!));
        this.biases.push(new Array(layerDims[i + 1]!).fill(0));
      }
    }
  }

  /**
   * Forward pass through the MLP.
   * Returns raw logits (before softmax).
   */
  forward(input: number[]): number[] {
    let current = [...input];

    for (let layer = 0; layer < this.weights.length; layer++) {
      const W = this.weights[layer]!;
      const b = this.biases[layer]!;
      const isOutputLayer = layer === this.weights.length - 1;
      const next: number[] = [];

      for (let i = 0; i < W.length; i++) {
        let sum = b[i]!;
        for (let j = 0; j < current.length; j++) {
          sum += W[i]![j]! * current[j]!;
        }
        // Output layer uses linear (logits), hidden layers use activation
        next.push(isOutputLayer ? sum : activate(sum, this.activation));
      }

      current = next;
    }

    return current;
  }

  /**
   * Route a query embedding to the best model.
   * Runs forward pass, applies softmax, returns top class.
   */
  route(input: number[]): MLPRouteResult {
    const logits = this.forward(input);
    const probabilities = softmax(logits);

    let bestIdx = 0;
    let bestProb = probabilities[0]!;
    for (let i = 1; i < probabilities.length; i++) {
      if (probabilities[i]! > bestProb) {
        bestProb = probabilities[i]!;
        bestIdx = i;
      }
    }

    return {
      chosenClass: this.classes[bestIdx]!,
      chosenAlias: this.classes[bestIdx]!,
      probabilities,
      logits,
    };
  }

  /**
   * Get top-N predictions with probabilities.
   */
  routeTopN(input: number[], n: number): Array<{ alias: string; probability: number }> {
    const logits = this.forward(input);
    const probabilities = softmax(logits);

    const indexed = probabilities.map((p, i) => ({
      alias: this.classes[i]!,
      probability: p,
    }));

    indexed.sort((a, b) => b.probability - a.probability);
    return indexed.slice(0, n);
  }

  /** Update weights (for online learning / fine-tuning). */
  setWeights(weights: number[][][], biases: number[][]): void {
    this.weights.length = 0;
    this.biases.length = 0;
    for (const w of weights) this.weights.push(w);
    for (const b of biases) this.biases.push(b);
  }

  /** Export current weights. */
  exportWeights(): { weights: number[][][]; biases: number[][] } {
    return { weights: this.weights, biases: this.biases };
  }
}

export default MLPRouter;
