/**
 * Context Pruning — dynamic conversation context management to reduce token usage.
 *
 * Extracted from opencode-dynamic-context-pruning: automatically manages conversation
 * context by pruning old messages, compressing tool outputs, and maintaining
 * a token budget while preserving important context.
 */

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  timestamp: number;
  tokenCount?: number;
  importance?: number; // 0-1, higher = more important to keep
  toolName?: string;
}

export interface PruningConfig {
  maxTokens: number;
  targetTokens: number;
  preserveSystemMessages: boolean;
  preserveRecentMessages: number;
  compressToolOutputs: boolean;
  toolOutputMaxTokens: number;
  importanceThreshold: number;
  tokenEstimator?: (text: string) => number;
}

const DEFAULT_CONFIG: PruningConfig = {
  maxTokens: 128000,
  targetTokens: 100000,
  preserveSystemMessages: true,
  preserveRecentMessages: 10,
  compressToolOutputs: true,
  toolOutputMaxTokens: 500,
  importanceThreshold: 0.3,
};

function defaultTokenEstimator(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface PruningResult {
  pruned: Message[];
  removed: Message[];
  compressed: number;
  tokensSaved: number;
  originalTokens: number;
  finalTokens: number;
}

/**
 * Dynamic Context Pruner — manages conversation context to stay within token budget.
 */
export class ContextPruner {
  private config: PruningConfig;
  private estimateTokens: (text: string) => number;

  constructor(config: Partial<PruningConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.estimateTokens = this.config.tokenEstimator ?? defaultTokenEstimator;
  }

  /**
   * Prune messages to fit within token budget.
   */
  prune(messages: Message[]): PruningResult {
    const originalTokens = messages.reduce((sum, m) => sum + this.msgTokens(m), 0);

    if (originalTokens <= this.config.targetTokens) {
      return {
        pruned: messages,
        removed: [],
        compressed: 0,
        tokensSaved: 0,
        originalTokens,
        finalTokens: originalTokens,
      };
    }

    let working = messages.map((m) => ({ ...m }));
    let removed: Message[] = [];
    let compressed = 0;

    // Phase 1: Compress tool outputs
    if (this.config.compressToolOutputs) {
      for (const msg of working) {
        if (msg.role === 'tool' && this.msgTokens(msg) > this.config.toolOutputMaxTokens) {
          const originalTokens = this.msgTokens(msg);
          msg.content = msg.content.slice(0, this.config.toolOutputMaxTokens * 4) + '\n... [compressed]';
          compressed++;
        }
      }
    }

    // Phase 2: Remove low-importance messages
    const targetTokens = this.config.targetTokens;
    let currentTokens = working.reduce((sum, m) => sum + this.msgTokens(m), 0);

    if (currentTokens > targetTokens) {
      const systemMessages: Message[] = [];
      const otherMessages: Message[] = [];

      for (const msg of working) {
        if (msg.role === 'system' && this.config.preserveSystemMessages) {
          systemMessages.push(msg);
        } else {
          otherMessages.push(msg);
        }
      }

      // Sort by importance (ascending) — remove least important first
      const sorted = otherMessages.sort((a, b) => (a.importance ?? 0.5) - (b.importance ?? 0.5));

      const keepRecent = sorted.slice(-this.config.preserveRecentMessages);
      const candidates = sorted.slice(0, -this.config.preserveRecentMessages);

      const toKeep: Message[] = [];

      for (const msg of candidates) {
        if (currentTokens <= targetTokens) {
          toKeep.push(msg);
        } else if ((msg.importance ?? 0.5) >= this.config.importanceThreshold) {
          toKeep.push(msg);
        } else {
          removed.push(msg);
          currentTokens -= this.msgTokens(msg);
        }
      }

      working = [...systemMessages, ...toKeep, ...keepRecent];
    }

    const finalTokens = working.reduce((sum, m) => sum + this.msgTokens(m), 0);

    return {
      pruned: working,
      removed,
      compressed,
      tokensSaved: originalTokens - finalTokens,
      originalTokens,
      finalTokens,
    };
  }

  private msgTokens(msg: Message): number {
    return msg.tokenCount ?? this.estimateTokens(msg.content);
  }
}
