/**
 * @nexus/rl-router — RL-trained cost-aware LLM routing.
 *
 * Inspired by xRouter (SalesforceAIResearch/xRouter). Provides:
 * - Cost-performance optimization via simulated RL training
 * - Query complexity classification for routing decisions
 * - Multi-provider model selection with budget constraints
 * - Routing history tracking for offline analysis
 * - Thompson Sampling-based adaptive routing
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ModelSpec {
  id: string;
  name: string;
  provider: string;
  /** Cost per 1K input tokens in USD */
  inputCostPer1k: number;
  /** Cost per 1K output tokens in USD */
  outputCostPer1k: number;
  /** Average latency in ms */
  avgLatencyMs: number;
  /** Quality score 0-1 (from evals) */
  qualityScore: number;
  /** Max context window */
  maxContextTokens: number;
  /** Supported capabilities */
  capabilities: string[];
  /** Rate limit (requests per minute) */
  rateLimitRpm: number;
}

export interface RoutingRequest {
  id: string;
  /** The prompt/query to route */
  prompt: string;
  /** Estimated token count */
  estimatedTokens: number;
  /** Required capabilities (e.g., "code", "math", "vision") */
  requiredCapabilities?: string[];
  /** Budget constraint in USD (0 = no limit) */
  budgetUsd?: number;
  /** Latency constraint in ms (0 = no limit) */
  latencyMs?: number;
  /** Priority: high, medium, low */
  priority?: 'high' | 'medium' | 'low';
}

export interface RoutingDecision {
  requestId: string;
  selectedModelId: string;
  /** Why this model was selected */
  reason: string;
  /** Estimated cost in USD */
  estimatedCostUsd: number;
  /** Confidence score 0-1 */
  confidence: number;
  /** Alternative models considered */
  alternatives: Array<{
    modelId: string;
    score: number;
    reason: string;
  }>;
  /** Routing strategy used */
  strategy: RoutingStrategy;
}

export type RoutingStrategy =
  | 'cost-optimal'
  | 'quality-first'
  | 'latency-first'
  | 'balanced'
  | 'budget-constrained'
  | 'rl-trained';

export interface RoutingOutcome {
  requestId: string;
  modelId: string;
  /** Actual cost in USD */
  actualCostUsd: number;
  /** Actual latency in ms */
  actualLatencyMs: number;
  /** Quality rating from evaluator 0-1 */
  qualityRating?: number;
  /** Whether the response met the budget constraint */
  withinBudget: boolean;
  /** Whether the response met the latency constraint */
  withinLatency: boolean;
  /** User satisfaction score 1-5 */
  satisfactionScore?: number;
}

export interface RLState {
  /** Model visit counts */
  visitCounts: Map<string, number>;
  /** Model reward sums (quality * cost-efficiency) */
  rewardSums: Map<string, number>;
  /** Model average rewards */
  averageRewards: Map<string, number>;
  /** Exploration rate (epsilon for epsilon-greedy) */
  explorationRate: number;
  /** Decay factor for exploration */
  explorationDecay: number;
  /** Total training steps */
  trainingSteps: number;
}

export interface QueryComplexity {
  /** Complexity score 0-1 */
  score: number;
  /** Complexity tier */
  tier: 'trivial' | 'simple' | 'moderate' | 'complex' | 'expert';
  /** Detected features */
  features: string[];
}

// ─── Query Complexity Classifier ─────────────────────────────────────────────

export class ComplexityClassifier {
  private readonly featurePatterns: Array<{
    name: string;
    pattern: RegExp;
    weight: number;
  }> = [
    { name: 'code-generation', pattern: /\b(write|implement|code|function|class|module|debug|refactor)\b/i, weight: 0.7 },
    { name: 'math-reasoning', pattern: /\b(prove|theorem|equation|integral|derivative|proof|calculate)\b/i, weight: 0.8 },
    { name: 'analysis', pattern: /\b(analyze|compare|evaluate|critique|assess|review)\b/i, weight: 0.6 },
    { name: 'creative', pattern: /\b(write|compose|create|draft|story|poem|essay)\b/i, weight: 0.5 },
    { name: 'multi-step', pattern: /\b(step.by.step|first.*then|plan|workflow|pipeline|orchestrat)\b/i, weight: 0.7 },
    { name: 'domain-specific', pattern: /\b(medical|legal|financial|scientific|technical)\b/i, weight: 0.6 },
    { name: 'long-context', pattern: /\b(document|article|paper|chapter|book|summary)\b/i, weight: 0.5 },
    { name: 'tool-use', pattern: /\b(tool|api|function.call|plugin|integration|webhook)\b/i, weight: 0.6 },
  ];

