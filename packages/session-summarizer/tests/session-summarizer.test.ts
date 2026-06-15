// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  LLMSessionSummarizer,
  FixedSummarizer,
  AutoCompressor,
  SummarizerError,
  NaiveTokenizer,
  type ISessionSummarizer,
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

function makeProvider(response = "Summarized."): { provider: LLMProvider; calls: LLMRequest[] } {
  const calls: LLMRequest[] = [];
  const provider: LLMProvider = {
    name: "mock",
    models: ["gpt-4o"],
    async complete(req) {
      calls.push(req);
      return { id: "r1", model: req.model, content: response, provider: "mock" };
    },
  };
  return { provider, calls };
}

// ── NaiveTokenizer ────────────────────────────────────────────────────────────

describe("NaiveTokenizer", () => {
  const tok = new NaiveTokenizer();
  it("counts ~4 chars per token", () => {
    expect(tok.count("abcd")).toBe(1);
    expect(tok.count("abcdefgh")).toBe(2);
  });
  it("returns 0 for empty string", () => {
    expect(tok.count("")).toBe(0);
  });
});

// ── LLMSessionSummarizer.summarize ────────────────────────────────────────────

describe("LLMSessionSummarizer.summarize", () => {
  it("calls provider.complete with messages + instruction", async () => {
    const { provider, calls } = makeProvider("Here is the summary.");
    const summarizer = new LLMSessionSummarizer(provider);
    const messages = [user("hello"), asst("hi there")];
    const summary = await summarizer.summarize(messages);
    expect(calls).toHaveLength(1);
    // Last message in the call should be the summarization instruction
    const lastMsg = calls[0]!.messages.at(-1)!;
    expect(lastMsg.role).toBe("user");
    expect(lastMsg.content).toContain("Summarize");
    expect(summary).toBe("Here is the summary.");
  });

  it("passes {count} substituted into custom instruction", async () => {
    const { provider, calls } = makeProvider("ok");
    const summarizer = new LLMSessionSummarizer(provider);
    await summarizer.summarize([user("a"), user("b")], {
      summaryInstruction: "Summarize {count} messages briefly.",
    });
    const lastMsg = calls[0]!.messages.at(-1)!;
    expect(lastMsg.content).toContain("2 messages");
  });

  it("uses first model in provider.models by default", async () => {
    const { provider, calls } = makeProvider("ok");
    const summarizer = new LLMSessionSummarizer(provider);
    await summarizer.summarize([user("x")]);
    expect(calls[0]!.model).toBe("gpt-4o");
  });

  it("uses custom model when specified in opts", async () => {
    const { provider, calls } = makeProvider("ok");
    const summarizer = new LLMSessionSummarizer(provider);
    await summarizer.summarize([user("x")], { model: "gpt-4o-mini" });
    expect(calls[0]!.model).toBe("gpt-4o-mini");
  });

  it("passes maxSummaryTokens as maxTokens to provider", async () => {
    const { provider, calls } = makeProvider("ok");
    const summarizer = new LLMSessionSummarizer(provider);
    await summarizer.summarize([user("x")], { maxSummaryTokens: 128 });
    expect(calls[0]!.maxTokens).toBe(128);
  });

  it("trims whitespace from the response", async () => {
    const { provider } = makeProvider("  leading and trailing  ");
    const summarizer = new LLMSessionSummarizer(provider);
    const result = await summarizer.summarize([user("x")]);
    expect(result).toBe("leading and trailing");
  });
});

// ── LLMSessionSummarizer.compress ─────────────────────────────────────────────

describe("LLMSessionSummarizer.compress", () => {
  it("returns messages unchanged when not enough to summarize", async () => {
    const { provider } = makeProvider("summary");
    const summarizer = new LLMSessionSummarizer(provider);
    const messages = [user("a"), user("b")];
    const result = await summarizer.compress(messages, { keepRecentCount: 4 });
    expect(result.messages).toHaveLength(2);
    expect(result.summarizedCount).toBe(0);
    expect(result.keptCount).toBe(2);
  });

  it("system message is always preserved", async () => {
    const { provider } = makeProvider("summary text");
    const summarizer = new LLMSessionSummarizer(provider);
    const messages = [sys(), user("a"), asst("b"), user("c"), asst("d"), user("e")];
    const result = await summarizer.compress(messages, { keepRecentCount: 2 });
    expect(result.messages[0]!.role).toBe("system");
  });

  it("inserts a summary message after system", async () => {
    const { provider } = makeProvider("The conversation was about cats.");
    const summarizer = new LLMSessionSummarizer(provider);
    const messages = [
      sys(),
      user("cats?"),
      asst("yes cats"),
      user("dogs?"),
      asst("no cats"),
      user("final"),
    ];
    const result = await summarizer.compress(messages, { keepRecentCount: 1 });
    const summaryMsg = result.messages[1];
    expect(summaryMsg!.role).toBe("assistant");
    expect(summaryMsg!.content).toContain("[Summary");
    expect(summaryMsg!.content).toContain("The conversation was about cats.");
  });

  it("keeps keepRecentCount tail messages verbatim", async () => {
    const { provider } = makeProvider("sum");
    const summarizer = new LLMSessionSummarizer(provider);
    const messages = [user("old1"), user("old2"), user("recent1"), user("recent2")];
    const result = await summarizer.compress(messages, { keepRecentCount: 2 });
    const contents = result.messages.map((m) => m.content);
    expect(contents).toContain("recent1");
    expect(contents).toContain("recent2");
  });

  it("reports correct counts", async () => {
    const { provider } = makeProvider("sum");
    const summarizer = new LLMSessionSummarizer(provider);
    // 1 sys + 6 messages → keep 2 recent → summarize 4
    const messages = [sys(), user("1"), user("2"), user("3"), user("4"), user("5"), user("6")];
    const result = await summarizer.compress(messages, { keepRecentCount: 2 });
    expect(result.originalCount).toBe(7);
    expect(result.summarizedCount).toBe(4);
    expect(result.keptCount).toBe(3); // sys + 2 recent
  });

  it("result messages are fewer than original when compression happens", async () => {
    const { provider } = makeProvider("compact");
    const summarizer = new LLMSessionSummarizer(provider);
    const messages = [user("1"), user("2"), user("3"), user("4"), user("5"), user("6")];
    const result = await summarizer.compress(messages, { keepRecentCount: 2 });
    expect(result.messages.length).toBeLessThan(messages.length);
  });
});

