// SPDX-License-Identifier: Apache-2.0
/**
 * sft-tagger — Conversation turn tagger for SFT (Supervised Fine-Tuning) dataset generation.
 *
 * Provides:
 *   • ConversationTurn     — a single message with role + content
 *   • TurnTag              — tag applied to a turn (instruction/response/etc.)
 *   • RuleTagger           — rule-based turn tagger
 *   • SftDataset           — accumulates and exports SFT-ready samples
 *   • DatasetFilter        — filter samples by quality signals
 *   • SftExporter          — export to JSONL / Alpaca / ShareGPT formats
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type TurnRole = "user" | "assistant" | "system" | "tool";

/** Turn tag label type alias. */
export type TurnTagLabel =
  | "instruction"
  | "response"
  | "chain-of-thought"
  | "refusal"
  | "tool-use"
  | "clarification"
  | "greeting"
  | "task-completion"
  | "error"
  | "unknown";

/** Conversation turn interface definition. */
export interface ConversationTurn {
  id: string;
  role: TurnRole;
  content: string;
  metadata?: Record<string, unknown>;
}

/** Turn tag interface definition. */
export interface TurnTag {
  turnId: string;
  label: TurnTagLabel;
  confidence: number;
  reasons: string[];
}

/** Sft sample interface definition. */
export interface SftSample {
  id: string;
  turns: ConversationTurn[];
  tags: TurnTag[];
  qualityScore: number; // 0-1
  source?: string;
  createdAt: string;
}

// ── ID util ───────────────────────────────────────────────────────────────────

let _seq = 0;
function uid(prefix: string) {
  return `${prefix}-${Date.now()}-${++_seq}`;
}

// ── RuleTagger ────────────────────────────────────────────────────────────────

interface TagRule {
  label: TurnTagLabel;
  roles: TurnRole[];
  patterns: RegExp[];
  negPatterns?: RegExp[];
  confidence: number;
  reason: string;
}

