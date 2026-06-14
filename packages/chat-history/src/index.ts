// SPDX-License-Identifier: Apache-2.0
/**
 * chat-history — Persistent chat session history management for Nexus.
 *
 * Provides:
 *   • ChatMessage      — a single chat turn (user | assistant | system)
 *   • ChatThread       — an ordered collection of messages in a session
 *   • ChatHistoryStore — in-memory store for threads; injectable for persistence
 *   • summarizeThread  — compute token-budget-aware summary of a thread
 *   • trimToTokenBudget — drop oldest messages to fit within a token limit
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  model?: string;
  timestamp: string;
  tokens?: number;
  metadata?: Record<string, unknown>;
}

export interface ChatThread {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  metadata?: Record<string, unknown>;
}

export interface ThreadSummary {
  threadId: string;
  title?: string;
  messageCount: number;
  lastMessage?: string;
  lastRole?: ChatRole;
  updatedAt: string;
  estimatedTokens: number;
}

// ── ID / token helpers ────────────────────────────────────────────────────────

let _counter = 0;
function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${++_counter}`;
}

/** Rough token estimate: 1 token ≈ 4 chars. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── ChatHistoryStore ──────────────────────────────────────────────────────────

export class ChatHistoryStore {
  private threads = new Map<string, ChatThread>();

  // ── Thread management ──────────────────────────────────────────────────────

  createThread(title?: string, metadata?: Record<string, unknown>): ChatThread {
    const now = new Date().toISOString();
    const thread: ChatThread = {
      id: uid("thread"),
      title,
      createdAt: now,
      updatedAt: now,
      messages: [],
      metadata,
    };
    this.threads.set(thread.id, thread);
    return thread;
  }

  getThread(id: string): ChatThread | undefined {
    return this.threads.get(id);
  }

  deleteThread(id: string): boolean {
    return this.threads.delete(id);
  }

  listThreads(): ThreadSummary[] {
    return [...this.threads.values()]
      .map((t) => this.buildSummary(t))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  threadCount(): number { return this.threads.size; }

  // ── Message operations ─────────────────────────────────────────────────────

  addMessage(
    threadId: string,
    role: ChatRole,
    content: string,
    opts: { model?: string; metadata?: Record<string, unknown> } = {},
  ): ChatMessage {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    const msg: ChatMessage = {
      id: uid("msg"),
      role,
      content,
      model: opts.model,
      timestamp: new Date().toISOString(),
      tokens: estimateTokens(content),
      metadata: opts.metadata,
    };
    thread.messages.push(msg);
    thread.updatedAt = msg.timestamp;
    return msg;
  }

  deleteMessage(threadId: string, messageId: string): boolean {
    const thread = this.threads.get(threadId);
    if (!thread) return false;
    const idx = thread.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return false;
    thread.messages.splice(idx, 1);
    return true;
  }

  // ── Utility ────────────────────────────────────────────────────────────────

  private buildSummary(thread: ChatThread): ThreadSummary {
    const last = thread.messages[thread.messages.length - 1];
    const totalTokens = thread.messages.reduce((s, m) => s + (m.tokens ?? 0), 0);
    return {
      threadId: thread.id,
      title: thread.title,
      messageCount: thread.messages.length,
      lastMessage: last?.content.slice(0, 80),
      lastRole: last?.role,
      updatedAt: thread.updatedAt,
      estimatedTokens: totalTokens,
    };
  }

  /**
   * Search across all threads for messages containing `query`.
   */
  searchMessages(query: string, limit = 20): Array<{ thread: ChatThread; message: ChatMessage }> {
    const q = query.toLowerCase();
    const results: Array<{ thread: ChatThread; message: ChatMessage }> = [];
    for (const thread of this.threads.values()) {
      for (const msg of thread.messages) {
        if (msg.content.toLowerCase().includes(q)) {
          results.push({ thread, message: msg });
          if (results.length >= limit) return results;
        }
      }
    }
    return results;
  }
}

// ── trimToTokenBudget ─────────────────────────────────────────────────────────

/**
 * Drop oldest non-system messages from a thread until total tokens ≤ budget.
 * System messages are never dropped.
 * Returns a new array (does not mutate).
 */
export function trimToTokenBudget(messages: ChatMessage[], tokenBudget: number): ChatMessage[] {
  const systemMessages = messages.filter((m) => m.role === "system");
  let nonSystem = messages.filter((m) => m.role !== "system");
  let total = messages.reduce((s, m) => s + (m.tokens ?? estimateTokens(m.content)), 0);

  while (total > tokenBudget && nonSystem.length > 0) {
    const removed = nonSystem.shift()!;
    total -= removed.tokens ?? estimateTokens(removed.content);
  }

  return [...systemMessages, ...nonSystem];
}

// ── summarizeThread ───────────────────────────────────────────────────────────

export interface ThreadStats {
  messageCount: number;
  userMessages: number;
  assistantMessages: number;
  estimatedTokens: number;
  firstMessage?: string;
  lastMessage?: string;
  modelsUsed: string[];
}

export function analyzeThread(thread: ChatThread): ThreadStats {
  const models = new Set<string>();
  for (const m of thread.messages) {
    if (m.model) models.add(m.model);
  }
  return {
    messageCount:      thread.messages.length,
    userMessages:      thread.messages.filter((m) => m.role === "user").length,
    assistantMessages: thread.messages.filter((m) => m.role === "assistant").length,
    estimatedTokens:   thread.messages.reduce((s, m) => s + (m.tokens ?? 0), 0),
    firstMessage:      thread.messages[0]?.content.slice(0, 80),
    lastMessage:       thread.messages[thread.messages.length - 1]?.content.slice(0, 80),
    modelsUsed:        [...models],
  };
}
