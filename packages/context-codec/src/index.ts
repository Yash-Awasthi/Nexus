/**
 * @nexus/context-codec — Content-addressed context blocks with deterministic ordering.
 *
 * Provides a codec system for LLM context management: content-addressed blocks
 * with stable hashing, deterministic block ordering, provider-specific rendering,
 * and token budgeting.  Inspired by the @diyor28/context repo.
 *
 * Key concepts:
 *   Block      — A unit of context (system rules, memory, history, etc.)
 *   Codec      — Renders a block for provider-specific formats
 *   Graph      — Ordered collection of blocks with deduplication
 *   Compiler   — Compiles a graph into provider-specific messages
 */

import { createHash } from "crypto";

// ─── Block Types ─────────────────────────────────────────────────────────────

export type BlockKind =
  | "pinned"       // System rules, always first
  | "reference"    // Tool schemas, external docs
  | "memory"       // Long-term memory, RAG results
  | "state"        // Current workflow/session state
  | "tool_output"  // Tool execution results
  | "history"      // Conversation history
  | "turn";        // Current turn (user message)

export type SensitivityLevel =
  | "public"       // Safe to fork to any model
  | "internal"     // Contains business logic/PII
  | "restricted";  // Contains credentials/secrets

/** Deterministic ordering for block kinds. */
export const KIND_ORDER: BlockKind[] = [
  "pinned",
  "reference",
  "memory",
  "state",
  "tool_output",
  "history",
  "turn",
];

export interface BlockMeta {
  kind: BlockKind;
  sensitivity: SensitivityLevel;
  codecId: string;
  codecVersion: string;
  createdAt: number;
  source?: string;
  tags?: string[];
}

export interface ContextBlock<TPayload = unknown> {
  id: string;
  meta: BlockMeta;
  payload: TPayload;
  /** Computed content hash (stable, deterministic) */
  hash: string;
}

// ─── Codec Interface ─────────────────────────────────────────────────────────

export interface RenderedContent {
  anthropic?: unknown;
  openai?: unknown;
  gemini?: unknown;
}

export interface BlockCodec<TPayload = unknown> {
  codecId: string;
  version: string;
  /** Canonicalize payload for deterministic hashing */
  canonicalize(payload: TPayload): unknown;
  /** Compute stable hash */
  hash(canonicalized: unknown): string;
  /** Render for provider-specific formats */
  render(block: ContextBlock<TPayload>): RenderedContent;
  /** Validate payload */
  validate(payload: unknown): payload is TPayload;
  /** Estimate token count */
  estimateTokens(block: ContextBlock<TPayload>): number;
}

// ─── Built-in Codecs ─────────────────────────────────────────────────────────

/** System rules codec — pinned instructions that always appear first. */
export class SystemRulesCodec implements BlockCodec<{ rules: string[] }> {
  codecId = "system-rules";
  version = "1.0.0";

  canonicalize(payload: { rules: string[] }): unknown {
    return { rules: [...payload.rules].sort() };
  }

  hash(canonicalized: unknown): string {
    return defaultHash(canonicalized);
  }

  render(block: ContextBlock<{ rules: string[] }>): RenderedContent {
    const text = block.payload.rules.join("\n");
    return {
      anthropic: { type: "text", text },
      openai: { role: "system", content: text },
      gemini: { role: "user", parts: [{ text }] },
    };
  }

  validate(payload: unknown): payload is { rules: string[] } {
    return (
      typeof payload === "object" &&
      payload !== null &&
      "rules" in payload &&
      Array.isArray((payload as any).rules)
    );
  }

  estimateTokens(block: ContextBlock<{ rules: string[] }>): number {
    return block.payload.rules.join("\n").length / 4;
  }
}

/** Conversation history codec — message arrays. */
export class ConversationHistoryCodec
  implements BlockCodec<{ messages: Array<{ role: string; content: string }> }>
{
  codecId = "conversation-history";
  version = "1.0.0";

  canonicalize(payload: {
    messages: Array<{ role: string; content: string }>;
  }): unknown {
    return payload.messages;
  }

  hash(canonicalized: unknown): string {
    return defaultHash(canonicalized);
  }

  render(
    block: ContextBlock<{
      messages: Array<{ role: string; content: string }>;
    }>,
  ): RenderedContent {
    const messages = block.payload.messages;
    return {
      anthropic: messages.map((m) => ({
        role: m.role === "user" ? "user" : "assistant",
        content: m.content,
      })),
      openai: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      gemini: messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
    };
  }

  validate(payload: unknown): payload is {
    messages: Array<{ role: string; content: string }>;
  } {
    return (
      typeof payload === "object" &&
      payload !== null &&
      "messages" in payload &&
      Array.isArray((payload as any).messages)
    );
  }

  estimateTokens(
    block: ContextBlock<{
      messages: Array<{ role: string; content: string }>;
    }>,
  ): number {
    return block.payload.messages.reduce(
      (sum, m) => sum + m.content.length / 4,
      0,
    );
  }
}

