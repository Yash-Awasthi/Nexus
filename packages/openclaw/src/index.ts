// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/openclaw — Conversation analysis engine.
 *
 * Analyzes completed conversations and extracts:
 *   • Dominant themes (keyword cluster labels)
 *   • Intent signals (information seeking, task execution, debugging, etc.)
 *   • Tone / sentiment estimate
 *   • Top keywords (TF-weighted, stop-word filtered)
 *   • Structured ConversationInsight suitable for memory storage
 *
 * Pure — no LLM or network dependencies. Regex + frequency analysis only.
 *
 * Usage
 * ─────
 * ```ts
 * import { ConversationAnalyzer } from "@nexus/openclaw";
 *
 * const analyzer = new ConversationAnalyzer();
 * const insight = analyzer.analyze({ id: "conv-1", messages });
 * console.log(insight.themes, insight.intents, insight.topKeywords);
 * ```
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export type IntentType =
  | "information_seeking"
  | "task_execution"
  | "creative_generation"
  | "debugging"
  | "code_review"
  | "learning"
  | "planning"
  | "analysis"
  | "social";

export type Sentiment = "positive" | "neutral" | "negative" | "mixed";

export interface IntentSignal {
  type: IntentType;
  confidence: number;
  /** Example phrases that triggered this signal. */
  evidence: string[];
}

export interface ConversationInsight {
  conversationId: string;
  analyzedAt: number;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  /** High-level topic clusters detected. */
  themes: string[];
  intents: IntentSignal[];
  sentiment: Sentiment;
  dominantTone: string;
  averageUserMessageLength: number;
  /** Top N keywords sorted by TF score. */
  topKeywords: string[];
  /** One-sentence summary of what the conversation was about. */
  summary: string;
}

export interface AnalyzeOptions {
  id: string;
  messages: ConversationMessage[];
  /** Number of top keywords to return. Default 10. */
  topK?: number;
}

// ── Intent patterns ───────────────────────────────────────────────────────────

interface IntentPattern {
  type: IntentType;
  patterns: RegExp[];
}

const INTENT_PATTERNS: IntentPattern[] = [
  {
    type: "debugging",
    patterns: [
      /\b(bug|error|exception|crash|fail|broken|not working|issue|problem|fix|debug|trace|stack trace)\b/i,
      /\b(why (is|does|isn't|doesn't)|what went wrong|how to fix)\b/i,
    ],
  },
  {
    type: "code_review",
    patterns: [
      /\b(review|refactor|clean up|improve|optimize|best practice|code smell|lgtm|pull request|pr)\b/i,
      /\b(is this (correct|right|good|okay)|looks good|any issues)\b/i,
    ],
  },
  {
    type: "task_execution",
    patterns: [
      /\b(write|create|build|implement|generate|make|add|update|delete|deploy|run|execute|do)\b/i,
      /\b(can you|please|i need you to|help me)\b/i,
    ],
  },
  {
    type: "information_seeking",
    patterns: [
      /\b(what (is|are|does|do)|how (do|does|can|to)|why|when|where|who|which|explain|tell me|describe)\b/i,
      /\?/,
    ],
  },
  {
    type: "creative_generation",
    patterns: [
      /\b(write a|generate a|create a|compose|brainstorm|imagine|story|poem|idea|design|suggest)\b/i,
    ],
  },
  {
    type: "learning",
    patterns: [
      /\b(learn|understand|tutorial|example|how to|teach me|explain|walkthrough|guide|show me)\b/i,
    ],
  },
  {
    type: "planning",
    patterns: [
      /\b(plan|roadmap|strategy|steps|approach|architecture|design|outline|agenda|todo|checklist)\b/i,
    ],
  },
  {
    type: "analysis",
    patterns: [
      /\b(analyze|analyse|compare|contrast|evaluate|assess|benchmark|review|breakdown|metrics|pros and cons|trade-?off)\b/i,
    ],
  },
  {
    type: "social",
    patterns: [
      /\b(hey|hi|hello|thanks|thank you|appreciate|cool|awesome|great|good job|nice|lol|haha)\b/i,
    ],
  },
];

// ── Sentiment / tone patterns ─────────────────────────────────────────────────

const POSITIVE_RE =
  /\b(great|awesome|thanks|good|nice|excellent|perfect|love|appreciate|helpful|works|solved|fixed|success)\b/i;
