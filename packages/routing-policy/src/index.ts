// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/routing-policy — Self-improving routing policy with evidence-based updates.
 *
 * Inspired by BitRouter's act → observe → evaluate → improve loop:
 *   1. Act — route each call using the current policy lock
 *   2. Observe — record telemetry (cost, latency, tokens, outcome) per hop
 *   3. Evaluate — admit external evaluation outcomes (cost, quality, latency)
 *   4. Improve — compile admitted evidence into a candidate policy lock
 *
 * The live route never changes implicitly between publications. Every change
 * is a diff you can read and revert.
 *
 * Features:
 *   • PolicyLock         — immutable, git-owned routing policy
 *   • RoutingPolicy       — per-step, per-context routing rules
 *   • PolicyCompiler      — turns evidence snapshots into candidate locks
 *   • EvidenceStore       — records evaluation outcomes
 *   • DecisionCertificate — cryptographic receipt for every routing decision
 *   • AdaptiveRouter      — wraps any router with self-improving loop
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** A routing decision: which model/provider to use for a given context. */
export interface RoutingDecision {
  /** The model alias or identifier chosen. */
  model: string;
  /** The provider that will serve this request. */
  provider: string;
  /** Why this decision was made. */
  reason: string;
  /** The step/tool that triggered this routing (context-aware). */
  step?: string;
  /** Confidence in this decision (0-1). */
  confidence: number;
  /** Timestamp. */
  timestamp: string;
}

/** A tier defines a group of models for a capability level. */
export interface ModelTier {
  /** Tier name (e.g. "strong", "balanced", "economy"). */
  name: string;
  /** Models in this tier, ordered by preference. */
  models: { model: string; provider: string }[];
  /** Cost per 1M input tokens (USD). */
  costPerMInput?: number;
  /** Cost per 1M output tokens (USD). */
  costPerMOutput?: number;
}

/** A routing rule maps a context to a tier. */
export interface RoutingRule {
  /** Context matcher — the step/tool name, or "*" for default. */
  step: string;
  /** Tier to use for this context. */
  tier: string;
  /** Optional override model (bypasses tier). */
  overrideModel?: string;
  /** Priority (higher = checked first). */
  priority: number;
}

/** The live routing policy — a frozen, versioned set of rules. */
export interface PolicyLock {
  /** Schema version. */
  version: "v1";
  /** Monotonically increasing policy number. */
  policyNumber: number;
  /** Hash of the previous lock (for chaining). */
  previousHash: string;
  /** Model tiers available. */
  tiers: ModelTier[];
  /** Routing rules, ordered by priority descending. */
  rules: RoutingRule[];
  /** Default tier when no rule matches. */
  defaultTier: string;
  /** Timestamp when this lock was published. */
  publishedAt: string;
  /** Human-readable change summary. */
  changelog: string;
  /** Hash of this lock's content (SHA-256). */
  hash: string;
}

/** An evidence record from an evaluation outcome. */
export interface EvaluationEvidence {
  /** Unique evidence ID. */
  id: string;
  /** The routing decision that was made. */
  decision: RoutingDecision;
  /** Actual cost incurred (USD). */
  actualCostUsd?: number;
  /** Actual latency in ms. */
  actualLatencyMs?: number;
  /** Actual token usage. */
  actualTokens?: { prompt: number; completion: number; total: number };
  /** Quality score (0-1, from evaluator). */
  qualityScore?: number;
  /** Whether the outcome was successful. */
  success: boolean;
  /** Evaluator identity. */
  evaluator: string;
  /** Timestamp when the evaluation was submitted. */
  evaluatedAt: string;
  /** Whether this evidence has been admitted into a policy compilation. */
  admitted: boolean;
  /** Policy number this evidence was evaluated against. */
  policyNumber: number;
}

/** A snapshot of admitted evidence ready for policy compilation. */
export interface EvidenceSnapshot {
  /** Policy number this snapshot is based on. */
  policyNumber: number;
  /** All admitted evidence for this policy. */
  evidence: EvaluationEvidence[];
  /** Aggregated statistics. */
  stats: {
    totalDecisions: number;
    averageCostUsd: number;
    averageLatencyMs: number;
    averageQualityScore: number;
    successRate: number;
    /** Per-tier breakdown. */
    byTier: Record<
      string,
      {
        decisions: number;
        averageCostUsd: number;
        averageLatencyMs: number;
        averageQualityScore: number;
      }
    >;
  };
}

