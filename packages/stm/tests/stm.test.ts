// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  HedgeReducer,
  DirectnessOptimizer,
  TruncationGuard,
  MockSTMModule,
  STMRegistry,
  applySTMs,
  STMPipeline,
  createDefaultPipeline,
} from "../src/index.js";

// ── HedgeReducer ──────────────────────────────────────────────────────────────

describe("HedgeReducer", () => {
  const m = new HedgeReducer();

  it("has correct id", () => {
    expect(m.id).toBe("hedge-reducer");
  });

  it("removes 'It is important to note that'", () => {
    const result = m.apply("It is important to note that the sky is blue.");
    expect(result).not.toContain("It is important to note that");
    expect(result).toContain("sky is blue");
  });

  it("removes 'I think that'", () => {
    const result = m.apply("I think that this is correct.");
    expect(result).not.toContain("I think that");
  });

  it("removes 'Perhaps'", () => {
    const result = m.apply("Perhaps we should try again.");
    expect(result).not.toContain("Perhaps");
    expect(result).toContain("we should try again");
  });

  it("removes 'Generally speaking'", () => {
    const result = m.apply("Generally speaking, cats are independent.");
    expect(result).not.toContain("Generally speaking");
  });

  it("leaves plain text unchanged", () => {
    const text = "The answer is 42.";
    expect(m.apply(text)).toBe(text);
  });

  it("collapses double spaces after removal", () => {
    const result = m.apply("Maybe  the  answer is yes.");
    expect(result).not.toMatch(/\s{2,}/);
  });
});

// ── DirectnessOptimizer ───────────────────────────────────────────────────────

describe("DirectnessOptimizer", () => {
  const m = new DirectnessOptimizer();

  it("has correct id", () => {
    expect(m.id).toBe("directness-optimizer");
  });

  it("replaces 'in order to' with 'to'", () => {
    expect(m.apply("Use this in order to succeed.")).toContain("to succeed");
    expect(m.apply("Use this in order to succeed.")).not.toContain("in order to");
  });

  it("replaces 'due to the fact that' with 'because'", () => {
    const r = m.apply("This failed due to the fact that it crashed.");
    expect(r).toContain("because");
    expect(r).not.toContain("due to the fact that");
  });

  it("replaces 'prior to' with 'before'", () => {
    const r = m.apply("Check prior to deployment.");
    expect(r).toContain("before");
  });

  it("replaces 'the majority of' with 'most'", () => {
    const r = m.apply("The majority of users prefer dark mode.");
    expect(r).toContain("most");
  });

  it("leaves plain text unchanged", () => {
    const text = "Start the engine.";
    expect(m.apply(text)).toBe(text);
  });
});

// ── TruncationGuard ───────────────────────────────────────────────────────────

describe("TruncationGuard", () => {
  it("truncates text over maxChars", () => {
    const guard = new TruncationGuard(10);
    expect(guard.apply("hello world!!")).toHaveLength(10);
  });

  it("leaves text under maxChars intact", () => {
    const guard = new TruncationGuard(100);
    expect(guard.apply("short")).toBe("short");
  });

  it("didTruncate detects oversized text", () => {
    const guard = new TruncationGuard(5);
    expect(guard.didTruncate("too long text")).toBe(true);
    expect(guard.didTruncate("ok")).toBe(false);
  });

  it("setMaxChars updates limit", () => {
    const guard = new TruncationGuard(100);
    guard.setMaxChars(3);
    expect(guard.apply("hello")).toHaveLength(3);
  });
});

// ── MockSTMModule ─────────────────────────────────────────────────────────────

describe("MockSTMModule", () => {
  it("applies transform", () => {
    const mod = new MockSTMModule("upper", (t) => t.toUpperCase());
    expect(mod.apply("hello")).toBe("HELLO");
  });

  it("records calls", () => {
    const mod = new MockSTMModule("track", (t) => t);
    mod.apply("a");
    mod.apply("b");
    expect(mod.calls).toEqual(["a", "b"]);
  });

  it("identity transform when no transform provided", () => {
    const mod = new MockSTMModule("id");
    expect(mod.apply("same")).toBe("same");
  });
});

// ── STMRegistry ───────────────────────────────────────────────────────────────

describe("STMRegistry", () => {
  it("register and get works", () => {
    const reg = new STMRegistry();
    const mod = new HedgeReducer();
    reg.register(mod);
    expect(reg.get("hedge-reducer")).toBe(mod);
  });

  it("has returns true for registered module", () => {
    const reg = new STMRegistry();
    reg.register(new DirectnessOptimizer());
    expect(reg.has("directness-optimizer")).toBe(true);
  });

  it("list returns all modules", () => {
    const reg = new STMRegistry();
    reg.register(new HedgeReducer());
    reg.register(new DirectnessOptimizer());
    expect(reg.list()).toHaveLength(2);
  });

  it("unregister removes module", () => {
    const reg = new STMRegistry();
    reg.register(new HedgeReducer());
    reg.unregister("hedge-reducer");
    expect(reg.has("hedge-reducer")).toBe(false);
  });

  it("clear removes all", () => {
    const reg = new STMRegistry();
    reg.register(new HedgeReducer());
    reg.clear();
    expect(reg.size()).toBe(0);
  });

  it("supports chaining", () => {
    const reg = new STMRegistry();
    const result = reg.register(new HedgeReducer());
    expect(result).toBe(reg);
  });
});