const NEGATIVE_RE =
  /\b(broken|fail|error|wrong|bad|terrible|useless|doesn't work|not working|frustrated|annoyed|issue|problem|bug)\b/i;

const TONE_MAP: { pattern: RegExp; tone: string }[] = [
  { pattern: /\b(urgent|asap|immediately|critical|blocker)\b/i, tone: "urgent" },
  { pattern: /\b(curious|wondering|interesting|fascinating)\b/i, tone: "curious" },
  { pattern: /\b(help|please|can you|need)\b/i, tone: "collaborative" },
  { pattern: /\b(analyze|review|evaluate|assess)\b/i, tone: "analytical" },
  { pattern: /\b(code|function|class|implement|build)\b/i, tone: "technical" },
];

// ── Theme patterns ────────────────────────────────────────────────────────────

const THEME_MAP: { theme: string; pattern: RegExp }[] = [
  { theme: "software-development", pattern: /\b(code|function|class|variable|api|endpoint|typescript|javascript|python|rust|sql|git|npm)\b/i },
  { theme: "debugging", pattern: /\b(bug|error|exception|crash|debug|fix|issue)\b/i },
  { theme: "architecture", pattern: /\b(architecture|design|pattern|system|component|module|service|microservice)\b/i },
  { theme: "testing", pattern: /\b(test|spec|vitest|jest|coverage|assertion|mock|stub)\b/i },
  { theme: "deployment", pattern: /\b(deploy|ci\/cd|docker|kubernetes|cloud|aws|vercel|production|staging)\b/i },
  { theme: "security", pattern: /\b(security|auth|authentication|authorization|token|password|vulnerability|pentest)\b/i },
  { theme: "data", pattern: /\b(data|database|sql|nosql|schema|query|index|postgres|mongo)\b/i },
  { theme: "ai-ml", pattern: /\b(model|llm|inference|training|embedding|vector|prompt|ai|machine learning)\b/i },
  { theme: "planning", pattern: /\b(roadmap|plan|milestone|sprint|task|backlog|priority)\b/i },
  { theme: "documentation", pattern: /\b(docs|documentation|readme|comment|explain|describe)\b/i },
];

// ── Stop words ────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of",
  "with", "by", "from", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could", "should",
  "may", "might", "shall", "can", "not", "no", "nor", "so", "yet", "both",
  "either", "neither", "each", "every", "all", "any", "few", "more", "most",
  "other", "some", "such", "than", "then", "there", "these", "they", "this",
  "those", "that", "it", "its", "i", "you", "he", "she", "we", "my", "your",
  "his", "her", "our", "their", "what", "which", "who", "when", "where", "how",
  "why", "just", "also", "very", "too", "up", "out", "as", "if", "about",
]);

// ── Analyzer ──────────────────────────────────────────────────────────────────

export class ConversationAnalyzer {
  private readonly topK: number;

  constructor(opts: { topK?: number } = {}) {
    this.topK = opts.topK ?? 10;
  }

  analyze(opts: AnalyzeOptions): ConversationInsight {
    const { id, messages, topK = this.topK } = opts;
    if (messages.length === 0) {
      return this.emptyInsight(id);
    }

    const userMessages = messages.filter((m) => m.role === "user");
    const allText = messages.map((m) => m.content).join(" ");
    const userText = userMessages.map((m) => m.content).join(" ");

    const intents = this.detectIntents(userText);
    const themes = this.detectThemes(allText);
    const topKeywords = this.extractKeywords(allText, topK);
    const sentiment = this.detectSentiment(allText);
    const dominantTone = this.detectTone(userText);

    const avgLen =
      userMessages.length > 0
        ? Math.round(userMessages.reduce((s, m) => s + m.content.length, 0) / userMessages.length)
        : 0;

    const primaryIntent = intents[0]?.type ?? "information_seeking";
    const topTheme = themes[0] ?? "general";
    const summary = `Conversation about ${topTheme.replace(/-/g, " ")} with primary intent of ${primaryIntent.replace(/_/g, " ")} (${messages.length} messages).`;

    return {
      conversationId: id,
      analyzedAt: Date.now(),
      messageCount: messages.length,
      userMessageCount: userMessages.length,
      assistantMessageCount: messages.length - userMessages.length,
      themes,
      intents,
      sentiment,
      dominantTone,
      averageUserMessageLength: avgLen,
      topKeywords,
      summary,
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private detectIntents(text: string): IntentSignal[] {
    const signals: IntentSignal[] = [];

    for (const { type, patterns } of INTENT_PATTERNS) {
      const evidence: string[] = [];
      let hits = 0;

      for (const p of patterns) {
        const matches = text.match(new RegExp(p.source, "gi"));
        if (matches) {
          hits += matches.length;
          for (const m of matches.slice(0, 2)) {
            if (!evidence.includes(m.toLowerCase())) evidence.push(m.toLowerCase());
          }
        }
      }

      if (hits > 0) {
        const confidence = Math.min(hits / 5, 1.0);
        signals.push({ type, confidence, evidence: evidence.slice(0, 3) });
      }
    }

    return signals.sort((a, b) => b.confidence - a.confidence);
  }

  private detectThemes(text: string): string[] {
    const scored: { theme: string; score: number }[] = [];
    for (const { theme, pattern } of THEME_MAP) {
      const matches = text.match(new RegExp(pattern.source, "gi"));
      if (matches && matches.length > 0) {
        scored.push({ theme, score: matches.length });
      }
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .map((s) => s.theme);
  }

  private extractKeywords(text: string, topK: number): string[] {
    const words = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));

    const freq = new Map<string, number>();
    for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);

    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([w]) => w);
  }

  private detectSentiment(text: string): Sentiment {
    const posHits = (text.match(new RegExp(POSITIVE_RE.source, "gi")) ?? []).length;
    const negHits = (text.match(new RegExp(NEGATIVE_RE.source, "gi")) ?? []).length;
    if (posHits === 0 && negHits === 0) return "neutral";
    if (posHits > 0 && negHits > 0) return "mixed";
    if (posHits > negHits) return "positive";
    return "negative";
  }

  private detectTone(text: string): string {
    for (const { pattern, tone } of TONE_MAP) {
      if (pattern.test(text)) return tone;
    }
    return "neutral";
  }

  private emptyInsight(id: string): ConversationInsight {
    return {
      conversationId: id,
      analyzedAt: Date.now(),
      messageCount: 0,
      userMessageCount: 0,
      assistantMessageCount: 0,
      themes: [],
      intents: [],
      sentiment: "neutral",
      dominantTone: "neutral",
      averageUserMessageLength: 0,
      topKeywords: [],
      summary: "Empty conversation.",
    };
  }
}

/** Convenience — create a default analyzer and call analyze in one step. */
export function analyzeConversation(opts: AnalyzeOptions): ConversationInsight {
  return new ConversationAnalyzer().analyze(opts);
}
