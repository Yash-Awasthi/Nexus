// SPDX-License-Identifier: Apache-2.0
/**
 * chat-suggestions — LLM-driven proactive query suggestions from chat history.
 *
 * Provides:
 *   • SuggestionContext   — extracted context from a conversation
 *   • SuggestionResult    — a single proactive suggestion
 *   • ContextExtractor    — pull topics/entities from message history
 *   • SuggestionGenerator — call LLM (injectable) to generate suggestions
 *   • SuggestionRanker    — reorder by novelty + relevance
 *   • SuggestionCache     — dedup across sessions
 *   • SuggestionEngine    — orchestrates context → generate → rank → cache
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type SuggestionCategory =
  | "clarification"
  | "deep-dive"
  | "alternative"
  | "next-step"
  | "related-topic";

/** Chat message interface definition. */
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: string;
}

/** Suggestion context interface definition. */
export interface SuggestionContext {
  topics: string[];
  entities: string[];
  lastUserIntent: string;
  conversationSummary: string;
  messageCount: number;
}

/** Suggestion result interface definition. */
export interface SuggestionResult {
  id: string;
  text: string;
  category: SuggestionCategory;
  relevanceScore: number; // 0-1
  noveltyScore: number; // 0-1 — how different from past suggestions
  finalScore: number; // weighted combination
  reasoning: string;
}

// ── LLM interface ─────────────────────────────────────────────────────────────

export type SuggestionLlmFn = (systemPrompt: string, userMessage: string) => Promise<string>;

const DEFAULT_LLM: SuggestionLlmFn = async (_sys, user) => {
  // Fallback for tests: returns 3 mock suggestions as JSON
  return JSON.stringify([
    {
      text: `Tell me more about ${user.slice(0, 30)}`,
      category: "deep-dive",
      reasoning: "User seems interested",
    },
    { text: "What are the alternatives?", category: "alternative", reasoning: "Explore options" },
    { text: "What should I do next?", category: "next-step", reasoning: "Natural progression" },
  ]);
};

// ── ID util ───────────────────────────────────────────────────────────────────

let _seq = 0;
function uid() {
  return `sug-${Date.now()}-${++_seq}`;
}

// ── ContextExtractor ──────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "have",
  "has",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "in",
  "on",
  "at",
  "by",
  "for",
  "with",
  "about",
  "to",
  "of",
  "and",
  "or",
  "but",
  "so",
  "if",
  "this",
  "that",
  "these",
  "those",
  "it",
  "i",
  "you",
  "we",
  "they",
  "what",
  "how",
  "when",
  "where",
  "why",
  "which",
  "who",
]);

function extractWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));
}

/** Context extractor. */
export class ContextExtractor {
  extract(messages: ChatMessage[], topicLimit = 10): SuggestionContext {
    const recentMessages = messages.slice(-20);
    const userMessages = recentMessages.filter((m) => m.role === "user");
    const allText = recentMessages.map((m) => m.content).join(" ");

    // Topic extraction: most frequent non-stop words
    const freq = new Map<string, number>();
    for (const word of extractWords(allText)) {
      freq.set(word, (freq.get(word) ?? 0) + 1);
    }
    const topics = [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topicLimit)
      .map(([w]) => w);

    // Entity extraction: capitalised sequences (heuristic)
    const entityRe = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g;
    const entities = [...new Set([...allText.matchAll(entityRe)].map((m) => m[1]!))].slice(0, 10);

    // Last user intent: last user message trimmed
    const lastUserMsg = userMessages[userMessages.length - 1]?.content ?? "";
    const lastUserIntent = lastUserMsg.slice(0, 200);

    // Conversation summary: first + last few words
    const words = allText.split(/\s+/).filter(Boolean);
    const conversationSummary =
      words.length > 30
        ? `${words.slice(0, 10).join(" ")} ... ${words.slice(-10).join(" ")}`
        : allText.slice(0, 200);

    return { topics, entities, lastUserIntent, conversationSummary, messageCount: messages.length };
  }
}

// ── SuggestionGenerator ───────────────────────────────────────────────────────

export interface GeneratorOptions {
  llmFn?: SuggestionLlmFn;
  maxSuggestions?: number;
}

interface RawSuggestion {
  text: string;
  category?: SuggestionCategory;
  reasoning?: string;
}

/** Suggestion generator. */
export class SuggestionGenerator {
  private llmFn: SuggestionLlmFn;
  private maxSuggestions: number;

  constructor(opts: GeneratorOptions = {}) {
    this.llmFn = opts.llmFn ?? DEFAULT_LLM;
    this.maxSuggestions = opts.maxSuggestions ?? 5;
  }

