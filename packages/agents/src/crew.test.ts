// SPDX-License-Identifier: Apache-2.0
// Role-based Crew orchestration (crewAI/CAMEL parity) — focused tests for the
// RoleAgent/Task/Crew module in @nexus/agents.
import { describe, expect, it } from "vitest";
import { RoleAgent, Crew, type CrewLlm, type CrewLlmMessage } from "./crew.js";
import { AgentError } from "./index.js";

// ── Scripted LLM double ──────────────────────────────────────────────────────

interface Scripted {
  llm: CrewLlm;
  log: CrewLlmMessage[][];
  /** Remaining queued replies after the run (asserts call count). */
  remaining(): number;
}

function scripted(...replies: string[]): Scripted {
  const log: CrewLlmMessage[][] = [];
  let i = 0;
  const llm: CrewLlm = {
    async chat(messages: readonly CrewLlmMessage[]) {
      log.push([...messages]);
      const content = replies[i] ?? "";
      i += 1;
      return { content };
    },
  };
  return { llm, log, remaining: () => replies.length - i };
}

const ROLES = [
  {
    name: "researcher",
    role: "Senior Research Analyst",
    goal: "gather facts",
    backstory: "Known for source rigor.",
  },
  { name: "writer", role: "Technical Writer", goal: "turn facts into prose" },
];

const TASKS = [
  {
    description: "Find the market size.",
    expectedOutput: "a number with source",
    agent: "researcher",
  },
  {
    description: "Write the summary.",
    expectedOutput: "three paragraphs",
    agent: "writer",
    context: ["0"],
  },
];

// ── RoleAgent ────────────────────────────────────────────────────────────────

describe("RoleAgent", () => {
  it("system prompt carries role, goal and backstory", () => {
    const agent = new RoleAgent(ROLES[0]!);
    const p = agent.systemPrompt();
    expect(p).toContain("You are Senior Research Analyst");
    expect(p).toContain("Goal: gather facts");
    expect(p).toContain("Known for source rigor.");
  });

  it("system prompt omits backstory when absent", () => {
    const agent = new RoleAgent(ROLES[1]!);
    expect(agent.systemPrompt()).not.toContain("backstory");
  });

  it("run sends persona + question and returns trimmed content", async () => {
    const s = scripted("  the answer  ");
    const agent = new RoleAgent(ROLES[0]!);
    const out = await agent.run("Size?", "", s.llm);
    expect(out).toBe("the answer");
    expect(s.log[0]![0]).toMatchObject({ role: "system", content: agent.systemPrompt() });
    expect(s.log[0]![1]).toMatchObject({ role: "user", content: "Size?" });
  });
});

// ── Sequential process ───────────────────────────────────────────────────────

describe("Crew sequential", () => {
  it("executes tasks in order on their roles and chains context", async () => {
    const s = scripted("market: 12B units", "Summary of the 12B-unit market");
    const crew = new Crew({ roles: ROLES, tasks: TASKS, llm: s.llm });
    const result = await crew.kickoff();

    expect(result.process).toBe("sequential");
    expect(result.results.map((r) => r.agent)).toEqual(["researcher", "writer"]);
    expect(result.results.map((r) => r.iterations)).toEqual([1, 1]);
    expect(result.results[0]!.output).toBe("market: 12B units");
    expect(result.finalOutput).toContain("12B-unit market");

    // Second task received the first task's output as context material.
    const secondUser = s.log[1]!.find((m) => m.role === "user")!.content;
    expect(secondUser).toContain("[task 0]");
    expect(secondUser).toContain("market: 12B units");
    expect(secondUser).toContain("Task: Write the summary.");
    expect(secondUser).toContain("Deliverable shape: three paragraphs");
    expect(s.remaining()).toBe(0);
  });

  it("defaults an unassigned task to the last role", async () => {
    const tasks = [
      { description: "d1", agent: "researcher" },
      { description: "d2" }, // no agent → last role (writer)
    ];
    const s = scripted("a", "b");
    const crew = new Crew({ roles: ROLES, tasks, llm: s.llm });
    const result = await crew.kickoff();
    expect(result.results.map((r) => r.agent)).toEqual(["researcher", "writer"]);
  });

  it("renders crew input into the task prompt when provided", async () => {
    const s = scripted("out");
    const crew = new Crew({
      roles: ROLES,
      tasks: [{ description: "do it", agent: "researcher" }],
      llm: s.llm,
    });
    await crew.kickoff({ region: "EMEA" });
    expect(s.log[0]![1]!.content).toContain('"region": "EMEA"');
  });

  it("refuses an empty crew and an empty task list", () => {
    expect(() => new Crew({ roles: [], tasks: TASKS, llm: scripted().llm })).toThrow(
      /at least one role/,
    );
    expect(() => new Crew({ roles: ROLES, tasks: [], llm: scripted().llm })).toThrow(
      /at least one task/,
    );
  });

  it("aborts before start with a CREW_FAILED error", async () => {
    const crew = new Crew({ roles: ROLES, tasks: TASKS, llm: scripted().llm });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(crew.kickoff({}, ctrl.signal)).rejects.toThrow(/aborted/);
    await expect(crew.kickoff({}, ctrl.signal)).rejects.toBeInstanceOf(AgentError);
  });
});

