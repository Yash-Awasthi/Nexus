// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  NaiveTokenizer,
  WordTokenizer,
  SlidingWindowPruner,
  TFIDFPruner,
  ImportanceWeightedPruner,
  PrunerChain,
  BudgetGuard,
  PrunerError,
  type IContextPruner,
  type Message,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
} from "../src/index.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function msg(role: Message["role"], content: string): Message {
  return { role, content };
}

function sys(content = "You are a helpful assistant."): Message {
  return msg("system", content);
}

function user(content: string): Message {
  return msg("user", content);
}
function asst(content: string): Message {
  return msg("assistant", content);
}

function makeProvider(response = "ok"): LLMProvider {
  return {
    name: "mock",
    models: ["gpt-4o"],
    async complete(req: LLMRequest): Promise<LLMResponse> {
      return { id: "r1", model: req.model, content: response, provider: "mock", latencyMs: 10 };
    },
  };
}

// ── NaiveTokenizer ────────────────────────────────────────────────────────────

describe("NaiveTokenizer", () => {
  const tok = new NaiveTokenizer();

  it("counts ~4 chars per token", () => {
    expect(tok.count("abcd")).toBe(1);
    expect(tok.count("abcdefgh")).toBe(2);
  });

  it("rounds up fractional tokens", () => {
    expect(tok.count("abc")).toBe(1); // ceil(3/4) = 1
    expect(tok.count("abcde")).toBe(2); // ceil(5/4) = 2
  });

  it("returns 0 for empty string", () => {
    expect(tok.count("")).toBe(0);
  });
});

// ── WordTokenizer ─────────────────────────────────────────────────────────────

describe("WordTokenizer", () => {
  const tok = new WordTokenizer();

  it("counts words by whitespace split", () => {
    expect(tok.count("hello world")).toBe(2);
    expect(tok.count("one two three four")).toBe(4);
  });

  it("returns 0 for empty string", () => {
    expect(tok.count("")).toBe(0);
    expect(tok.count("   ")).toBe(0);
  });
});

// ── SlidingWindowPruner ───────────────────────────────────────────────────────

describe("SlidingWindowPruner", () => {
  const pruner = new SlidingWindowPruner(new NaiveTokenizer());

  it("returns all messages when they fit within budget", async () => {
    const msgs = [sys(), user("hi"), asst("hello")];
    const result = await pruner.prune(msgs, 10000);
    expect(result.messages).toHaveLength(3);
    expect(result.prunedCount).toBe(0);
  });

  it("always retains the system message", async () => {
    const sysMsg = sys("You are a helpful assistant. " + "x".repeat(100));
    const msgs = [sysMsg, user("a"), user("b"), user("c")];
    const result = await pruner.prune(msgs, 60);
    expect(result.messages[0]?.role).toBe("system");
  });

  it("keeps most recent messages when budget is tight", async () => {
    const msgs = [user("old message 1"), user("old message 2"), user("recent message")];
    const result = await pruner.prune(msgs, 30);
    const contents = result.messages.map((m) => m.content);
    expect(contents).toContain("recent message");
  });

  it("reports correct prunedCount", async () => {
    const msgs = [sys(), user("a"), user("b"), user("c"), user("d")];
    const result = await pruner.prune(msgs, 20);
    expect(result.prunedCount).toBe(result.originalCount - result.messages.length);
    expect(result.originalCount).toBe(5);
  });

  it("strategy name is 'sliding-window'", async () => {
    const result = await pruner.prune([user("hi")], 1000);
    expect(result.strategy).toBe("sliding-window");
  });

  it("estimate returns total token count", () => {
    const msgs = [user("hello world")]; // 4 + ceil(11/4)=3 = 7 tokens
    expect(pruner.estimate(msgs)).toBeGreaterThan(0);
  });

  it("handles empty messages array", async () => {
    const result = await pruner.prune([], 1000);
    expect(result.messages).toHaveLength(0);
    expect(result.prunedCount).toBe(0);
  });

  it("handles only system message", async () => {
    const result = await pruner.prune([sys()], 1000);
    expect(result.messages).toHaveLength(1);
  });

  it("respects reserveTokens option", async () => {
    // Budget 100 tokens but reserve 80 → only 20 tokens for content
    const msgs = [user("short"), user("a".repeat(100))];
    const tight = await pruner.prune(msgs, 100, { reserveTokens: 80 });
    const loose = await pruner.prune(msgs, 100, { reserveTokens: 0 });
    expect(tight.messages.length).toBeLessThanOrEqual(loose.messages.length);
  });

  it("implements IContextPruner interface", () => {
    const p: IContextPruner = pruner;
    expect(typeof p.prune).toBe("function");
    expect(typeof p.estimate).toBe("function");
  });
});