const DEFAULT_RULES: TagRule[] = [
  {
    label: "instruction",
    roles: ["user"],
    patterns: [
      /\b(please|can you|could you|help me|write|create|generate|explain|list|summarize|translate|what is|how do|when|why)\b/i,
    ],
    confidence: 0.85,
    reason: "contains instruction keywords",
  },
  {
    label: "chain-of-thought",
    roles: ["assistant"],
    patterns: [
      /\b(let me think|step by step|first,|second,|third,|1\.|2\.|3\.|\btherefore\b|\bbecause\b)/i,
    ],
    confidence: 0.8,
    reason: "contains reasoning markers",
  },
  {
    label: "refusal",
    roles: ["assistant"],
    patterns: [
      /\b(i can'?t|i am not able|i'm unable|i cannot|i won'?t|i refuse|that'?s not something)/i,
    ],
    confidence: 0.9,
    reason: "contains refusal language",
  },
  {
    label: "tool-use",
    roles: ["assistant", "tool"],
    patterns: [/```json\s*\{[^}]*"function"/i, /\btool_call\b|\bfunction_call\b|\btool_use\b/i],
    confidence: 0.9,
    reason: "contains tool call markers",
  },
  {
    label: "clarification",
    roles: ["user", "assistant"],
    patterns: [
      /\b(could you clarify|what do you mean|can you elaborate|i'm not sure what|do you mean)\b/i,
    ],
    confidence: 0.75,
    reason: "contains clarification request",
  },
  {
    label: "greeting",
    roles: ["user", "assistant"],
    patterns: [/^(hi|hello|hey|good morning|good afternoon|good evening|greetings)/i],
    confidence: 0.95,
    reason: "starts with greeting",
  },
  {
    label: "task-completion",
    roles: ["assistant"],
    patterns: [
      /\b(here'?s? (the|your)|i'?ve? (created|written|generated|completed|finished)|done!|here you go)/i,
    ],
    confidence: 0.8,
    reason: "contains task completion markers",
  },
  {
    label: "error",
    roles: ["assistant"],
    patterns: [
      /\b(error|exception|failed|failure|oops|sorry,? (something went wrong|i made a mistake))/i,
    ],
    confidence: 0.85,
    reason: "contains error language",
  },
  {
    label: "response",
    roles: ["assistant"],
    patterns: [/.{20,}/], // any non-trivially long assistant response
    confidence: 0.5,
    reason: "default assistant response",
  },
];

/** Rule tagger. */
export class RuleTagger {
  private rules: TagRule[];

  constructor(rules: TagRule[] = DEFAULT_RULES) {
    this.rules = rules;
  }

  tag(turn: ConversationTurn): TurnTag {
    const matched: { label: TurnTagLabel; confidence: number; reason: string }[] = [];

    for (const rule of this.rules) {
      if (!rule.roles.includes(turn.role)) continue;
      const hasNeg = rule.negPatterns?.some((p) => p.test(turn.content));
      if (hasNeg) continue;
      const hasPos = rule.patterns.some((p) => p.test(turn.content));
      if (hasPos) {
        matched.push({ label: rule.label, confidence: rule.confidence, reason: rule.reason });
      }
    }

    // Take highest-confidence match
    matched.sort((a, b) => b.confidence - a.confidence);
    const best = matched[0];

    if (!best) {
      return { turnId: turn.id, label: "unknown", confidence: 0.5, reasons: ["no rule matched"] };
    }

    return {
      turnId: turn.id,
      label: best.label,
      confidence: best.confidence,
      reasons: matched.map((m) => m.reason),
    };
  }

  tagAll(turns: ConversationTurn[]): TurnTag[] {
    return turns.map((t) => this.tag(t));
  }
}

// ── QualityScorer ─────────────────────────────────────────────────────────────

export class QualityScorer {
  /** Score a conversation sample 0-1. */
  score(turns: ConversationTurn[], tags: TurnTag[]): number {
    if (turns.length === 0) return 0;

    let score = 0;
    const weights = {
      hasInstruction: 0.3,
      hasResponse: 0.3,
      noRefusal: 0.2,
      lengthBonus: 0.1,
      noUnknown: 0.1,
    };

    const labels = tags.map((t) => t.label);
    if (labels.includes("instruction")) score += weights.hasInstruction;
    if (labels.includes("response") || labels.includes("task-completion"))
      score += weights.hasResponse;
    if (!labels.includes("refusal")) score += weights.noRefusal;
    if (!labels.includes("unknown")) score += weights.noUnknown;

    // Length bonus: reward substantial responses
    const assistantTurns = turns.filter((t) => t.role === "assistant");
    const avgLen =
      assistantTurns.reduce((s, t) => s + t.content.length, 0) / Math.max(assistantTurns.length, 1);
    if (avgLen > 100) score += weights.lengthBonus;

    return Math.min(score, 1);
  }
}

// ── SftDataset ────────────────────────────────────────────────────────────────

export class SftDataset {
  private samples: SftSample[] = [];
  private tagger: RuleTagger;
  private scorer: QualityScorer;

  constructor(tagger?: RuleTagger, scorer?: QualityScorer) {
    this.tagger = tagger ?? new RuleTagger();
    this.scorer = scorer ?? new QualityScorer();
  }

  /** Add a conversation as turns. Auto-assigns IDs. */
  addConversation(
    rawTurns: { role: TurnRole; content: string; metadata?: Record<string, unknown> }[],
    source?: string,
  ): SftSample {
    const turns: ConversationTurn[] = rawTurns.map((t) => ({
      id: uid("turn"),
      role: t.role,
      content: t.content,
      metadata: t.metadata,
    }));
    const tags = this.tagger.tagAll(turns);
    const qualityScore = this.scorer.score(turns, tags);
    const sample: SftSample = {
      id: uid("sample"),
      turns,
      tags,
      qualityScore,
      source,
      createdAt: new Date().toISOString(),
    };
    this.samples.push(sample);
    return sample;
  }

  get(id: string): SftSample | undefined {
    return this.samples.find((s) => s.id === id);
  }

  list(): SftSample[] {
    return [...this.samples];
  }
  count(): number {
    return this.samples.length;
  }
  clear(): void {
    this.samples = [];
  }
}

// ── DatasetFilter ─────────────────────────────────────────────────────────────

export interface FilterOptions {
  minQualityScore?: number;
  maxQualityScore?: number;
  requireLabels?: TurnTagLabel[];
  excludeLabels?: TurnTagLabel[];
  minTurns?: number;
  maxTurns?: number;
  source?: string;
}

/** Dataset filter. */
export class DatasetFilter {
  filter(samples: SftSample[], opts: FilterOptions = {}): SftSample[] {
    return samples.filter((sample) => {
      if (opts.minQualityScore !== undefined && sample.qualityScore < opts.minQualityScore)
        return false;
      if (opts.maxQualityScore !== undefined && sample.qualityScore > opts.maxQualityScore)
        return false;
      if (opts.minTurns !== undefined && sample.turns.length < opts.minTurns) return false;
      if (opts.maxTurns !== undefined && sample.turns.length > opts.maxTurns) return false;
      if (opts.source && sample.source !== opts.source) return false;

      const labels = sample.tags.map((t) => t.label);
      if (opts.requireLabels?.length && !opts.requireLabels.every((l) => labels.includes(l)))
        return false;
      if (opts.excludeLabels?.length && opts.excludeLabels.some((l) => labels.includes(l)))
        return false;

      return true;
    });
  }
}

// ── SftExporter ───────────────────────────────────────────────────────────────

export type ExportFormat = "jsonl" | "alpaca" | "sharegpt";

/** Alpaca sample interface definition. */
export interface AlpacaSample {
  instruction: string;
  input: string;
  output: string;
}

/** Share gpt sample interface definition. */
export interface ShareGptSample {
  conversations: { from: "human" | "gpt" | "system"; value: string }[];
}

/** Sft exporter. */
export class SftExporter {
  /** Export as JSONL (one JSON object per line). */
  toJsonl(samples: SftSample[]): string {
    return samples.map((s) => JSON.stringify(s)).join("\n");
  }

  /** Export in Alpaca format (instruction, input, output). */
  toAlpaca(samples: SftSample[]): AlpacaSample[] {
    return samples
      .map((sample) => {
        const userTurns = sample.turns.filter((t) => t.role === "user");
        const assistantTurns = sample.turns.filter((t) => t.role === "assistant");
        const system = sample.turns.find((t) => t.role === "system");

        const instruction = userTurns[0]?.content ?? "";
        const input =
          userTurns
            .slice(1)
            .map((t) => t.content)
            .join("\n") ||
          (system?.content ?? "");
        const output = assistantTurns.map((t) => t.content).join("\n");

        return { instruction, input, output };
      })
      .filter((s) => s.instruction && s.output);
  }

  /** Export in ShareGPT format (human/gpt conversation pairs). */
  toShareGpt(samples: SftSample[]): ShareGptSample[] {
    return samples.map((sample) => {
      const conversations: ShareGptSample["conversations"] = sample.turns.map((t) => ({
        from: t.role === "user" ? "human" : t.role === "system" ? "system" : "gpt",
        value: t.content,
      }));
      return { conversations };
    });
  }

  /** Export in specified format. */
  export(samples: SftSample[], format: ExportFormat): string {
    if (format === "jsonl") return this.toJsonl(samples);
    if (format === "alpaca") return JSON.stringify(this.toAlpaca(samples), null, 2);
    if (format === "sharegpt") return JSON.stringify(this.toShareGpt(samples), null, 2);
    return "";
  }
}
