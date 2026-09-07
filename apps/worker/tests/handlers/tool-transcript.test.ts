// SPDX-License-Identifier: Apache-2.0
// End-to-end wiring test (pass 62): every council/debate tool invocation through
// the worker's agent loop leaves the pass-58 inspectable transcript — a real
// tool-call round-trip produces the artifact with route evidence, per-agent
// answer stages, metrics/total_ms, and the OR-of-five degradation verdict;
// failed calls still leave a degraded transcript before the error rethrows.
import { describe, it, expect } from "vitest";
import {
  councilRuntimeTools,
  debateRuntimeTool,
  type DebateAgentTransport,
  type TranscriptSink,
} from "../../src/handlers/agent-mcp.js";
import type { CouncilTranscript, ILLMTransport } from "@nexus/council";

function collector(): { transcripts: CouncilTranscript[]; sink: TranscriptSink } {
  const transcripts: CouncilTranscript[] = [];
  return {
    transcripts,
    sink: (t) => transcripts.push(t),
  };
}

function scriptedTransport(
  scripts: Record<string, string[]>,
): { transport: DebateAgentTransport } {
  return {
    transport: async (req) => {
      const script = scripts[req.agent] ?? [];
      return script[Math.min(req.round, script.length - 1)]!;
    },
  };
}

const STABLE: Record<string, string[]> = {
  A: ["a0", "a1", "pos-a", "pos-a", "pos-a", "pos-a"],
  B: ["b0", "b1", "pos-b", "pos-b", "pos-b", "pos-b"],
};

describe("debate tool invocation transcripts", () => {
  it("a converging debate leaves a transcript with per-agent stages and metrics", async () => {
    const { transcripts, sink } = collector();
    const { transport } = scriptedTransport(STABLE);
    const tool = debateRuntimeTool({ transport, agents: ["A", "B"], hooks: { onTranscript: sink } });
    const raw = await tool.handler({ question: "Is X better than Y?", rounds: 6, convergence: true });
    const parsed = JSON.parse(raw) as { converged: boolean; roundsRun: number };

    expect(transcripts).toHaveLength(1);
    const t = transcripts[0]!;
    expect(t.protocol).toBe("debate__run");
    expect(t.query).toBe("Is X better than Y?");
    expect(t.routing).toMatchObject({ mode: "explicit", tool: "debate__run" });
    // one stage per final answer (two agents)
    expect(t.stages.map((s) => s.name).sort()).toEqual(["answer:A", "answer:B"]);
    expect(t.auditTrail.some((e) => e.step === "debate" && e.converged === parsed.converged)).toBe(true);
    expect(t.metrics.total_ms).toBeGreaterThanOrEqual(0);
    expect(t.degraded).toBe(false);
    expect(t.warnings).toEqual([]);
  });

  it("a failed debate still leaves a degraded transcript with the error", async () => {
    const { transcripts, sink } = collector();
    const tool = debateRuntimeTool({
      transport: async () => {
        throw new Error("debate provider down");
      },
      agents: ["A", "B"],
      hooks: { onTranscript: sink },
    });
    await expect(tool.handler({ question: "X or Y?", rounds: 2 })).rejects.toThrow(/debate provider down/);
    expect(transcripts).toHaveLength(1);
    const t = transcripts[0]!;
    expect(t.degraded).toBe(true);
    expect(t.auditTrail.some((e) => e.step === "error")).toBe(true);
    expect(JSON.stringify(t.warnings)).toContain("debate provider down");
  });
});

describe("council tool invocation transcripts", () => {
  /** Transport whose chat() echoes a constant position (converges instantly). */
  const echoTransport: ILLMTransport = {
    async chat(messages) {
      const user = messages.find((m) => m.role === "user")?.content ?? "";
      let content = "A position.";
      if (user.includes("Produce the COUNCIL VERDICT")) {
        content = "RECOMMENDATION:\nGo with option X.";
      } else if (user.includes("advisors independently answered")) {
        content = "1. Strongest: A — clear. 2. Biggest blind spot: B. 3. Missed by all: cost.";
      }
      return { content, model: "fake", usage: { promptTokens: 5, completionTokens: 5 }, latencyMs: 1 };
    },
  };

  it("a council_debate tool call through the served surface leaves a transcript", async () => {
    const { transcripts, sink } = collector();
    const tools = await councilRuntimeTools(
      { llm: echoTransport, tools: ["debate"] as const },
      "council",
      { onTranscript: sink },
    );
    const debate = tools.find((t) => t.name === "council__council_debate")!;
    const raw = await debate.handler({
      question: "Should we adopt X?",
      agents: ["A", "B"],
      rounds: 3,
      convergence: true,
    });
    const parsed = JSON.parse(raw) as { converged: boolean; roundsRun: number; finalAnswers: unknown[] };

    expect(transcripts).toHaveLength(1);
    const t = transcripts[0]!;
    expect(t.protocol).toBe("council_debate");
    expect(t.query).toBe("Should we adopt X?");
    expect(t.stages.length).toBe(parsed.finalAnswers.length);
    expect(t.auditTrail.some((e) => e.step === "debate")).toBe(true);
    expect(t.degraded).toBe(false);
    expect(t.metrics.total_ms).toBeGreaterThanOrEqual(0);
  });
});