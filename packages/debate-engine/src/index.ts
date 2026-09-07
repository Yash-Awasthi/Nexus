// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/debate-engine — Multi-round debate with quality validation and weighted scoring.
 *
 * Inspired by csv610/AIDebator:
 *   • Organizer/Supporter/Opposer/Judge roles
 *   • Multi-round alternating arguments
 *   • Quality validation — automated termination if quality falls below threshold
 *   • Weighted scoring — evidence quality weighted at 40%
 *   • Dynamic adjustments — bonuses for acknowledging valid opponent points
 *   • Strategy adaptation — debaters receive intermediate scores
 *
 * Complements @nexus/council (deliberation) with structured debate mechanics.
 */

// ── Types ──────────────────────────────────────────────────────────────────

/** Debate participant roles. */
export type DebateRole = "organizer" | "supporter" | "opposer" | "judge";

/** Debate configuration. */
export interface DebateConfig {
  /** The topic to debate. */
  topic: string;
  /** Number of rounds (default: 3). */
  numRounds: number;
  /** Quality threshold for termination (0-10, default: 3). */
  qualityThreshold: number;
  /** Weight for evidence quality in scoring (0-1, default: 0.4). */
  evidenceWeight: number;
  /** Maximum consecutive low-quality arguments before termination (default: 2). */
  maxLowQuality: number;
}

/** A single argument in the debate. */
export interface Argument {
  /** Unique argument ID. */
  id: string;
  /** Round number. */
  round: number;
  /** Role that made this argument. */
  role: DebateRole;
  /** The argument content. */
  content: string;
  /** Quality score (0-10). */
  qualityScore: number;
  /** Timestamp. */
  timestamp: string;
}

/** Scoring criteria. */
export interface ScoringCriteria {
  /** Argument quality (0-10). */
  argumentQuality: number;
  /** Evidence quality (0-10). */
  evidenceQuality: number;
  /** Logical consistency (0-10). */
  logicalConsistency: number;
  /** Responsiveness to gaps (0-10). */
  responsivenessToGaps: number;
  /** Overall score (0-10). */
  overallScore: number;
}

/** A scored argument with detailed feedback. */
export interface ScoredArgument extends Argument {
  /** Detailed scoring criteria. */
  criteria: ScoringCriteria;
  /** Feedback for improvement. */
  feedback: string;
  /** Bonus points for acknowledging valid opponent points. */
  acknowledgmentBonus: number;
  /** Penalty for unaddressed weaknesses. */
  weaknessPenalty: number;
}

/** Debate result. */
export interface DebateResult {
  /** The original topic. */
  topic: string;
  /** All arguments in order. */
  arguments: Argument[];
  /** Final scores for each debater. */
  finalScores: {
    supporter: ScoringCriteria;
    opposer: ScoringCriteria;
  };
  /** Winner determination. */
  winner: "supporter" | "opposer" | "tie";
  /** Judge's final verdict. */
  verdict: string;
  /** Total rounds completed. */
  roundsCompleted: number;
  /** Whether the debate was terminated early. */
  earlyTermination: boolean;
  /** Reason for early termination (if applicable). */
  terminationReason?: string;
}

// ── Quality Validation ─────────────────────────────────────────────────────

/**
 * Validate argument quality and determine if debate should continue.
 */
export function validateArgumentQuality(
  argument: string,
  previousArguments: Argument[],
  config: DebateConfig,
): { valid: boolean; reason?: string; qualityScore: number } {
  // Basic quality checks
  if (!argument || argument.trim().length < 50) {
    return { valid: false, reason: "Argument too short", qualityScore: 0 };
  }

  // Check for repetition
  const isRepetitive = previousArguments.some((prev) => {
    const similarity = computeSimilarity(argument, prev.content);
    return similarity > 0.8;
  });

  if (isRepetitive) {
    return { valid: false, reason: "Argument is repetitive", qualityScore: 2 };
  }

  // Check for off-topic content
  const topicWords = config.topic.toLowerCase().split(/\s+/);
  const argLower = argument.toLowerCase();
  const topicRelevance = topicWords.filter((w) => argLower.includes(w)).length / topicWords.length;

  if (topicRelevance < 0.1) {
    return { valid: false, reason: "Argument appears off-topic", qualityScore: 3 };
  }

  // Compute quality score (simplified heuristic)
  const qualityScore = computeQualityScore(argument);

  if (qualityScore < config.qualityThreshold) {
    return {
      valid: false,
      reason: `Quality score ${qualityScore.toFixed(1)} below threshold ${config.qualityThreshold}`,
      qualityScore,
    };
  }

  return { valid: true, qualityScore };
}

