// SPDX-License-Identifier: Apache-2.0
// End-to-end wiring test (pass 61): debateRuntimeTool wraps debate-engine's
// runMultiAgentDebate (pass-34 convergence) as an in-process RuntimeTool —
// naming/schema conventions, the legacy fixed-round path, the convergence path
// (stops before the budget once positions stabilise), and the executor error
// path. Offline: scripted transports drive every round.
import { describe, it, expect } from "vitest";
import { debateRuntimeTool, type DebateAgentTransport } from "../../src/handlers/agent-mcp.js";

/** Transport that plays back per-agent scripts indexed by round number. */
function scriptedTransport(scripts: Record<string, string[]>): {
  transport: DebateAgentTransport;
  calls: Array<{ agent: string; round: number }>;
} {
  const calls: Array<{ agent: string; round: number }> = [];
  return {
    calls,
    transport: async (req) => {
      calls.push({ agent: req.agent, round: req.round });
      const script = scripts[req.agent] ?? [];
      return script[Math.min(req.round, script.length - 1)]!;
    },
  };
}

const STABLE: Record<string, string[]> = {
  A: ["a0", "a1", "pos-a", "pos-a", "pos-a", "pos-a"],
  B: ["b0", "b1", "pos-b", "pos-b", "pos-b", "pos-b"],
};

describe("debateRuntimeTool", () => {
  it("is namespaced and schema-valid", () => {
    const { transport } = scriptedTransport(STABLE);
    const tool = debateRuntimeTool({ transport, agents: ["A", "B"] });
    expect(tool.name).toBe("debate__run");
    expect(tool.description).toContain("convergence");
    expect((tool.parameters as { required?: string[] }).required).toEqual(["question"]);
  });

  it("keeps fixed-round behaviour without convergence", async () => {
    const { transport, calls } = scriptedTransport(STABLE);
    const tool = debateRuntimeTool({ transport, agents: ["A", "B"] });
    const raw = await tool.handler({ question: "Is X better than Y?", rounds: 3 });
    const parsed = JSON.parse(raw) as {
      converged: boolean;
      roundsRun: number;
      majority: { answer: string; count: number };
    };
    expect(parsed.converged).toBe(false);
    expect(parsed.roundsRun).toBe(3);
    // two agents × three rounds
    expect(calls).toHaveLength(6);
    // the two debaters hold different final answers, so the majority is one
    expect(parsed.majority.count).toBe(1);
    expect(parsed.majority.answer.length).toBeGreaterThan(0);
  });

  it("stops before the budget once positions stabilise (convergence)", async () => {
    const { transport, calls } = scriptedTransport(STABLE);
    const tool = debateRuntimeTool({ transport, agents: ["A", "B"] });
    const raw = await tool.handler({
      question: "Is X better than Y?",
      rounds: 6,
      convergence: true,
    });
    const parsed = JSON.parse(raw) as { converged: boolean; roundsRun: number };
    expect(parsed.converged).toBe(true);
    expect(parsed.roundsRun).toBeGreaterThanOrEqual(2); // minRounds respected
    expect(parsed.roundsRun).toBeLessThan(6); // early stop
    expect(calls.length).toBe(parsed.roundsRun * 2);
  });

  it("propagates a transport failure through the handler", async () => {
    const tool = debateRuntimeTool({
      transport: async () => {
        throw new Error("debate provider down");
      },
      agents: ["A", "B"],
    });
    await expect(tool.handler({ question: "X or Y?", rounds: 2 })).rejects.toThrow(
      /debate provider down/,
    );
  });
});
