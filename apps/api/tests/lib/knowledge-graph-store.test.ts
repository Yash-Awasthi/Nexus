// SPDX-License-Identifier: Apache-2.0
/**
 * KG extractor wiring (§16.9) — the adapter that lets the shared
 * KnowledgeGraph run the @nexus/nlp-utils extractors over an LlmDriver.
 *
 * Hermetic: the driver is a stub, so these assert the wiring (message shape,
 * response passthrough, graph write) rather than any model's output.
 */
import { InMemoryKGStore, KnowledgeGraph } from "@nexus/knowledge-graph";
import type { LlmDriver, LlmRequestOptions, LlmResponse } from "@nexus/llm-drivers";
import { extractEntities, extractRelationships } from "@nexus/nlp-utils";
import { describe, it, expect } from "vitest";

import { getKG, nlpClientFromDriver } from "../../src/lib/knowledge-graph-store.js";

const ENTITIES = JSON.stringify([
  { text: "Alice", type: "PERSON", confidence: 0.9 },
  { text: "Acme Corp", type: "ORG", confidence: 0.8 },
]);
const RELATIONSHIPS = JSON.stringify([
  { subject: "Alice", predicate: "works at", object: "Acme Corp", confidence: 0.7 },
]);

/** Answers each `complete()` from `replies` in order; records what it was asked. */
function stubDriver(replies: string[]): LlmDriver & { calls: LlmRequestOptions[] } {
  const calls: LlmRequestOptions[] = [];
  return {
    provider: "stub",
    model: "stub-model",
    calls,
    complete: async (opts) => {
      calls.push(opts);
      return {
        id: "stub",
        content: replies[calls.length - 1] ?? "[]",
        model: "stub-model",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        finishReason: "stop",
        durationMs: 0,
      } satisfies LlmResponse;
    },
    stream: async () => {
      throw new Error("not used");
    },
    countTokens: (t) => t.length,
  };
}

describe("nlpClientFromDriver", () => {
  it("passes the prompt through and returns the driver's content", async () => {
    const driver = stubDriver([ENTITIES]);
    const res = await nlpClientFromDriver(driver)([{ role: "user", content: "hello" }], {
      temperature: 0,
      maxTokens: 512,
    });

    expect(res).toEqual({ content: ENTITIES, model: "stub-model" });
    expect(driver.calls[0]).toMatchObject({
      model: "stub-model",
      temperature: 0,
      maxTokens: 512,
      messages: [{ role: "user", content: "hello" }],
    });
  });

  it("drives a real ingest: entities and relationships land in the graph", async () => {
    const driver = stubDriver([ENTITIES, RELATIONSHIPS]);
    const llm = nlpClientFromDriver(driver);
    const kg = new KnowledgeGraph(new InMemoryKGStore());

    const result = await kg.ingest("Alice works at Acme Corp.", {
      entityExtractor: (text) => extractEntities(text, llm),
      relationshipExtractor: (text, entities) => extractRelationships(text, entities, llm),
    });

    expect(result.entities.map((e) => e.text)).toEqual(["Alice", "Acme Corp"]);
    expect(result.relationships).toHaveLength(1);
    expect(result.nodesAdded).toBe(2);
    expect(result.edgesAdded).toBe(1);
  });
});

describe("getKG default extractors", () => {
  it("fails soft to zero entities when no LLM answers", async () => {
    const result = await getKG().ingest("Alice works at Acme Corp.");

    expect(result.entities).toEqual([]);
    expect(result.relationships).toEqual([]);
    expect(result.nodesAdded).toBe(0);
  });
});
