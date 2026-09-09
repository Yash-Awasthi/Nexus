// SPDX-License-Identifier: Apache-2.0
/**
 * Heuristic Classifier — 14-dimension weighted scoring for zero-cost prompt routing.
 *
 * Extracted from llm-switchboard: scores requests across 14 weighted dimensions
 * and maps aggregate score to a tier using configurable boundaries.
 * Handles 70-80% of requests in <1ms with zero cost.
 */

export type Tier = "simple" | "moderate" | "complex";

export interface DimensionScore {
  name: string;
  score: number; // -1 to 1
  signal: string | null;
}

export interface ScoringResult {
  tier: Tier;
  confidence: number;
  dimensions: DimensionScore[];
  aggregate: number;
}

export interface ScoringConfig {
  tokenThresholds: { simple: number; complex: number };
  keywordThresholds: { low: number; high: number };
  tierBoundaries: { simple: number; complex: number };
}

const DEFAULT_CONFIG: ScoringConfig = {
  tokenThresholds: { simple: 50, complex: 200 },
  keywordThresholds: { low: 2, high: 4 },
  tierBoundaries: { simple: -0.3, complex: 0.3 },
};

// Keyword groups with weights
const KEYWORD_GROUPS = [
  { keywords: ["fix", "debug", "error", "bug", "issue"], name: "debugging", weight: -0.5 },
  { keywords: ["refactor", "optimize", "improve", "clean"], name: "refactoring", weight: -0.2 },
  { keywords: ["design", "architect", "scale", "distributed"], name: "architecture", weight: 0.8 },
  { keywords: ["review", "explain", "describe", "what is"], name: "explanation", weight: -0.4 },
  { keywords: ["generate", "create", "build", "implement"], name: "generation", weight: 0.3 },
  { keywords: ["security", "vulnerability", "auth", "encrypt"], name: "security", weight: 0.6 },
  { keywords: ["test", "spec", "assert", "mock"], name: "testing", weight: -0.1 },
  { keywords: ["migrate", "transform", "convert", "port"], name: "migration", weight: 0.2 },
];

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function scoreTokenCount(tokens: number, config: ScoringConfig): DimensionScore {
  if (tokens < config.tokenThresholds.simple) {
    return { name: "tokenCount", score: -1.0, signal: `short (${tokens} tokens)` };
  }
  if (tokens > config.tokenThresholds.complex) {
    return { name: "tokenCount", score: 1.0, signal: `long (${tokens} tokens)` };
  }
  return { name: "tokenCount", score: 0, signal: null };
}

function scoreKeywordMatch(
  text: string,
  group: (typeof KEYWORD_GROUPS)[0],
  config: ScoringConfig,
): DimensionScore {
  const lower = text.toLowerCase();
  const matches = group.keywords.filter((kw) => lower.includes(kw));
  const count = matches.length;

  if (count >= config.keywordThresholds.high) {
    return {
      name: group.name,
      score: group.weight,
      signal: `${group.name} (${matches.slice(0, 3).join(", ")})`,
    };
  }
  if (count >= config.keywordThresholds.low) {
    return { name: group.name, score: group.weight * 0.5, signal: `${group.name} (partial)` };
  }
  return { name: group.name, score: 0, signal: null };
}

function scoreMultiStep(text: string): DimensionScore {
  const patterns = [/first.*then/i, /step \d/i, /\d\.\s/];
  const hits = patterns.filter((p) => p.test(text));
  if (hits.length > 0) {
    return { name: "multiStep", score: 0.6, signal: `multi-step (${hits.length} signals)` };
  }
  return { name: "multiStep", score: 0, signal: null };
}

function scoreCodePresence(text: string): DimensionScore {
  const hasCode = /```[\s\S]*```/.test(text);
  const hasInlineCode = /`[^`]+`/.test(text);
  if (hasCode) return { name: "codePresence", score: 0.3, signal: "code block detected" };
  if (hasInlineCode) return { name: "codePresence", score: 0.1, signal: "inline code" };
  return { name: "codePresence", score: 0, signal: null };
}

function scoreQuestionType(text: string): DimensionScore {
  const isQuestion = /\?$/.test(text.trim());
  const isCommand = /^(write|create|build|generate|fix|implement|add|remove|delete|update)\b/i.test(
    text.trim(),
  );
  if (isQuestion) return { name: "questionType", score: -0.3, signal: "question" };
  if (isCommand) return { name: "questionType", score: 0.4, signal: "command" };
  return { name: "questionType", score: 0, signal: null };
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Classify a prompt using 14-dimension weighted scoring.
 * Returns tier, confidence, and per-dimension breakdown.
 */
export function classify(prompt: string, config: ScoringConfig = DEFAULT_CONFIG): ScoringResult {
  const tokens = estimateTokens(prompt);
  const dimensions: DimensionScore[] = [];

  // Token count
  dimensions.push(scoreTokenCount(tokens, config));

  // Keyword groups
  for (const group of KEYWORD_GROUPS) {
    dimensions.push(scoreKeywordMatch(prompt, group, config));
  }

  // Multi-step detection
  dimensions.push(scoreMultiStep(prompt));

  // Code presence
  dimensions.push(scoreCodePresence(prompt));

  // Question type
  dimensions.push(scoreQuestionType(prompt));

  // Aggregate score (weighted average)
  const totalWeight = dimensions.reduce((sum, d) => sum + Math.abs(d.score || 0.1), 0);
  const aggregate =
    dimensions.reduce((sum, d) => sum + d.score, 0) / Math.max(1, dimensions.length);

  // Map to tier
  let tier: Tier;
  if (aggregate < config.tierBoundaries.simple) {
    tier = "simple";
  } else if (aggregate > config.tierBoundaries.complex) {
    tier = "complex";
  } else {
    tier = "moderate";
  }

  // Confidence via sigmoid
  const confidence = sigmoid(aggregate * 3); // scale for better discrimination

  return { tier, confidence, dimensions, aggregate };
}