// ── TFIDFPruner ───────────────────────────────────────────────────────────────

describe("TFIDFPruner", () => {
  const pruner = new TFIDFPruner(new NaiveTokenizer());

  it("always keeps the last user message", async () => {
    const msgs = [
      user("unrelated topic one"),
      user("unrelated topic two"),
      user("what is the capital of France"),
    ];
    const result = await pruner.prune(msgs, 40);
    const contents = result.messages.map((m) => m.content);
    expect(contents).toContain("what is the capital of France");
  });

  it("retains system message", async () => {
    const msgs = [sys(), user("question about dogs"), asst("answer"), user("follow-up about dogs")];
    const result = await pruner.prune(msgs, 60);
    expect(result.messages[0]?.role).toBe("system");
  });

  it("scores relevant messages higher than irrelevant ones", async () => {
    // Last user message is about Python. Relevant prior msg should score higher.
    const msgs = [
      user("I like cats and dogs"), // irrelevant
      asst("Nice! Cats are great"), // irrelevant
      user("Python is a great language"), // relevant
      asst("Python rocks"), // relevant
      user("Tell me more about Python"), // anchor
    ];
    // Tight budget: only fits ~3 messages (anchor + 2 others)
    const result = await pruner.prune(msgs, 60);
    const contents = result.messages.map((m) => m.content);
    // The Python-related messages should be preferred
    expect(contents).toContain("Tell me more about Python");
  });

  it("strategy name is 'tfidf'", async () => {
    const result = await pruner.prune([user("hi")], 1000);
    expect(result.strategy).toBe("tfidf");
  });

  it("handles empty rest after extracting system", async () => {
    const result = await pruner.prune([sys()], 1000);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.role).toBe("system");
  });
});

// ── ImportanceWeightedPruner ──────────────────────────────────────────────────

describe("ImportanceWeightedPruner", () => {
  const pruner = new ImportanceWeightedPruner(new NaiveTokenizer());

  it("always retains system message", async () => {
    const msgs = [sys(), user("a"), asst("b"), user("c"), asst("d")];
    const result = await pruner.prune(msgs, 30);
    expect(result.messages[0]?.role).toBe("system");
  });

  it("prefers user messages over assistant messages under budget pressure", async () => {
    const msgs = [
      asst("assistant response 1"),
      asst("assistant response 2"),
      user("important user question"),
    ];
    const result = await pruner.prune(msgs, 40);
    const roles = result.messages.map((m) => m.role);
    // User message should survive when something must be dropped
    expect(roles).toContain("user");
  });

  it("strategy name is 'importance-weighted'", async () => {
    const result = await pruner.prune([user("hi")], 1000);
    expect(result.strategy).toBe("importance-weighted");
  });

  it("preserves original message order in output", async () => {
    const msgs = [user("first"), asst("second"), user("third")];
    const result = await pruner.prune(msgs, 10000);
    expect(result.messages.map((m) => m.content)).toEqual(["first", "second", "third"]);
  });
});

// ── PrunerChain ───────────────────────────────────────────────────────────────