// ── LLMSessionSummarizer.shouldCompress ──────────────────────────────────────

describe("LLMSessionSummarizer.shouldCompress", () => {
  const { provider } = makeProvider();
  const tok = new NaiveTokenizer();
  const summarizer = new LLMSessionSummarizer(provider, tok);

  it("returns true when messages exceed budget", () => {
    const messages = [user("a".repeat(400))]; // 100 tokens
    expect(summarizer.shouldCompress(messages, 50)).toBe(true);
  });

  it("returns false when messages fit within budget", () => {
    const messages = [user("hi")]; // 1 token
    expect(summarizer.shouldCompress(messages, 100)).toBe(false);
  });
});

// ── FixedSummarizer ───────────────────────────────────────────────────────────

describe("FixedSummarizer", () => {
  it("summarize returns fixed string", async () => {
    const s = new FixedSummarizer("Fixed summary.");
    expect(await s.summarize([user("x")])).toBe("Fixed summary.");
  });

  it("compress inserts fixed summary", async () => {
    const s = new FixedSummarizer("the summary");
    const messages = [user("a"), user("b"), user("c"), user("d"), user("e")];
    const result = await s.compress(messages, { keepRecentCount: 2 });
    expect(result.summary).toBe("the summary");
    expect(result.summarizedCount).toBe(3);
  });

  it("compress preserves system message", async () => {
    const s = new FixedSummarizer("sum");
    const messages = [sys(), user("1"), user("2"), user("3"), user("4"), user("5")];
    const result = await s.compress(messages, { keepRecentCount: 2 });
    expect(result.messages[0]!.role).toBe("system");
  });

  it("compress returns unchanged when too few messages", async () => {
    const s = new FixedSummarizer("sum");
    const messages = [user("a"), user("b")];
    const result = await s.compress(messages, { keepRecentCount: 4 });
    expect(result.summarizedCount).toBe(0);
    expect(result.messages).toHaveLength(2);
  });

  it("shouldCompress returns true when over budget", () => {
    const s = new FixedSummarizer("sum", new NaiveTokenizer());
    expect(s.shouldCompress([user("a".repeat(400))], 50)).toBe(true);
  });

  it("shouldCompress returns false when under budget", () => {
    const s = new FixedSummarizer("sum", new NaiveTokenizer());
    expect(s.shouldCompress([user("hi")], 100)).toBe(false);
  });

  it("implements ISessionSummarizer interface", () => {
    const s: ISessionSummarizer = new FixedSummarizer();
    expect(typeof s.summarize).toBe("function");
    expect(typeof s.compress).toBe("function");
    expect(typeof s.shouldCompress).toBe("function");
  });
});

// ── AutoCompressor ────────────────────────────────────────────────────────────

describe("AutoCompressor", () => {
  it("does not compress when under budget", async () => {
    const s = new FixedSummarizer("sum");
    const ac = new AutoCompressor(s, 10_000);
    const messages = [user("hi")];
    const result = await ac.maybeCompress(messages);
    expect(result.summarizedCount).toBe(0);
    expect(result.messages).toEqual(messages);
  });

  it("compresses when over budget", async () => {
    const s = new FixedSummarizer("sum", new NaiveTokenizer());
    const ac = new AutoCompressor(s, 1); // budget of 1 token
    const messages = [
      user("this is a long message"),
      user("another one"),
      user("more"),
      user("and more content"),
      user("final"),
    ];
    const result = await ac.maybeCompress(messages);
    expect(result.summarizedCount).toBeGreaterThan(0);
  });

  it("passes opts through to compress", async () => {
    const s = new FixedSummarizer("sum", new NaiveTokenizer());
    const ac = new AutoCompressor(s, 1);
    const messages = [user("a"), user("b"), user("c"), user("d"), user("e"), user("f")];
    const result = await ac.maybeCompress(messages, { keepRecentCount: 1 });
    // Should only keep 1 recent + summary
    const nonSummaryNonSys = result.messages.filter(
      (m) => m.role !== "system" && !m.content.startsWith("[Summary"),
    );
    expect(nonSummaryNonSys).toHaveLength(1);
  });
});

// ── SummarizerError ───────────────────────────────────────────────────────────

describe("SummarizerError", () => {
  it("has correct name, code, and message", () => {
    const e = new SummarizerError("provider timeout", "PROVIDER_TIMEOUT");
    expect(e.name).toBe("SummarizerError");
    expect(e.code).toBe("PROVIDER_TIMEOUT");
    expect(e instanceof Error).toBe(true);
  });
});
