// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  buildGraphRagIndex,
  makeCommunitySummarizer,
  parseSummaryJson,
  GraphRAGQueryEngine,
  type CommunityReport,
} from "./index.js";

// Deterministic extractor: recognizes "<Name> is a <Type>" and "<A> relates to <B>".
const extractEntities = (chunk: string) => {
  const out: { name: string; type: string; description?: string }[] = [];
  for (const m of chunk.matchAll(/([A-Z][a-z]+(?:\s[A-Z][a-z]+)*) is a ([a-z]+)/g)) {
    out.push({ name: m[1]!, type: m[2]!, description: `found in "${chunk.slice(0, 30)}"` });
  }
  return out;
};
const extractRelations = (chunk: string) => {
  const out: { source: string; target: string; type: string }[] = [];
  for (const m of chunk.matchAll(/([A-Z][a-z]+) relates to ([A-Z][a-z]+)/g)) {
    out.push({ source: m[1]!, target: m[2]!, type: "relates_to" });
  }
  return out;
};

class FakeRouter {
  calls: string[] = [];
  async complete(params: { messages: Array<{ content: string }> }) {
    this.calls.push(params.messages[0]!.content);
    return {
      content: JSON.stringify({
        title: "community report",
        summary: "A synthesized answer about these entities.",
        findings: ["finding one", "finding two"],
      }),
    };
  }
}

describe("buildGraphRagIndex", () => {
  it("extracts, merges across chunks, partitions and reports", async () => {
    const router = new FakeRouter();
    const chunks = [
      "Alice is a researcher. Bob is a developer. Alice relates to Bob.",
      "Alice is a researcher. Carol is a designer. Bob relates to Carol.",
    ];
    const result = await buildGraphRagIndex(chunks, {
      extractEntities,
      extractRelations,
      router: router as never,
      modelAlias: "test-model",
    });

    // Dedup across chunks: Alice mentioned twice.
    const alice = result.entities.find((e) => e.name === "Alice")!;
    expect(alice.mentions).toBe(2);
    // 3 unique entities, 2 unique relations.
    expect(result.entities.map((e) => e.name).sort()).toEqual(["Alice", "Bob", "Carol"]);
    expect(result.relations).toHaveLength(2);
    // One connected component (all entities linked) -> one community/report.
    expect(result.communities).toHaveLength(1);
    expect(result.reports).toHaveLength(1);
    const report = result.reports[0]!;
    expect(report.title).toBe("community report");
    expect(report.entities.sort()).toEqual(["Alice", "Bob", "Carol"]);
    expect(report.rank).toBe(3);
    // Router was prompted at least once (once per community).
    expect(router.calls.length).toBe(1);
  });

  it("puts disconnected entities into separate communities", async () => {
    const result = await buildGraphRagIndex(["Alice is a researcher.", "Zed is a musician."], {
      extractEntities,
      router: new FakeRouter() as never,
    });
    expect(result.communities).toHaveLength(2);
    expect(result.reports).toHaveLength(2);
  });

  it("produces reports the query engine can answer from", async () => {
    const router = new FakeRouter();
    const result = await buildGraphRagIndex(
      ["Alice is a researcher. Bob is a developer. Alice relates to Bob."],
      {
        extractEntities,
        extractRelations,
        router: router as never,
        modelAlias: "test-model",
      },
    );
    const engine = new GraphRAGQueryEngine(router as never, "test-model");
    engine.addReports(result.reports as CommunityReport[]);
    const answer = await engine.query("Tell me about Alice and Bob");
    expect(answer.answer).toContain("synthesized answer");
    expect(answer.communitiesUsed).toHaveLength(1);
  });
});

describe("parseSummaryJson", () => {
  it("extracts JSON from a fenced/verbose LLM response", () => {
    const out = parseSummaryJson(
      'Here you go:\n```json\n{"title":"T","summary":"S","findings":["a","b"]}\n```',
    );
    expect(out?.title).toBe("T");
    expect(out?.findings).toEqual(["a", "b"]);
  });

  it("returns null for non-JSON responses", () => {
    expect(parseSummaryJson("I cannot summarize this.")).toBeNull();
  });
});

describe("makeCommunitySummarizer", () => {
  it("falls back to the raw response when the router returns prose", async () => {
    const summarizer = await makeCommunitySummarizer(
      { complete: async () => ({ content: "plain prose summary" }) } as never,
      "m",
    );
    const summary = await summarizer({
      id: "c",
      entities: [{ name: "Alice", type: "researcher", descriptions: [], mentions: 1 }],
      relations: [],
    });
    expect(summary.title).toContain("Alice");
    expect(summary.summary).toBe("plain prose summary");
  });
});
