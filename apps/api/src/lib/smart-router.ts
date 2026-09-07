/**
 * Smart Multi-Model Router
 *
 * Automatically routes requests to the optimal model based on task type,
 * cost, latency, and quality requirements. Supports:
 * - Task classification (code, reasoning, creative, analytical)
 * - Cost-aware routing (prefer cheaper models for simple tasks)
 * - Latency-aware routing (prefer faster models for real-time)
 * - Quality fallback (escalate to stronger model if confidence low)
 * - Consensus mode (ask multiple models, merge answers)
 */

export type TaskType =
  | "code_generation"
  | "code_review"
  | "reasoning"
  | "creative_writing"
  | "analytical"
  | "summarization"
  | "classification"
  | "translation"
  | "math"
  | "general";

export interface ModelProfile {
  id: string;
  provider: string;
  strengths: TaskType[];
  costPer1kTokens: number;   // $ per 1k tokens (input)
  avgLatencyMs: number;
  qualityScore: number;       // 1-10 benchmark score
  maxTokens: number;
  contextWindow: number;
  isAvailable: boolean;
}

export interface RoutingDecision {
  model: ModelProfile;
  reason: string;
  confidence: number;         // 0-1, how confident we are this is the best pick
  alternatives: ModelProfile[];
  estimatedCost: number;
  estimatedLatencyMs: number;
}

export interface ConsensusRequest {
  prompt: string;
  taskType: TaskType;
  models: ModelProfile[];
  majorityThreshold: number;  // 0.5 = simple majority, 0.67 = supermajority
}

export interface ConsensusResult {
  answers: Array<{
    model: string;
    answer: string;
    confidence: number;
  }>;
  mergedAnswer: string;
  agreement: number;          // 0-1, how much models agreed
  bestModel: string;          // which model had highest confidence
}

// Default model registry
const DEFAULT_MODELS: ModelProfile[] = [
  {
    id: "claude-4-sonnet",
    provider: "anthropic",
    strengths: ["code_generation", "code_review", "reasoning", "analytical"],
    costPer1kTokens: 0.003,
    avgLatencyMs: 800,
    qualityScore: 9.2,
    maxTokens: 8192,
    contextWindow: 200_000,
    isAvailable: true,
  },
  {
    id: "gpt-4o",
    provider: "openai",
    strengths: ["creative_writing", "translation", "general", "summarization"],
    costPer1kTokens: 0.005,
    avgLatencyMs: 600,
    qualityScore: 9.0,
    maxTokens: 4096,
    contextWindow: 128_000,
    isAvailable: true,
  },
  {
    id: "gemini-3.6-flash",
    provider: "google",
    strengths: ["math", "reasoning", "analytical", "code_generation"],
    costPer1kTokens: 0.00125,
    avgLatencyMs: 1200,
    qualityScore: 9.1,
    maxTokens: 8192,
    contextWindow: 1_000_000,
    isAvailable: true,
  },
  {
    id: "deepseek-r1",
    provider: "deepseek",
    strengths: ["math", "reasoning", "code_generation", "code_review"],
    costPer1kTokens: 0.00055,
    avgLatencyMs: 2000,
    qualityScore: 8.8,
    maxTokens: 8192,
    contextWindow: 128_000,
    isAvailable: true,
  },
  {
    id: "llama-3.3-70b",
    provider: "meta",
    strengths: ["general", "summarization", "classification", "creative_writing"],
    costPer1kTokens: 0.0002,
    avgLatencyMs: 400,
    qualityScore: 8.0,
    maxTokens: 4096,
    contextWindow: 128_000,
    isAvailable: true,
  },
];

export class SmartRouter {
  private models: ModelProfile[];

  constructor(models: ModelProfile[] = DEFAULT_MODELS) {
    this.models = models.filter((m) => m.isAvailable);
  }

