// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import {
  RuleTagger,
  QualityScorer,
  SftDataset,
  DatasetFilter,
  SftExporter,
  type ConversationTurn,
  type TurnTag,
} from "../src/index.js";

// ── RuleTagger ────────────────────────────────────────────────────────────────

const makeTurn = (role: ConversationTurn["role"], content: string): ConversationTurn => ({
  id: `t-${Date.now()}-${Math.random()}`,
  role,
  content,
});

describe("RuleTagger", () => {
  const tagger = new RuleTagger();

  it("tags user instruction turn", () => {
    const turn = makeTurn("user", "Please write a Python function that sorts a list.");
    const tag = tagger.tag(turn);
    expect(tag.label).toBe("instruction");
    expect(tag.confidence).toBeGreaterThan(0.5);
  });

  it("tags assistant chain-of-thought", () => {
    const turn = makeTurn(
      "assistant",
      "Let me think step by step. First, we need to understand the input. Second, sort it.",
    );
    const tag = tagger.tag(turn);
    expect(tag.label).toBe("chain-of-thought");
  });

  it("tags refusal", () => {
    const turn = makeTurn("assistant", "I can't help with that request.");
    const tag = tagger.tag(turn);
    expect(tag.label).toBe("refusal");
  });

  it("tags greeting", () => {
    const turn = makeTurn("user", "Hello! I need help with TypeScript.");
    const tag = tagger.tag(turn);
    expect(tag.label).toBe("greeting");
  });

  it("tags task completion", () => {
    const turn = makeTurn(
      "assistant",
      "Here's the function you requested: ```python def sort_list(x): return sorted(x)```",
    );
    const tag = tagger.tag(turn);
    expect(["task-completion", "response"]).toContain(tag.label);
  });

  it("tags tool use", () => {
    const turn = makeTurn("assistant", "Making a tool_call to search for results.");
    const tag = tagger.tag(turn);
    expect(tag.label).toBe("tool-use");
  });

  it("tags error", () => {
    const turn = makeTurn(
      "assistant",
      "Sorry, something went wrong while processing your request.",
    );
    const tag = tagger.tag(turn);
    expect(tag.label).toBe("error");
  });

  it("returns unknown for unmatched system role", () => {
    const turn = makeTurn("system", "You are a helpful assistant.");
    // system role doesn't match any standard rule patterns
    const tag = tagger.tag(turn);
    expect(tag.turnId).toBe(turn.id);
    expect(["unknown", "response"]).toContain(tag.label);
  });

  it("tagAll processes multiple turns", () => {
    const turns = [
      makeTurn("user", "Please explain TypeScript generics."),
      makeTurn(
        "assistant",
        "Here's an explanation: TypeScript generics allow you to write reusable code.",
      ),
    ];
    const tags = tagger.tagAll(turns);
    expect(tags).toHaveLength(2);
    expect(tags[0]!.label).toBe("instruction");
  });

  it("tag includes turnId", () => {
    const turn = makeTurn("user", "What is 2+2?");
    const tag = tagger.tag(turn);
    expect(tag.turnId).toBe(turn.id);
  });
});

// ── QualityScorer ─────────────────────────────────────────────────────────────

describe("QualityScorer", () => {
  const scorer = new QualityScorer();

  it("returns 0 for empty turns", () => {
    expect(scorer.score([], [])).toBe(0);
  });

  it("scores higher with instruction + response", () => {
    const turns = [
      makeTurn("user", "Please write hello world in Python."),
      makeTurn(
        "assistant",
        "Here's the code: print('Hello, World!') This should work for your use case.",
      ),
    ];
    const tagger = new RuleTagger();
    const tags = tagger.tagAll(turns);
    const score = scorer.score(turns, tags);
    expect(score).toBeGreaterThan(0.5);
  });

  it("penalises refusals", () => {
    const turns = [
      makeTurn("user", "Please do something."),
      makeTurn("assistant", "I can't do that."),
    ];
    const tagger = new RuleTagger();
    const tags = tagger.tagAll(turns);
    const score = scorer.score(turns, tags);
    expect(score).toBeLessThan(0.9);
  });
});

// ── SftDataset ────────────────────────────────────────────────────────────────

describe("SftDataset", () => {
  let dataset: SftDataset;

  beforeEach(() => {
    dataset = new SftDataset();
  });

  it("adds a conversation and returns sample", () => {
    const sample = dataset.addConversation([
      { role: "user", content: "Please explain closures in JavaScript." },
      {
        role: "assistant",
        content:
          "Here's a detailed explanation of closures: A closure is a function that retains access to its outer scope even after the outer function has returned.",
      },
    ]);
    expect(sample.id).toMatch(/^sample-/);
    expect(sample.turns).toHaveLength(2);
    expect(sample.tags).toHaveLength(2);
    expect(sample.qualityScore).toBeGreaterThanOrEqual(0);
    expect(sample.createdAt).toBeTruthy();
  });

  it("assigns turn IDs", () => {
    const sample = dataset.addConversation([{ role: "user", content: "Hi" }]);
    expect(sample.turns[0]!.id).toMatch(/^turn-/);
  });

  it("stores source field", () => {
    const sample = dataset.addConversation(
      [{ role: "user", content: "Hello?" }],
      "chat_export_2024",
    );
    expect(sample.source).toBe("chat_export_2024");
  });

  it("count tracks samples", () => {
    dataset.addConversation([{ role: "user", content: "q" }]);
    dataset.addConversation([{ role: "user", content: "q2" }]);
    expect(dataset.count()).toBe(2);
  });

  it("get retrieves by id", () => {
    const sample = dataset.addConversation([{ role: "user", content: "q" }]);
    expect(dataset.get(sample.id)).toBe(sample);
    expect(dataset.get("nonexistent")).toBeUndefined();
  });

  it("clear empties dataset", () => {
    dataset.addConversation([{ role: "user", content: "q" }]);
    dataset.clear();
    expect(dataset.count()).toBe(0);
  });

  it("list returns all samples", () => {
    dataset.addConversation([{ role: "user", content: "a" }]);
    dataset.addConversation([{ role: "user", content: "b" }]);
    expect(dataset.list()).toHaveLength(2);
  });
});

