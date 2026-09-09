// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/context-builder — Graph-based context composition for LLM conversations.
 *
 * Inspired by @diyor28/context's ContextBuilder.
 * Provides a fluent API for building context from system rules, history,
 * memory, and attachments with deterministic ordering and token budgeting.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type BlockKind =
  "system" | "reference" | "state" | "memory" | "history" | "attachment" | "turn";
export type SensitivityLevel = "public" | "internal" | "confidential" | "secret";

export interface ContextBlock {
  id: string;
  kind: BlockKind;
  content: string;
  sensitivity: SensitivityLevel;
  tokenCount: number;
  priority: number;
  tags: string[];
  hash: string;
}

export interface CompiledContext {
  blocks: ContextBlock[];
  totalTokens: number;
  provider: string;
  messages: Array<{ role: string; content: string }>;
}

export interface TokenBudget {
  maxTokens: number;
  usedTokens: number;
  remainingTokens: number;
}

// ── Token Estimation ─────────────────────────────────────────────────────────

export class TokenEstimator {
  private provider: string;

  constructor(provider: string = "openai") {
    this.provider = provider;
  }

  estimate(text: string): number {
    // Provider-specific estimation
    switch (this.provider) {
      case "anthropic":
        // Anthropic: ~3.5 chars per token
        return Math.ceil(text.length / 3.5);
      case "gemini":
        // Gemini: ~4 chars per token
        return Math.ceil(text.length / 4);
      default:
        // OpenAI: ~4 chars per token
        return Math.ceil(text.length / 4);
    }
  }
}

// ── Block Codecs ─────────────────────────────────────────────────────────────

export interface BlockCodec<T = unknown> {
  encode(payload: T): string;
  decode(content: string): T;
  kind: BlockKind;
}

export class SystemRulesCodec implements BlockCodec<{ rules: string[] }> {
  kind: BlockKind = "system";

  encode(payload: { rules: string[] }): string {
    return payload.rules.join("\n\n");
  }

  decode(content: string): { rules: string[] } {
    return { rules: content.split("\n\n").filter((r) => r.trim()) };
  }
}

export class ConversationHistoryCodec implements BlockCodec<{
  messages: Array<{ role: string; content: string }>;
}> {
  kind: BlockKind = "history";

  encode(payload: { messages: Array<{ role: string; content: string }> }): string {
    return payload.messages.map((m) => `${m.role}: ${m.content}`).join("\n\n");
  }

  decode(content: string): { messages: Array<{ role: string; content: string }> } {
    const messages: Array<{ role: string; content: string }> = [];
    const lines = content.split("\n\n");
    for (const line of lines) {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        messages.push({
          role: line.slice(0, colonIdx).trim(),
          content: line.slice(colonIdx + 1).trim(),
        });
      }
    }
    return { messages };
  }
}

// ── Context Graph ────────────────────────────────────────────────────────────

const KIND_PRIORITY: Record<BlockKind, number> = {
  system: 0,
  reference: 1,
  state: 2,
  memory: 3,
  history: 4,
  attachment: 5,
  turn: 6,
};

export class ContextGraph {
  private blocks: ContextBlock[] = [];

  addBlock(block: Omit<ContextBlock, "id" | "hash">): ContextBlock {
    const id = `block-${this.blocks.length}`;
    const hash = this.computeHash(block.content);
    const fullBlock: ContextBlock = { ...block, id, hash };
    this.blocks.push(fullBlock);
    return fullBlock;
  }

  removeBlock(id: string): boolean {
    const idx = this.blocks.findIndex((b) => b.id === id);
    if (idx >= 0) {
      this.blocks.splice(idx, 1);
      return true;
    }
    return false;
  }

  getBlocks(kind?: BlockKind): ContextBlock[] {
    const filtered = kind ? this.blocks.filter((b) => b.kind === kind) : this.blocks;
    return [...filtered].sort((a, b) => {
      const kindDiff = KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind];
      if (kindDiff !== 0) return kindDiff;
      return a.priority - b.priority;
    });
  }

  computeBudget(): TokenBudget {
    const used = this.blocks.reduce((sum, b) => sum + b.tokenCount, 0);
    return {
      maxTokens: 0,
      usedTokens: used,
      remainingTokens: 0,
    };
  }

  deduplicate(): number {
    const seen = new Set<string>();
    let removed = 0;
    this.blocks = this.blocks.filter((b) => {
      if (seen.has(b.hash)) {
        removed++;
        return false;
      }
      seen.add(b.hash);
      return true;
    });
    return removed;
  }

  filterBySensitivity(maxLevel: SensitivityLevel): ContextBlock[] {
    const levels: SensitivityLevel[] = ["public", "internal", "confidential", "secret"];
    const maxIdx = levels.indexOf(maxLevel);
    return this.blocks.filter((b) => levels.indexOf(b.sensitivity) <= maxIdx);
  }

  size(): number {
    return this.blocks.length;
  }

  private computeHash(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) - hash + content.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(36);
  }
}

// ── Context Builder ──────────────────────────────────────────────────────────

export class ContextBuilder {
  private graph: ContextGraph;
  private estimator: TokenEstimator;
  private budget: number;