/**
 * Compute a simple quality score for an argument.
 */
function computeQualityScore(argument: string): number {
  let score = 5; // Base score

  // Length bonus (longer arguments often more substantive)
  if (argument.length > 500) score += 1;
  if (argument.length > 1000) score += 1;

  // Evidence indicators
  const evidencePatterns = [
    /\b(study|research|evidence|data|statistics|according to)\b/i,
    /\b(example|instance|case study)\b/i,
    /\b(because|therefore|consequently|thus)\b/i,
  ];
  const evidenceCount = evidencePatterns.filter((p) => p.test(argument)).length;
  score += Math.min(evidenceCount, 2);

  // Logical structure indicators
  const logicPatterns = [
    /\b(first|second|third|finally)\b/i,
    /\b(however|moreover|furthermore|additionally)\b/i,
    /\b(in contrast|on the other hand|conversely)\b/i,
  ];
  const logicCount = logicPatterns.filter((p) => p.test(argument)).length;
  score += Math.min(logicCount, 2);

  return Math.min(10, Math.max(0, score));
}

/**
 * Compute similarity between two strings (simple Jaccard).
 */
function computeSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);
  return union.size > 0 ? intersection.size / union.size : 0;
}

// ── Weighted Scoring ───────────────────────────────────────────────────────

/**
 * Compute weighted score with evidence quality emphasis.
 */
export function computeWeightedScore(
  criteria: ScoringCriteria,
  evidenceWeight: number = 0.4,
): number {
  const otherWeight = (1 - evidenceWeight) / 4;
  return (
    criteria.argumentQuality * otherWeight +
    criteria.evidenceQuality * evidenceWeight +
    criteria.logicalConsistency * otherWeight +
    criteria.responsivenessToGaps * otherWeight +
    criteria.overallScore * otherWeight
  );
}

/**
 * Compute acknowledgment bonus for recognizing valid opponent points.
 */
export function computeAcknowledgmentBonus(
  currentArgument: string,
  opponentArguments: Argument[],
): number {
  let bonus = 0;

  for (const opponent of opponentArguments) {
    // Check if current argument acknowledges opponent's point
    const acknowledges = [
      /\b(acknowledge|concede|admit|recognize|valid point)\b/i,
      /\b(opponent correctly|opponent rightly|fair point)\b/i,
      /\b(makes a good point|has a point)\b/i,
    ].some((p) => p.test(currentArgument));

    if (acknowledges) {
      bonus += 0.5;
    }
  }

  return Math.min(bonus, 2); // Cap at 2 points
}

/**
 * Compute weakness penalty for unaddressed points.
 */
export function computeWeaknessPenalty(
  currentArgument: string,
  opponentArguments: Argument[],
): number {
  let penalty = 0;

  for (const opponent of opponentArguments) {
    // Check if opponent raised a point that wasn't addressed
    const addressed = [
      /\b(refute|counter|rebut|address|respond to)\b/i,
      /\b(opponent claims|opponent argues|opponent states)\b/i,
    ].some((p) => p.test(currentArgument));

    if (!addressed) {
      penalty += 0.25;
    }
  }

  return Math.min(penalty, 1); // Cap at 1 point
}

// ── Debate Session ─────────────────────────────────────────────────────────

/**
 * A structured debate session with quality validation and weighted scoring.
 */
export class DebateSession {
  private config: DebateConfig;
  private arguments: Argument[] = [];
  private lowQualityCount = 0;

  constructor(config: DebateConfig) {
    this.config = config;
  }

