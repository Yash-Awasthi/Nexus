/**
 * @nexus/adaptive-testing — Adaptive A/B testing with multi-armed bandits.
 *
 * Implements Thompson Sampling for model/prompt selection, Dynamic In-Context
 * Learning (DICL) for automatic example selection, and a feedback loop that
 * turns production data into smarter variants.  Inspired by TensorZero's
 * experimentation and optimization features.
 *
 * Key concepts:
 *   Variant    — A named configuration (model, prompt, params).
 *   Metric     — A numeric score produced by a judge or heuristic.
 *   Arm        — A variant + its posterior distribution (Beta for binary, Normal for continuous).
 *   Bandit     — Selects arms via Thompson Sampling.
 *   DICL       — Selects in-context examples from a dataset based on similarity.
 *   Optimizer  — Analyzes metrics and proposes improved variants.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Variant {
  id: string;
  name: string;
  /** Model identifier (e.g. "gpt-4o", "claude-sonnet-4-20250514") */
  model: string;
  /** System prompt or template */
  prompt: string;
  /** Optional temperature */
  temperature?: number;
  /** Optional max tokens */
  maxTokens?: number;
  /** Arbitrary config passed through to the provider */
  params?: Record<string, unknown>;
}

export interface MetricResult {
  variantId: string;
  /** Trial/infrastructure ID */
  trialId: string;
  /** 0.0–1.0 quality score */
  score: number;
  /** Whether the trial succeeded (no errors, no refusals) */
  success: boolean;
  /** Latency in milliseconds */
  latencyMs: number;
  /** Token usage */
  tokens: { input: number; output: number };
  /** Cost in USD (approximate) */
  costUsd: number;
  /** Human feedback override (if any) */
  humanScore?: number;
  /** Timestamp */
  timestamp: string;
  /** Optional tags for filtering */
  tags?: Record<string, string>;
}

// ─── Bandit Arm (Beta posterior for binary outcomes) ─────────────────────────

export class BetaArm {
  id: string;
  alpha: number; // successes + 1
  beta: number; // failures + 1
  totalTrials = 0;
  totalCost = 0;
  totalLatency = 0;

  constructor(id: string, alpha = 1, beta = 1) {
    this.id = id;
    this.alpha = alpha;
    this.beta = beta;
  }

  /** Sample from the Beta distribution (Thompson Sampling). */
  sample(): number {
    return betaSample(this.alpha, this.beta);
  }

  /** Posterior mean. */
  mean(): number {
    return this.alpha / (this.alpha + this.beta);
  }

  /** Update with a success/failure outcome. */
  update(success: boolean, costUsd = 0, latencyMs = 0): void {
    this.totalTrials++;
    this.totalCost += costUsd;
    this.totalLatency += latencyMs;
    if (success) {
      this.alpha++;
    } else {
      this.beta++;
    }
  }

  /** 95% credible interval (approximate via normal approximation). */
  credibleInterval(): [number, number] {
    const mean = this.mean();
    const n = this.alpha + this.beta;
    const std = Math.sqrt((this.alpha * this.beta) / (n * n * (n + 1)));
    return [Math.max(0, mean - 1.96 * std), Math.min(1, mean + 1.96 * std)];
  }

  serialize(): SerializedArm {
    return {
      id: this.id,
      alpha: this.alpha,
      beta: this.beta,
      totalTrials: this.totalTrials,
      totalCost: this.totalCost,
      totalLatency: this.totalLatency,
    };
  }

  static deserialize(data: SerializedArm): BetaArm {
    const arm = new BetaArm(data.id, data.alpha, data.beta);
    arm.totalTrials = data.totalTrials;
    arm.totalCost = data.totalCost;
    arm.totalLatency = data.totalLatency;
    return arm;
  }
}

export interface SerializedArm {
  id: string;
  alpha: number;
  beta: number;
  totalTrials: number;
  totalCost: number;
  totalLatency: number;
}

// ─── Normal Arm (for continuous scores 0–1) ─────────────────────────────────

export class NormalArm {
  id: string;
  mean: number;
  variance: number;
  count: number;
  totalCost = 0;
  totalLatency = 0;

  constructor(
    id: string,
    mean = 0.5,
    variance = 0.25,
    count = 0,
  ) {
    this.id = id;
    this.mean = mean;
    this.variance = variance;
    this.count = count;
  }

  /** Sample from the posterior (Normal-Normal conjugate). */
  sample(): number {
    const std = Math.sqrt(this.variance);
    return clamp(this.mean + boxMuller() * std, 0, 1);
  }