/** Tool output codec — results from tool executions. */
export class ToolOutputCodec implements BlockCodec<{ outputs: Record<string, unknown> }> {
  codecId = "tool-output";
  version = "1.0.0";

  canonicalize(payload: { outputs: Record<string, unknown> }): unknown {
    // Sort keys for determinism
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(payload.outputs).sort()) {
      sorted[key] = payload.outputs[key];
    }
    return sorted;
  }

  hash(canonicalized: unknown): string {
    return defaultHash(canonicalized);
  }

  render(block: ContextBlock<{ outputs: Record<string, unknown> }>): RenderedContent {
    const text = JSON.stringify(block.payload.outputs, null, 2);
    return {
      anthropic: { type: "text", text: `[Tool Results]\n${text}` },
      openai: { role: "tool", content: text },
      gemini: { role: "user", parts: [{ text: `[Tool Results]\n${text}` }] },
    };
  }

  validate(payload: unknown): payload is { outputs: Record<string, unknown> } {
    return (
      typeof payload === "object" &&
      payload !== null &&
      "outputs" in payload &&
      typeof (payload as any).outputs === "object"
    );
  }

  estimateTokens(block: ContextBlock<{ outputs: Record<string, unknown> }>): number {
    return JSON.stringify(block.payload.outputs).length / 4;
  }
}

/** Redacted stub codec — placeholder for sensitive content. */
export class RedactedStubCodec implements BlockCodec<{ label: string; originalHash: string }> {
  codecId = "redacted-stub";
  version = "1.0.0";

  canonicalize(payload: { label: string; originalHash: string }): unknown {
    return payload;
  }

  hash(canonicalized: unknown): string {
    return defaultHash(canonicalized);
  }

  render(block: ContextBlock<{ label: string; originalHash: string }>): RenderedContent {
    const text = `[REDACTED: ${block.payload.label}]`;
    return {
      anthropic: { type: "text", text },
      openai: { role: "system", content: text },
      gemini: { role: "user", parts: [{ text }] },
    };
  }

  validate(payload: unknown): payload is { label: string; originalHash: string } {
    return (
      typeof payload === "object" &&
      payload !== null &&
      "label" in payload &&
      "originalHash" in payload
    );
  }

  estimateTokens(): number {
    return 5;
  }
}

// ─── Built-in Codec Registry ─────────────────────────────────────────────────

export const BUILT_IN_CODECS: Record<string, BlockCodec> = {
  "system-rules": new SystemRulesCodec(),
  "conversation-history": new ConversationHistoryCodec(),
  "tool-output": new ToolOutputCodec(),
  "redacted-stub": new RedactedStubCodec(),
};

// ─── Context Graph ───────────────────────────────────────────────────────────

export class ContextGraph {
  private blocks: ContextBlock[] = [];
  private hashIndex = new Map<string, ContextBlock>();

  /** Add a block, deduplicating by content hash. */
  addBlock(block: ContextBlock): boolean {
    if (this.hashIndex.has(block.hash)) {
      return false; // Duplicate
    }
    this.blocks.push(block);
    this.hashIndex.set(block.hash, block);
    return true;
  }

  /** Get all blocks in deterministic order. */
  getOrdered(): ContextBlock[] {
    return [...this.blocks].sort((a, b) => {
      const orderA = KIND_ORDER.indexOf(a.meta.kind);
      const orderB = KIND_ORDER.indexOf(b.meta.kind);
      if (orderA !== orderB) return orderA - orderB;
      return a.meta.createdAt - b.meta.createdAt;
    });
  }

  /** Get blocks filtered by kind. */
  getByKind(kind: BlockKind): ContextBlock[] {
    return this.getOrdered().filter((b) => b.meta.kind === kind);
  }

  /** Get blocks filtered by sensitivity (at or below level). */
  getBySensitivity(maxLevel: SensitivityLevel): ContextBlock[] {
    const maxIdx = ["public", "internal", "restricted"].indexOf(maxLevel);
    return this.getOrdered().filter((b) => {
      const idx = ["public", "internal", "restricted"].indexOf(b.meta.sensitivity);
      return idx <= maxIdx;
    });
  }

  /** Remove a block by hash. */
  removeBlock(hash: string): boolean {
    const block = this.hashIndex.get(hash);
    if (!block) return false;
    this.blocks = this.blocks.filter((b) => b.hash !== hash);
    this.hashIndex.delete(hash);
    return true;
  }

  /** Fork the graph, removing restricted blocks (for sending to a sub-agent). */
  fork(maxSensitivity: SensitivityLevel = "internal"): ContextGraph {
    const forked = new ContextGraph();
    for (const block of this.getBySensitivity(maxSensitivity)) {
      forked.addBlock(block);
    }
    return forked;
  }

  /** Total blocks */
  get size(): number {
    return this.blocks.length;
  }