  constructor(options?: { provider?: string; maxTokens?: number }) {
    this.graph = new ContextGraph();
    this.estimator = new TokenEstimator(options?.provider);
    this.budget = options?.maxTokens ?? 128_000;
  }

  /**
   * Add system rules.
   */
  system(rules: string | string[]): this {
    const text = Array.isArray(rules) ? rules.join("\n\n") : rules;
    this.graph.addBlock({
      kind: "system",
      content: text,
      sensitivity: "internal",
      tokenCount: this.estimator.estimate(text),
      priority: 0,
      tags: ["system"],
    });
    return this;
  }

  /**
   * Add conversation history.
   */
  history(messages: Array<{ role: string; content: string }>): this {
    for (const msg of messages) {
      this.graph.addBlock({
        kind: "history",
        content: `${msg.role}: ${msg.content}`,
        sensitivity: "internal",
        tokenCount: this.estimator.estimate(msg.content),
        priority: 10,
        tags: [msg.role],
      });
    }
    return this;
  }

  /**
   * Add a memory block.
   */
  memory(content: string, tags: string[] = []): this {
    this.graph.addBlock({
      kind: "memory",
      content,
      sensitivity: "confidential",
      tokenCount: this.estimator.estimate(content),
      priority: 20,
      tags,
    });
    return this;
  }

  /**
   * Add a reference (tool schema, docs).
   */
  reference(content: string, tags: string[] = []): this {
    this.graph.addBlock({
      kind: "reference",
      content,
      sensitivity: "public",
      tokenCount: this.estimator.estimate(content),
      priority: 5,
      tags,
    });
    return this;
  }

  /**
   * Add the current user turn.
   */
  turn(content: string): this {
    this.graph.addBlock({
      kind: "turn",
      content,
      sensitivity: "internal",
      tokenCount: this.estimator.estimate(content),
      priority: 100,
      tags: ["user-turn"],
    });
    return this;
  }

  /**
   * Add an attachment.
   */
  attachment(content: string, tags: string[] = []): this {
    this.graph.addBlock({
      kind: "attachment",
      content,
      sensitivity: "internal",
      tokenCount: this.estimator.estimate(content),
      priority: 50,
      tags,
    });
    return this;
  }

  /**
   * Compile the context into messages for an LLM provider.
   */
  compile(provider?: string): CompiledContext {
    // Deduplicate
    this.graph.deduplicate();

    // Get sorted blocks
    const blocks = this.graph.getBlocks();

    // Apply token budget
    let remainingBudget = this.budget;
    const withinBudget: ContextBlock[] = [];

    for (const block of blocks) {
      if (remainingBudget - block.tokenCount >= 0) {
        withinBudget.push(block);
        remainingBudget -= block.tokenCount;
      } else if (block.kind === "turn" || block.kind === "system") {
        // Always include system and turn blocks
        withinBudget.push(block);
        remainingBudget -= block.tokenCount;
      }
    }

    // Convert to messages
    const messages: Array<{ role: string; content: string }> = [];
    let systemContent = "";

    for (const block of withinBudget) {
      switch (block.kind) {
        case "system":
          systemContent += (systemContent ? "\n\n" : "") + block.content;
          break;
        case "turn":
          messages.push({ role: "user", content: block.content });
          break;
        case "history":
          const colonIdx = block.content.indexOf(":");
          if (colonIdx > 0) {
            messages.push({
              role: block.content.slice(0, colonIdx).trim(),
              content: block.content.slice(colonIdx + 1).trim(),
            });
          }
          break;
        default:
          // Other blocks go into system prompt
          systemContent += (systemContent ? "\n\n" : "") + `[${block.kind}]\n${block.content}`;
      }
    }

    if (systemContent) {
      messages.unshift({ role: "system", content: systemContent });
    }

    return {
      blocks: withinBudget,
      totalTokens: this.budget - remainingBudget,
      provider: provider ?? "openai",
      messages,
    };
  }

  /**
   * Fork the builder with filters.
   */
  fork(options: {
    maxSensitivity?: SensitivityLevel;
    includeKinds?: BlockKind[];
    excludeKinds?: BlockKind[];
  }): ContextBuilder {
    const forked = new ContextBuilder({ maxTokens: this.budget });
    let blocks = this.graph.getBlocks();

    if (options.maxSensitivity) {
      blocks = blocks.filter((b) => {
        const levels: SensitivityLevel[] = ["public", "internal", "confidential", "secret"];
        return levels.indexOf(b.sensitivity) <= levels.indexOf(options.maxSensitivity!);
      });
    }

    if (options.includeKinds) {
      blocks = blocks.filter((b) => options.includeKinds!.includes(b.kind));
    }

    if (options.excludeKinds) {
      blocks = blocks.filter((b) => !options.excludeKinds!.includes(b.kind));
    }

    for (const block of blocks) {
      forked.graph.addBlock(block);
    }

    return forked;
  }

  /**
   * Get the underlying graph for inspection.
   */
  getGraph(): ContextGraph {
    return this.graph;
  }
}

export default ContextBuilder;