  update(score: number, costUsd = 0, latencyMs = 0): void {
    this.totalCost += costUsd;
    this.totalLatency += latencyMs;
    const priorVariance = 1; // uninformative prior
    const priorMean = 0.5;
    this.count++;

    // Bayesian update
    const posteriorPrecision = 1 / priorVariance + this.count;
    const posteriorMean =
      (priorMean / priorVariance + score * this.count) / posteriorPrecision;
    const posteriorVariance = 1 / posteriorPrecision;

    this.mean = posteriorMean;
    this.variance = posteriorVariance;
  }

  serialize(): SerializedNormalArm {
    return {
      id: this.id,
      mean: this.mean,
      variance: this.variance,
      count: this.count,
      totalCost: this.totalCost,
      totalLatency: this.totalLatency,
    };
  }

  static deserialize(data: SerializedNormalArm): NormalArm {
    const arm = new NormalArm(data.id, data.mean, data.variance, data.count);
    arm.totalCost = data.totalCost;
    arm.totalLatency = data.totalLatency;
    return arm;
  }
}

export interface SerializedNormalArm {
  id: string;
  mean: number;
  variance: number;
  count: number;
  totalCost: number;
  totalLatency: number;
}

// ─── Bandit ──────────────────────────────────────────────────────────────────

export type ArmType = "beta" | "normal";

export interface BanditConfig {
  /** Which arm type to use. Default: "normal". */
  armType?: ArmType;
  /** Minimum trials before exploitation starts (exploration-only phase). */
  minTrials?: number;
  /** Temperature for soft-max sampling (higher = more exploration). */
  temperature?: number;
  /** UCB1 exploration bonus (only used if armType is omitted). */
  explorationBonus?: number;
}

export class ThompsonBandit {
  private arms: Map<string, BetaArm | NormalArm> = new Map();
  private armType: ArmType;
  private minTrials: number;

  constructor(config?: BanditConfig) {
    this.armType = config?.armType ?? "normal";
    this.minTrials = config?.minTrials ?? 0;
  }

  /** Register a variant as an arm. */
  addArm(variantId: string): void {
    if (!this.arms.has(variantId)) {
      if (this.armType === "beta") {
        this.arms.set(variantId, new BetaArm(variantId));
      } else {
        this.arms.set(variantId, new NormalArm(variantId));
      }
    }
  }

  /** Select the best arm via Thompson Sampling. */
  select(): string {
    const armIds = [...this.arms.keys()];
    if (armIds.length === 0) throw new Error("No arms registered");
    if (armIds.length === 1) return armIds[0];

    // In exploration-only phase, pick randomly
    const totalTrials = armIds.reduce(
      (sum, id) => sum + this.getTrials(id),
      0,
    );
    if (totalTrials < this.minTrials) {
      return armIds[Math.floor(Math.random() * armIds.length)];
    }

    // Thompson Sampling: sample from each arm's posterior, pick the highest
    let bestId = armIds[0];
    let bestSample = -Infinity;

    for (const id of armIds) {
      const arm = this.arms.get(id)!;
      const sample = arm instanceof BetaArm ? arm.sample() : arm.sample();
      if (sample > bestSample) {
        bestSample = sample;
        bestId = id;
      }
    }

    return bestId;
  }

  /** Update an arm with a metric result. */
  record(result: MetricResult): void {
    const arm = this.arms.get(result.variantId);
    if (!arm) throw new Error(`Unknown variant: ${result.variantId}`);

    if (arm instanceof BetaArm) {
      arm.update(result.success, result.costUsd, result.latencyMs);
    } else {
      const score = result.humanScore ?? result.score;
      arm.update(score, result.costUsd, result.latencyMs);
    }
  }

  /** Get the estimated value of each arm. */
  rankings(): Array<{
    variantId: string;
    mean: number;
    trials: number;
    cost: number;
    interval?: [number, number];
  }> {
    return [...this.arms.values()]
      .map((arm) => {
        if (arm instanceof BetaArm) {
          return {
            variantId: arm.id,
            mean: arm.mean(),
            trials: arm.totalTrials,
            cost: arm.totalCost,
            interval: arm.credibleInterval(),
          };
        } else {
          return {
            variantId: arm.id,
            mean: arm.mean,
            trials: arm.count,
            cost: arm.totalCost,
            interval: undefined,
          };
        }
      })
      .sort((a, b) => b.mean - a.mean);
  }

