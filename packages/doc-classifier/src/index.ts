// SPDX-License-Identifier: Apache-2.0
/**
 * doc-classifier — Rule-based + ML-ready AI document auto-classification.
 *
 * Provides:
 *   • ClassifierRule  — keyword/regex-based rule
 *   • RuleClassifier  — fast deterministic classification without LLM
 *   • ClassifierPipeline — chain multiple classifiers, return highest-confidence result
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type DocCategory =
  | "technical"
  | "legal"
  | "financial"
  | "marketing"
  | "hr"
  | "research"
  | "support"
  | "general"
  | string;

export interface ClassificationResult {
  category: DocCategory;
  confidence: number; // [0, 1]
  matchedRules?: string[];
  durationMs: number;
  classifiedAt: string;
}

export interface ClassifierRule {
  name: string;
  category: DocCategory;
  /** Array of keywords (case-insensitive). All listed keywords contribute to score. */
  keywords?: string[];
  /** Regex patterns that contribute to score when matched. */
  patterns?: RegExp[];
  /** Weight multiplier (default 1.0). Increase for high-signal rules. */
  weight?: number;
}

export interface Classifier {
  classify(content: string): ClassificationResult;
}

// ── Default rule sets ──────────────────────────────────────────────────────────

export const DEFAULT_RULES: ClassifierRule[] = [
  {
    name: "technical-code",
    category: "technical",
    keywords: ["function", "class", "import", "export", "interface", "async", "await", "const", "variable"],
    patterns: [/```[\w]*\n/, /\bAPI\b/, /\bendpoint\b/i],
    weight: 1.2,
  },
  {
    name: "legal-contract",
    category: "legal",
    keywords: ["agreement", "clause", "liability", "indemnify", "warrant", "jurisdiction", "plaintiff", "defendant", "hereby"],
    patterns: [/\bwhereas\b/i, /\bpursuant to\b/i, /\bterms and conditions\b/i],
    weight: 1.3,
  },
  {
    name: "financial-report",
    category: "financial",
    keywords: ["revenue", "profit", "loss", "balance", "assets", "liabilities", "equity", "cash flow", "EBITDA", "fiscal"],
    patterns: [/\$[\d,]+/, /\d+%\s+(?:growth|decline|increase|decrease)/i],
    weight: 1.2,
  },
  {
    name: "marketing-copy",
    category: "marketing",
    keywords: ["brand", "campaign", "audience", "conversion", "funnel", "CTA", "engagement", "ROI", "impressions", "click-through"],
    patterns: [/\bcall to action\b/i, /\blead generation\b/i],
    weight: 1.0,
  },
  {
    name: "hr-policy",
    category: "hr",
    keywords: ["employee", "onboarding", "performance", "benefits", "PTO", "vacation", "salary", "compensation", "recruiter", "interview"],
    patterns: [/\bhuman resources\b/i, /\bcode of conduct\b/i],
    weight: 1.0,
  },
  {
    name: "research-paper",
    category: "research",
    keywords: ["abstract", "hypothesis", "methodology", "experiment", "findings", "conclusion", "citation", "references", "dataset"],
    patterns: [/\bet al\./i, /\bp\s*[<>]\s*0\.\d+/],
    weight: 1.1,
  },
  {
    name: "support-ticket",
    category: "support",
    keywords: ["issue", "bug", "error", "ticket", "resolved", "customer", "request", "workaround", "priority", "escalate"],
    patterns: [/\bticket\s*#?\d+\b/i, /\bseverity\s*:\s*(low|medium|high|critical)\b/i],
    weight: 1.0,
  },
];

// ── RuleClassifier ─────────────────────────────────────────────────────────────

export class RuleClassifier implements Classifier {
  private rules: ClassifierRule[];

  constructor(rules: ClassifierRule[] = DEFAULT_RULES) {
    this.rules = rules;
  }

  classify(content: string): ClassificationResult {
    const t0 = Date.now();
    const lower = content.toLowerCase();
    const wordCount = Math.max(1, lower.split(/\s+/).length);

    const scores = new Map<DocCategory, number>();
    const allMatched = new Map<DocCategory, string[]>();

    for (const rule of this.rules) {
      let hits = 0;
      const matched: string[] = [];
      const w = rule.weight ?? 1.0;

      for (const kw of rule.keywords ?? []) {
        if (lower.includes(kw.toLowerCase())) {
          hits++;
          matched.push(kw);
        }
      }
      for (const pat of rule.patterns ?? []) {
        if (pat.test(content)) {
          hits++;
          matched.push(pat.source);
        }
      }

      if (hits > 0) {
        // Normalize by word count to avoid size bias; cap at 1
        const rawScore = Math.min(1, (hits * w * 2) / wordCount + hits * 0.08);
        const prev = scores.get(rule.category) ?? 0;
        scores.set(rule.category, Math.min(1, prev + rawScore));
        const prevMatched = allMatched.get(rule.category) ?? [];
        allMatched.set(rule.category, [...prevMatched, ...matched]);
      }
    }

    if (scores.size === 0) {
      return {
        category: "general",
        confidence: 0.1,
        matchedRules: [],
        durationMs: Date.now() - t0,
        classifiedAt: new Date().toISOString(),
      };
    }

    let bestCat: DocCategory = "general";
    let bestScore = 0;
    for (const [cat, score] of scores) {
      if (score > bestScore) {
        bestScore = score;
        bestCat = cat;
      }
    }

    return {
      category: bestCat,
      confidence: Math.min(1, bestScore),
      matchedRules: allMatched.get(bestCat) ?? [],
      durationMs: Date.now() - t0,
      classifiedAt: new Date().toISOString(),
    };
  }
}

// ── ClassifierPipeline ─────────────────────────────────────────────────────────

/**
 * Chain multiple classifiers; return the result with the highest confidence.
 */
export class ClassifierPipeline {
  private classifiers: Classifier[];

  constructor(classifiers: Classifier[]) {
    this.classifiers = classifiers;
  }

  classify(content: string): ClassificationResult {
    let best: ClassificationResult | null = null;
    for (const clf of this.classifiers) {
      const result = clf.classify(content);
      if (!best || result.confidence > best.confidence) {
        best = result;
      }
    }
    return best ?? {
      category: "general",
      confidence: 0,
      matchedRules: [],
      durationMs: 0,
      classifiedAt: new Date().toISOString(),
    };
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

/**
 * Quick single-call classify with default rules.
 */
export function classify(content: string, rules?: ClassifierRule[]): ClassificationResult {
  return new RuleClassifier(rules).classify(content);
}
