// SPDX-License-Identifier: Apache-2.0
/**
 * Complexity Router — classify prompts by complexity, route to local or cloud models.
 *
 * Extracted from llm-cascade-router: uses LLM-as-classifier to score prompt
 * complexity (0-100), then routes simple tasks to local models and complex
 * tasks to cloud models for cost optimization.
 *
 * Also exports the prompt tierer ported from llm-switchboard (4-tier
 * SIMPLE/MEDIUM/COMPLEX/REASONING classification with sigmoid confidence and
 * agentic detection) — see ./prompt-tier.js.
 */

// ── Prompt tiering (ported from llm-switchboard) ─────────────────────────────
export { classifyPrompt, calibrateConfidence, PROMPT_TIER_DEFAULTS } from "./prompt-tier.js";
export type {
  PromptTier,
  PromptTierConfig,
  PromptTierResult,
  DimensionName,
} from "./prompt-tier.js";

export interface ComplexitySignals {
  requiresDeepReasoning: boolean;
  domainBreadth: number;
  ambiguity: boolean;
  isGenerative: boolean;
}

export interface ComplexityResult {
  score: number;
  signals: ComplexitySignals;
  recommendation: "local" | "cloud";
}

export interface ComplexityRouterConfig {
  /** Score threshold above which to route to cloud (default: 65) */
  threshold: number;
  /** Boost for deep reasoning signals */
  deepReasoningBoost: number;
  /** Boost for generative tasks */
  generativeBoost: number;
  /** Boost for ambiguous prompts */
  ambiguityBoost: number;
  /** Boost when domain breadth >= this value */
  domainBreadthThreshold: number;
  domainBreadthBoost: number;
}

const DEFAULT_CONFIG: ComplexityRouterConfig = {
  threshold: 65,
  deepReasoningBoost: 15,
  generativeBoost: 10,
  ambiguityBoost: 5,
  domainBreadthThreshold: 3,
  domainBreadthBoost: 10,
};

/**
 * Rule-based complexity scorer (no LLM call needed).
 * Estimates complexity from prompt characteristics.
 */
export function scoreComplexity(
  prompt: string,
  config: ComplexityRouterConfig = DEFAULT_CONFIG,
): ComplexityResult {
  const words = prompt.split(/\s+/).length;
  const sentences = prompt.split(/[.!?]+/).length;
  const hasCode =
    /```[\s\S]*```/.test(prompt) || /\b(function|class|import|def|return)\b/.test(prompt);
  const hasArchitecture =
    /\b(design|architect|scale|distributed|microservice|trade-off|compare|evaluate)\b/i.test(
      prompt,
    );
  const hasAmbiguity = /\b(maybe|perhaps|or|somehow|kind of|sort of|not sure)\b/i.test(prompt);
  const isGenerative = /\b(generate|create|brainstorm|imagine|novel|innovative|invent)\b/i.test(
    prompt,
  );
  const hasMultipleDomains =
    /\b(database|network|security|api|frontend|backend|deploy|test|monitor)\b/i.test(prompt);

  // Count distinct technical domains mentioned
  const domainPatterns = [
    "database",
    "network",
    "security",
    "api",
    "frontend",
    "backend",
    "deploy",
    "test",
    "monitor",
    "cache",
    "queue",
    "auth",
    "ui",
    "ml",
    "data",
  ];
  const domainBreadth = domainPatterns.filter((d) =>
    new RegExp(`\\b${d}\\b`, "i").test(prompt),
  ).length;

  // Base score from prompt length and complexity
  let score = Math.min(40, Math.floor(words / 5) + Math.floor(sentences / 2));
  if (hasCode) score += 10;
  if (hasArchitecture) score += 20;

  // Apply boosts
  const signals: ComplexitySignals = {
    requiresDeepReasoning: hasArchitecture,
    domainBreadth,
    ambiguity: hasAmbiguity,
    isGenerative,
  };

  if (signals.requiresDeepReasoning) score = Math.min(100, score + config.deepReasoningBoost);
  if (signals.isGenerative) score = Math.min(100, score + config.generativeBoost);
  if (signals.ambiguity) score = Math.min(100, score + config.ambiguityBoost);
  if (signals.domainBreadth >= config.domainBreadthThreshold)
    score = Math.min(100, score + config.domainBreadthBoost);

  return {
    score,
    signals,
    recommendation: score >= config.threshold ? "cloud" : "local",
  };
}

/**
 * Model registry for cascade routing.
 */
export interface CascadeModel {
  id: string;
  provider: "local" | "cloud";
  endpoint: string;
  model: string;
  maxConcurrency?: number;
  costPer1kTokens?: number;
}

/**
 * Cascade Router — routes requests to local or cloud based on complexity.
 */
export class CascadeRouter {
  private localModels: CascadeModel[] = [];
  private cloudModels: CascadeModel[] = [];
  private config: ComplexityRouterConfig;
  private localIndex = 0;
  private cloudIndex = 0;

  constructor(config: Partial<ComplexityRouterConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  addModel(model: CascadeModel): void {
    if (model.provider === "local") this.localModels.push(model);
    else this.cloudModels.push(model);
  }

  /**
   * Route a prompt to the appropriate model tier.
   */
  route(prompt: string): { model: CascadeModel; complexity: ComplexityResult } {
    const complexity = scoreComplexity(prompt, this.config);

    if (complexity.recommendation === "cloud" && this.cloudModels.length > 0) {
      this.cloudIndex = (this.cloudIndex + 1) % this.cloudModels.length;
      return { model: this.cloudModels[this.cloudIndex], complexity };
    }

    if (this.localModels.length > 0) {
      this.localIndex = (this.localIndex + 1) % this.localModels.length;
      return { model: this.localModels[this.localIndex], complexity };
    }

    // Fallback to cloud
    if (this.cloudModels.length > 0) {
      this.cloudIndex = (this.cloudIndex + 1) % this.cloudModels.length;
      return { model: this.cloudModels[this.cloudIndex], complexity };
    }

    throw new Error("No models available in cascade router");
  }

  stats(): { localModels: number; cloudModels: number; threshold: number } {
    return {
      localModels: this.localModels.length,
      cloudModels: this.cloudModels.length,
      threshold: this.config.threshold,
    };
  }
}