  /** Estimate total tokens across all blocks using registered codecs. */
  estimateTokens(codecs: Record<string, BlockCodec>): number {
    return this.getOrdered().reduce((sum, block) => {
      const codec = codecs[block.meta.codecId];
      return sum + (codec?.estimateTokens(block) ?? 0);
    }, 0);
  }
}

// ─── Context Compiler ────────────────────────────────────────────────────────

export type Provider = "anthropic" | "openai" | "gemini";

export interface CompiledContext {
  provider: Provider;
  messages: unknown[];
  totalTokens: number;
}

/**
 * Compiles a context graph into provider-specific message arrays,
 * respecting token budgets.
 */
export class ContextCompiler {
  private codecs: Record<string, BlockCodec>;

  constructor(codecs: Record<string, BlockCodec> = BUILT_IN_CODECS) {
    this.codecs = codecs;
  }

  /**
   * Compile the graph into messages for a specific provider.
   * Respects token budget by truncating history if needed.
   */
  compile(
    graph: ContextGraph,
    provider: Provider,
    tokenBudget?: number,
  ): CompiledContext {
    const ordered = graph.getOrdered();
    const messages: unknown[] = [];
    let totalTokens = 0;

    for (const block of ordered) {
      const codec = this.codecs[block.meta.codecId];
      if (!codec) continue;

      const rendered = codec.render(block);
      const providerContent = rendered[provider];
      if (!providerContent) continue;

      const blockTokens = codec.estimateTokens(block);

      // If we have a budget and adding this block would exceed it,
      // try to fit partial history
      if (tokenBudget && totalTokens + blockTokens > tokenBudget) {
        if (block.meta.kind === "history") {
          // Truncate history to fit budget
          const remaining = tokenBudget - totalTokens;
          const truncated = this.truncateHistory(block, provider, remaining, codec);
          if (truncated) {
            messages.push(truncated);
            totalTokens += remaining;
          }
          break; // Can't add anything after budget is hit
        }
        break; // Non-history blocks must fit or be skipped
      }

      if (Array.isArray(providerContent)) {
        messages.push(...providerContent);
      } else {
        messages.push(providerContent);
      }
      totalTokens += blockTokens;
    }

    return { provider, messages, totalTokens };
  }

  private truncateHistory(
    block: ContextBlock,
    provider: Provider,
    tokenBudget: number,
    codec: BlockCodec,
  ): unknown | null {
    // Simple truncation: keep the most recent messages that fit
    const rendered = codec.render(block);
    const providerContent = rendered[provider];
    if (!providerContent || !Array.isArray(providerContent)) return null;

    // Estimate tokens per message and keep the most recent ones
    const messages = providerContent as Array<Record<string, unknown>>;
    const result: Record<string, unknown>[] = [];
    let tokens = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msgTokens = JSON.stringify(messages[i]).length / 4;
      if (tokens + msgTokens > tokenBudget) break;
      result.unshift(messages[i]);
      tokens += msgTokens;
    }

    return result.length > 0 ? result : null;
  }
}

// ─── Block Builder ───────────────────────────────────────────────────────────

/**
 * Fluent builder for creating context blocks with proper hashing.
 */
export class BlockBuilder<TPayload> {
  private meta: Partial<BlockMeta> = {};
  private payload: TPayload | undefined;
  private codec: BlockCodec<TPayload> | undefined;

  kind(kind: BlockKind): this {
    this.meta.kind = kind;
    return this;
  }

  sensitivity(level: SensitivityLevel): this {
    this.meta.sensitivity = level;
    return this;
  }

  useCodec(c: BlockCodec<TPayload>): this {
    this.codec = c;
    this.meta.codecId = c.codecId;
    this.meta.codecVersion = c.version;
    return this;
  }

  source(source: string): this {
    this.meta.source = source;
    return this;
  }

  tags(tags: string[]): this {
    this.meta.tags = tags;
    return this;
  }

  withPayload(p: TPayload): this {
    this.payload = p;
    return this;
  }

  build(): ContextBlock<TPayload> {
    if (!this.payload) throw new Error("Payload is required");
    if (!this.codec) throw new Error("Codec is required");
    if (!this.meta.kind) throw new Error("Kind is required");

    const meta: BlockMeta = {
      kind: this.meta.kind,
      sensitivity: this.meta.sensitivity ?? "public",
      codecId: this.meta.codecId!,
      codecVersion: this.meta.codecVersion ?? "1.0.0",
      createdAt: this.meta.createdAt ?? Math.floor(Date.now() / 1000),
      source: this.meta.source,
      tags: this.meta.tags,
    };

    const canonicalized = this.codec.canonicalize(this.payload);
    const hash = this.codec.hash(canonicalized);

    return {
      id: hash.slice(0, 12),
      meta,
      payload: this.payload,
      hash,
    };
  }
}

/**
 * Convenience function to create a block builder.
 */
export function createBlock<TPayload>(): BlockBuilder<TPayload> {
  return new BlockBuilder<TPayload>();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Default hash: SHA-256 of JSON.stringify. */
function defaultHash(canonicalized: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalized))
    .digest("hex");
}
