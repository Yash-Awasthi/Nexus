// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/context-assembly — Composable context assembly and compaction.
 *
 * Inspired by ag2's AssemblyPolicy and CompactStrategy patterns.
 * Provides composable policies that transform context before each LLM call,
 * and strategies to compact long conversations while preserving key information.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  timestamp?: number;
  tokenCount?: number;
  metadata?: Record<string, unknown>;
}

export interface AssemblyContext {
  messages: Message[];
  systemPrompt?: string;
  maxTokens: number;
  metadata: Record<string, unknown>;
}

// ── Assembly Policies ────────────────────────────────────────────────────────

export interface AssemblyPolicy {
  name: string;
  apply(context: AssemblyContext): Promise<AssemblyContext>;
}

/**
 * Drop oldest messages to fit within token budget.
 */
export class TokenBudgetPolicy implements AssemblyPolicy {
  name = "token-budget";

  constructor(private maxTokens: number) {}

  async apply(context: AssemblyContext): Promise<AssemblyContext> {
    let totalTokens = 0;
    const kept: Message[] = [];

    // Always keep system prompt
    if (context.systemPrompt) {
      totalTokens += estimateTokens(context.systemPrompt);
    }

    // Keep messages from newest to oldest within budget
    for (let i = context.messages.length - 1; i >= 0; i--) {
      const msg = context.messages[i];
      if (!msg) break;
      const tokens = msg.tokenCount ?? estimateTokens(msg.content);
      if (totalTokens + tokens <= this.maxTokens) {
        kept.unshift(msg);
        totalTokens += tokens;
      } else {
        break;
      }
    }

    return { ...context, messages: kept };
  }
}

/**
 * Inject system prompt based on conversation state.
 */
export class SystemPromptPolicy implements AssemblyPolicy {
  name = "system-prompt";

  constructor(
    private basePrompt: string,
    private dynamicParts: ((ctx: AssemblyContext) => string)[] = [],
  ) {}

  async apply(context: AssemblyContext): Promise<AssemblyContext> {
    const parts = [this.basePrompt];
    for (const part of this.dynamicParts) {
      parts.push(part(context));
    }
    return { ...context, systemPrompt: parts.join("\n\n") };
  }
}

/**
 * Deduplicate repeated messages.
 */
export class DeduplicationPolicy implements AssemblyPolicy {
  name = "deduplication";

  async apply(context: AssemblyContext): Promise<AssemblyContext> {
    const seen = new Set<string>();
    const deduped: Message[] = [];

    for (const msg of context.messages) {
      const key = `${msg.role}:${msg.content}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(msg);
      }
    }

    return { ...context, messages: deduped };
  }
}

/**
 * Summarize older messages into a compact summary.
 */
export class SummarizePolicy implements AssemblyPolicy {
  name = "summarize";

  constructor(
    private keepRecent = 10,
    private summarizer?: (messages: Message[]) => Promise<string>,
  ) {}

  async apply(context: AssemblyContext): Promise<AssemblyContext> {
    if (context.messages.length <= this.keepRecent) {
      return context;
    }

    const older = context.messages.slice(0, -this.keepRecent);
    const recent = context.messages.slice(-this.keepRecent);

    let summary: string;
    if (this.summarizer) {
      summary = await this.summarizer(older);
    } else {
      summary = this.defaultSummarize(older);
    }

    const summaryMessage: Message = {
      role: "system",
      content: `[Conversation summary]\n${summary}`,
      timestamp: older[older.length - 1]?.timestamp,
      metadata: { type: "summary", originalCount: older.length },
    };

    return { ...context, messages: [summaryMessage, ...recent] };
  }

  private defaultSummarize(messages: Message[]): string {
    const userMsgs = messages.filter((m) => m.role === "user");
    const topics = userMsgs.map((m) => m.content.slice(0, 100));
    return `Previous conversation covered ${topics.length} exchanges. Key topics: ${topics.slice(-5).join("; ")}`;
  }
}

// ── Compaction Strategies ────────────────────────────────────────────────────

export interface CompactStrategy {
  compact(messages: Message[]): Promise<Message[]>;
}

/**
 * Remove messages that are structurally redundant.
 */
export class StructuralCompact implements CompactStrategy {
  async compact(messages: Message[]): Promise<Message[]> {
    return messages.filter((msg, i) => {
      // Keep system messages
      if (msg.role === "system") return true;
      // Keep last message
      if (i === messages.length - 1) return true;
      // Remove consecutive same-role messages (keep only last)
      const next = i < messages.length - 1 ? messages[i + 1] : undefined;
      if (next && next.role === msg.role) {
        return false;
      }
      return true;
    });
  }
}

/**
 * Keep a sliding window of recent messages with optional summary.
 */
export class SlidingWindowCompact implements CompactStrategy {
  constructor(
    private windowSize: number,
    private summarizer?: (msgs: Message[]) => Promise<string>,
  ) {}

  async compact(messages: Message[]): Promise<Message[]> {
    if (messages.length <= this.windowSize) return messages;

    const older = messages.slice(0, -this.windowSize);
    const recent = messages.slice(-this.windowSize);

    if (this.summarizer) {
      const summary = await this.summarizer(older);
      return [
        { role: "system", content: `[Summary of ${older.length} messages] ${summary}` },
        ...recent,
      ];
    }

    return recent;
  }
}

/**
 * Merge consecutive tool calls with their results.
 */
export class ToolCallCompact implements CompactStrategy {
  async compact(messages: Message[]): Promise<Message[]> {
    const result: Message[] = [];
    let i = 0;

    while (i < messages.length) {
      const msg = messages[i];
      if (!msg) break;
      if (msg.role === "assistant" && msg.metadata?.toolCalls) {
        // Find the matching tool result
        const toolResult = messages
          .slice(i + 1)
          .find((m) => m.role === "tool" && m.metadata?.toolCallId === msg.metadata?.toolCallId);
        if (toolResult) {
          result.push({
            ...msg,
            content: `${msg.content}\n\nTool result: ${toolResult.content}`,
          });
          i += 2; // Skip the tool result
          continue;
        }
      }
      result.push(msg);
      i++;
    }

    return result;
  }
}

// ── Assembler ────────────────────────────────────────────────────────────────

export class ContextAssembler {
  private policies: AssemblyPolicy[] = [];

  addPolicy(policy: AssemblyPolicy): this {
    this.policies.push(policy);
    return this;
  }

  removePolicy(name: string): this {
    this.policies = this.policies.filter((p) => p.name !== name);
    return this;
  }

  async assemble(context: AssemblyContext): Promise<AssemblyContext> {
    let result = { ...context };
    for (const policy of this.policies) {
      result = await policy.apply(result);
    }
    return result;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export default ContextAssembler;
