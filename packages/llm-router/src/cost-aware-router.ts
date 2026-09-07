// SPDX-License-Identifier: Apache-2.0
/**
 * Cost-aware threshold routing for Nexus LLM Router.
 *
 * Inspired by RouteLLM's matrix-factorization and similarity-weighted routers.
 * Predicts whether a strong model is likely to outperform a weak model
 * for a given prompt, and only uses the expensive model when needed.
 */

export interface ModelPair {
  strong: { alias: string; costPerToken: number; avgLatencyMs: number };
  weak: { alias: string; costPerToken: number; avgLatencyMs: number };
}

export interface RoutingDecision {
  chosenAlias: string;
  strongWinRate: number;
  threshold: number;
  estimatedCostSaving: number;
}

/**
 * Compute a heuristic "complexity score" for a prompt.
 * This is a lightweight feature extractor — replace with a trained model for production.
 */
function estimatePromptComplexity(prompt: string): number {
  let score = 0;

  // Length-based: longer prompts tend to need stronger models
  const wordCount = prompt.split(/\s+/).length;
  score += Math.min(wordCount / 200, 0.3);

  // Reasoning keywords increase complexity
  const reasoningKeywords = [
    "explain", "analyze", "compare", "contrast", "evaluate",
    "prove", "derive", "implement", "design", "architect",
    "debug", "refactor", "optimize", "reason", "think step by step",
  ];
  const lowerPrompt = prompt.toLowerCase();
  const reasoningMatches = reasoningKeywords.filter((k) => lowerPrompt.includes(k)).length;
  score += Math.min(reasoningMatches * 0.1, 0.3);

  // Code-related prompts tend to need stronger models
  const codeIndicators = [
    "```", "function", "class", "import", "def ", "const ",
    "async", "await", "Promise", "interface", "type ",
  ];
  const codeMatches = codeIndicators.filter((k) => prompt.includes(k)).length;
  score += Math.min(codeMatches * 0.08, 0.25);

  // Math/logic keywords
  const mathKeywords = [
    "equation", "integral", "derivative", "proof", "theorem",
    "algorithm", "complexity", "optimize", "minimize", "maximize",
  ];
  const mathMatches = mathKeywords.filter((k) => lowerPrompt.includes(k)).length;
  score += Math.min(mathMatches * 0.05, 0.15);

  return Math.min(score, 1);
}

export class CostAwareRouter {
  private battleHistory: Array<{
    prompt: string;
    strongWins: boolean;
    timestamp: number;
  }> = [];

  private threshold = 0.5;

  constructor(
    private router: { complete: (req: { model: string; messages: Array<{ role: string; content: string }>; maxTokens?: number }) => Promise<{ content: string; latencyMs: number }> },
    private pair: ModelPair,
    options?: { threshold?: number },
  ) {
    if (options?.threshold !== undefined) {
      this.threshold = options.threshold;
    }
  }

  /**
   * Route a prompt to the optimal model based on estimated complexity.
   */
  route(prompt: string): RoutingDecision {
    const complexity = estimatePromptComplexity(prompt);

    // Blend complexity with historical win rate if we have data
    const historicalWinRate = this.getHistoricalWinRate(prompt);
    const strongWinRate = historicalWinRate !== null
      ? 0.6 * complexity + 0.4 * historicalWinRate
      : complexity;

    const chosenAlias = strongWinRate >= this.threshold
      ? this.pair.strong.alias
      : this.pair.weak.alias;

    const costSaving = chosenAlias === this.pair.weak.alias
      ? 1 - this.pair.weak.costPerToken / this.pair.strong.costPerToken
      : 0;

    return {
      chosenAlias,
      strongWinRate,
      threshold: this.threshold,
      estimatedCostSaving: costSaving,
    };
  }

  /**
   * Record the outcome of a routing decision for future calibration.
   */
  recordOutcome(prompt: string, strongWins: boolean): void {
    this.battleHistory.push({
      prompt,
      strongWins,
      timestamp: Date.now(),
    });

    // Recalibrate threshold periodically
    if (this.battleHistory.length % 10 === 0) {
      this.calibrateThreshold();
    }
  }

  /**
   * Calibrate the threshold to achieve a target cost saving.
   * Default target: use the strong model ~40% of the time.
   */
  private calibrateThreshold(targetStrongRate = 0.4): void {
    if (this.battleHistory.length < 20) return;

    const recent = this.battleHistory.slice(-100);
    const strongWinRate = recent.filter((b) => b.strongWins).length / recent.length;

    // Adjust threshold: higher threshold → route more to weak → higher savings
    this.threshold = strongWinRate > 0
      ? 1 - (strongWinRate * targetStrongRate)
      : 0.5;

    this.threshold = Math.max(0.1, Math.min(0.9, this.threshold));
  }

  private getHistoricalWinRate(prompt: string): number | null {
    if (this.battleHistory.length === 0) return null;

    // Simple similarity: find battles with similar prompt lengths
    const promptWords = new Set(prompt.toLowerCase().split(/\s+/));
    let bestSimilarity = 0;
    let bestWinRate = 0;
    let matchCount = 0;

    for (const battle of this.battleHistory) {
      const battleWords = new Set(battle.prompt.toLowerCase().split(/\s+/));
      const intersection = [...promptWords].filter((w) => battleWords.has(w)).length;
      const union = new Set([...promptWords, ...battleWords]).size;
      const similarity = union > 0 ? intersection / union : 0;

      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestWinRate = battle.strongWins ? 1 : 0;
        matchCount = 1;
      } else if (Math.abs(similarity - bestSimilarity) < 0.05) {
        bestWinRate += battle.strongWins ? 1 : 0;
        matchCount++;
      }
    }

    return matchCount > 0 ? bestWinRate / matchCount : null;
  }
}

export default CostAwareRouter;
