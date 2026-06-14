// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryTranscriptStore } from "../src/index.js";

let store: InMemoryTranscriptStore;
beforeEach(() => { store = new InMemoryTranscriptStore(); });

describe("session lifecycle", () => {
  it("creates a session with auto-generated id", () => {
    const t = store.createSession();
    expect(t.sessionId).toBeTruthy();
    expect(t.messages).toHaveLength(0);
  });

  it("creates a session with provided id", () => {
    const t = store.createSession("my-session");
    expect(t.sessionId).toBe("my-session");
  });

  it("getSession returns the session", () => {
    store.createSession("s1");
    expect(store.getSession("s1")).toBeDefined();
  });

  it("getSession returns undefined for unknown id", () => {
    expect(store.getSession("ghost")).toBeUndefined();
  });

  it("deleteSession removes session", () => {
    store.createSession("s1");
    expect(store.deleteSession("s1")).toBe(true);
    expect(store.getSession("s1")).toBeUndefined();
  });

  it("deleteSession returns false for unknown id", () => {
    expect(store.deleteSession("ghost")).toBe(false);
  });

  it("listSessionIds returns all session ids", () => {
    store.createSession("a");
    store.createSession("b");
    const ids = store.listSessionIds();
    expect(ids).toContain("a");
    expect(ids).toContain("b");
  });
});

describe("append", () => {
  it("appends a message and returns it", () => {
    store.createSession("s");
    const msg = store.append("s", "user", "Hello");
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("Hello");
    expect(msg.id).toBeTruthy();
    expect(msg.timestamp).toBeTruthy();
  });

  it("appends multiple messages in order", () => {
    store.createSession("s");
    store.append("s", "user", "Q1");
    store.append("s", "assistant", "A1");
    store.append("s", "user", "Q2");
    expect(store.messageCount("s")).toBe(3);
  });

  it("throws for unknown session", () => {
    expect(() => store.append("ghost", "user", "hi")).toThrow();
  });

  it("stores metadata", () => {
    store.createSession("s");
    const msg = store.append("s", "assistant", "hi", { model: "claude-3" });
    expect(msg.metadata?.model).toBe("claude-3");
  });
});

describe("replay", () => {
  beforeEach(() => {
    store.createSession("s");
    store.append("s", "system", "You are helpful");
    store.append("s", "user", "Hello");
    store.append("s", "assistant", "Hi there");
    store.append("s", "user", "Goodbye");
  });

  it("replays all messages by default", () => {
    expect(store.replay("s")).toHaveLength(4);
  });

  it("replays from a specific index", () => {
    const r = store.replay("s", { fromIndex: 2 });
    expect(r).toHaveLength(2);
    expect(r[0]!.content).toBe("Hi there");
  });

  it("replays up to a specific index", () => {
    const r = store.replay("s", { toIndex: 1 });
    expect(r).toHaveLength(2);
  });

  it("replays with role filter", () => {
    const r = store.replay("s", { roles: ["user"] });
    expect(r).toHaveLength(2);
    expect(r.every((m) => m.role === "user")).toBe(true);
  });

  it("returns empty for unknown session", () => {
    expect(store.replay("ghost")).toHaveLength(0);
  });
});

describe("search", () => {
  beforeEach(() => {
    store.createSession("s");
    store.append("s", "user", "Tell me about JavaScript");
    store.append("s", "assistant", "JavaScript is a scripting language");
    store.append("s", "user", "What about TypeScript?");
    store.append("s", "assistant", "TypeScript adds types to JavaScript");
  });

  it("finds messages by substring", () => {
    const r = store.search("s", "JavaScript");
    expect(r.length).toBeGreaterThan(0);
  });

  it("is case-insensitive by default", () => {
    const r = store.search("s", "javascript");
    expect(r.length).toBeGreaterThan(0);
  });

  it("can be case-sensitive", () => {
    const r = store.search("s", "javascript", { caseSensitive: true });
    // lowercase 'javascript' won't match 'JavaScript' or 'TypeScript adds...'
    expect(r.length).toBe(0);
  });

  it("filters by role", () => {
    const r = store.search("s", "JavaScript", { role: "user" });
    expect(r.every((m) => m.role === "user")).toBe(true);
  });

  it("respects limit", () => {
    const r = store.search("s", "JavaScript", { limit: 1 });
    expect(r).toHaveLength(1);
  });

  it("returns empty for unknown session", () => {
    expect(store.search("ghost", "anything")).toHaveLength(0);
  });
});

describe("exportText", () => {
  it("formats messages as role: content", () => {
    store.createSession("s");
    store.append("s", "user", "Hello");
    store.append("s", "assistant", "Hi");
    const text = store.exportText("s");
    expect(text).toContain("[USER]");
    expect(text).toContain("[ASSISTANT]");
    expect(text).toContain("Hello");
    expect(text).toContain("Hi");
  });

  it("returns empty string for unknown session", () => {
    expect(store.exportText("ghost")).toBe("");
  });
});

describe("exportJSON", () => {
  it("exports valid JSON", () => {
    store.createSession("s");
    store.append("s", "user", "test");
    const json = store.exportJSON("s");
    const parsed = JSON.parse(json);
    expect(parsed.sessionId).toBe("s");
    expect(parsed.messages).toHaveLength(1);
  });

  it("returns 'null' for unknown session", () => {
    expect(store.exportJSON("ghost")).toBe("null");
  });
});

describe("snapshot", () => {
  it("forks session with all messages", () => {
    store.createSession("src");
    store.append("src", "user", "msg1");
    store.append("src", "assistant", "msg2");
    const fork = store.snapshot("src", "fork");
    expect(fork.sessionId).toBe("fork");
    expect(fork.messages).toHaveLength(2);
  });

  it("forks up to a specific index", () => {
    store.createSession("src");
    store.append("src", "user", "msg1");
    store.append("src", "assistant", "msg2");
    store.append("src", "user", "msg3");
    const fork = store.snapshot("src", "fork", 1);
    expect(fork.messages).toHaveLength(2);
  });

  it("fork is independent of source", () => {
    store.createSession("src");
    store.append("src", "user", "msg1");
    store.snapshot("src", "fork");
    store.append("src", "user", "msg2");
    expect(store.getSession("fork")!.messages).toHaveLength(1);
    expect(store.messageCount("src")).toBe(2);
  });

  it("throws for unknown source session", () => {
    expect(() => store.snapshot("ghost", "fork")).toThrow();
  });
});
