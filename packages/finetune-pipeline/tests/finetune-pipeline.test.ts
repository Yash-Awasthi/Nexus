// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import {
  FinetunePipeline,
  FinetuneExportError,
  MIN_EXPORT_EXAMPLES,
  CORPUS_INSTRUCTION_TEMPLATE,
  type CorpusDocumentLike,
} from "../src/index.js";

const DOCS: CorpusDocumentLike[] = [
  {
    id: "d1",
    title: "Transformer Interpretability",
    content:
      "Attention patterns in transformer models can be visualised to explain which input tokens drive each output token. Layer-wise relevance propagation further localises the responsible neurons.",
    topics: ["ai", "interpretability"],
    source: "corpus",
  },
  {
    id: "d2",
    title: "Retrieval-Augmented Generation",
    content:
      "RAG combines a frozen parametric model with an external retriever. The retriever fetches the top-k passages for a query and the generator conditions on them, reducing hallucination on long-tail facts.",
    topics: ["ai", "rag"],
    source: "corpus",
  },
  {
    id: "d3",
    title: "Fine-Tuning",
    content:
      "Supervised fine-tuning adapts a pretrained model to a target distribution using labelled instruction–response pairs. It is cheaper than pretraining and typically requires only thousands of examples.",
    topics: ["ai", "sft"],
    source: "corpus",
  },
];

const CONVERSATIONS: { role: "user" | "assistant"; content: string }[][] = [
  [
    { role: "user", content: "Please write a Python function that sorts a list." },
    {
      role: "assistant",
      content:
        "Here's a clean implementation: def sort_list(x): return sorted(x). It handles any comparable type and returns a new list.",
    },
  ],
  [
    { role: "user", content: "What is the capital of France?" },
    {
      role: "assistant",
      content: "The capital of France is Paris. It is also the largest city in the country.",
    },
  ],
];

describe("FinetunePipeline.assemble", () => {
  it("assembles corpus documents into tagged, scored samples", () => {
    const p = new FinetunePipeline();
    p.addCorpusDocuments(DOCS);
    const { counts, ready } = p.assemble();
    expect(counts.corpus).toBe(3);
    expect(counts.total).toBe(3);
    expect(ready).toHaveLength(3);
    expect(ready[0]!.turns[0]!.role).toBe("user");
    expect(ready[0]!.turns[1]!.role).toBe("assistant");
    expect(ready[0]!.turns[0]!.content).toBe(
      CORPUS_INSTRUCTION_TEMPLATE("Transformer Interpretability"),
    );
    expect(ready[0]!.qualityScore).toBeGreaterThan(0);
  });

  it("assembles conversations alongside corpus documents", () => {
    const p = new FinetunePipeline();
    p.addCorpusDocuments(DOCS);
    p.addConversations(CONVERSATIONS, "chat-export");
    const { counts, ready } = p.assemble();
    expect(counts.conversations).toBe(2);
    expect(counts.total).toBe(5);
    expect(ready).toHaveLength(5);
  });

  it("drops samples below minQuality from the ready set", () => {
    const p = new FinetunePipeline();
    p.addCorpusDocuments(DOCS);
    // A refusal conversation scores ~0.4 (refusal costs the noRefusal weight
    // and the one-liner earns no response tag) — below the 0.5 default gate.
    p.addConversations([
      [
        { role: "user", content: "Please do something disallowed." },
        { role: "assistant", content: "I can't do that." },
      ],
    ]);
    const { ready, dropped } = p.assemble();
    expect(ready).toHaveLength(3); // corpus docs only
    expect(dropped.map((s) => s.id)).toHaveLength(1);
    expect(dropped[0]!.tags.some((t) => t.label === "refusal")).toBe(true);
  });

  it("applies a limit to the ready set (dropped counts the remainder)", () => {
    const p = new FinetunePipeline();
    p.addCorpusDocuments(DOCS);
    const { ready, dropped, counts } = p.assemble({ limit: 2 });
    expect(ready).toHaveLength(2);
    expect(counts.total).toBe(3);
    expect(dropped).toHaveLength(1);
  });
});

