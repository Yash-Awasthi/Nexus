// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/finetune-pipeline — dataset assembly → OpenAI JSONL export (§15.3).
 *
 * Bridges the two existing building blocks:
 *   • @nexus/sft-tagger    — conversation tagging, quality scoring, filtering
 *   • @nexus/corpus-builder — document corpus assembly
 *
 * Assembles a supervised fine-tuning dataset from BOTH sources:
 *   • corpus documents → deterministic instruction/response samples (each doc
 *     becomes an "Explain <title>" sample whose assistant turn is the document
 *     body — a legal, copyright-safe, self-generated corpus recipe) and
 *   • tagged conversations → chat-format samples.
 *
 * Everything is code-only up to the export: assembling, tagging, scoring,
 * filtering, and writing OpenAI chat-completions JSONL
 * (`{"messages":[{role,content},…]}`). Training runs remain infra/GPU (Blocked).
 * No network, no LLM calls — the tagger is rule-based and the export is pure.
 */

import {
  DatasetFilter,
  RuleTagger,
  SftDataset,
  QualityScorer,
  type ConversationTurn,
  type SftSample,
  type TurnRole,
} from "@nexus/sft-tagger";

/** Structural subset of @nexus/corpus-builder's CorpusDocument (duck-typed so the
 *  pipeline has no hard runtime dependency on a search backend). */
export interface CorpusDocumentLike {
  id: string;
  title: string;
  content: string;
  source?: string;
  topics?: string[];
  wordCount?: number;
  url?: string;
  publishedAt?: string;
}

/** An OpenAI chat-completions fine-tune example: `{"messages":[…]}`. */
export interface ChatExample {
  messages: { role: "system" | "user" | "assistant"; content: string }[];
}

/** Options for {@link FinetunePipeline.assemble}. */
export interface AssembleOptions {
  /**
   * Minimum quality score (0–1) a sample must have to enter the ready set.
   * Default 0.5.
   */
  minQuality?: number;
  /** Maximum samples to keep in the ready set (0/undefined = unlimited). */
  limit?: number;
  /**
   * When true (default), samples whose assistant turn is empty/whitespace are
   * dropped instead of exported (they would be garbage training targets).
   */
  dropIncomplete?: boolean;
}

export interface AssembleResult {
  /** Samples that survive the minQuality / completeness / limit gates. */
  ready: SftSample[];
  /** Samples dropped by the gates (ready = total − dropped). */
  dropped: SftSample[];
  /** Per-source counts (pre-gate). */
  counts: { corpus: number; conversations: number; total: number };
}

/** Error raised when an export precondition fails. */
export class FinetuneExportError extends Error {
  constructor(
    message: string,
    public readonly code: "INSUFFICIENT_DATA" | "EMPTY_DATASET",
    public readonly readyCount: number,
  ) {
    super(message);
    this.name = "FinetuneExportError";
  }
}

/** Instruction template used when turning a corpus document into a sample. */
export const CORPUS_INSTRUCTION_TEMPLATE = (title: string): string =>
  `Explain the topic "${title}" in detail, using the reference text below as the source of truth.`;

/** Minimum rated examples required for a fine-tune export. */
export const MIN_EXPORT_EXAMPLES = 10;

/**
 * §15.3 dataset assembly → JSONL export.
 *
 * ```
 * const p = new FinetunePipeline();
 * p.addCorpusDocuments(docs);
 * p.addConversations(turns, "chat-export");
 * const { ready } = p.assemble({ minQuality: 0.6 });
 * const jsonl = p.exportOpenAiJsonl(ready, { systemPrompt: "You are Nexus." });
 * ```
 */
export class FinetunePipeline {
  private readonly tagger = new RuleTagger();
  private readonly scorer = new QualityScorer();
  private readonly dataset = new SftDataset();
  private readonly filter = new DatasetFilter();
  private corpusDocs: CorpusDocumentLike[] = [];

  /** Register corpus documents as a sample source. */
  addCorpusDocuments(docs: CorpusDocumentLike[]): this {
    this.corpusDocs.push(...docs);
    return this;
  }