// ── Hierarchical process ─────────────────────────────────────────────────────

describe("Crew hierarchical", () => {
  it("manager delegates, executor runs, DONE accepts on first pass", async () => {
    // call 1: manager pick; call 2: executor run; call 3: manager verify DONE.
    const s = scripted("writer", "the deliverable", "DONE");
    const crew = new Crew({
      roles: ROLES,
      tasks: [{ description: "Summarize", agent: "writer" }],
      process: "hierarchical",
      llm: s.llm,
    });
    const result = await crew.kickoff();
    expect(result.process).toBe("hierarchical");
    expect(result.results[0]).toMatchObject({
      agent: "writer",
      output: "the deliverable",
      iterations: 1,
    });
    // Manager prompt showed the roster of roles.
    expect(s.log[0]![1]!.content).toContain("researcher: Senior Research Analyst");
    expect(s.remaining()).toBe(0);
  });

  it("refines on manager feedback until DONE", async () => {
    // pick writer; run; verify→feedback; pick researcher; run; verify→DONE
    const s = scripted(
      "writer",
      "v1 output",
      "needs numbers",
      "researcher",
      "v2 with numbers",
      "DONE",
    );
    const crew = new Crew({
      roles: ROLES,
      tasks: [{ description: "Quantify", agent: "writer" }],
      process: "hierarchical",
      maxIterations: 4,
      llm: s.llm,
    });
    const result = await crew.kickoff();
    expect(result.results[0]!.iterations).toBe(2);
    expect(result.results[0]!.output).toBe("v2 with numbers");
    // Feedback carried into the second delegate prompt.
    const delegate = s.log[3]![1]!.content;
    expect(delegate).toContain("needs numbers");
    expect(s.remaining()).toBe(0);
  });

  it("falls back to the task's default role when the manager names an unknown role", async () => {
    const s = scripted("ghost", "output", "DONE");
    const crew = new Crew({
      roles: ROLES,
      tasks: [{ description: "D", agent: "writer" }],
      process: "hierarchical",
      llm: s.llm,
    });
    const result = await crew.kickoff();
    expect(result.results[0]!.agent).toBe("writer");
    expect(result.results[0]!.output).toBe("output");
  });

  it("caps at maxIterations when the manager never accepts", async () => {
    const replies: string[] = [];
    for (let i = 0; i < 3; i++) replies.push("writer", `attempt ${i}`, "more detail needed");
    const s = scripted(...replies);
    const crew = new Crew({
      roles: ROLES,
      tasks: [{ description: "Never ending", agent: "writer" }],
      process: "hierarchical",
      maxIterations: 3,
      llm: s.llm,
    });
    const result = await crew.kickoff();
    expect(result.results[0]!.iterations).toBe(3);
    expect(result.results[0]!.output).toBe("attempt 2");
  });
});
