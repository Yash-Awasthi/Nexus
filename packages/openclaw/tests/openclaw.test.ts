// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  ConversationAnalyzer,
  analyzeConversation,
  type ConversationMessage,
} from "../src/index.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const CODING_CONV: ConversationMessage[] = [
  { role: "user", content: "I have a bug in my TypeScript function. The async call fails with an error." },
  { role: "assistant", content: "Let's debug this. Can you share the stack trace?" },
  { role: "user", content: "TypeError: Cannot read property 'data' of undefined at line 42. How do I fix this?" },
  { role: "assistant", content: "The error means the API response is undefined. Add null checking before accessing .data." },
  { role: "user", content: "That fixed it! Thanks, great help." },
];

const CREATIVE_CONV: ConversationMessage[] = [
  { role: "user", content: "Write me a short story about a robot who learns to paint." },
  { role: "assistant", content: "In the factory district of Neo-Seoul, unit RX-7 discovered a discarded easel..." },
  { role: "user", content: "I love it! Can you write a poem about the same theme?" },
  { role: "assistant", content: "Circuits hum in midnight blue, / Steel fingers learn what artists knew..." },
];

const PLANNING_CONV: ConversationMessage[] = [
  { role: "user", content: "Help me plan the architecture for a microservice deployment." },
  { role: "assistant", content: "Let's outline the key components: API gateway, service mesh, and monitoring." },
  { role: "user", content: "What are the pros and cons of using Kubernetes for this?" },
  { role: "assistant", content: "Pros: scalability, container orchestration. Cons: steep learning curve, operational overhead." },
];

const EMPTY_CONV: ConversationMessage[] = [];

// ── ConversationAnalyzer — basics ─────────────────────────────────────────────

describe("ConversationAnalyzer", () => {
  const analyzer = new ConversationAnalyzer();

  it("handles empty conversation gracefully", () => {
    const insight = analyzer.analyze({ id: "empty", messages: EMPTY_CONV });
    expect(insight.conversationId).toBe("empty");
    expect(insight.messageCount).toBe(0);
    expect(insight.themes).toEqual([]);
    expect(insight.intents).toEqual([]);
    expect(insight.summary).toMatch(/empty/i);
    expect(insight.sentiment).toBe("neutral");
  });

  it("counts messages correctly", () => {
    const insight = analyzer.analyze({ id: "c1", messages: CODING_CONV });
    expect(insight.messageCount).toBe(5);
    expect(insight.userMessageCount).toBe(3);
    expect(insight.assistantMessageCount).toBe(2);
  });

  it("sets conversationId from input", () => {
    const insight = analyzer.analyze({ id: "my-conv-123", messages: CODING_CONV });
    expect(insight.conversationId).toBe("my-conv-123");
  });

  it("sets analyzedAt close to now", () => {
    const before = Date.now();
    const insight = analyzer.analyze({ id: "t", messages: CODING_CONV });
    expect(insight.analyzedAt).toBeGreaterThanOrEqual(before);
    expect(insight.analyzedAt).toBeLessThanOrEqual(Date.now() + 100);
  });

  it("computes averageUserMessageLength > 0 for non-empty conversations", () => {
    const insight = analyzer.analyze({ id: "c", messages: CODING_CONV });
    expect(insight.averageUserMessageLength).toBeGreaterThan(0);
  });
});

// ── Theme detection ───────────────────────────────────────────────────────────

describe("theme detection", () => {
  it("detects debugging theme in coding conversation", () => {
    const insight = analyzeConversation({ id: "c", messages: CODING_CONV });
    expect(insight.themes).toContain("debugging");
  });

  it("detects software-development theme", () => {
    const insight = analyzeConversation({ id: "c", messages: CODING_CONV });
    // TypeScript is mentioned → software-development theme
    expect(insight.themes).toContain("software-development");
  });

  it("detects architecture / planning theme", () => {
    const insight = analyzeConversation({ id: "p", messages: PLANNING_CONV });
    expect(insight.themes.some((t) => ["architecture", "planning"].includes(t))).toBe(true);
  });

  it("returns empty themes for empty conversation", () => {
    const insight = analyzeConversation({ id: "e", messages: [] });
    expect(insight.themes).toEqual([]);
  });
});

// ── Intent detection ──────────────────────────────────────────────────────────

