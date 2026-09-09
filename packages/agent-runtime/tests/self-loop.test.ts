// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  AgentTemplateRegistry,
  makeBestOfNTool,
  makeReviewTool,
  makeSpawnAgentInlineTool,
  makeThinkDeeplyTool,
  parseReviewResult,
  RuntimeToolSet,
  ToolAgentRuntime,
  type LlmToolFn,
  type RuntimeMessage,
} from "../src/index.js";

/** Scripted tool-aware LLM: turn 1 calls a tool, later turns answer. */
function scriptedLlm(toolName: string, args: Record<string, unknown> = {}): LlmToolFn {
  let turn = 0;
  return () => {
    turn += 1;
    if (turn === 1) {
      return Promise.resolve({
        content: "",
        toolCalls: [{ name: toolName, arguments: args, callId: "call_1" }],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      });
    }
    return Promise.resolve({
      content: "done",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
  };
}

/** Records every message list it sees, then answers per script. */
function recordingLlm(
  script: (
    messages: RuntimeMessage[],
    call: number,
  ) => Promise<{
    content: string;
    toolCalls?: { name: string; arguments: Record<string, unknown>; callId?: string }[];
  }>,
): { llm: LlmToolFn; seen: RuntimeMessage[][] } {
  const seen: RuntimeMessage[][] = [];
  let call = 0;
  const llm: LlmToolFn = (messages) => {
    seen.push(messages.map((m) => ({ ...m })));
    call += 1;
    return script(messages, call);
  };
  return { llm, seen };
}

// ── Steering hook ─────────────────────────────────────────────────────────────

describe("steering hook (drainSteeringMessages)", () => {
  it("injects host messages at step boundaries so a host can redirect the agent", async () => {
    const steer: string[] = [];
    const { llm, seen } = recordingLlm((messages, call) => {
      if (call === 1) {
        return Promise.resolve({
          content: "looking",
          toolCalls: [{ name: "noop", arguments: {}, callId: "c1" }],
        });
      }
      // The steering message must be visible to the model on call 2.
      const sawSteer = messages.some((m) => m.role === "user" && m.content.includes("STEERED"));
      return Promise.resolve({
        content: sawSteer ? "followed steer" : "ignored steer",
        toolCalls: [],
      });
    });
    const toolSet = new RuntimeToolSet().add({
      name: "noop",
      description: "",
      handler: () => Promise.resolve("ok"),
    });
    const runtime = new ToolAgentRuntime({
      llm,
      toolSet,
      maxSteps: 3,
      drainSteeringMessages: () => {
        if (steer.length === 0) steer.push("STEERED: stop and summarize");
        return steer;
      },
    });

    const result = await runtime.run("do the thing");
    expect(result.finalContent).toBe("followed steer");
    // The steering text landed in history as a user message.
    expect(result.messages.some((m) => m.role === "user" && m.content.includes("STEERED"))).toBe(
      true,
    );
    // The step that saw the steer really had it in its message list.
    expect(seen[1]?.some((m) => m.content.includes("STEERED"))).toBe(true);
  });

  it("does nothing when the hook returns nothing", async () => {
    const llm = scriptedLlm("noop");
    const toolSet = new RuntimeToolSet().add({
      name: "noop",
      description: "",
      handler: () => Promise.resolve("ok"),
    });
    const runtime = new ToolAgentRuntime({
      llm,
      toolSet,
      maxSteps: 2,
      drainSteeringMessages: () => [],
    });
    const result = await runtime.run("x");
    expect(result.finalContent).toBe("done");
  });
});

// ── spawn_agent_inline ────────────────────────────────────────────────────────

describe("spawn_agent_inline (self-spawn)", () => {
  const registry = new AgentTemplateRegistry();
  registry.register({
    id: "coder",
    name: "Coder",
    description: "edits code",
    systemPrompt: "You are a careful coder.",
    maxSteps: 2,
  });
  registry.register({
    id: "researcher",
    name: "Researcher",
    description: "researches",
    systemPrompt: "You are a researcher.",
  });

  function childLlm(answers: string[]): LlmToolFn {
    let call = 0;
    return () => {
      call += 1;
      return Promise.resolve({
        content: answers[Math.min(call - 1, answers.length - 1)] ?? "child-done",
        toolCalls: [],
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      });
    };
  }

  it("defaults to the parent's own template — the self-loop", async () => {
    const tool = makeSpawnAgentInlineTool(childLlm(["sub-fixed"]), {
      registry,
      parentTemplateId: "coder",
    });
    const res = await tool.handler({ prompt: "fix the type error" });
    expect(res.output).toBe("sub-fixed");
    expect(res.steps).toBe(1);
    expect(res.usage.totalTokens).toBe(5);
  });

  it("runs any registered template by agent_id", async () => {
    const tool = makeSpawnAgentInlineTool(childLlm(["found it"]), { registry });
    const res = await tool.handler({ agent_id: "researcher", prompt: "find the doc" });
    expect(res.output).toBe("found it");
  });

  it("errors on unknown agent ids", async () => {
    const tool = makeSpawnAgentInlineTool(childLlm(["x"]), { registry, parentTemplateId: "coder" });
    const ts = new RuntimeToolSet().add(tool);
    const result = await ts.invoke("spawn_agent_inline", { agent_id: "ghost", prompt: "hi" });
    expect(result.error).toContain("unknown agent");
  });

  it("works as a real tool inside the parent loop (child runs, parent finishes)", async () => {
    const child = childLlm(["child answer"]);
    const tool = makeSpawnAgentInlineTool(child, { registry, parentTemplateId: "coder" });
    const parentLlm = scriptedLlm("spawn_agent_inline", {
      prompt: "go do it",
      agent_id: "coder",
    });
    const toolSet = new RuntimeToolSet().add(tool);
    const runtime = new ToolAgentRuntime({ llm: parentLlm, toolSet, maxSteps: 2 });
    const result = await runtime.run("delegate");
    expect(result.finalContent).toBe("done");
    const toolMsg = result.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("child answer");
  });
});

// ── think_deeply ──────────────────────────────────────────────────────────────

describe("think_deeply", () => {
  it("logs the thought and acknowledges", async () => {
    const tool = makeThinkDeeplyTool();
    const res = await tool.handler({ thought: "maybe the cache key is the bug" });
    expect(res.message).toBe("Thought logged.");
    expect(res.thought).toBe("maybe the cache key is the bug");
  });
});

// ── review ────────────────────────────────────────────────────────────────────

describe("review tool", () => {
  it("parses a reviewer verdict and scores", async () => {
    const llm: LlmToolFn = () =>
      Promise.resolve({
        content: JSON.stringify({
          score: 92,
          verdict: "accept",
          issues: [],
          suggestions: ["add a test"],
        }),
        toolCalls: [],
      });
    const tool = makeReviewTool(llm);
    const res = await tool.handler({ subject: "fix bug", output: "the fix" });
    expect(res.verdict).toBe("accept");
    expect(res.score).toBe(92);
    expect(res.suggestions).toEqual(["add a test"]);
  });

  it("rejects below 70 even when the model says accept", async () => {
    const llm: LlmToolFn = () =>
      Promise.resolve({
        content: `{"score": 40, "verdict": "accept", "issues": ["half done"], "suggestions": []}`,
        toolCalls: [],
      });
    const tool = makeReviewTool(llm);
    const res = await tool.handler({ subject: "s", output: "o" });
    expect(res.verdict).toBe("reject");
    expect(res.issues).toEqual(["half done"]);
  });

  it("parseReviewResult tolerates fenced / prose-wrapped JSON", () => {
    expect(parseReviewResult('```json\n{"score": 80, "verdict": "accept"}\n```').verdict).toBe(
      "accept",
    );
    expect(parseReviewResult('Here you go: {"score": 30, "issues": ["a"]}').score).toBe(30);
    expect(parseReviewResult("no json here").verdict).toBe("unknown");
    expect(parseReviewResult("no json here").unparsed).toBe(true);
    expect(parseReviewResult("no json here").score).toBe(0);
  });

  it("extracts the first balanced JSON object from prose with text before and after", () => {
    const wrapped =
      'That looks great! Here is the verdict: {"score": 75, "verdict": "accept", "issues": [], "suggestions": ["add a test"]}. Hope that helps!';
    const res = parseReviewResult(wrapped);
    expect(res.verdict).toBe("accept");
    expect(res.score).toBe(75);
    expect(res.suggestions).toEqual(["add a test"]);
  });

  it("repairs single-quoted JSON and trailing commas", () => {
    const sloppy =
      "Result: {score: 60, verdict: 'reject', issues: ['half done',], suggestions: []}";
    const res = parseReviewResult(sloppy);
    expect(res.verdict).toBe("reject");
    expect(res.score).toBe(60);
    expect(res.issues).toEqual(["half done"]);
  });

  it("yields a real passing score for positive prose instead of a 0/100 reject", () => {
    const res = parseReviewResult("That looks great! Well done, the script works correctly.");
    expect(res.verdict).toBe("accept");
    expect(res.score).toBe(70);
    expect(res.unparsed).toBeUndefined();
  });

  it("yields a real rejection with the prose as the issue for negative prose", () => {
    const res = parseReviewResult("This is broken: the file is missing and it does not work.");
    expect(res.verdict).toBe("reject");
    expect(res.score).toBe(30);
    expect(res.issues.length).toBe(1);
    expect(res.issues[0]).toContain("broken");
  });

  it("never fabricates a reject 0/100 for genuinely unparseable output", () => {
    const res = parseReviewResult("lorem ipsum dolor sit amet");
    expect(res.verdict).toBe("unknown");
    expect(res.unparsed).toBe(true);
    expect(res.score).toBe(0);
    expect(res.issues).toEqual([]);
  });
});

// ── best_of_n ─────────────────────────────────────────────────────────────────

describe("best_of_n tool", () => {
  it("generates candidates, scores them, and returns the best", async () => {
    let call = 0;
    const llm: LlmToolFn = () => {
      call += 1;
      return Promise.resolve({
        content: call === 1 ? "short answer" : "detailed complete answer with structure",
        toolCalls: [],
      });
    };
    const tool = makeBestOfNTool(llm, { n: 2, temperature: 0.9 });
    const res = await tool.handler({ prompt: "explain X" });
    expect(call).toBe(2); // both candidates were generated
    expect(res.n).toBe(2);
    expect(res.scores).toHaveLength(2);
    // The longer structured answer out-scores the short one.
    expect(res.best).toBe("detailed complete answer with structure");
    expect(res.scores[0]).toBeGreaterThanOrEqual(res.scores[1] ?? 0);
  });
});