  /**
   * Route a request to the optimal model.
   */
  route(
    taskType: TaskType,
    options?: {
      maxCost?: number;
      maxLatencyMs?: number;
      preferQuality?: boolean;
      estimatedTokens?: number;
    },
  ): RoutingDecision {
    const { maxCost, maxLatencyMs, preferQuality = false, estimatedTokens = 1000 } =
      options || {};

    // Filter eligible models
    let candidates = this.models.filter((m) => {
      if (maxCost && m.costPer1kTokens * (estimatedTokens / 1000) > maxCost) return false;
      if (maxLatencyMs && m.avgLatencyMs > maxLatencyMs) return false;
      return true;
    });

    if (candidates.length === 0) {
      candidates = this.models; // fallback to all models
    }

    // Score each candidate
    const scored = candidates.map((model) => {
      let score = 0;

      // Strength match (40% weight)
      if (model.strengths.includes(taskType)) {
        score += 40;
      }

      // Quality (25% weight)
      score += (model.qualityScore / 10) * 25;

      // Cost efficiency (20% weight)
      const cost = model.costPer1kTokens * (estimatedTokens / 1000);
      const maxCostVal = Math.max(...candidates.map((c) => c.costPer1kTokens * (estimatedTokens / 1000)));
      score += ((maxCostVal - cost) / maxCostVal) * 20;

      // Latency (15% weight)
      const maxLat = Math.max(...candidates.map((c) => c.avgLatencyMs));
      score += ((maxLat - model.avgLatencyMs) / maxLat) * 15;

      if (preferQuality) {
        score *= 1.2; // boost quality
      }

      return { model, score };
    });

    scored.sort((a, b) => b.score - a.score);
    if (scored.length === 0) {
      throw new Error(`No models available for task type: ${taskType}`);
    }
    const best = scored[0]!;
    const totalScore = scored.reduce((sum, s) => sum + s.score, 0);

    return {
      model: best.model,
      reason: `Best match for ${taskType}: ${best.model.strengths.includes(taskType) ? "strength match" : "highest overall score"}`,
      confidence: best.score / totalScore,
      alternatives: scored.slice(1, 4).map((s) => s.model),
      estimatedCost: best.model.costPer1kTokens * (estimatedTokens / 1000),
      estimatedLatencyMs: best.model.avgLatencyMs,
    };
  }

  /**
   * Consensus mode: ask multiple models, merge answers.
   */
  buildConsensusRequest(request: ConsensusRequest): ConsensusRequest {
    // Auto-select models if not specified
    if (request.models.length === 0) {
      const top3 = this.route(request.taskType).alternatives.slice(0, 2);
      const primary = this.route(request.taskType).model;
      request.models = [primary, ...top3];
    }
    return request;
  }

  /**
   * Merge consensus answers into a single response.
   */
  mergeConsensus(answers: ConsensusResult["answers"]): ConsensusResult {
    // Find agreement by comparing answers
    const agreement = this.calculateAgreement(answers);

    // Pick answer from highest-confidence model
    const best = answers.reduce((a, b) => (a.confidence > b.confidence ? a : b));

    return {
      answers,
      mergedAnswer: best.answer,
      agreement,
      bestModel: best.model,
    };
  }

  private calculateAgreement(
    answers: ConsensusResult["answers"],
  ): number {
    if (answers.length <= 1) return 1;

    // Simple string similarity heuristic
    let pairs = 0;
    let matches = 0;
    for (let i = 0; i < answers.length; i++) {
      for (let j = i + 1; j < answers.length; j++) {
        pairs++;
        const a = answers[i]!;
        const b = answers[j]!;
        if (this.similar(a.answer, b.answer)) {
          matches++;
        }
      }
    }
    return pairs > 0 ? matches / pairs : 0;
  }

  private similar(a: string, b: string): boolean {
    // Quick similarity check: Jaccard on words
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.toLowerCase().split(/\s+/));
    const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
    const union = new Set([...wordsA, ...wordsB]);
    return intersection.size / union.size > 0.4;
  }
}