describe("intent detection", () => {
  it("detects debugging intent in coding conversation", () => {
    const insight = analyzeConversation({ id: "c", messages: CODING_CONV });
    const types = insight.intents.map((i) => i.type);
    expect(types).toContain("debugging");
  });

  it("detects information_seeking intent (questions)", () => {
    const msgs: ConversationMessage[] = [
      { role: "user", content: "What is the difference between async/await and promises? How does it work?" },
    ];
    const insight = analyzeConversation({ id: "i", messages: msgs });
    const types = insight.intents.map((i) => i.type);
    expect(types).toContain("information_seeking");
  });

  it("detects creative_generation intent", () => {
    const insight = analyzeConversation({ id: "cr", messages: CREATIVE_CONV });
    const types = insight.intents.map((i) => i.type);
    expect(types).toContain("creative_generation");
  });

  it("detects task_execution intent", () => {
    const msgs: ConversationMessage[] = [
      { role: "user", content: "Please write a function that sorts an array. Create a test for it too." },
    ];
    const insight = analyzeConversation({ id: "t", messages: msgs });
    const types = insight.intents.map((i) => i.type);
    expect(types).toContain("task_execution");
  });

  it("intents are sorted by confidence descending", () => {
    const insight = analyzeConversation({ id: "c", messages: CODING_CONV });
    for (let i = 1; i < insight.intents.length; i++) {
      expect(insight.intents[i - 1]!.confidence).toBeGreaterThanOrEqual(
        insight.intents[i]!.confidence,
      );
    }
  });

  it("intent confidence is in [0, 1]", () => {
    const insight = analyzeConversation({ id: "c", messages: CODING_CONV });
    for (const intent of insight.intents) {
      expect(intent.confidence).toBeGreaterThanOrEqual(0);
      expect(intent.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("evidence is a non-empty array of strings", () => {
    const insight = analyzeConversation({ id: "c", messages: CODING_CONV });
    for (const intent of insight.intents) {
      expect(Array.isArray(intent.evidence)).toBe(true);
      expect(intent.evidence.length).toBeGreaterThan(0);
    }
  });
});

// ── Sentiment ─────────────────────────────────────────────────────────────────

describe("sentiment detection", () => {
  it("detects positive sentiment when thanks/great present", () => {
    const msgs: ConversationMessage[] = [
      { role: "user", content: "That fixed it! Thanks, great help, awesome!" },
    ];
    expect(analyzeConversation({ id: "p", messages: msgs }).sentiment).toBe("positive");
  });

  it("detects negative sentiment when errors/broken present", () => {
    const msgs: ConversationMessage[] = [
      { role: "user", content: "It's broken again. The error is terrible and it doesn't work." },
    ];
    expect(analyzeConversation({ id: "n", messages: msgs }).sentiment).toBe("negative");
  });

  it("detects mixed sentiment when both positive and negative terms present", () => {
    const msgs: ConversationMessage[] = [
      { role: "user", content: "Great progress but still have this terrible error. Thanks for the help though!" },
    ];
    expect(analyzeConversation({ id: "m", messages: msgs }).sentiment).toBe("mixed");
  });

  it("returns neutral for no sentiment signals", () => {
    const msgs: ConversationMessage[] = [
      { role: "user", content: "What is the capital of France?" },
    ];
    expect(analyzeConversation({ id: "n", messages: msgs }).sentiment).toBe("neutral");
  });
});

// ── Keywords ──────────────────────────────────────────────────────────────────

describe("keyword extraction", () => {
  it("extracts top keywords from conversation", () => {
    const insight = analyzeConversation({ id: "c", messages: CODING_CONV });
    expect(insight.topKeywords.length).toBeGreaterThan(0);
    expect(insight.topKeywords.every((k) => typeof k === "string")).toBe(true);
  });

  it("respects topK limit", () => {
    const insight = new ConversationAnalyzer({ topK: 3 }).analyze({
      id: "c",
      messages: CODING_CONV,
    });
    expect(insight.topKeywords.length).toBeLessThanOrEqual(3);
  });

  it("topK option in analyze() overrides constructor default", () => {
    const analyzer = new ConversationAnalyzer({ topK: 10 });
    const insight = analyzer.analyze({ id: "c", messages: CODING_CONV, topK: 2 });
    expect(insight.topKeywords.length).toBeLessThanOrEqual(2);
  });

  it("keywords are lowercase strings", () => {
    const insight = analyzeConversation({ id: "c", messages: CODING_CONV });
    for (const kw of insight.topKeywords) {
      expect(kw).toBe(kw.toLowerCase());
    }
  });

  it("keywords don't include common stop words", () => {
    const insight = analyzeConversation({ id: "c", messages: CODING_CONV });
    const stopWords = ["the", "a", "and", "is", "to", "in", "of"];
    for (const sw of stopWords) {
      expect(insight.topKeywords).not.toContain(sw);
    }
  });
});

// ── Summary ───────────────────────────────────────────────────────────────────

describe("summary", () => {
  it("returns a non-empty string for real conversations", () => {
    const insight = analyzeConversation({ id: "c", messages: CODING_CONV });
    expect(typeof insight.summary).toBe("string");
    expect(insight.summary.length).toBeGreaterThan(10);
  });

  it("returns empty conversation notice for empty input", () => {
    const insight = analyzeConversation({ id: "e", messages: [] });
    expect(insight.summary).toMatch(/empty/i);
  });
});

// ── analyzeConversation convenience export ────────────────────────────────────

describe("analyzeConversation()", () => {
  it("produces same result as new ConversationAnalyzer().analyze()", () => {
    const opts = { id: "x", messages: CODING_CONV };
    const a = analyzeConversation(opts);
    const b = new ConversationAnalyzer().analyze(opts);
    expect(a.messageCount).toBe(b.messageCount);
    expect(a.themes).toEqual(b.themes);
    expect(a.topKeywords).toEqual(b.topKeywords);
  });
});
