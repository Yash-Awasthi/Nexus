// SPDX-License-Identifier: Apache-2.0
/**
 * Prompt tiering — ported from inspiration/Nexus/llm-switchboard (Uo1428/llm-switchboard).
 *
 * llm-switchboard's distinctive features vs the base complexity scorer:
 *   • 4-tier output — SIMPLE / MEDIUM / COMPLEX / REASONING via configurable
 *     boundaries on a weighted score axis (scoreComplexity only gives local/cloud).
 *   • 15 weighted dimensions scored in [-1, 1] (token length, code presence,
 *     reasoning markers, technical terms, creative markers, simple indicators,
 *     multi-step patterns, question count, imperative verbs, constraints,
 *     output format, references, negation, domain specificity, agentic task).
 *   • Agentic detection — a dedicated 0–1 agenticScore from file/execution/
 *     iteration keyword hits; 3+ hits flip the router into agentic mode.
 *   • Sigmoid confidence calibration — distance from the nearest tier boundary
 *     maps to [0.5, 1]; below the threshold the tier is null ("ambiguous") and
 *     the caller applies its ambiguousDefaultTier.
 *   • Reasoning override — 2+ reasoning markers in the *user* prompt (never the
 *     system prompt) force REASONING at ≥ 0.85 confidence.
 *
 * Keyword data ships in English; the scorer config accepts any keyword lists,
 * so multilingual sets can be injected per deployment.
 */

// ── Tier ──────────────────────────────────────────────────────────────────────

export type PromptTier = "SIMPLE" | "MEDIUM" | "COMPLEX" | "REASONING";

// ── Config ────────────────────────────────────────────────────────────────────

export interface PromptTierConfig {
  /** Token-length thresholds used by the tokenCount dimension. */
  tokenCountThresholds: { simple: number; complex: number };
  /** Keyword lists per dimension (lowercased substring match). */
  keywords: {
    code: string[];
    reasoning: string[];
    technical: string[];
    creative: string[];
    simple: string[];
    imperative: string[];
    constraints: string[];
    outputFormat: string[];
    references: string[];
    negation: string[];
    domainSpecific: string[];
    agentic: string[];
  };
  /** Dimension weights — must sum to 1 for a score in the tier-axis range. */
  dimensionWeights: Record<DimensionName, number>;
  /** Weighted-score boundaries: score < simpleMedium → SIMPLE, etc. */
  tierBoundaries: { simpleMedium: number; mediumComplex: number; complexReasoning: number };
  /** Sigmoid steepness for confidence calibration (llm-switchboard default: 12). */
  confidenceSteepness: number;
  /** Below this confidence the tier is null (ambiguous). Default: 0.7. */
  confidenceThreshold: number;
}

export interface PromptTierResult {
  /** Weighted score across all dimensions. */
  score: number;
  /** Classified tier, or null when ambiguous (confidence below threshold). */
  tier: PromptTier | null;
  /** Sigmoid-calibrated confidence in [0.5, 1]. */
  confidence: number;
  /** Human-readable signals for each dimension that fired. */
  signals: string[];
  /** Agentic-task score in [0, 1] — independent of the tier axis. */
  agenticScore: number;
}

export type DimensionName =
  | "tokenCount"
  | "codePresence"
  | "reasoningMarkers"
  | "technicalTerms"
  | "creativeMarkers"
  | "simpleIndicators"
  | "multiStepPatterns"
  | "questionComplexity"
  | "imperativeVerbs"
  | "constraintCount"
  | "outputFormat"
  | "referenceComplexity"
  | "negationComplexity"
  | "domainSpecificity"
  | "agenticTask";

const EN_KEYWORDS = {
  code: [
    "function", "class", "import", "def", "select", "async", "await", "const",
    "let", "var", "return", "```",
  ],
  reasoning: [
    "prove", "theorem", "derive", "step by step", "chain of thought", "formally",
    "mathematical", "proof", "logically",
  ],
  technical: [
    "algorithm", "optimize", "architecture", "distributed", "kubernetes",
    "microservice", "database", "infrastructure",
  ],
  creative: ["story", "poem", "compose", "brainstorm", "creative", "imagine", "write a"],
  simple: [
    "what is", "define", "translate", "hello", "yes or no", "capital of",
    "how old", "who is", "when was",
  ],
  imperative: [
    "build", "create", "implement", "design", "develop", "construct",
    "generate", "deploy", "configure", "set up",
  ],
  constraints: [
    "under", "at most", "at least", "within", "no more than", "o(", "maximum",
    "minimum", "limit", "budget",
  ],
  outputFormat: ["json", "yaml", "xml", "table", "csv", "markdown", "schema", "format as", "structured"],
  references: ["above", "below", "previous", "following", "the docs", "the api", "the code", "earlier", "attached"],
  negation: ["don't", "do not", "avoid", "never", "without", "except", "exclude", "no longer"],
  domainSpecific: [
    "quantum", "fpga", "vlsi", "risc-v", "asic", "photonics", "genomics",
    "proteomics", "topological", "homomorphic", "zero-knowledge", "lattice-based",
  ],
  agentic: [
    "read file", "read the file", "look at", "check the", "open the", "edit",
    "modify", "update the", "change the", "write to", "create file", "execute",
    "deploy", "install", "npm", "pip", "compile", "after that", "and also",
    "once done", "step 1", "step 2", "fix", "debug", "until it works",
    "keep trying", "iterate", "make sure", "verify", "confirm",
  ],
};