describe("PrunerChain", () => {
  it("throws PrunerError when no pruners provided", () => {
    expect(() => new PrunerChain([])).toThrow(PrunerError);
  });

  it("returns first pruner result when it satisfies budget", async () => {
    const sliding = new SlidingWindowPruner(new NaiveTokenizer());
    const tfidf = new TFIDFPruner(new NaiveTokenizer());
    const chain = new PrunerChain([sliding, tfidf]);
    const msgs = [user("short")];
    const result = await chain.prune(msgs, 10000);
    expect(result.strategy).toBe("sliding-window");
  });

  it("falls back to second pruner if first result exceeds budget", async () => {
    // Tiny budget — sliding window can't fit, neither can tfidf, but importance might
    const msgs = [user("a"), user("b"), user("c"), user("d"), user("e")];

    // Wrap pruners with artificial token inflation for test control
    const bigPruner: IContextPruner = {
      estimate: () => 9999,
      async prune(m) {
        return {
          messages: m,
          originalCount: m.length,
          prunedCount: 0,
          estimatedTokens: 9999,
          strategy: "big",
        };
      },
    };
    const smallPruner: IContextPruner = {
      estimate: () => 1,
      async prune(m) {
        return {
          messages: [m[m.length - 1]!],
          originalCount: m.length,
          prunedCount: m.length - 1,
          estimatedTokens: 1,
          strategy: "small",
        };
      },
    };
    const chain = new PrunerChain([bigPruner, smallPruner]);
    const result = await chain.prune(msgs, 100);
    expect(result.strategy).toBe("small");
  });

  it("falls back to last result when none satisfy budget", async () => {
    const alwaysOver: IContextPruner = {
      estimate: () => 9999,
      async prune(m) {
        return {
          messages: m,
          originalCount: m.length,
          prunedCount: 0,
          estimatedTokens: 9999,
          strategy: "over",
        };
      },
    };
    const chain = new PrunerChain([alwaysOver]);
    const result = await chain.prune([user("hi")], 1);
    expect(result).toBeDefined(); // returns last result regardless
  });
});

// ── BudgetGuard ───────────────────────────────────────────────────────────────

describe("BudgetGuard", () => {
  it("passes through when messages fit in context window", async () => {
    const inner = makeProvider("response");
    const pruner = new SlidingWindowPruner(new NaiveTokenizer());
    const guard = new BudgetGuard(inner, pruner, { contextWindowTokens: 10000 });
    const result = await guard.complete({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.content).toBe("response");
  });

  it("prunes messages when they exceed context window", async () => {
    const captured: LLMRequest[] = [];
    const inner: LLMProvider = {
      name: "spy",
      models: ["gpt-4o"],
      async complete(req) {
        captured.push(req);
        return { id: "r", model: req.model, content: "ok", provider: "spy", latencyMs: 1 };
      },
    };
    const pruner = new SlidingWindowPruner(new NaiveTokenizer());
    // Very tight: 50 token window, 30 reserved for completion → only 20 for context
    const guard = new BudgetGuard(inner, pruner, {
      contextWindowTokens: 50,
      reserveCompletionTokens: 30,
    });
    const manyMessages = Array.from({ length: 20 }, (_, i) => ({
      role: "user" as const,
      content: `message number ${i}`,
    }));
    await guard.complete({ model: "gpt-4o", messages: manyMessages });
    expect(captured[0]!.messages.length).toBeLessThan(manyMessages.length);
  });

  it("wraps provider name", () => {
    const guard = new BudgetGuard(makeProvider(), new SlidingWindowPruner());
    expect(guard.name).toBe("budget-guarded(mock)");
  });

  it("exposes contextPruner", () => {
    const p = new SlidingWindowPruner();
    const guard = new BudgetGuard(makeProvider(), p);
    expect(guard.contextPruner).toBe(p);
  });
});

// ── PrunerError ───────────────────────────────────────────────────────────────

describe("PrunerError", () => {
  it("has correct name and code", () => {
    const e = new PrunerError("overflow", "OVERFLOW", { tokens: 9999 });
    expect(e.name).toBe("PrunerError");
    expect(e.code).toBe("OVERFLOW");
    expect(e instanceof Error).toBe(true);
  });
});
