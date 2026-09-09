// SPDX-License-Identifier: Apache-2.0
/**
 * Served council — end-to-end tests that drive the REAL JSON-RPC surface
 * (initialize → tools/list → tools/call) of the server created by
 * createCouncilMcpServer, with a single phase-routing transport scripting
 * every protocol prompt the tools fire.
 */
import { describe, expect, it } from "vitest";
import { createCouncilMcpServer } from "./mcp-server.js";
import type { Archetype } from "./archetypes.js";
import type { ILLMResponse, ILLMTransport } from "./engine.js";

const PANEL: Archetype[] = [
  {
    id: "architect",
    name: "The Architect",
    thinkingStyle: "systems-first, long-term structural view",
    asks: "What breaks at scale?",
    blindSpot: "immediate costs",
    systemPrompt: "You are The Architect. Focus on structure, interfaces, and durability.",
  },
  {
    id: "minimalist",
    name: "The Minimalist",
    thinkingStyle: "do the least that works",
    asks: "What can we cut?",
    blindSpot: "future-proofing",
    systemPrompt: "You are The Minimalist. Cut scope until only essentials remain.",
  },
];

const VERDICT_TEXT =
  "AGREEMENTS:\n- everyone agrees scope matters\n\n" +
  "CLASHES:\n- The Architect wants modularity now; the Minimalist wants to defer it\n\n" +
  "BLIND SPOTS:\n- only the review round surfaced the rollout risk\n\n" +
  "RECOMMENDATION:\nStart small and ship the module behind a flag.\n\n" +
  "NEXT ACTION:\nDraft the RFC this week.";

/** Single transport that scripts every phase by user-prompt markers. */
function phaseTransport(): ILLMTransport {
  return {
    async chat(messages): Promise<ILLMResponse> {
      // The LAST user message is the current ask — earlier ones are history
      // (the debate loop accumulates every round's prompts per agent).
      const user = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
      const sys = messages.find((m) => m.role === "system")?.content ?? "";
      let content = "";
      if (user.includes("brought this question to the council")) {
        content = "Position: the plan is workable if scoped tightly.";
      } else if (user.includes("Answer these three questions")) {
        content =
          "1. Strongest: B — grounded in the evidence.\n" +
          "2. Biggest blind spot: A — it ignores rollout cost.\n" +
          "3. Missed by all: the timeline is unrealistic.";
      } else if (user.includes("Rank ALL")) {
        content = "B, A"; // strongest first
      } else if (user.includes("Produce the COUNCIL VERDICT")) {
        content = VERDICT_TEXT;
      } else if (user.includes("Can you solve the following question")) {
        content = "initial-answer";
      } else if (user.includes("These are the solutions")) {
        content = "refined-answer";
      } else if (sys.includes("red team adversary") || user.includes("red team adversary")) {
        content =
          "Flaws: overclaims. Edge cases: none handled. Adversarial inputs: yes. Failure modes: at scale.";
      } else if (sys.includes("critical reviewer") || user.includes("critical reviewer")) {
        content =
          "Strengths: clear. Weaknesses: thin evidence. Errors: none found. Confidence: 80%";
      } else if (user.includes("Is this response correct, complete, and well reasoned")) {
        content = '{"verdict": true, "aspect": "correctness", "reasoning": "approved by script"}';
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

function makeServer(tools?: readonly ("deliberate" | "vote" | "debate" | "critique" | "verify")[]) {
  return createCouncilMcpServer({ llm: phaseTransport(), advisors: PANEL, tools });
}

function call(
  server: ReturnType<typeof makeServer>,
  id: number,
  name: string,
  args: Record<string, unknown> = {},
) {
  return server.handle({
    method: "POST",
    path: "/mcp",
    body: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
  });
}

function textOf(res: { body: unknown }): Record<string, unknown> {
  const body = res.body as { result: { content: { text: string }[] } };
  return JSON.parse(body.result.content[0]!.text) as Record<string, unknown>;
}

describe("createCouncilMcpServer", () => {
  it("advertises the full protocol tool set over tools/list", async () => {
    const server = makeServer();
    const res = await server.handle({
      method: "POST",
      path: "/mcp",
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    const names = (res.body as { result: { tools: { name: string }[] } }).result.tools.map(
      (t) => t.name,
    );
    expect(names.sort()).toEqual([
      "council_critique",
      "council_debate",
      "council_deliberate",
      "council_verify",
      "council_vote",
    ]);
  });

  it("respects a tool subset", async () => {
    const server = makeServer(["deliberate"]);
    const res = await server.handle({
      method: "POST",
      path: "/mcp",
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    const names = (res.body as { result: { tools: { name: string }[] } }).result.tools.map(
      (t) => t.name,
    );
    expect(names).toEqual(["council_deliberate"]);
  });

  it("runs the full deliberative flow through council_deliberate", async () => {
    const server = makeServer();
    const res = await call(server, 2, "council_deliberate", {
      question: "Should we shard now?",
    });
    const out = textOf(res);
    const verdict = out.verdict as {
      agreements: unknown[];
      clashes: unknown[];
      recommendation: string;
      nextAction: string;
    };
    expect(verdict.agreements.length).toBeGreaterThan(0);
    expect(verdict.clashes.length).toBeGreaterThan(0);
    expect(verdict.recommendation).toContain("flag");
    expect(verdict.nextAction).toContain("RFC");
    expect(out.advisors).toEqual(["The Architect", "The Minimalist"]);
  });

  it("returns a Borda winner through council_vote", async () => {
    const server = makeServer(["vote"]);
    const res = await call(server, 3, "council_vote", { question: "Pick a migration strategy." });
    const out = textOf(res);
    const winner = out.winner as string;
    expect(["The Architect", "The Minimalist"]).toContain(winner);
    const tally = out.tally as { winner: string; standings: unknown[] };
    expect(typeof tally.winner).toBe("string");
    expect(tally.standings.length).toBe(2);
  });

  it("converges a debate early when positions stabilise (council_debate)", async () => {
    const server = makeServer(["debate"]);
    const res = await call(server, 4, "council_debate", {
      question: "Debate the shard key choice.",
      rounds: 5,
      convergence: true,
    });
    const out = textOf(res);
    expect(out.converged).toBe(true);
    expect(out.roundsRun).toBe(3); // initial + refine + stable → stopped before the budget
    expect((out.finalAnswers as { agent: string }[]).length).toBe(2);
    expect((out.majority as { answer: string }).answer).toBe("refined-answer");
  });

  it("serves the red-team framing through council_critique", async () => {
    const server = makeServer(["critique"]);
    const res = await call(server, 5, "council_critique", {
      question: "Is the plan robust?",
      mode: "redteam",
    });
    const out = textOf(res);
    expect(out.mode).toBe("redteam");
    expect((out.critiques as { critic: string }[]).map((c) => c.critic).sort()).toEqual([
      "The Architect",
      "The Minimalist",
    ]);
  });

  it("cross-checks every answer through council_verify", async () => {
    const server = makeServer(["verify"]);
    const res = await call(server, 6, "council_verify", {
      question: "Is the event store choice sound?",
    });
    const out = textOf(res);
    const verified = out.verified as { label: string };
    expect(["The Architect", "The Minimalist"]).toContain(verified.label);
    expect(out.approvals).toBe(4); // 2 candidates × 2 verifiers, all script-approved
    expect((out.scores as Record<string, number>)[verified.label]).toBe(2);
  });
});