describe("FinetunePipeline.exportOpenAiJsonl", () => {
  /** 12 corpus docs → clears the 10-example export precondition. */
  function bigPipeline(): FinetunePipeline {
    const p = new FinetunePipeline();
    p.addCorpusDocuments([
      ...DOCS,
      ...Array.from({ length: 9 }, (_, i) => ({
        id: `x${i}`,
        title: `Extra topic ${i}`,
        content: `A reference passage on extra topic ${i} with enough substance to pass the quality gate.`,
      })),
    ]);
    return p;
  }

  it("produces OpenAI chat-completions JSONL with system/user/assistant turns", () => {
    const p = bigPipeline();
    p.addConversations(CONVERSATIONS);
    const { ready } = p.assemble();
    const jsonl = p.exportOpenAiJsonl(ready, { systemPrompt: "You are Nexus." });
    const lines = jsonl.split("\n").filter(Boolean);
    expect(lines).toHaveLength(ready.length);
    const first = JSON.parse(lines[0]!) as {
      messages: { role: string; content: string }[];
    };
    expect(first.messages[0]).toEqual({ role: "system", content: "You are Nexus." });
    expect(first.messages.some((m) => m.role === "user")).toBe(true);
    expect(first.messages.some((m) => m.role === "assistant")).toBe(true);
  });

  it("skips tool turns (OpenAI chat format rejects them)", () => {
    const p = bigPipeline();
    p.addConversations([
      [
        { role: "user", content: "Search the web for X." },
        { role: "tool", content: '{"tool_call": "search.web"}' },
        { role: "assistant", content: "Here are the results I found for X." },
      ],
    ]);
    const { ready } = p.assemble();
    const jsonl = p.exportOpenAiJsonl(ready);
    const parsed = JSON.parse(jsonl.split("\n")[0]!) as { messages: { role: string }[] };
    expect(parsed.messages.some((m) => m.role === "tool")).toBe(false);
  });

  it("throws INSUFFICIENT_DATA below the 10-example precondition", () => {
    const p = new FinetunePipeline();
    p.addCorpusDocuments(DOCS);
    const { ready } = p.assemble();
    try {
      p.exportOpenAiJsonl(ready);
      expect.unreachable();
    } catch (e) {
      const err = e as FinetuneExportError;
      expect(err.code).toBe("INSUFFICIENT_DATA");
      expect(err.readyCount).toBe(3);
      expect(err.message).toContain("10");
    }
  });

  it("export succeeds at exactly the 10-example threshold", () => {
    const p = new FinetunePipeline();
    p.addCorpusDocuments([
      ...DOCS,
      ...Array.from({ length: 7 }, (_, i) => ({
        id: `t${i}`,
        title: `Threshold topic ${i}`,
        content: `Reference text for threshold topic ${i}, long enough to score well above the gate.`,
      })),
    ]);
    const { ready } = p.assemble();
    expect(ready).toHaveLength(10);
    expect(() => p.exportOpenAiJsonl(ready)).not.toThrow();
  });

  it("throws EMPTY_DATASET when nothing is ready", () => {
    const p = new FinetunePipeline();
    const { ready } = p.assemble();
    try {
      p.exportOpenAiJsonl(ready);
      expect.unreachable();
    } catch (e) {
      expect((e as FinetuneExportError).code).toBe("EMPTY_DATASET");
    }
  });
});

describe("MIN_EXPORT_EXAMPLES", () => {
  it("is 10 and matches the error message contract", () => {
    expect(MIN_EXPORT_EXAMPLES).toBe(10);
    const p = new FinetunePipeline();
    p.addCorpusDocuments(DOCS);
    const { ready } = p.assemble();
    try {
      p.exportOpenAiJsonl(ready);
      expect.unreachable();
    } catch (e) {
      expect((e as FinetuneExportError).message).toContain(String(MIN_EXPORT_EXAMPLES));
    }
  });
});