// ── Policy Lock ───────────────────────────────────────────────────────────────

import { createHash, randomUUID } from "node:crypto";

/** Compute SHA-256 hash of a policy lock's content. */
function hashPolicy(lock: Omit<PolicyLock, "hash">): string {
  const content = JSON.stringify({
    version: lock.version,
    policyNumber: lock.policyNumber,
    previousHash: lock.previousHash,
    tiers: lock.tiers,
    rules: lock.rules,
    defaultTier: lock.defaultTier,
    publishedAt: lock.publishedAt,
    changelog: lock.changelog,
  });
  return createHash("sha256").update(content).digest("hex");
}

/** Create a new policy lock from a candidate. */
export function publishPolicy(candidate: {
  previousHash: string;
  policyNumber: number;
  tiers: ModelTier[];
  rules: RoutingRule[];
  defaultTier: string;
  changelog: string;
}): PolicyLock {
  const withoutHash = {
    version: "v1" as const,
    previousHash: candidate.previousHash,
    policyNumber: candidate.policyNumber,
    tiers: candidate.tiers,
    rules: candidate.rules,
    defaultTier: candidate.defaultTier,
    publishedAt: new Date().toISOString(),
    changelog: candidate.changelog,
  };
  return { ...withoutHash, hash: hashPolicy(withoutHash) };
}

/** Verify a policy lock chain (each lock's previousHash matches the prior hash). */
export function verifyPolicyChain(locks: PolicyLock[]): {
  valid: boolean;
  brokenAt?: number;
  reason?: string;
} {
  for (let i = 1; i < locks.length; i++) {
    if (locks[i]!.previousHash !== locks[i - 1]!.hash) {
      return {
        valid: false,
        brokenAt: i,
        reason: `Lock ${locks[i]!.policyNumber}: previousHash doesn't match prior lock hash`,
      };
    }
    const { hash: _hash, ...rest } = locks[i]!;
    const expectedHash = hashPolicy(rest);
    if (locks[i]!.hash !== expectedHash) {
      return {
        valid: false,
        brokenAt: i,
        reason: `Lock ${locks[i]!.policyNumber}: hash mismatch (content tampered)`,
      };
    }
  }
  return { valid: true };
}

// ── Decision Certificate ─────────────────────────────────────────────────────

/** A cryptographic receipt for a routing decision. */
export interface DecisionCertificate {
  /** Unique certificate ID. */
  id: string;
  /** The routing decision. */
  decision: RoutingDecision;
  /** Policy number this decision was made under. */
  policyNumber: number;
  /** Policy hash this decision was made under. */
  policyHash: string;
  /** SHA-256 of the decision content. */
  decisionHash: string;
  /** Timestamp. */
  createdAt: string;
}

/** Create a decision certificate. */
export function createDecisionCertificate(
  decision: RoutingDecision,
  policy: PolicyLock,
): DecisionCertificate {
  const content = JSON.stringify({
    model: decision.model,
    provider: decision.provider,
    reason: decision.reason,
    step: decision.step,
    confidence: decision.confidence,
    timestamp: decision.timestamp,
    policyNumber: policy.policyNumber,
  });
  return {
    id: `cert-${randomUUID().slice(0, 8)}`,
    decision,
    policyNumber: policy.policyNumber,
    policyHash: policy.hash,
    decisionHash: createHash("sha256").update(content).digest("hex"),
    createdAt: new Date().toISOString(),
  };
}

/** Verify a decision certificate against a policy. */
export function verifyDecisionCertificate(
  cert: DecisionCertificate,
  policy: PolicyLock,
): { valid: boolean; reason?: string } {
  if (cert.policyNumber !== policy.policyNumber) {
    return { valid: false, reason: "Policy number mismatch" };
  }
  if (cert.policyHash !== policy.hash) {
    return { valid: false, reason: "Policy hash mismatch" };
  }
  return { valid: true };
}

// ── Evidence Store ────────────────────────────────────────────────────────────

/** In-memory evidence store for recording evaluation outcomes. */
export class EvidenceStore {
  private evidence: EvaluationEvidence[] = [];

