// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  ChatHistoryStore,
  trimToTokenBudget,
  analyzeThread,
  type ChatMessage,
  type ChatThread,
} from "../src/index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMsg(role: "user" | "assistant" | "system", content: string, tokens = 10): ChatMessage {
  return {
    id: `msg-${Math.random()}`,
    role,
    content,
    timestamp: new Date().toISOString(),
    tokens,
  };
}

function makeThread(messages: ChatMessage[]): ChatThread {
  return {
    id: "t1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages,
  };
}

// ── ChatHistoryStore ──────────────────────────────────────────────────────────

describe("ChatHistoryStore — threads", () => {
  let store: ChatHistoryStore;
  beforeEach(() => { store = new ChatHistoryStore(); });

  it("creates a thread with auto-generated id", () => {
    const t = store.createThread("My Chat");
    expect(t.id).toBeTruthy();
    expect(t.title).toBe("My Chat");
    expect(t.messages).toHaveLength(0);
  });

  it("getThread returns the thread", () => {
    const t = store.createThread();
    expect(store.getThread(t.id)).toBe(t);
  });

  it("getThread returns undefined for unknown id", () => {
    expect(store.getThread("ghost")).toBeUndefined();
  });

  it("deleteThread removes it", () => {
    const t = store.createThread();
    expect(store.deleteThread(t.id)).toBe(true);
    expect(store.getThread(t.id)).toBeUndefined();
  });

  it("deleteThread returns false for unknown id", () => {
    expect(store.deleteThread("ghost")).toBe(false);
  });

  it("threadCount reflects created threads", () => {
    store.createThread(); store.createThread();
    expect(store.threadCount()).toBe(2);
  });

  it("listThreads returns summaries sorted by updatedAt desc", async () => {
    const a = store.createThread("A");
    const b = store.createThread("B");
    await new Promise((r) => setTimeout(r, 2));
    store.addMessage(b.id, "user", "msg");
    const list = store.listThreads();
    expect(list[0]!.threadId).toBe(b.id);
  });

  it("listThreads summary includes messageCount and estimatedTokens", () => {
    const t = store.createThread();
    store.addMessage(t.id, "user", "hello world");
    const [summary] = store.listThreads();
    expect(summary!.messageCount).toBe(1);
    expect(summary!.estimatedTokens).toBeGreaterThan(0);
  });
});

describe("ChatHistoryStore — messages", () => {
  let store: ChatHistoryStore;
  let threadId: string;

  beforeEach(() => {
    store = new ChatHistoryStore();
    threadId = store.createThread().id;
  });

  it("addMessage appends and returns message", () => {
    const m = store.addMessage(threadId, "user", "Hello");
    expect(m.role).toBe("user");
    expect(m.content).toBe("Hello");
    expect(m.id).toBeTruthy();
    expect(m.tokens).toBeGreaterThan(0);
  });

  it("message has timestamp", () => {
    const m = store.addMessage(threadId, "user", "Hi");
    expect(m.timestamp).toBeTruthy();
  });

  it("stores model", () => {
    const m = store.addMessage(threadId, "assistant", "A", { model: "claude-3" });
    expect(m.model).toBe("claude-3");
  });

  it("throws for unknown thread", () => {
    expect(() => store.addMessage("ghost", "user", "Hi")).toThrow();
  });

  it("deleteMessage removes it", () => {
    const m = store.addMessage(threadId, "user", "Hi");
    expect(store.deleteMessage(threadId, m.id)).toBe(true);
    expect(store.getThread(threadId)!.messages).toHaveLength(0);
  });

  it("deleteMessage returns false for unknown message", () => {
    expect(store.deleteMessage(threadId, "ghost")).toBe(false);
  });

  it("multiple messages appended in order", () => {
    store.addMessage(threadId, "user", "Q1");
    store.addMessage(threadId, "assistant", "A1");
    store.addMessage(threadId, "user", "Q2");
    expect(store.getThread(threadId)!.messages).toHaveLength(3);
  });

  it("thread updatedAt changes on new message", async () => {
    const before = store.getThread(threadId)!.updatedAt;
    await new Promise((r) => setTimeout(r, 2));
    store.addMessage(threadId, "user", "Hi");
    expect(store.getThread(threadId)!.updatedAt).not.toBe(before);
  });
});