/** llm-switchboard default configuration (weights/boundaries verbatim). */
export const PROMPT_TIER_DEFAULTS: PromptTierConfig = {
  tokenCountThresholds: { simple: 50, complex: 500 },
  keywords: EN_KEYWORDS,
  dimensionWeights: {
    tokenCount: 0.08,
    codePresence: 0.15,
    reasoningMarkers: 0.18,
    technicalTerms: 0.1,
    creativeMarkers: 0.05,
    simpleIndicators: 0.02,
    multiStepPatterns: 0.12,
    questionComplexity: 0.05,
    imperativeVerbs: 0.03,
    constraintCount: 0.04,
    outputFormat: 0.03,
    referenceComplexity: 0.02,
    negationComplexity: 0.01,
    domainSpecificity: 0.02,
    agenticTask: 0.04,
  },
  tierBoundaries: { simpleMedium: 0.0, mediumComplex: 0.3, complexReasoning: 0.5 },
  confidenceSteepness: 12,
  confidenceThreshold: 0.7,
};

// ── Dimension scoring ─────────────────────────────────────────────────────────

interface DimensionScore {
  name: DimensionName;
  score: number; // in [-1, 1]
  signal: string | null;
}

function countHits(text: string, keywords: string[]): string[] {
  return keywords.filter((kw) => text.includes(kw.toLowerCase()));
}

function dim(name: DimensionName, score: number, signal: string | null): DimensionScore {
  return { name, score, signal };
}

function tokenDim(estimatedTokens: number, cfg: PromptTierConfig): DimensionScore {
  if (estimatedTokens < cfg.tokenCountThresholds.simple) {
    return dim("tokenCount", -1.0, `short (${estimatedTokens} tokens)`);
  }
  if (estimatedTokens > cfg.tokenCountThresholds.complex) {
    return dim("tokenCount", 1.0, `long (${estimatedTokens} tokens)`);
  }
  return dim("tokenCount", 0, null);
}

/** Keyword-hit dimension: none → scores.none, ≥low → scores.low, ≥high → scores.high. */
function keywordDim(
  name: DimensionName,
  hits: string[],
  label: string,
  thresholds: { low: number; high: number },
  scores: { none: number; low: number; high: number },
): DimensionScore {
  if (hits.length >= thresholds.high) {
    return dim(name, scores.high, `${label} (${hits.slice(0, 3).join(", ")})`);
  }
  if (hits.length >= thresholds.low) {
    return dim(name, scores.low, `${label} (${hits.slice(0, 3).join(", ")})`);
  }
  return dim(name, scores.none, null);
}

function multiStepDim(text: string): DimensionScore {
  const patterns = [/first.*then/i, /step \d/i, /\d\.\s/];
  if (patterns.some((p) => p.test(text))) return dim("multiStepPatterns", 0.5, "multi-step");
  return dim("multiStepPatterns", 0, null);
}

function questionDim(prompt: string): DimensionScore {
  const count = (prompt.match(/\?/g) ?? []).length;
  if (count > 3) return dim("questionComplexity", 0.5, `${count} questions`);
  return dim("questionComplexity", 0, null);
}

/** Agentic threshold scoring: ≥4 hits = 1.0, ≥3 = 0.6 (auto-agentic), ≥1 = 0.2. */
function agenticDim(text: string, keywords: string[]): { d: DimensionScore; score: number } {
  const hits = countHits(text, keywords);
  if (hits.length >= 4) {
    return {
      d: dim("agenticTask", 1.0, `agentic (${hits.slice(0, 3).join(", ")})`),
      score: 1.0,
    };
  }
  if (hits.length >= 3) {
    return {
      d: dim("agenticTask", 0.6, `agentic (${hits.slice(0, 3).join(", ")})`),
      score: 0.6,
    };
  }
  if (hits.length >= 1) {
    return {
      d: dim("agenticTask", 0.2, `agentic-light (${hits.slice(0, 3).join(", ")})`),
      score: 0.2,
    };
  }
  return { d: dim("agenticTask", 0, null), score: 0 };
}

// ── Confidence ────────────────────────────────────────────────────────────────

/** Sigmoid calibration mapping distance-from-boundary to [0.5, 1]. */
export function calibrateConfidence(distance: number, steepness: number): number {
  return 1 / (1 + Math.exp(-steepness * distance));
}