  /** Record a new evaluation outcome. */
  record(outcome: Omit<EvaluationEvidence, "id" | "admitted">): EvaluationEvidence {
    const entry: EvaluationEvidence = {
      ...outcome,
      id: `ev-${randomUUID().slice(0, 8)}`,
      admitted: false,
    };
    this.evidence.push(entry);
    return entry;
  }

  /** Admit evidence by ID (marks it for policy compilation). */
  admit(id: string): boolean {
    const ev = this.evidence.find((e) => e.id === id);
    if (ev) {
      ev.admitted = true;
      return true;
    }
    return false;
  }

  /** Admit all evidence for a given policy number. */
  admitAll(policyNumber: number): number {
    let count = 0;
    for (const ev of this.evidence) {
      if (ev.policyNumber === policyNumber && !ev.admitted) {
        ev.admitted = true;
        count++;
      }
    }
    return count;
  }

  /** Get all admitted evidence for a policy number. */
  getAdmitted(policyNumber: number): EvaluationEvidence[] {
    return this.evidence.filter((e) => e.admitted && e.policyNumber === policyNumber);
  }

  /** Get all evidence (any status). */
  getAll(): EvaluationEvidence[] {
    return [...this.evidence];
  }

  /** Build an evidence snapshot for policy compilation. */
  snapshot(policyNumber: number): EvidenceSnapshot {
    const admitted = this.getAdmitted(policyNumber);
    const byTier: Record<
      string,
      {
        decisions: number;
        averageCostUsd: number;
        averageLatencyMs: number;
        averageQualityScore: number;
      }
    > = {};

    for (const ev of admitted) {
      const tier = ev.decision.reason.includes("tier:")
        ? (ev.decision.reason.split("tier:")[1]?.trim() ?? "unknown")
        : "default";
      if (!byTier[tier]) {
        byTier[tier] = {
          decisions: 0,
          averageCostUsd: 0,
          averageLatencyMs: 0,
          averageQualityScore: 0,
        };
      }
      byTier[tier]!.decisions++;
      byTier[tier]!.averageCostUsd += ev.actualCostUsd ?? 0;
      byTier[tier]!.averageLatencyMs += ev.actualLatencyMs ?? 0;
      byTier[tier]!.averageQualityScore += ev.qualityScore ?? 0;
    }

    // Average the totals
    for (const tier of Object.values(byTier)) {
      if (tier.decisions > 0) {
        tier.averageCostUsd /= tier.decisions;
        tier.averageLatencyMs /= tier.decisions;
        tier.averageQualityScore /= tier.decisions;
      }
    }

    const totalDecisions = admitted.length;
    const totalCost = admitted.reduce((s, e) => s + (e.actualCostUsd ?? 0), 0);
    const totalLatency = admitted.reduce((s, e) => s + (e.actualLatencyMs ?? 0), 0);
    const totalQuality = admitted.reduce((s, e) => s + (e.qualityScore ?? 0), 0);
    const successCount = admitted.filter((e) => e.success).length;

    return {
      policyNumber,
      evidence: admitted,
      stats: {
        totalDecisions,
        averageCostUsd: totalDecisions > 0 ? totalCost / totalDecisions : 0,
        averageLatencyMs: totalDecisions > 0 ? totalLatency / totalDecisions : 0,
        averageQualityScore: totalDecisions > 0 ? totalQuality / totalDecisions : 0,
        successRate: totalDecisions > 0 ? successCount / totalDecisions : 0,
        byTier,
      },
    };
  }

  /** Clear old evidence (older than maxAgeMs). */
  cleanup(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    const before = this.evidence.length;
    this.evidence = this.evidence.filter((e) => new Date(e.evaluatedAt).getTime() > cutoff);
    return before - this.evidence.length;
  }
}

// ── Policy Compiler ───────────────────────────────────────────────────────────

/** Configuration for the policy compiler. */
export interface CompilerConfig {
  /** Minimum evidence count before proposing changes. Default: 100. */
  minEvidenceCount?: number;
  /** Maximum cost improvement threshold (ratio). Default: 0.05 (5%). */
  costImprovementThreshold?: number;
  /** Maximum quality degradation allowed (ratio). Default: 0.02 (2%). */
  maxQualityDegradation?: number;
  /** Whether to allow tier demotion. Default: true. */
  allowTierDemotion?: boolean;
}