  private getTrials(id: string): number {
    const arm = this.arms.get(id);
    if (!arm) return 0;
    return arm instanceof BetaArm ? arm.totalTrials : arm.count;
  }

  /** Serialize the entire bandit state for persistence. */
  serialize(): SerializedBandit {
    return {
      armType: this.armType,
      minTrials: this.minTrials,
      arms: [...this.arms.values()].map((arm) =>
        arm instanceof BetaArm
          ? { ...arm.serialize(), type: "beta" as const }
          : { ...arm.serialize(), type: "normal" as const },
      ),
    };
  }

  static deserialize(data: SerializedBandit): ThompsonBandit {
    const bandit = new ThompsonBandit({
      armType: data.armType,
      minTrials: data.minTrials,
    });
    for (const armData of data.arms) {
      if (armData.type === "beta") {
        bandit.arms.set(armData.id, BetaArm.deserialize(armData));
      } else {
        bandit.arms.set(armData.id, NormalArm.deserialize(armData));
      }
    }
    return bandit;
  }
}

export interface SerializedBandit {
  armType: ArmType;
  minTrials: number;
  arms: Array<
    | ({ type: "beta" } & SerializedArm)
    | ({ type: "normal" } & SerializedNormalArm)
  >;
}

// ─── DICL (Dynamic In-Context Learning) ──────────────────────────────────────

export interface DiclExample {
  id: string;
  input: string;
  output: string;
  embedding?: number[];
  tags?: string[];
}

/**
 * Selects the most relevant in-context examples from a dataset based on
 * embedding similarity to the current query.  This is the core of
 * Dynamic In-Context Learning (DICL).
 */
export class DiclSelector {
  private examples: DiclExample[] = [];
  private maxExamples: number;

  constructor(maxExamples = 5) {
    this.maxExamples = maxExamples;
  }

  /** Add examples to the dataset. */
  addExamples(examples: DiclExample[]): void {
    this.examples.push(...examples);
  }

