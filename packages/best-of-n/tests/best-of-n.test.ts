// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import {
  BestOfNGenerator,
  NullBonLlmClient,
  defaultScorer,
  type BonCandidate,
} from "../src/index.js";

// ── defaultScorer ─────────────────────────────────────────────────────────────

describe("defaultScorer", () => {
  it("returns 0 for empty content", () => {
    expect(defaultScorer("", "question")).toBe(0);
  });

  it("scores longer structured content higher", () => {
    const short = defaultScorer("Yes.", "how to refactor code");
    const long = defaultScorer(
      `## Refactoring Guide\n\n\`\`\`typescript\nfunction clean() { return true; }\n\`\`\`\n- Step 1\n- Step 2\n- Step 3`,
      "how to refactor code",
    );
    expect(long).toBeGreaterThan(short);
  });

  it("penalises hedge phrases", () => {
    const clean = defaultScorer("The answer is 42.", "what is the answer");
    const hedged = defaultScorer("I cannot provide that. I'm unable to help.", "what is the answer");
    expect(clean).toBeGreaterThan(hedged);
  });

  it("returns number between 0 and 100", () => {
    const score = defaultScorer("A reasonable answer with good content.", "question");
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});

// ── NullBonLlmClient ──────────────────────────────────────────────────────────

describe("NullBonLlmClient", () => {
  it("returns provided responses", async () => {
    const client = new NullBonLlmClient({ responses: ["resp-a", "resp-b"] });
    const r1 = await client.complete([{ role: "user", content: "test" }]);
    const r2 = await client.complete([{ role: "user", content: "test" }]);
    expect(r1.content).toBe("resp-a");
    expect(r2.content).toBe("resp-b");
  });

  it("cycles through responses", async () => {
    const client = new NullBonLlmClient({ responses: ["only"] });
    const r1 = await client.complete([{ role: "user", content: "q" }]);
    const r2 = await client.complete([{ role: "user", content: "q" }]);
    expect(r1.content).toBe("only");
    expect(r2.content).toBe("only");
  });

  it("throws when error is configured", async () => {
    const client = new NullBonLlmClient({ error: "LLM down" });
    await expect(client.complete([])).rejects.toThrow("LLM down");
  });

  it("reports correct model name", async () => {
    const client = new NullBonLlmClient({ model: "test-model-v2" });
    const r = await client.complete([]);
    expect(r.model).toBe("test-model-v2");
  });
});

// ── BestOfNGenerator ──────────────────────────────────────────────────────────

describe("BestOfNGenerator", () => {
  it("returns the best of N candidates", async () => {
    const responses = [
      "Short.",
      `## Comprehensive Answer\n\nThis is a detailed response with \`\`\`code\`\`\` and:\n- Bullet 1\n- Bullet 2\n- Bullet 3\nCovering all aspects.`,
      "Medium length answer that is decent.",
    ];

    const client = new NullBonLlmClient({ responses });
    const gen = new BestOfNGenerator({ llm: client, n: 3, role: "thinker" });

    const result = await gen.generate({ prompt: "how to implement a function" });

    expect(result.best).toBeDefined();
    expect(result.all).toHaveLength(3);
    expect(result.stats.n).toBe(3);
    expect(result.stats.succeeded).toBe(3);
    // The best should be the highest-scored candidate
    expect(result.best.score).toBe(Math.max(...result.all.map((c) => c.score)));
  });

  it("uses n=3 by default", async () => {
    const client = new NullBonLlmClient({ responses: ["r1", "r2", "r3", "r4"] });
    const gen = new BestOfNGenerator({ llm: client });
    const result = await gen.generate({ prompt: "test" });
    expect(result.stats.n).toBe(3);
    expect(result.all).toHaveLength(3);
  });

  it("includes stats with avg and best scores", async () => {
    const client = new NullBonLlmClient({ responses: ["resp A", "resp B"] });
    const gen = new BestOfNGenerator({ llm: client, n: 2 });
    const result = await gen.generate({ prompt: "question" });
    expect(result.stats.bestScore).toBeGreaterThanOrEqual(result.stats.avgScore);
    expect(result.stats.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("throws when all candidates fail", async () => {
    const client = new NullBonLlmClient({ error: "Model crashed" });
    const gen = new BestOfNGenerator({ llm: client, n: 2 });
    await expect(gen.generate({ prompt: "test" })).rejects.toThrow();
  });

  it("handles partial failures (some succeed, some fail)", async () => {
    let callN = 0;
    const client = {
      async complete(_msgs: unknown[]) {
        callN++;
        if (callN === 1) throw new Error("fail");
        return { content: "good response here", model: "m", durationMs: 1 };
      },
    };

    const gen = new BestOfNGenerator({ llm: client, n: 3 });
    const result = await gen.generate({ prompt: "test" });
    expect(result.stats.succeeded).toBe(2);
    expect(result.best.success).toBe(true);
  });

  it("uses custom scorer when provided", async () => {
    const client = new NullBonLlmClient({ responses: ["alpha", "beta", "gamma"] });
    // Custom scorer: score based on last character ASCII value
    const customScorer = (content: string) =>
      content.charCodeAt(content.length - 1) ?? 0;

    const gen = new BestOfNGenerator({ llm: client, n: 3, scorer: customScorer });
    const result = await gen.generate({ prompt: "pick one" });
    // gamma ends with 'a' (97), alpha ends with 'a' (97), beta ends with 'a' (97) — all same
    // Just verify the scorer was called and result is valid
    expect(result.best).toBeDefined();
  });

  it("prepends system prompt when provided", async () => {
    const receivedMessages: unknown[] = [];
    const client = {
      async complete(msgs: unknown[]) {
        receivedMessages.push(...msgs);
        return { content: "response", model: "m", durationMs: 1 };
      },
    };
    const gen = new BestOfNGenerator({ llm: client, n: 1 });
    await gen.generate({ prompt: "user question", systemPrompt: "You are a helper" });
    const msgs = receivedMessages as Array<{ role: string; content: string }>;
    expect(msgs[0]?.role).toBe("system");
    expect(msgs[0]?.content).toBe("You are a helper");
  });

  it("respects role label", () => {
    const client = new NullBonLlmClient();
    const gen = new BestOfNGenerator({ llm: client, n: 1, role: "editor" });
    expect(gen.role).toBe("editor");
  });
});
