// SPDX-License-Identifier: Apache-2.0
// End-to-end wiring test (pass 60): the worker's agent-MCP surface now serves
// the batch-35 council protocol tools in-process — a request through a
// RuntimeTool handler reaches createCouncilMcpServer over its real JSON-RPC
// handle() seam and returns a parsed result, with the executor error path.
// DB-free and offline (stub ILLMTransport drives every protocol call).
import { describe, it, expect } from "vitest";
import {
  councilRuntimeToolsFromTransport,
  councilRuntimeTools,
} from "../../src/handlers/agent-mcp.js";
import type { ILLMTransport } from "@nexus/council";

/** DeliberativeCouncil-convention stub (convene → review → chairman verdict). */
function fakeTransport(): ILLMTransport {
  return {
    async chat(messages) {
      const user = messages.find((m) => m.role === "user")?.content ?? "";
      let content = "";
      if (user.includes("brought this question to the council")) {
        content = "Position: the plan is workable if scoped tightly.";
      } else if (user.includes("advisors independently answered this question")) {
        content =
          "1. Strongest: B — grounded in the evidence.\n" +
          "2. Biggest blind spot: D — it ignores rollout cost.\n" +
          "3. Missed by all: the timeline is unrealistic.";
      } else if (user.includes("Produce the COUNCIL VERDICT")) {
        content =
          "AGREEMENTS:\n- everyone agrees scope matters\n\n" +
          "CLASHES:\n- The Architect wants modularity now; the Minimalist wants to defer it\n\n" +
          "BLIND SPOTS:\n- only the review round surfaced the rollout risk\n\n" +
          "RECOMMENDATION:\nStart small and ship the module behind a flag.\n\n" +
          "NEXT ACTION:\nDraft the RFC this week.";
      }
      return {
        content,
        model: "fake",
        usage: { promptTokens: 10, completionTokens: 20 },
        latencyMs: 1,
      };
    },
  };
}

describe("councilRuntimeTools (local served council → RuntimeTools)", () => {
  it("surfaces all five protocol tools namespaced under the prefix", async () => {
    const tools = await councilRuntimeToolsFromTransport(fakeTransport());
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "council__council_critique",
        "council__council_debate",
        "council__council_deliberate",
        "council__council_verify",
        "council__council_vote",
      ].sort(),
    );
    const deliberate = tools.find((t) => t.name === "council__council_deliberate")!;
    expect(deliberate.description).toContain("deliberative council");
    expect((deliberate.parameters as { required?: string[] }).required).toEqual(["question"]);
  });

  it("a tool request reaches the council and returns a parsed verdict", async () => {
    const tools = await councilRuntimeTools(
      { llm: fakeTransport(), tools: ["deliberate"] as const },
      "council",
    );
    const deliberate = tools.find((t) => t.name === "council__council_deliberate")!;
    const raw = await deliberate.handler({ question: "Should we ship the migration?" });
    const parsed = JSON.parse(raw) as { verdict: unknown; advisors: string[] };
    expect(parsed.advisors).toHaveLength(5); // default archetype panel
    expect(JSON.stringify(parsed.verdict)).toContain("Start small");
  });

  it("propagates an executor error through the tool handler", async () => {
    const failing: ILLMTransport = {
      async chat() {
        throw new Error("provider unreachable");
      },
    };
    const tools = await councilRuntimeTools({ llm: failing, tools: ["deliberate"] as const }, "council");
    const deliberate = tools.find((t) => t.name === "council__council_deliberate")!;
    await expect(deliberate.handler({ question: "Should we ship?" })).rejects.toThrow(
      /provider unreachable/,
    );
  });

  it("honors a custom subset and prefix", async () => {
    const tools = await councilRuntimeTools(
      { llm: fakeTransport(), tools: ["vote"] as const },
      "gov",
    );
    expect(tools.map((t) => t.name)).toEqual(["gov__council_vote"]);
  });
});