/**
 * Compiles evidence snapshots into candidate policy locks.
 *
 * The compiler never mutates the live lock — it proposes a new one.
 * Review and publication are explicit.
 */
export class PolicyCompiler {
  private config: CompilerConfig;

  constructor(config: CompilerConfig = {}) {
    this.config = {
      minEvidenceCount: config.minEvidenceCount ?? 100,
      costImprovementThreshold: config.costImprovementThreshold ?? 0.05,
      maxQualityDegradation: config.maxQualityDegradation ?? 0.02,
      allowTierDemotion: config.allowTierDemotion ?? true,
    };
  }

  /**
   * Compile a candidate policy from evidence.
   * Returns null if there's insufficient evidence or no improvement.
   */
  compile(
    currentPolicy: PolicyLock,
    snapshot: EvidenceSnapshot,
  ): { candidate: PolicyLock; changes: string[] } | null {
    if (snapshot.stats.totalDecisions < (this.config.minEvidenceCount ?? 100)) {
      return null; // Insufficient evidence
    }

    const changes: string[] = [];
    const newRules = [...currentPolicy.rules];

    // Analyze tier performance
    const tierStats = snapshot.stats.byTier;
    const tierNames = Object.keys(tierStats);

    // Check if we can optimize routing rules based on evidence
    for (let i = 0; i < newRules.length; i++) {
      const rule = newRules[i]!;
      const tier = snapshot.stats.byTier[rule.tier];

      if (tier && tier.decisions >= 10) {
        // If this tier has high cost but low quality, suggest demotion
        if (
          this.config.allowTierDemotion &&
          tier.averageCostUsd > snapshot.stats.averageCostUsd * 1.5 &&
          tier.averageQualityScore < snapshot.stats.averageQualityScore * 0.9
        ) {
          changes.push(
            `Rule for step "${rule.step}": tier "${rule.tier}" has ${((tier.averageCostUsd / snapshot.stats.averageCostUsd - 1) * 100).toFixed(1)}% higher cost with ${((1 - tier.averageQualityScore / snapshot.stats.averageQualityScore) * 100).toFixed(1)}% lower quality`,
          );
        }
      }
    }

    // If no changes identified, return null
    if (changes.length === 0) {
      return null;
    }

    // Build candidate lock
    const candidate = publishPolicy({
      previousHash: currentPolicy.hash,
      policyNumber: currentPolicy.policyNumber + 1,
      tiers: currentPolicy.tiers,
      rules: newRules,
      defaultTier: currentPolicy.defaultTier,
      changelog: changes.join("; "),
    });

    return { candidate, changes };
  }
}

// ── Adaptive Router ───────────────────────────────────────────────────────────

/** A router that wraps any routing function with self-improving policy. */
export class AdaptiveRouter {
  private policy: PolicyLock;
  private evidenceStore: EvidenceStore;
  private compiler: PolicyCompiler;
  private certificates: DecisionCertificate[] = [];
  private history: PolicyLock[] = [];

  constructor(policy: PolicyLock, evidenceStore?: EvidenceStore, compiler?: PolicyCompiler) {
    this.policy = policy;
    this.evidenceStore = evidenceStore ?? new EvidenceStore();
    this.compiler = compiler ?? new PolicyCompiler();
    this.history = [policy];
  }