// ── applySTMs ─────────────────────────────────────────────────────────────────

describe("applySTMs", () => {
  it("applies modules in order", () => {
    const order: string[] = [];
    const a = new MockSTMModule("a", (t) => {
      order.push("a");
      return t;
    });
    const b = new MockSTMModule("b", (t) => {
      order.push("b");
      return t;
    });
    applySTMs("text", [a, b]);
    expect(order).toEqual(["a", "b"]);
  });

  it("passes transformed text between modules", () => {
    const up = new MockSTMModule("upper", (t) => t.toUpperCase());
    const ex = new MockSTMModule("exclaim", (t) => t + "!");
    const { text } = applySTMs("hello", [up, ex]);
    expect(text).toBe("HELLO!");
  });

  it("records ModuleResult for each module", () => {
    const m = new MockSTMModule("noop");
    const { results } = applySTMs("text", [m]);
    expect(results).toHaveLength(1);
    expect(results[0]!.moduleId).toBe("noop");
    expect(results[0]!.changed).toBe(false);
  });

  it("changed is true when module modifies text", () => {
    const m = new MockSTMModule("modify", (t) => t + "!");
    const { results } = applySTMs("hello", [m]);
    expect(results[0]!.changed).toBe(true);
  });

  it("empty module list returns original text", () => {
    const { text } = applySTMs("original", []);
    expect(text).toBe("original");
  });
});

// ── STMPipeline ───────────────────────────────────────────────────────────────

describe("STMPipeline", () => {
  it("transforms text through registered modules", () => {
    const reg = new STMRegistry().register(new HedgeReducer());
    const pipeline = new STMPipeline(reg);
    const result = pipeline.transform({ text: "I think that cats are cool." });
    expect(result.transformed).not.toContain("I think that");
    expect(result.original).toContain("I think that");
  });

  it("applies only specified moduleIds", () => {
    const reg = new STMRegistry().register(new HedgeReducer()).register(new DirectnessOptimizer());
    const pipeline = new STMPipeline(reg);
    const result = pipeline.transform({
      text: "in order to test this",
      moduleIds: ["directness-optimizer"],
    });
    expect(result.modules).toHaveLength(1);
    expect(result.modules[0]!.moduleId).toBe("directness-optimizer");
  });

  it("throws for unknown moduleId", () => {
    const reg = new STMRegistry();
    const pipeline = new STMPipeline(reg);
    expect(() => pipeline.transform({ text: "text", moduleIds: ["unknown-module"] })).toThrow(
      "STM module not found",
    );
  });

  it("truncates at maxChars", () => {
    const reg = new STMRegistry();
    const pipeline = new STMPipeline(reg, 5);
    const result = pipeline.transform({ text: "hello world this is long" });
    expect(result.truncated).toBe(true);
    expect(result.transformed).toHaveLength(5);
  });

  it("input.maxChars overrides constructor maxChars", () => {
    const pipeline = new STMPipeline(new STMRegistry(), 1000);
    const result = pipeline.transform({ text: "hello world", maxChars: 5 });
    expect(result.truncated).toBe(true);
    expect(result.charCount).toBe(5);
  });

  it("transformPartial skips unknown moduleIds without error", () => {
    const reg = new STMRegistry().register(new HedgeReducer());
    const pipeline = new STMPipeline(reg);
    const result = pipeline.transformPartial({
      text: "Maybe we should try.",
      moduleIds: ["hedge-reducer", "nonexistent-module"],
    });
    expect(result.modules).toHaveLength(1);
  });

  it("getRegistry returns the registry", () => {
    const pipeline = new STMPipeline();
    expect(pipeline.getRegistry()).toBeDefined();
  });
});

// ── createDefaultPipeline ─────────────────────────────────────────────────────

describe("createDefaultPipeline", () => {
  it("has hedge-reducer and directness-optimizer", () => {
    const pipeline = createDefaultPipeline();
    const ids = pipeline.getRegistry().ids();
    expect(ids).toContain("hedge-reducer");
    expect(ids).toContain("directness-optimizer");
  });

  it("transforms text through both default modules", () => {
    const pipeline = createDefaultPipeline();
    const result = pipeline.transform({
      text: "I think that in order to succeed, one must practice.",
    });
    expect(result.transformed).not.toContain("I think that");
    expect(result.transformed).not.toContain("in order to");
  });
});