  /**
   * Select the best examples for a given query.
   * If embeddings are available, uses cosine similarity.
   * Otherwise, falls back to simple keyword matching.
   */
  select(query: string, queryEmbedding?: number[]): DiclExample[] {
    if (this.examples.length === 0) return [];

    const scored = this.examples.map((ex) => ({
      example: ex,
      score:
        queryEmbedding && ex.embedding
          ? cosineSimilarity(queryEmbedding, ex.embedding)
          : keywordScore(query, ex.input + " " + ex.output),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, this.maxExamples).map((s) => s.example);
  }

  /**
   * Build a prompt with dynamically selected examples.
   */
  buildPrompt(
    query: string,
    queryEmbedding?: number[],
    systemPrompt?: string,
  ): string {
    const examples = this.select(query, queryEmbedding);
    const parts: string[] = [];

    if (systemPrompt) {
      parts.push(systemPrompt);
      parts.push("");
    }

    if (examples.length > 0) {
      parts.push("Here are some relevant examples:");
      parts.push("");
      for (const ex of examples) {
        parts.push(`Input: ${ex.input}`);
        parts.push(`Output: ${ex.output}`);
        parts.push("");
      }
    }

    parts.push(`Input: ${query}`);
    parts.push("Output:");

    return parts.join("\n");
  }

  /** Serialize the selector state. */
  serialize(): DiclExample[] {
    return this.examples;
  }

  static deserialize(
    data: DiclExample[],
    maxExamples = 5,
  ): DiclSelector {
    const selector = new DiclSelector(maxExamples);
    selector.addExamples(data);
    return selector;
  }
}

// ─── Experiment Tracker ──────────────────────────────────────────────────────

export interface ExperimentConfig {
  id: string;
  name: string;
  variants: Variant[];
  /** Primary metric name */
  metric: string;
  /** Significance level for early stopping */
  significanceLevel?: number;
  /** Max samples per variant */
  maxSamples?: number;
}

export interface ExperimentResult {
  experimentId: string;
  status: "running" | "completed" | "stopped";
  winner?: string;
  rankings: Array<{
    variantId: string;
    mean: number;
    trials: number;
    cost: number;
    ci?: [number, number];
  }>;
  totalSamples: number;
  totalCost: number;
  startedAt: string;
  endedAt?: string;
}

/**
 * Tracks an experiment with multiple variants, automatically selects
 * the best variant via Thompson Sampling, and supports early stopping.
 */
export class ExperimentTracker {
  private experiments = new Map<string, {
    config: ExperimentConfig;
    bandit: ThompsonBandit;
    metrics: MetricResult[];
    startedAt: string;
  }>();

  /** Create a new experiment. */
  create(config: ExperimentConfig): void {
    const bandit = new ThompsonBandit({ armType: "normal", minTrials: 2 });
    for (const v of config.variants) {
      bandit.addArm(v.id);
    }
    this.experiments.set(config.id, {
      config,
      bandit,
      metrics: [],
      startedAt: new Date().toISOString(),
    });
  }

  /** Get the next variant to test. */
  nextVariant(experimentId: string): Variant {
    const exp = this.experiments.get(experimentId);
    if (!exp) throw new Error(`Unknown experiment: ${experimentId}`);

    const selectedId = exp.bandit.select();
    return exp.config.variants.find((v) => v.id === selectedId)!;
  }

  /** Record a metric result for an experiment. */
  record(experimentId: string, result: MetricResult): void {
    const exp = this.experiments.get(experimentId);
    if (!exp) throw new Error(`Unknown experiment: ${experimentId}`);

    exp.metrics.push(result);
    exp.bandit.record(result);
  }

  /** Get the current state of an experiment. */
  getState(experimentId: string): ExperimentResult {
    const exp = this.experiments.get(experimentId);
    if (!exp) throw new Error(`Unknown experiment: ${experimentId}`);

    const rankings = exp.bandit.rankings();
    const maxSamples = exp.config.maxSamples ?? Infinity;
    const totalSamples = rankings.reduce((s, r) => s + r.trials, 0);
    const totalCost = rankings.reduce((s, r) => s + r.cost, 0);
    const status =
      totalSamples >= maxSamples ? "completed" : "running";

    // Early stopping: if one arm's CI doesn't overlap with others
    let winner: string | undefined;
    if (rankings.length >= 2 && rankings[0].trials >= 10) {
      const [bestLow, bestHigh] = rankings[0].interval ?? [0, 1];
      const secondBest = rankings[1];
      const [secondLow] = secondBest.interval ?? [0, 1];
      if (bestLow > secondLow && rankings[0].trials > rankings[1].trials * 2) {
        winner = rankings[0].variantId;
      }
    }

    return {
      experimentId,
      status: winner ? "completed" : status,
      winner,
      rankings,
      totalSamples,
      totalCost,
      startedAt: exp.startedAt,
      endedAt:
        status === "completed" || winner
          ? new Date().toISOString()
          : undefined,
    };
  }

  /** List all experiments. */
  list(): Array<{ id: string; name: string; status: string; samples: number }> {
    return [...this.experiments.entries()].map(([id, exp]) => {
      const state = this.getState(id);
      return {
        id,
        name: exp.config.name,
        status: state.status,
        samples: state.totalSamples,
      };
    });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Box-Muller transform for normal distribution sampling. */
function boxMuller(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Simple Beta distribution sampling via Jöhnk's algorithm (for small α, β). */
function betaSample(alpha: number, beta: number): number {
  // For small parameters, use Jöhnk's algorithm
  if (alpha < 1 || beta < 1) {
    // Use gamma-based sampling
    const ga = gammaSample(alpha);
    const gb = gammaSample(beta);
    return ga / (ga + gb);
  }
  // For larger parameters, normal approximation
  const mean = alpha / (alpha + beta);
  const variance =
    (alpha * beta) / ((alpha + beta) * (alpha + beta) * (alpha + beta + 1));
  const z = boxMuller();
  return clamp(mean + z * Math.sqrt(variance), 0, 1);
}

/** Gamma distribution sampling (Marsaglia and Tsang method). */
function gammaSample(shape: number): number {
  if (shape < 1) {
    return gammaSample(shape + 1) * Math.pow(Math.random(), 1 / shape);
  }

  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);

  while (true) {
    let x, v;
    do {
      x = boxMuller();
      v = 1 + c * x;
    } while (v <= 0);

    v = v * v * v;
    const u = Math.random();

    if (u < 1 - 0.0331 * (x * x) * (x * x)) {
      return d * v;
    }

    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
      return d * v;
    }
  }
}

/** Cosine similarity between two vectors. */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Simple keyword overlap score. */
function keywordScore(query: string, text: string): number {
  const queryWords = new Set(query.toLowerCase().split(/\s+/));
  const textWords = new Set(text.toLowerCase().split(/\s+/));
  let overlap = 0;
  for (const w of queryWords) {
    if (textWords.has(w)) overlap++;
  }
  return overlap / Math.max(queryWords.size, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
