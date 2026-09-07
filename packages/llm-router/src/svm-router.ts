// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/svm-router — SVM-inspired classifier for LLM routing.
 *
 * Inspired by LLMRouter's SVMRouter. Uses RBF kernel similarity against
 * support vectors to classify queries into the best model. Pre-computed
 * support vectors and dual coefficients are loaded at init time.
 *
 * Usage
 * ─────
 * ```ts
 * const router = new SVMRouter({
 *   classes: ["claude-opus", "gpt-4o", "llama-70b"],
 *   supportVectors: [[...], [...]],
 *   dualCoefficients: [[...], [...]],
 *   gamma: 0.1,
 *   intercepts: [0.5, -0.3],
 * });
 * const route = router.route(queryEmbedding);
 * ```
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface SVMRouterConfig {
  classes: string[];
  /** Support vectors: array of embedding vectors. */
  supportVectors: number[][];
  /** Dual coefficients: one row per class (excluding one). */
  dualCoefficients: number[][];
  /** RBF kernel gamma parameter. Default: 1/inputDim. */
  gamma?: number;
  /** Decision function intercepts per class. */
  intercepts: number[];
}

export interface SVMRouteResult {
  chosenAlias: string;
  decisionValues: number[];
  confidence: number;
}

// ── RBF Kernel ───────────────────────────────────────────────────────────────

function rbfKernel(a: number[], b: number[], gamma: number): number {
  let sqDist = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = a[i]! - b[i]!;
    sqDist += diff * diff;
  }
  return Math.exp(-gamma * sqDist);
}

// ── SVM Router ───────────────────────────────────────────────────────────────

export class SVMRouter {
  private readonly classes: string[];
  private readonly supportVectors: number[][];
  private readonly dualCoefficients: number[][];
  private readonly gamma: number;
  private readonly intercepts: number[];

  constructor(config: SVMRouterConfig) {
    this.classes = config.classes;
    this.supportVectors = config.supportVectors;
    this.dualCoefficients = config.dualCoefficients;
    this.intercepts = config.intercepts;
    // Default gamma = 1 / numFeatures
    const numFeatures = config.supportVectors[0]?.length ?? 1;
    this.gamma = config.gamma ?? 1 / numFeatures;
  }

  /**
   * Compute decision function values for all classes.
   * decision_k(x) = sum_i(alpha_ki * K(x, sv_i)) + intercept_k
   */
  private decisionFunction(input: number[]): number[] {
    const numClasses = this.classes.length;
    const values: number[] = new Array(numClasses).fill(0);

    // Compute kernel values against all support vectors
    const kernelValues: number[] = [];
    for (const sv of this.supportVectors) {
      kernelValues.push(rbfKernel(input, sv, this.gamma));
    }

    // For one-vs-rest: each dualCoefficients row corresponds to a class
    for (let k = 0; k < numClasses - 1; k++) {
      const coeffs = this.dualCoefficients[k] ?? [];
      let sum = 0;
      for (let i = 0; i < coeffs.length; i++) {
        sum += coeffs[i]! * (kernelValues[i] ?? 0);
      }
      values[k] = sum + (this.intercepts[k] ?? 0);
    }

    // Last class gets 0 decision value (one-vs-rest convention)
    // The actual class is the one with the highest decision value

    return values;
  }

  /**
   * Route a query embedding to the best model.
   * Computes decision values and picks the class with highest value.
   */
  route(input: number[]): SVMRouteResult {
    const decisionValues = this.decisionFunction(input);

    let bestIdx = 0;
    let bestVal = decisionValues[0]!;
    for (let i = 1; i < decisionValues.length; i++) {
      if (decisionValues[i]! > bestVal) {
        bestVal = decisionValues[i]!;
        bestIdx = i;
      }
    }

    // Confidence from decision margin
    const sorted = [...decisionValues].sort((a, b) => b - a);
    const margin = sorted[0]! - (sorted[1] ?? 0);
    const confidence = 1 / (1 + Math.exp(-margin)); // sigmoid of margin

    return {
      chosenAlias: this.classes[bestIdx]!,
      decisionValues,
      confidence,
    };
  }

  /** Update support vectors and coefficients. */
  updateModel(
    supportVectors: number[][],
    dualCoefficients: number[][],
    intercepts: number[],
  ): void {
    this.supportVectors.length = 0;
    this.dualCoefficients.length = 0;
    for (const sv of supportVectors) this.supportVectors.push(sv);
    for (const dc of dualCoefficients) this.dualCoefficients.push(dc);
    this.intercepts.length = 0;
    for (const i of intercepts) this.intercepts.push(i);
  }

  /** Get number of support vectors. */
  get numSupportVectors(): number {
    return this.supportVectors.length;
  }

  /** Get registered classes. */
  getClasses(): string[] {
    return [...this.classes];
  }
}

export default SVMRouter;