  /**
   * Route a request using the current policy.
   * Returns a routing decision with a decision certificate.
   */
  route(params: {
    step?: string;
    preferredTier?: string;
    fallbackModel?: string;
  }): RoutingDecision & { certificate: DecisionCertificate } {
    const { step, preferredTier, fallbackModel } = params;

    // Find matching rule
    let matchedRule: RoutingRule | undefined;
    for (const rule of this.policy.rules.sort((a, b) => b.priority - a.priority)) {
      if (rule.step === "*" || rule.step === step) {
        matchedRule = rule;
        break;
      }
    }

    // Resolve tier
    const tierName = preferredTier ?? matchedRule?.tier ?? this.policy.defaultTier;
    const tier = this.policy.tiers.find((t) => t.name === tierName);

    let model: string;
    let provider: string;

    if (matchedRule?.overrideModel) {
      // Direct override
      model = matchedRule.overrideModel;
      provider = "override";
    } else if (tier && tier.models.length > 0) {
      // Use first model in tier
      model = tier.models[0]!.model;
      provider = tier.models[0]!.provider;
    } else if (fallbackModel) {
      model = fallbackModel;
      provider = "fallback";
    } else {
      model = this.policy.tiers[0]?.models[0]?.model ?? "default";
      provider = this.policy.tiers[0]?.models[0]?.provider ?? "default";
    }

    const decision: RoutingDecision = {
      model,
      provider,
      reason: matchedRule
        ? `rule:${matchedRule.step} tier:${tierName}`
        : `default tier:${tierName}`,
      step,
      confidence: matchedRule ? 0.9 : 0.5,
      timestamp: new Date().toISOString(),
    };

    const certificate = createDecisionCertificate(decision, this.policy);
    this.certificates.push(certificate);

    return { ...decision, certificate };
  }

  /**
   * Record an evaluation outcome for the current policy.
   */
  recordOutcome(outcome: {
    certificate: DecisionCertificate;
    actualCostUsd?: number;
    actualLatencyMs?: number;
    actualTokens?: { prompt: number; completion: number; total: number };
    qualityScore?: number;
    success: boolean;
    evaluator: string;
  }): EvaluationEvidence {
    // Reconstruct the decision from the certificate
    const decision: RoutingDecision = {
      ...outcome.certificate.decision,
      timestamp: outcome.certificate.createdAt,
    };

    return this.evidenceStore.record({
      decision,
      actualCostUsd: outcome.actualCostUsd,
      actualLatencyMs: outcome.actualLatencyMs,
      actualTokens: outcome.actualTokens,
      qualityScore: outcome.qualityScore,
      success: outcome.success,
      evaluator: outcome.evaluator,
      evaluatedAt: new Date().toISOString(),
      policyNumber: this.policy.policyNumber,
    });
  }

  /**
   * Attempt to compile a new policy from admitted evidence.
   * Returns null if no improvement is found.
   */
  compileCandidate(): { candidate: PolicyLock; changes: string[] } | null {
    const snapshot = this.evidenceStore.snapshot(this.policy.policyNumber);
    return this.compiler.compile(this.policy, snapshot);
  }

  /**
   * Publish a new policy (explicitly called by the operator).
   */
  publish(candidate: PolicyLock): void {
    this.policy = candidate;
    this.history.push(candidate);
  }

  /** Get the current policy. */
  getPolicy(): PolicyLock {
    return this.policy;
  }

  /** Get the evidence store. */
  getEvidenceStore(): EvidenceStore {
    return this.evidenceStore;
  }

  /** Get all decision certificates. */
  getCertificates(): DecisionCertificate[] {
    return [...this.certificates];
  }

  /** Get the policy history. */
  getHistory(): PolicyLock[] {
    return [...this.history];
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/** Create a default policy with common tiers. */
export function createDefaultPolicy(): PolicyLock {
  return publishPolicy({
    previousHash: "0".repeat(64),
    policyNumber: 1,
    tiers: [
      {
        name: "strong",
        models: [
          { model: "claude-opus-4-5", provider: "anthropic" },
          { model: "gpt-5", provider: "openai" },
        ],
        costPerMInput: 15,
        costPerMOutput: 75,
      },
      {
        name: "balanced",
        models: [
          { model: "claude-sonnet-4", provider: "anthropic" },
          { model: "gpt-4o", provider: "openai" },
        ],
        costPerMInput: 3,
        costPerMOutput: 15,
      },
      {
        name: "economy",
        models: [
          { model: "claude-haiku-4", provider: "anthropic" },
          { model: "gpt-4o-mini", provider: "openai" },
          { model: "nexus/fast", provider: "groq" },
        ],
        costPerMInput: 0.25,
        costPerMOutput: 1.25,
      },
    ],
    rules: [
      { step: "*", tier: "balanced", priority: 0 },
      { step: "architecture", tier: "strong", priority: 10 },
      { step: "boilerplate", tier: "economy", priority: 10 },
      { step: "refactor", tier: "balanced", priority: 5 },
      { step: "test", tier: "economy", priority: 5 },
    ],
    defaultTier: "balanced",
    changelog: "Initial policy",
  });
}