  async generate(context: SuggestionContext): Promise<SuggestionResult[]> {
    const systemPrompt = [
      "You are a helpful assistant generating follow-up question suggestions.",
      `Topics discussed: ${context.topics.slice(0, 5).join(", ")}`,
      `Key entities: ${context.entities.slice(0, 5).join(", ")}`,
      `Generate ${this.maxSuggestions} diverse suggestions as JSON array.`,
      'Each item: { "text": "...", "category": "clarification|deep-dive|alternative|next-step|related-topic", "reasoning": "..." }',
    ].join("\n");

    const userMessage = `Last user intent: ${context.lastUserIntent}\nContext: ${context.conversationSummary}`;

    let raw: RawSuggestion[] = [];
    try {
      const response = await this.llmFn(systemPrompt, userMessage);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const parsed = JSON.parse(response);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      raw = Array.isArray(parsed) ? parsed : [];
    } catch {
      raw = [];
    }

    return raw.slice(0, this.maxSuggestions).map((r) => ({
      id: uid(),
      text: r.text ?? "",
      category: r.category ?? "related-topic",
      relevanceScore: 0.75,
      noveltyScore: 1.0, // will be set by ranker
      finalScore: 0.75,
      reasoning: r.reasoning ?? "",
    }));
  }
}

// ── SuggestionRanker ──────────────────────────────────────────────────────────

export class SuggestionRanker {
  private seenTexts: Set<string>;
  private relevanceWeight: number;
  private noveltyWeight: number;

  constructor(
    opts: { seenTexts?: Set<string>; relevanceWeight?: number; noveltyWeight?: number } = {},
  ) {
    this.seenTexts = opts.seenTexts ?? new Set();
    this.relevanceWeight = opts.relevanceWeight ?? 0.6;
    this.noveltyWeight = opts.noveltyWeight ?? 0.4;
  }

  rank(suggestions: SuggestionResult[], context: SuggestionContext): SuggestionResult[] {
    return suggestions
      .map((s) => {
        // Novelty: penalise if text is similar to seen suggestions
        const simToSeen = [...this.seenTexts].some(
          (seen) =>
            seen.toLowerCase().includes(s.text.toLowerCase().slice(0, 20)) ||
            s.text.toLowerCase().includes(seen.toLowerCase().slice(0, 20)),
        );
        const noveltyScore = simToSeen ? 0.2 : 1.0;

        // Relevance: topic overlap
        const topicWords = context.topics.map((t) => t.toLowerCase());
        const matchCount = topicWords.filter((t) => s.text.toLowerCase().includes(t)).length;
        const relevanceScore = Math.min(0.5 + matchCount * 0.1, 1.0);

        const finalScore =
          relevanceScore * this.relevanceWeight + noveltyScore * this.noveltyWeight;
        return { ...s, relevanceScore, noveltyScore, finalScore };
      })
      .sort((a, b) => b.finalScore - a.finalScore);
  }
}

// ── SuggestionCache ───────────────────────────────────────────────────────────

export class SuggestionCache {
  private cache = new Map<string, { suggestions: SuggestionResult[]; expiresAt: number }>();
  private ttlMs: number;

  constructor(ttlMs = 60_000) {
    this.ttlMs = ttlMs;
  }

  set(sessionId: string, suggestions: SuggestionResult[]): void {
    this.cache.set(sessionId, {
      suggestions: [...suggestions],
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  get(sessionId: string): SuggestionResult[] | null {
    const entry = this.cache.get(sessionId);
    if (!entry || Date.now() > entry.expiresAt) {
      this.cache.delete(sessionId);
      return null;
    }
    return [...entry.suggestions];
  }

  invalidate(sessionId: string): void {
    this.cache.delete(sessionId);
  }
  clear(): void {
    this.cache.clear();
  }
  size(): number {
    return this.cache.size;
  }

  /** Collect all unique suggestion texts seen across sessions (for novelty). */
  seenTexts(): Set<string> {
    const texts = new Set<string>();
    for (const { suggestions } of this.cache.values()) {
      for (const s of suggestions) texts.add(s.text);
    }
    return texts;
  }
}

// ── SuggestionEngine ──────────────────────────────────────────────────────────

export interface EngineOptions {
  llmFn?: SuggestionLlmFn;
  maxSuggestions?: number;
  cacheTtlMs?: number;
}

/** Suggestion engine. */
export class SuggestionEngine {
  private extractor: ContextExtractor;
  private generator: SuggestionGenerator;
  private ranker: SuggestionRanker;
  private cache: SuggestionCache;

  constructor(opts: EngineOptions = {}) {
    this.extractor = new ContextExtractor();
    this.generator = new SuggestionGenerator({
      llmFn: opts.llmFn,
      maxSuggestions: opts.maxSuggestions,
    });
    this.ranker = new SuggestionRanker();
    this.cache = new SuggestionCache(opts.cacheTtlMs);
  }

  async suggest(
    sessionId: string,
    messages: ChatMessage[],
    forceRefresh = false,
  ): Promise<SuggestionResult[]> {
    if (!forceRefresh) {
      const cached = this.cache.get(sessionId);
      if (cached) return cached;
    }

    const context = this.extractor.extract(messages);
    const raw = await this.generator.generate(context);
    const seenTexts = this.cache.seenTexts();
    const ranked = new SuggestionRanker({ seenTexts }).rank(raw, context);
    this.cache.set(sessionId, ranked);
    return ranked;
  }

  invalidate(sessionId: string): void {
    this.cache.invalidate(sessionId);
  }

  getCache(): SuggestionCache {
    return this.cache;
  }
}
