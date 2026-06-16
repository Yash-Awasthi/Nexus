// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  PreviouslySeenRenderer,
  AgentContextRenderer,
  UserContextRenderer,
  InstructionsRenderer,
  FooterRenderer,
  TokenEconomicsRenderer,
  SectionAssembler,
  type Section,
} from "../src/index.js";

// ── PreviouslySeenRenderer ────────────────────────────────────────────────────

describe("PreviouslySeenRenderer", () => {
  const r = new PreviouslySeenRenderer();

  it("type is 'previously-seen'", () => expect(r.type).toBe("previously-seen"));

  it("renders numbered fact list", () => {
    const s = r.render({ facts: ["Alice likes TypeScript", "Bob prefers Python"] });
    expect(s.content).toContain("1. Alice");
    expect(s.content).toContain("2. Bob");
  });

  it("enabled is false for empty facts", () => {
    expect(r.render({ facts: [] }).enabled).toBe(false);
  });

  it("enabled is true when facts present", () => {
    expect(r.render({ facts: ["fact"] }).enabled).toBe(true);
  });

  it("maxFacts limits rendered list", () => {
    const facts = Array.from({ length: 30 }, (_, i) => `fact-${i}`);
    const s = r.render({ facts, maxFacts: 5 });
    expect(s.content.split("\n").filter((l) => l.match(/^\d+\./))).toHaveLength(5);
  });

  it("has tokenEstimate > 0 when content present", () => {
    const s = r.render({ facts: ["some fact"] });
    expect(s.tokenEstimate).toBeGreaterThan(0);
  });

  it("priority is 10", () => expect(r.render({ facts: [] }).priority).toBe(10));
});

// ── AgentContextRenderer ──────────────────────────────────────────────────────

describe("AgentContextRenderer", () => {
  const r = new AgentContextRenderer();

  it("type is 'agent-context'", () => expect(r.type).toBe("agent-context"));

  it("includes agent name and role", () => {
    const s = r.render({ agentName: "Nexus", role: "a helpful AI assistant" });
    expect(s.content).toContain("Nexus");
    expect(s.content).toContain("helpful AI assistant");
  });

  it("lists capabilities with bullet points", () => {
    const s = r.render({ agentName: "N", role: "r", capabilities: ["Search", "Code"] });
    expect(s.content).toContain("• Search");
    expect(s.content).toContain("• Code");
  });

  it("lists constraints with bullet points", () => {
    const s = r.render({ agentName: "N", role: "r", constraints: ["No PII"] });
    expect(s.content).toContain("• No PII");
  });

  it("always enabled", () => {
    expect(r.render({ agentName: "N", role: "r" }).enabled).toBe(true);
  });

  it("priority is 20", () => expect(r.render({ agentName: "N", role: "r" }).priority).toBe(20));
});

// ── UserContextRenderer ───────────────────────────────────────────────────────

describe("UserContextRenderer", () => {
  const r = new UserContextRenderer();

  it("type is 'user-context'", () => expect(r.type).toBe("user-context"));

  it("renders displayName and userId", () => {
    const s = r.render({ displayName: "Yash", userId: "u-1" });
    expect(s.content).toContain("Yash");
    expect(s.content).toContain("u-1");
  });

  it("renders preferences as key: value", () => {
    const s = r.render({ preferences: { theme: "dark", lang: "en" } });
    expect(s.content).toContain("theme: dark");
    expect(s.content).toContain("lang: en");
  });

  it("renders recentTopics as comma-separated", () => {
    const s = r.render({ recentTopics: ["TypeScript", "Nexus"] });
    expect(s.content).toContain("TypeScript, Nexus");
  });

  it("disabled when no content", () => {
    expect(r.render({}).enabled).toBe(false);
  });

  it("priority is 30", () => expect(r.render({ displayName: "X" }).priority).toBe(30));
});

// ── InstructionsRenderer ──────────────────────────────────────────────────────

describe("InstructionsRenderer", () => {
  const r = new InstructionsRenderer();

  it("type is 'instructions'", () => expect(r.type).toBe("instructions"));

  it("renders instructions text", () => {
    const s = r.render({ instructions: "Be concise." });
    expect(s.content).toContain("Be concise.");
  });

  it("prepends optional header", () => {
    const s = r.render({ instructions: "Do X.", header: "System Rules" });
    expect(s.content).toContain("System Rules");
    expect(s.content).toContain("Do X.");
  });

  it("disabled for empty instructions", () => {
    expect(r.render({ instructions: "" }).enabled).toBe(false);
  });
});

// ── FooterRenderer ────────────────────────────────────────────────────────────