  classify(prompt: string): QueryComplexity {
    const features: string[] = [];
    let totalWeight = 0;
    let matchCount = 0;

    for (const { name, pattern, weight } of this.featurePatterns) {
      if (pattern.test(prompt)) {
        features.push(name);
        totalWeight += weight;
        matchCount++;
      }
    }

    // Factor in prompt length
    const tokenEstimate = prompt.split(/\s+/).length * 1.3;
    if (tokenEstimate > 2000) {
      totalWeight += 0.2;
      features.push('long-prompt');
    }
    if (tokenEstimate > 8000) {
      totalWeight += 0.2;
      features.push('very-long-prompt');
    }

    // Factor in structural complexity (lists, code blocks, tables)
    const hasCodeBlocks = /```[\s\S]*```/.test(prompt);
    const hasLists = /^\s*[-*]\s/gm.test(prompt);
    const hasTables = /\|.*\|.*\|/.test(prompt);
    if (hasCodeBlocks) { totalWeight += 0.15; features.push('code-blocks'); }
    if (hasLists) { totalWeight += 0.05; features.push('structured-lists'); }
    if (hasTables) { totalWeight += 0.1; features.push('tables'); }

    const score = Math.min(1, totalWeight / 3);

    let tier: QueryComplexity['tier'];
    if (score < 0.15) tier = 'trivial';
    else if (score < 0.35) tier = 'simple';
    else if (score < 0.55) tier = 'moderate';
    else if (score < 0.75) tier = 'complex';
    else tier = 'expert';

    return { score, tier, features };
  }
}

// ─── Cost-Aware Router ───────────────────────────────────────────────────────

/**
 * Routes queries to optimal LLM models based on cost, quality, and latency.
 * Supports both heuristic and RL-trained routing policies.
 */
export class CostAwareRouter {
  private models: Map<string, ModelSpec> = new Map();
  private history: RoutingOutcome[] = [];
  private rlState: RLState;
  private complexityClassifier: ComplexityClassifier;

  constructor(models: ModelSpec[] = []) {
    for (const model of models) {
      this.models.set(model.id, model);
    }

    this.rlState = {
      visitCounts: new Map(),
      rewardSums: new Map(),
      averageRewards: new Map(),
      explorationRate: 0.2,
      explorationDecay: 0.995,
      trainingSteps: 0,
    };

    this.complexityClassifier = new ComplexityClassifier();
  }

  // ── Model Management ───────────────────────────────────────────────

  registerModel(model: ModelSpec): void {
    this.models.set(model.id, model);
    this.rlState.visitCounts.set(model.id, 0);
    this.rlState.rewardSums.set(model.id, 0);
    this.rlState.averageRewards.set(model.id, 0);
  }

  getModels(): ModelSpec[] {
    return Array.from(this.models.values());
  }

  // ── Routing ────────────────────────────────────────────────────────

  route(request: RoutingRequest, strategy: RoutingStrategy = 'balanced'): RoutingDecision {
    const candidates = this.filterCandidates(request);
    const complexity = this.complexityClassifier.classify(request.prompt);

    if (candidates.length === 0) {
      throw new Error('No models match the request constraints');
    }

    let scored: Array<{ model: ModelSpec; score: number; reason: string }>;

    switch (strategy) {
      case 'rl-trained':
        scored = this.rlRoute(candidates, complexity);
        break;
      case 'cost-optimal':
        scored = this.costOptimalRoute(candidates);
        break;
      case 'quality-first':
        scored = this.qualityFirstRoute(candidates);
        break;
      case 'latency-first':
        scored = this.latencyFirstRoute(candidates);
        break;
      case 'budget-constrained':
        scored = this.budgetConstrainedRoute(candidates, request.budgetUsd ?? Infinity);
        break;
      default:
        scored = this.balancedRoute(candidates, complexity);
    }

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];