  /**
   * Register raw conversation turns as a sample source. Each entry is one
   * conversation (array of turns) tagged + scored immediately, exactly like
   * `POST /sft/conversations`.
   */
  addConversations(
    conversations: { role: TurnRole; content: string; metadata?: Record<string, unknown> }[][],
    source?: string,
  ): this {
    for (const turns of conversations) {
      if (turns.length > 0) this.dataset.addConversation(turns, source);
    }
    return this;
  }

  /** Assemble + gate every source into one ready set. */
  assemble(opts: AssembleOptions = {}): AssembleResult {
    const { minQuality = 0.5, limit, dropIncomplete = true } = opts;

    const corpusSamples = this.corpusDocs.map((doc) => this.sampleFromDocument(doc));
    const conversationSamples = this.dataset.list();
    const all = [...corpusSamples, ...conversationSamples];

    let ready = this.filter
      .filter(all, { minQualityScore: minQuality })
      .filter((s) => !dropIncomplete || this.hasAssistantContent(s));
    if (limit !== undefined && limit > 0) ready = ready.slice(0, limit);

    const readyIds = new Set(ready.map((s) => s.id));
    const dropped = all.filter((s) => !readyIds.has(s.id));

    return {
      ready,
      dropped,
      counts: {
        corpus: corpusSamples.length,
        conversations: conversationSamples.length,
        total: all.length,
      },
    };
  }

  /**
   * Export ready samples as OpenAI chat-completions JSONL. Fails fast with
   * {@link FinetuneExportError} when fewer than {@link MIN_EXPORT_EXAMPLES}
   * are ready — the same precondition the API routes surface as 422
   * `insufficient_data`.
   */
  exportOpenAiJsonl(ready: SftSample[], opts: { systemPrompt?: string } = {}): string {
    if (ready.length === 0) {
      throw new FinetuneExportError(
        "No samples are ready for export — add rated conversations or corpus documents first.",
        "EMPTY_DATASET",
        0,
      );
    }
    if (ready.length < MIN_EXPORT_EXAMPLES) {
      throw new FinetuneExportError(
        `Need at least ${MIN_EXPORT_EXAMPLES} rated examples to export a fine-tune dataset (have ${ready.length}).`,
        "INSUFFICIENT_DATA",
        ready.length,
      );
    }
    const systemPrompt = opts.systemPrompt ?? "You are a helpful assistant.";
    return ready.map((s) => JSON.stringify(this.toChatExample(s, systemPrompt))).join("\n");
  }

  /** Convert one SftSample into the OpenAI chat messages shape. */
  toChatExample(sample: SftSample, systemPrompt = "You are a helpful assistant."): ChatExample {
    const messages: ChatExample["messages"] = [{ role: "system", content: systemPrompt }];
    for (const turn of sample.turns) {
      // Tool turns have no place in a chat-completions fine-tune file; skip them
      // silently rather than emitting a role OpenAI rejects.
      if (turn.role === "tool") continue;
      const role = turn.role === "user" ? "user" : "assistant";
      messages.push({ role, content: turn.content });
    }
    return { messages };
  }

  private sampleFromDocument(doc: CorpusDocumentLike): SftSample {
    const turns: ConversationTurn[] = [
      {
        id: `doc-user-${doc.id}`,
        role: "user",
        content: CORPUS_INSTRUCTION_TEMPLATE(doc.title),
        metadata: { sourceDoc: doc.id, source: doc.source ?? "corpus" },
      },
      {
        id: `doc-assistant-${doc.id}`,
        role: "assistant",
        content: doc.content,
        metadata: { sourceDoc: doc.id, source: doc.source ?? "corpus" },
      },
    ];
    const tags = this.tagger.tagAll(turns);
    const qualityScore = this.scorer.score(turns, tags);
    return {
      id: `corpus-${doc.id}`,
      turns,
      tags,
      qualityScore,
      source: doc.source ?? "corpus",
      createdAt: new Date().toISOString(),
    };
  }

  private hasAssistantContent(sample: SftSample): boolean {
    return sample.turns.some((t) => t.role === "assistant" && t.content.trim().length > 0);
  }
}