  /**
   * Add an argument to the debate.
   */
  addArgument(
    role: DebateRole,
    content: string,
    round: number,
  ): { accepted: boolean; qualityScore: number; reason?: string } {
    const validation = validateArgumentQuality(content, this.arguments, this.config);

    if (!validation.valid) {
      this.lowQualityCount++;
      if (this.lowQualityCount >= this.config.maxLowQuality) {
        return {
          accepted: false,
          qualityScore: validation.qualityScore,
          reason: `Debate terminated: ${validation.reason} (consecutive low-quality: ${this.lowQualityCount})`,
        };
      }
      return {
        accepted: false,
        qualityScore: validation.qualityScore,
        reason: validation.reason,
      };
    }

    // Reset low quality counter on valid argument
    this.lowQualityCount = 0;

    const argument: Argument = {
      id: `arg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      round,
      role,
      content,
      qualityScore: validation.qualityScore,
      timestamp: new Date().toISOString(),
    };

    this.arguments.push(argument);
    return { accepted: true, qualityScore: validation.qualityScore };
  }

  /**
   * Get all arguments for a specific role.
   */
  getArgumentsByRole(role: DebateRole): Argument[] {
    return this.arguments.filter((a) => a.role === role);
  }

  /**
   * Get all arguments for a specific round.
   */
  getArgumentsByRound(round: number): Argument[] {
    return this.arguments.filter((a) => a.round === round);
  }

  /**
   * Check if debate should terminate early.
   */
  shouldTerminate(): { terminate: boolean; reason?: string } {
    if (this.lowQualityCount >= this.config.maxLowQuality) {
      return {
        terminate: true,
        reason: `Too many consecutive low-quality arguments (${this.lowQualityCount})`,
      };
    }

    // Check if we've completed all rounds
    const maxRound = Math.max(...this.arguments.map((a) => a.round), 0);
    if (maxRound >= this.config.numRounds) {
      return { terminate: true, reason: "All rounds completed" };
    }

    return { terminate: false };
  }

  /**
   * Generate a summary of the debate so far.
   */
  generateSummary(): {
    totalArguments: number;
    averageQuality: number;
    roundsCompleted: number;
    supporterScore: number;
    opposerScore: number;
  } {
    const supporterArgs = this.getArgumentsByRole("supporter");
    const opposerArgs = this.getArgumentsByRole("opposer");

    const avgQuality =
      this.arguments.length > 0
        ? this.arguments.reduce((sum, a) => sum + a.qualityScore, 0) / this.arguments.length
        : 0;

    const supporterAvg =
      supporterArgs.length > 0
        ? supporterArgs.reduce((sum, a) => sum + a.qualityScore, 0) / supporterArgs.length
        : 0;

    const opposerAvg =
      opposerArgs.length > 0
        ? opposerArgs.reduce((sum, a) => sum + a.qualityScore, 0) / opposerArgs.length
        : 0;

    const maxRound = Math.max(...this.arguments.map((a) => a.round), 0);

    return {
      totalArguments: this.arguments.length,
      averageQuality: avgQuality,
      roundsCompleted: maxRound,
      supporterScore: supporterAvg,
      opposerScore: opposerAvg,
    };
  }
}

// ── Factory Function ───────────────────────────────────────────────────────

/**
 * Create a new debate session with sensible defaults.
 */
export function createDebate(
  topic: string,
  options: Partial<DebateConfig> = {},
): DebateSession {
  const config: DebateConfig = {
    topic,
    numRounds: options.numRounds ?? 3,
    qualityThreshold: options.qualityThreshold ?? 3,
    evidenceWeight: options.evidenceWeight ?? 0.4,
    maxLowQuality: options.maxLowQuality ?? 2,
  };

  return new DebateSession(config);
}

export {
  majorityFinalAnswer,
  runMultiAgentDebate,
} from "./multiagent-debate.js";
export type {
  AgentMessage,
  AgentTranscript,
  MultiAgentDebateOptions,
  MultiAgentDebateResult,
} from "./multiagent-debate.js";