describe("ChatHistoryStore — searchMessages", () => {
  let store: ChatHistoryStore;

  beforeEach(() => {
    store = new ChatHistoryStore();
    const t1 = store.createThread();
    const t2 = store.createThread();
    store.addMessage(t1.id, "user", "Tell me about TypeScript");
    store.addMessage(t1.id, "assistant", "TypeScript is a typed superset of JS");
    store.addMessage(t2.id, "user", "How about Python?");
  });

  it("finds messages by content", () => {
    const r = store.searchMessages("TypeScript");
    expect(r.length).toBeGreaterThan(0);
  });

  it("is case-insensitive", () => {
    const r = store.searchMessages("typescript");
    expect(r.length).toBeGreaterThan(0);
  });

  it("returns empty for no match", () => {
    expect(store.searchMessages("Cobol")).toHaveLength(0);
  });

  it("respects limit", () => {
    const t = store.createThread();
    for (let i = 0; i < 5; i++) store.addMessage(t.id, "user", "match me");
    const r = store.searchMessages("match me", 2);
    expect(r.length).toBeLessThanOrEqual(2);
  });
});

// ── trimToTokenBudget ─────────────────────────────────────────────────────────

describe("trimToTokenBudget", () => {
  it("returns all messages within budget", () => {
    const msgs = [makeMsg("user", "A", 10), makeMsg("assistant", "B", 10)];
    expect(trimToTokenBudget(msgs, 100)).toHaveLength(2);
  });

  it("drops oldest non-system messages to fit budget", () => {
    const msgs = [
      makeMsg("user",      "A", 20),
      makeMsg("assistant", "B", 20),
      makeMsg("user",      "C", 20),
    ];
    const trimmed = trimToTokenBudget(msgs, 25);
    expect(trimmed.length).toBeLessThan(3);
    expect(trimmed[trimmed.length - 1]!.content).toBe("C");
  });

  it("never drops system messages", () => {
    const msgs = [
      makeMsg("system",    "Sys", 5),
      makeMsg("user",      "A",   50),
      makeMsg("assistant", "B",   50),
    ];
    const trimmed = trimToTokenBudget(msgs, 10);
    expect(trimmed.some((m) => m.role === "system")).toBe(true);
  });

  it("returns empty when all non-system exceed budget", () => {
    const msgs = [makeMsg("user", "A", 100)];
    const trimmed = trimToTokenBudget(msgs, 5);
    expect(trimmed).toHaveLength(0);
  });
});

// ── analyzeThread ──────────────────────────────────────────────────────────────

describe("analyzeThread", () => {
  it("counts messages by role", () => {
    const thread = makeThread([
      makeMsg("user",      "Q"),
      makeMsg("assistant", "A"),
      makeMsg("user",      "Q2"),
    ]);
    const stats = analyzeThread(thread);
    expect(stats.userMessages).toBe(2);
    expect(stats.assistantMessages).toBe(1);
    expect(stats.messageCount).toBe(3);
  });

  it("collects models used", () => {
    const thread = makeThread([
      { ...makeMsg("assistant", "A"), model: "claude-3" },
      { ...makeMsg("assistant", "B"), model: "gpt-4" },
    ]);
    const stats = analyzeThread(thread);
    expect(stats.modelsUsed).toContain("claude-3");
    expect(stats.modelsUsed).toContain("gpt-4");
  });

  it("computes estimatedTokens as sum", () => {
    const thread = makeThread([makeMsg("user", "X", 15), makeMsg("assistant", "Y", 20)]);
    const stats = analyzeThread(thread);
    expect(stats.estimatedTokens).toBe(35);
  });

  it("provides firstMessage and lastMessage excerpts", () => {
    const thread = makeThread([makeMsg("user", "First message"), makeMsg("assistant", "Last message")]);
    const stats = analyzeThread(thread);
    expect(stats.firstMessage).toContain("First");
    expect(stats.lastMessage).toContain("Last");
  });

  it("handles empty thread", () => {
    const thread = makeThread([]);
    const stats = analyzeThread(thread);
    expect(stats.messageCount).toBe(0);
    expect(stats.firstMessage).toBeUndefined();
  });
});