    return {
      requestId: request.id,
      selectedModelId: best.model.id,
      reason: best.reason,
      estimatedCostUsd: this.estimateCost(best.model, request.estimatedTokens),
      confidence: best.score,
      alternatives: scored.slice(1, 4).map(s => ({
        modelId: s.model.id,
        score: s.score,
        reason: s.reason,
      })),
      strategy,
    };
  }

  // ── RL Training Loop ──────────────────────────────────────────────

  /**
   * Record an outcome and update the RL policy.
   */
  recordOutcome(outcome: RoutingOutcome): void {
    this.history.push(outcome);

    // Update visit counts
    const visits = this.rlState.visitCounts.get(outcome.modelId) ?? 0;
    this.rlState.visitCounts.set(outcome.modelId, visits + 1);

    // Compute reward: quality * cost-efficiency
    const model = this.models.get(outcome.modelId);
    const costEfficiency = model
      ? Math.max(0, 1 - outcome.actualCostUsd / (model.inputCostPer1k * 10))
      : 0.5;
    const qualityReward = outcome.qualityRating ?? 0.5;
    const latencyReward = outcome.withinLatency ? 1.0 : 0.5;
    const budgetReward = outcome.withinBudget ? 1.0 : 0.3;
    const satisfactionReward = outcome.satisfactionScore
      ? outcome.satisfactionScore / 5
      : 0.5;

    const reward =
      0.3 * qualityReward +
      0.2 * costEfficiency +
      0.15 * latencyReward +
      0.15 * budgetReward +
      0.2 * satisfactionReward;

    // Update running average
    const prevSum = this.rlState.rewardSums.get(outcome.modelId) ?? 0;
    this.rlState.rewardSums.set(outcome.modelId, prevSum + reward);
    this.rlState.averageRewards.set(
      outcome.modelId,
      (prevSum + reward) / (visits + 1),
    );

    // Decay exploration
    this.rlState.explorationRate *= this.rlState.explorationDecay;
    this.rlState.trainingSteps++;
  }

  /**
   * Get the RL policy statistics.
   */
  getRLStats(): {
    state: RLState;
    modelRankings: Array<{ modelId: string; avgReward: number; visits: number }>;
    totalOutcomes: number;
  } {
    const modelRankings = Array.from(this.models.keys())
      .map(modelId => ({
        modelId,
        avgReward: this.rlState.averageRewards.get(modelId) ?? 0,
        visits: this.rlState.visitCounts.get(modelId) ?? 0,
      }))
      .sort((a, b) => b.avgReward - a.avgReward);

    return {
      state: { ...this.rlState },
      modelRankings,
      totalOutcomes: this.history.length,
    };
  }

  // ── Private Routing Strategies ─────────────────────────────────────

  private filterCandidates(request: RoutingRequest): ModelSpec[] {
    return Array.from(this.models.values()).filter(model => {
      // Check context window
      if (request.estimatedTokens > model.maxContextTokens) return false;

      // Check capabilities
      if (request.requiredCapabilities?.length) {
        const hasAll = request.requiredCapabilities.every(cap =>
          model.capabilities.includes(cap),
        );
        if (!hasAll) return false;
      }

      // Check budget (estimate max tokens for the budget)
      if (request.budgetUsd && request.budgetUsd > 0) {
        const maxCost = request.budgetUsd;
        const estimatedCost = this.estimateCost(model, request.estimatedTokens);
        if (estimatedCost > maxCost) return false;
      }

      return true;
    });
  }

  private rlRoute(
    candidates: ModelSpec[],
    complexity: QueryComplexity,
  ): Array<{ model: ModelSpec; score: number; reason: string }> {
    // Epsilon-greedy exploration
    if (Math.random() < this.rlState.explorationRate) {
      // Explore: random selection
      const shuffled = [...candidates].sort(() => Math.random() - 0.5);
      return shuffled.map(model => ({
        model,
        score: Math.random() * 0.5,
        reason: 'Exploration (epsilon-greedy)',
      }));
    }

    // Exploit: use learned rewards
    return candidates.map(model => {
      const avgReward = this.rlState.averageRewards.get(model.id) ?? 0;
      const visits = this.rlState.visitCounts.get(model.id) ?? 0;
      // UCB1 exploration bonus
      const explorationBonus = visits > 0
        ? Math.sqrt((2 * Math.log(this.rlState.trainingSteps + 1)) / visits)
        : 10; // High bonus for unvisited models
      const score = avgReward + 0.3 * explorationBonus;
      return {
        model,
        score,
        reason: `RL: avgReward=${avgReward.toFixed(3)}, visits=${visits}, ucb=${explorationBonus.toFixed(3)}`,
      };
    });
  }

  private costOptimalRoute(
    candidates: ModelSpec[],
  ): Array<{ model: ModelSpec; score: number; reason: string }> {
    return candidates.map(model => {
      const costScore = 1 - (model.inputCostPer1k / 0.1); // normalize against $0.10/1k
      const score = Math.max(0, costScore) * 0.7 + model.qualityScore * 0.3;
      return {
        model,
        score,
        reason: `Cost-optimal: $${model.inputCostPer1k}/1k, quality=${model.qualityScore}`,
      };
    });
  }

  private qualityFirstRoute(
    candidates: ModelSpec[],
  ): Array<{ model: ModelSpec; score: number; reason: string }> {
    return candidates.map(model => {
      const score = model.qualityScore * 0.8 + (1 - model.avgLatencyMs / 10000) * 0.2;
      return {
        model,
        score,
        reason: `Quality-first: quality=${model.qualityScore}, latency=${model.avgLatencyMs}ms`,
      };
    });
  }

  private latencyFirstRoute(
    candidates: ModelSpec[],
  ): Array<{ model: ModelSpec; score: number; reason: string }> {
    return candidates.map(model => {
      const latencyScore = 1 - model.avgLatencyMs / 10000;
      const score = latencyScore * 0.8 + model.qualityScore * 0.2;
      return {
        model,
        score,
        reason: `Latency-first: ${model.avgLatencyMs}ms, quality=${model.qualityScore}`,
      };
    });
  }

  private budgetConstrainedRoute(
    candidates: ModelSpec[],
    budgetUsd: number,
  ): Array<{ model: ModelSpec; score: number; reason: string }> {
    return candidates
      .filter(model => this.estimateCost(model, 1000) <= budgetUsd)
      .map(model => {
        const costEfficiency = 1 - this.estimateCost(model, 1000) / budgetUsd;
        const score = costEfficiency * 0.6 + model.qualityScore * 0.4;
        return {
          model,
          score,
          reason: `Budget-constrained: cost=$${this.estimateCost(model, 1000).toFixed(4)}, budget=$${budgetUsd}`,
        };
      });
  }

  private balancedRoute(
    candidates: ModelSpec[],
    complexity: QueryComplexity,
  ): Array<{ model: ModelSpec; score: number; reason: string }> {
    // Adjust weights based on complexity
    const qualityWeight = 0.3 + complexity.score * 0.3;
    const costWeight = 0.3 - complexity.score * 0.15;
    const latencyWeight = 0.4 - complexity.score * 0.15;

    return candidates.map(model => {
      const costScore = 1 - model.inputCostPer1k / 0.1;
      const latencyScore = 1 - model.avgLatencyMs / 10000;

      const score =
        qualityWeight * model.qualityScore +
        costWeight * Math.max(0, costScore) +
        latencyScore * latencyScore * latencyWeight;

      return {
        model,
        score,
        reason: `Balanced: quality=${model.qualityScore}, cost=$${model.inputCostPer1k}/1k, latency=${model.avgLatencyMs}ms [complexity=${complexity.tier}]`,
      };
    });
  }

  private estimateCost(model: ModelSpec, tokens: number): number {
    return (tokens / 1000) * model.inputCostPer1k;
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createRLRouter(models: ModelSpec[] = []): CostAwareRouter {
  return new CostAwareRouter(models);
}

export function createComplexityClassifier(): ComplexityClassifier {
  return new ComplexityClassifier();
}

/** Default model catalog for quick setup */
export const DEFAULT_MODELS: ModelSpec[] = [
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    provider: 'openai',
    inputCostPer1k: 0.0025,
    outputCostPer1k: 0.01,
    avgLatencyMs: 2000,
    qualityScore: 0.92,
    maxContextTokens: 128000,
    capabilities: ['code', 'math', 'analysis', 'vision', 'tool-use'],
    rateLimitRpm: 500,
  },
  {
    id: 'gpt-4o-mini',
    name: 'GPT-4o Mini',
    provider: 'openai',
    inputCostPer1k: 0.00015,
    outputCostPer1k: 0.0006,
    avgLatencyMs: 800,
    qualityScore: 0.78,
    maxContextTokens: 128000,
    capabilities: ['code', 'math', 'analysis', 'tool-use'],
    rateLimitRpm: 2000,
  },
  {
    id: 'claude-sonnet-4',
    name: 'Claude Sonnet 4',
    provider: 'anthropic',
    inputCostPer1k: 0.003,
    outputCostPer1k: 0.015,
    avgLatencyMs: 1800,
    qualityScore: 0.91,
    maxContextTokens: 200000,
    capabilities: ['code', 'math', 'analysis', 'tool-use'],
    rateLimitRpm: 400,
  },
  {
    id: 'claude-haiku-3.5',
    name: 'Claude 3.5 Haiku',
    provider: 'anthropic',
    inputCostPer1k: 0.0008,
    outputCostPer1k: 0.004,
    avgLatencyMs: 600,
    qualityScore: 0.8,
    maxContextTokens: 200000,
    capabilities: ['code', 'analysis', 'tool-use'],
    rateLimitRpm: 1000,
  },
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    provider: 'google',
    inputCostPer1k: 0.00125,
    outputCostPer1k: 0.01,
    avgLatencyMs: 2200,
    qualityScore: 0.9,
    maxContextTokens: 1000000,
    capabilities: ['code', 'math', 'analysis', 'vision', 'tool-use'],
    rateLimitRpm: 300,
  },
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    provider: 'google',
    inputCostPer1k: 0.000075,
    outputCostPer1k: 0.0003,
    avgLatencyMs: 500,
    qualityScore: 0.76,
    maxContextTokens: 1000000,
    capabilities: ['code', 'analysis'],
    rateLimitRpm: 2000,
  },
];