describe("FooterRenderer", () => {
  const r = new FooterRenderer();

  it("type is 'footer'", () => expect(r.type).toBe("footer"));

  it("renders reminder text", () => {
    const s = r.render({ reminder: "Always be helpful." });
    expect(s.content).toContain("Always be helpful.");
  });

  it("includes timestamp when requested", () => {
    const s = r.render({ timestamp: true });
    expect(s.content).toContain("Current time:");
  });

  it("includes format instruction", () => {
    const s = r.render({ format: "JSON" });
    expect(s.content).toContain("Response format: JSON");
  });

  it("disabled when no content", () => {
    expect(r.render({}).enabled).toBe(false);
  });

  it("priority is 90", () => expect(r.render({ reminder: "x" }).priority).toBe(90));
});

// ── TokenEconomicsRenderer ────────────────────────────────────────────────────

describe("TokenEconomicsRenderer", () => {
  const r = new TokenEconomicsRenderer();

  it("type is 'token-economics'", () => expect(r.type).toBe("token-economics"));

  it("shows used / budget and percentage", () => {
    const s = r.render({ inputTokensUsed: 5000, inputTokenBudget: 10000 });
    expect(s.content).toContain("50%");
  });

  it("shows output budget when provided", () => {
    const s = r.render({ inputTokensUsed: 0, inputTokenBudget: 1000, outputTokenBudget: 2048 });
    expect(s.content).toContain("2,048");
  });

  it("shows remaining turns when provided", () => {
    const s = r.render({
      inputTokensUsed: 0,
      inputTokenBudget: 1000,
      remainingConversationTurns: 5,
    });
    expect(s.content).toContain("~5");
  });

  it("always enabled", () => {
    expect(r.render({ inputTokensUsed: 0, inputTokenBudget: 1000 }).enabled).toBe(true);
  });
});

// ── SectionAssembler ──────────────────────────────────────────────────────────

describe("SectionAssembler", () => {
  const makeSection = (content: string, priority = 50, enabled = true): Section => ({
    type: "custom",
    content,
    priority,
    enabled,
    tokenEstimate: Math.ceil(content.length / 4),
  });

  it("assembles sections in priority order", () => {
    const a = new SectionAssembler();
    const result = a.assemble([makeSection("LAST", 90), makeSection("FIRST", 10)]);
    expect(result.indexOf("FIRST")).toBeLessThan(result.indexOf("LAST"));
  });

  it("skips disabled sections", () => {
    const a = new SectionAssembler();
    const result = a.assemble([makeSection("visible"), makeSection("hidden", 50, false)]);
    expect(result).toContain("visible");
    expect(result).not.toContain("hidden");
  });

  it("joins with custom separator", () => {
    const a = new SectionAssembler({ separator: "---" });
    const result = a.assemble([makeSection("A"), makeSection("B", 60)]);
    expect(result).toContain("---");
  });

  it("trims to maxChars", () => {
    const a = new SectionAssembler({ maxChars: 5 });
    const result = a.assemble([makeSection("hello world this is long")]);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it("shows labels when showLabels=true", () => {
    const a = new SectionAssembler({ showLabels: true });
    const s: Section = { ...makeSection("Content"), label: "My Label" };
    const result = a.assemble([s]);
    expect(result).toContain("My Label");
    expect(result).toContain("Content");
  });

  it("custom labelPrefix", () => {
    const a = new SectionAssembler({ showLabels: true, labelPrefix: "### " });
    const s: Section = { ...makeSection("X"), label: "H" };
    expect(a.assemble([s])).toContain("### H");
  });

  it("totalTokenEstimate sums enabled sections", () => {
    const a = new SectionAssembler();
    const sections = [makeSection("hello", 10, true), makeSection("world", 20, false)];
    // only first section is enabled; "hello" → ceil(5/4)=2
    const total = a.totalTokenEstimate(sections);
    expect(total).toBe(2);
  });

  it("returns empty string for no enabled sections", () => {
    const a = new SectionAssembler();
    expect(a.assemble([makeSection("x", 50, false)])).toBe("");
  });
});

// ── Integration: full context assembly ───────────────────────────────────────

describe("Full context assembly", () => {
  it("assembles agent + user + instructions in priority order", () => {
    const agentR = new AgentContextRenderer();
    const userR = new UserContextRenderer();
    const instrR = new InstructionsRenderer();
    const footer = new FooterRenderer();

    const sections = [
      agentR.render({ agentName: "Nexus", role: "an AI assistant" }),
      userR.render({ displayName: "Yash", preferences: { lang: "en" } }),
      instrR.render({ instructions: "Be concise and accurate." }),
      footer.render({ reminder: "Always cite sources." }),
    ];

    const assembler = new SectionAssembler();
    const ctx = assembler.assemble(sections);

    expect(ctx).toContain("Nexus");
    expect(ctx).toContain("Yash");
    expect(ctx).toContain("Be concise");
    expect(ctx).toContain("Always cite");
    // order: agent (20) → user (30) → instructions (40) → footer (90)
    expect(ctx.indexOf("Nexus")).toBeLessThan(ctx.indexOf("Yash"));
  });
});