// ── DatasetFilter ─────────────────────────────────────────────────────────────

describe("DatasetFilter", () => {
  let dataset: SftDataset;
  const filter = new DatasetFilter();

  beforeEach(() => {
    dataset = new SftDataset();
    dataset.addConversation(
      [
        {
          role: "user",
          content: "Please write a detailed Python sorting function with documentation and tests.",
        },
        {
          role: "assistant",
          content:
            "Here's the function you requested with full documentation and examples of how to use it in production code.",
        },
      ],
      "source-a",
    );
    dataset.addConversation(
      [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "I can't help with that unfortunately." },
      ],
      "source-b",
    );
  });

  it("filters by minQualityScore", () => {
    const filtered = filter.filter(dataset.list(), { minQualityScore: 0.7 });
    expect(filtered.length).toBeLessThan(dataset.count());
  });

  it("filters by maxQualityScore", () => {
    const filtered = filter.filter(dataset.list(), { maxQualityScore: 0.3 });
    expect(filtered.every((s) => s.qualityScore <= 0.3)).toBe(true);
  });

  it("filters by minTurns", () => {
    const filtered = filter.filter(dataset.list(), { minTurns: 2 });
    expect(filtered.every((s) => s.turns.length >= 2)).toBe(true);
  });

  it("filters by maxTurns", () => {
    dataset.addConversation([
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
      { role: "user", content: "follow up" },
      { role: "assistant", content: "follow up answer" },
    ]);
    const filtered = filter.filter(dataset.list(), { maxTurns: 2 });
    expect(filtered.every((s) => s.turns.length <= 2)).toBe(true);
  });

  it("filters by source", () => {
    const filtered = filter.filter(dataset.list(), { source: "source-a" });
    expect(filtered.every((s) => s.source === "source-a")).toBe(true);
    expect(filtered).toHaveLength(1);
  });

  it("filters out samples with excluded labels", () => {
    const filtered = filter.filter(dataset.list(), { excludeLabels: ["refusal"] });
    const hasRefusal = filtered.some((s) => s.tags.some((t) => t.label === "refusal"));
    expect(hasRefusal).toBe(false);
  });

  it("returns all when no filters applied", () => {
    expect(filter.filter(dataset.list(), {})).toHaveLength(dataset.count());
  });
});

// ── SftExporter ───────────────────────────────────────────────────────────────

describe("SftExporter", () => {
  const exporter = new SftExporter();
  let dataset: SftDataset;

  beforeEach(() => {
    dataset = new SftDataset();
    dataset.addConversation([
      { role: "user", content: "Please write a hello world program." },
      { role: "assistant", content: "Here's hello world: print('Hello, World!')" },
    ]);
  });

  it("toJsonl exports one JSON per line", () => {
    const jsonl = exporter.toJsonl(dataset.list());
    const lines = jsonl.split("\n").filter(Boolean);
    expect(lines).toHaveLength(dataset.count());
    expect(() => lines.forEach((l) => JSON.parse(l))).not.toThrow();
  });

  it("toAlpaca produces instruction/input/output", () => {
    const alpaca = exporter.toAlpaca(dataset.list());
    expect(alpaca).toHaveLength(1);
    expect(alpaca[0]!.instruction).toContain("hello world");
    expect(alpaca[0]!.output).toContain("Hello, World!");
  });

  it("toShareGpt produces human/gpt format", () => {
    const sharegpt = exporter.toShareGpt(dataset.list());
    expect(sharegpt).toHaveLength(1);
    const convs = sharegpt[0]!.conversations;
    expect(convs.some((c) => c.from === "human")).toBe(true);
    expect(convs.some((c) => c.from === "gpt")).toBe(true);
  });

  it("export('jsonl') returns JSONL string", () => {
    const output = exporter.export(dataset.list(), "jsonl");
    expect(output).toContain("{");
    expect(output.split("\n").length).toBeGreaterThan(0);
  });

  it("export('alpaca') returns JSON array string", () => {
    const output = exporter.export(dataset.list(), "alpaca");
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toHaveProperty("instruction");
  });

  it("export('sharegpt') returns JSON array string", () => {
    const output = exporter.export(dataset.list(), "sharegpt");
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toHaveProperty("conversations");
  });

  it("toAlpaca filters samples without instruction or output", () => {
    dataset.clear();
    dataset.addConversation([{ role: "system", content: "System prompt only." }]);
    const alpaca = exporter.toAlpaca(dataset.list());
    // No user turn and no assistant turn — should be filtered
    expect(alpaca.every((s) => s.instruction && s.output)).toBe(true);
  });
});
