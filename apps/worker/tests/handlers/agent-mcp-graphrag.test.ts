// SPDX-License-Identifier: Apache-2.0
// End-to-end wiring test (pass 71): the worker's agent-MCP surface can now
// serve graphrag local + global search — a request through a RuntimeTool
// handler reaches createGraphRagMcpServer over its real JSON-RPC handle()
// seam, with the loop's ILLMTransport adapted to graphrag's QueryRouter. DB-free
// and offline: a deterministic in-memory index + scripted transport drive it.
import { describe, expect, it } from "vitest";

import { graphRagRuntimeTools } from "../../src/handlers/agent-mcp.js";
import type { ILLMTransport } from "@nexus/council";

const ENTITIES = [
  { name: "acme aerospace", type: "entity", descriptions: ["builds rockets"], mentions: 5 },
  { name: "green energy", type: "entity", descriptions: ["solar panels"], mentions: 2 },
];
const RELATIONS = [
  { source: "acme aerospace", target: "rocket engine", type: "rel", descriptions: ["acme rel rocket engine"], mentions: 1 },
];

/** Scripted transport: content from a per-call script; counts completions. */
function fakeTransport(contents: string[]): ILLMTransport & { calls: number } {
  let calls = 0;
  return {
    async chat(messages) {
      const user = messages.find((m) => m.role === "user")?.content ?? "";
      calls++;
      return {
        content: contents[Math.min(calls - 1, contents.length - 1)] ?? user.slice(0, 40),
        model: "fake",
        usage: { promptTokens: 10, completionTokens: 20 },
        latencyMs: 1,
      };
    },
    get calls() {
      return calls;
    },
  };
}

describe("graphRagRuntimeTools (served graphrag → RuntimeTools)", () => {
  it("surfaces both search tools namespaced under the prefix with question required", async () => {
    const tools = await graphRagRuntimeTools({
      entities: ENTITIES,
      relations: RELATIONS,
      llm: fakeTransport(["x"]),
    });
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "graphrag__graphrag_global_search",
        "graphrag__graphrag_local_search",
      ].sort(),
    );
    for (const t of tools) {
      expect((t.parameters as { required?: string[] }).required).toEqual(["question"]);
    }
  });

  it("a local-search request reaches the engine over the adapted transport and returns the grounded answer", async () => {
    const transport = fakeTransport(["acme builds rockets (worker)."]);
    const tools = await graphRagRuntimeTools({
      entities: ENTITIES,
      relations: RELATIONS,
      llm: transport,
    });
    const local = tools.find((t) => t.name === "graphrag__graphrag_local_search")!;
    const raw = await local.handler({ question: "acme aerospace" });
    const parsed = JSON.parse(raw) as {
      answer: string;
      entitiesUsed: string[];
      relationshipsUsed: unknown[];
      durationMs: number;
    };
    expect(parsed.answer).toBe("acme builds rockets (worker).");
    expect(parsed.entitiesUsed).toContain("acme aerospace");
    expect(parsed.relationshipsUsed.length).toBeGreaterThan(0);
    expect(parsed.durationMs).toBeGreaterThanOrEqual(0);
    expect(transport.calls).toBe(1); // single-pass
  });

  it("a no-match local search never calls the loop transport", async () => {
    const transport = fakeTransport([]);
    const tools = await graphRagRuntimeTools({
      entities: ENTITIES,
      relations: RELATIONS,
      llm: transport,
    });
    const local = tools.find((t) => t.name === "graphrag__graphrag_local_search")!;
    const raw = await local.handler({ question: "quantum computing" });
    const parsed = JSON.parse(raw) as { answer: string; entitiesUsed: string[] };
    expect(transport.calls).toBe(0);
    expect(parsed.entitiesUsed).toEqual([]);
    expect(parsed.answer).toMatch(/No entities/);
  });
});