// ── Classifier ────────────────────────────────────────────────────────────────

/**
 * Classify a prompt into a 4-tier band with calibrated confidence and an
 * independent agentic score. Faithful port of llm-switchboard's classifyByRules:
 * reasoning markers are read from the *user* prompt only, so a system prompt
 * containing "step by step" never forces the REASONING tier.
 */
export function classifyPrompt(
  prompt: string,
  opts: {
    systemPrompt?: string;
    estimatedTokens?: number;
    config?: PromptTierConfig;
  } = {},
): PromptTierResult {
  const cfg = opts.config ?? PROMPT_TIER_DEFAULTS;
  const k = cfg.keywords;
  const combined = `${opts.systemPrompt ?? ""} ${prompt}`.toLowerCase();
  const userText = prompt.toLowerCase();
  const tokens = opts.estimatedTokens ?? 0;

  const dimensions: DimensionScore[] = [
    tokenDim(tokens, cfg),
    keywordDim("codePresence", countHits(combined, k.code), "code", { low: 1, high: 2 }, { none: 0, low: 0.5, high: 1.0 }),
    keywordDim("reasoningMarkers", countHits(userText, k.reasoning), "reasoning", { low: 1, high: 2 }, { none: 0, low: 0.7, high: 1.0 }),
    keywordDim("technicalTerms", countHits(combined, k.technical), "technical", { low: 2, high: 4 }, { none: 0, low: 0.5, high: 1.0 }),
    keywordDim("creativeMarkers", countHits(combined, k.creative), "creative", { low: 1, high: 2 }, { none: 0, low: 0.5, high: 0.7 }),
    keywordDim("simpleIndicators", countHits(combined, k.simple), "simple", { low: 1, high: 2 }, { none: 0, low: -1.0, high: -1.0 }),
    multiStepDim(combined),
    questionDim(prompt),
    keywordDim("imperativeVerbs", countHits(combined, k.imperative), "imperative", { low: 1, high: 2 }, { none: 0, low: 0.3, high: 0.5 }),
    keywordDim("constraintCount", countHits(combined, k.constraints), "constraints", { low: 1, high: 3 }, { none: 0, low: 0.3, high: 0.7 }),
    keywordDim("outputFormat", countHits(combined, k.outputFormat), "format", { low: 1, high: 2 }, { none: 0, low: 0.4, high: 0.7 }),
    keywordDim("referenceComplexity", countHits(combined, k.references), "references", { low: 1, high: 2 }, { none: 0, low: 0.3, high: 0.5 }),
    keywordDim("negationComplexity", countHits(combined, k.negation), "negation", { low: 2, high: 3 }, { none: 0, low: 0.3, high: 0.5 }),
    keywordDim("domainSpecificity", countHits(combined, k.domainSpecific), "domain-specific", { low: 1, high: 2 }, { none: 0, low: 0.5, high: 0.8 }),
  ];

  const agentic = agenticDim(combined, k.agentic);
  dimensions.push(agentic.d);

  const signals = dimensions.filter((d) => d.signal !== null).map((d) => d.signal as string);

  let weightedScore = 0;
  for (const d of dimensions) {
    weightedScore += d.score * (cfg.dimensionWeights[d.name] ?? 0);
  }

  // Direct reasoning override: 2+ reasoning markers in the user prompt.
  const reasoningHits = countHits(userText, k.reasoning);
  if (reasoningHits.length >= 2) {
    const confidence = Math.max(
      calibrateConfidence(Math.max(weightedScore, 0.3), cfg.confidenceSteepness),
      0.85,
    );
    return { score: weightedScore, tier: "REASONING", confidence, signals, agenticScore: agentic.score };
  }

  const { simpleMedium, mediumComplex, complexReasoning } = cfg.tierBoundaries;
  let tier: PromptTier;
  let distanceFromBoundary: number;
  if (weightedScore < simpleMedium) {
    tier = "SIMPLE";
    distanceFromBoundary = simpleMedium - weightedScore;
  } else if (weightedScore < mediumComplex) {
    tier = "MEDIUM";
    distanceFromBoundary = Math.min(weightedScore - simpleMedium, mediumComplex - weightedScore);
  } else if (weightedScore < complexReasoning) {
    tier = "COMPLEX";
    distanceFromBoundary = Math.min(
      weightedScore - mediumComplex,
      complexReasoning - weightedScore,
    );
  } else {
    tier = "REASONING";
    distanceFromBoundary = weightedScore - complexReasoning;
  }

  const confidence = calibrateConfidence(distanceFromBoundary, cfg.confidenceSteepness);
  if (confidence < cfg.confidenceThreshold) {
    return { score: weightedScore, tier: null, confidence, signals, agenticScore: agentic.score };
  }
  return { score: weightedScore, tier, confidence, signals, agenticScore: agentic.score };
}
