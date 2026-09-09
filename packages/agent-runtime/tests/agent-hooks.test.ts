// SPDX-License-Identifier: Apache-2.0
// Lifecycle hooks — focused tests for the hooks module
// and its wiring into ToolAgentRuntime / makeSpawnAgentsTool.
import { describe, it, expect } from "vitest";
import {
  ToolAgentRuntime,
  RuntimeToolSet,
  HookDispatcher,
  mergeHookDecisions,
  makeSpawnAgentsTool,
  type LlmStreamFn,
  type LlmToolFn,
  type LlmTurnResult,
  type RuntimeMessage,
  type RuntimeTool,
  type AgentHooks,
  type HookDecision,
  type ToolSpec,
  type SpawnAgentResult,
} from "../src/index.js";

// ── Fakes ────────────────────────────────────────────────────────────────────

/** Scripted LLM: one turn per run() step, replayed in order. */
function scriptedLlm(turns: LlmTurnResult[]): LlmToolFn {
  let i = 0;
  return async (_messages: RuntimeMessage[]): Promise<LlmTurnResult> => {
    if (i >= turns.length) return { content: "(no more turns)", toolCalls: [] };
    return turns[i++]!;
  };
}

/** A deterministic one-line tool. */
function echoTool(name = "echo"): RuntimeTool {
  return {
    name,
    description: "returns its input verbatim",
    handler: async (args) => ({ echoed: args.text ?? "" }),
    parameters: { type: "object", properties: { text: { type: "string" } } },
  };
}

const call = (text: string, id = "c1") => ({
  name: "echo",
  arguments: { text },
  callId: id,
});

const NO_TOOLS: ToolSpec[] = [
  { name: "echo", description: "returns its input verbatim", parameters: { type: "object" } },
];

// ── mergeHookDecisions ───────────────────────────────────────────────────────

describe("mergeHookDecisions", () => {
  it("empty merges stay empty; single-sided returns that side", () => {
    expect(mergeHookDecisions(undefined, undefined)).toBeUndefined();
    expect(mergeHookDecisions({ feedback: "a" }, undefined)).toEqual({ feedback: "a" });
    expect(mergeHookDecisions(undefined, { feedback: "b" })).toEqual({ feedback: "b" });
  });

  it("blocks stick once any decision blocks (fail-closed)", () => {
    const merged = mergeHookDecisions({ feedback: "a" }, { continue: false, feedback: "b" });
    expect(merged?.continue).toBe(false);
    expect(merged?.feedback).toBe("a\nb");
  });

  it("stopReason keeps the blocker's; suppressOutput ORs", () => {
    const merged = mergeHookDecisions(
      { continue: false, stopReason: "guard_a", feedback: "first" },
      { stopReason: "guard_b", suppressOutput: true }, // b did not block
    );
    expect(merged).toEqual({
      continue: false,
      stopReason: "guard_a",
      feedback: "first",
      suppressOutput: true,
    });
  });
});

// ── HookDispatcher ───────────────────────────────────────────────────────────

describe("HookDispatcher", () => {
  it("rejects unknown hook keys loudly", () => {
    expect(() => new HookDispatcher({ preToolUSe: () => {} } as unknown as AgentHooks)).toThrow(
      /unknown hook event/i,
    );
  });

  it("runs handlers in order and merges decisions fail-closed", async () => {
    const order: string[] = [];
    const d = new HookDispatcher({
      preToolUse: [
        (input) => {
          order.push(`a:${input.toolName}`);
          return { feedback: "first" };
        },
        () => {
          order.push("b");
          return { continue: false, stopReason: "guard" };
        },
        () => {
          order.push("c");
          return { continue: true }; // cannot un-block
        },
      ],
    });
    const decision = await d.dispatch("preToolUse", { toolName: "t", toolCallId: "1", input: {} });
    expect(order).toEqual(["a:t", "b", "c"]);
    expect(decision?.continue).toBe(false);
    expect(decision?.stopReason).toBe("guard");
  });

  it("dispatch with no handlers resolves undefined", async () => {
    const d = new HookDispatcher({});
    expect(
      await d.dispatch("stop", { finalContent: "", totalUsage: {} as never, steps: [] }),
    ).toBeUndefined();
    expect(d.has("stop")).toBe(false);
  });
});

// ── ToolAgentRuntime wiring ──────────────────────────────────────────────────

describe("ToolAgentRuntime hooks", () => {
  it("preToolUse block feeds the model a tool error instead of running the tool", async () => {
    let ran = false;
    const toolSet = new RuntimeToolSet().add({
      name: "echo",
      description: "t",
      handler: async () => {
        ran = true;
        return "should not happen";
      },
    });
    const runtime = new ToolAgentRuntime({
      llm: scriptedLlm([
        { content: "", toolCalls: [call("hi")] },
        { content: "done", toolCalls: [] },
      ]),
      toolSet,
      tools: NO_TOOLS,
      hooks: { preToolUse: () => ({ continue: false, stopReason: "guard: no echo today" }) },
    });

    const result = await runtime.run("use the tool");
    expect(ran).toBe(false);
    expect(result.aborted).toBe(false);
    const toolMsg = result.messages.find((m) => m.role === "tool");
    expect(String(toolMsg?.content)).toContain("hook_blocked: guard: no echo today");
  });

  it("preToolUse block without feedback falls back to a generic reason", async () => {
    const toolSet = new RuntimeToolSet().add(echoTool());
    const runtime = new ToolAgentRuntime({
      llm: scriptedLlm([
        { content: "", toolCalls: [call("x")] },
        { content: "done", toolCalls: [] },
      ]),
      toolSet,
      tools: NO_TOOLS,
      hooks: { preToolUse: () => ({ continue: false }) },
    });
    const result = await runtime.run("go");
    const toolMsg = result.messages.find((m) => m.role === "tool");
    expect(String(toolMsg?.content)).toContain("hook_blocked:");
  });

  it("postToolUse feedback replaces the history text (result object untouched)", async () => {
    const toolSet = new RuntimeToolSet().add(echoTool());
    const runtime = new ToolAgentRuntime({
      llm: scriptedLlm([
        { content: "", toolCalls: [call("secret")] },
        { content: "done", toolCalls: [] },
      ]),
      toolSet,
      tools: NO_TOOLS,
      hooks: {
        postToolUse: (input) => ({
          feedback: `[redacted] ${String((input.result.output as { echoed: string }).echoed).length} chars`,
        }),
      },
    });
    const result = await runtime.run("go");
    const toolMsg = result.messages.find((m) => m.role === "tool");
    expect(String(toolMsg?.content)).toContain("[redacted]");
    expect(String(toolMsg?.content)).not.toContain("secret");
    // The actual tool result recorded on the step keeps the real output.
    expect(result.steps[0]!.toolResults[0]!.output).toEqual({ echoed: "secret" });
  });

  it("postToolUse suppressOutput blanks the history text", async () => {
    const toolSet = new RuntimeToolSet().add(echoTool());
    const runtime = new ToolAgentRuntime({
      llm: scriptedLlm([
        { content: "", toolCalls: [call("loud")] },
        { content: "done", toolCalls: [] },
      ]),
      toolSet,
      tools: NO_TOOLS,
      hooks: { postToolUse: () => ({ suppressOutput: true }) },
    });
    const result = await runtime.run("go");
    const toolMsg = result.messages.find((m) => m.role === "tool");
    expect(String(toolMsg?.content)).toContain("[output suppressed by hook]");
  });

  it("stop hook transforms the final answer", async () => {
    const runtime = new ToolAgentRuntime({
      llm: scriptedLlm([{ content: "raw answer", toolCalls: [] }]),
      toolSet: new RuntimeToolSet(),
      hooks: { stop: (input) => ({ feedback: `${input.finalContent} [reviewed]` }) },
    });
    const result = await runtime.run("answer me");
    expect(result.finalContent).toBe("raw answer [reviewed]");
  });

  it("stop hook does NOT fire on aborted runs", async () => {
    let stopFired = false;
    const runtime = new ToolAgentRuntime({
      llm: scriptedLlm([{ content: "x", toolCalls: [] }]),
      toolSet: new RuntimeToolSet(),
      // The abort check inside the loop returns early — before the stop hook.
      hooks: {
        stop: () => {
          stopFired = true;
          return { feedback: "nope" };
        },
      },
    });
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await runtime.run("go", ctrl.signal);
    expect(result.aborted).toBe(true);
    expect(stopFired).toBe(false);
  });

  it("runs without hooks exactly as before (default off)", async () => {
    const toolSet = new RuntimeToolSet().add(echoTool());
    const runtime = new ToolAgentRuntime({
      llm: scriptedLlm([
        { content: "", toolCalls: [call("plain")] },
        { content: "done", toolCalls: [] },
      ]),
      toolSet,
      tools: NO_TOOLS,
    });
    const result = await runtime.run("go");
    expect(result.steps[0]!.toolResults[0]!.output).toEqual({ echoed: "plain" });
    expect(result.finalContent).toBe("done");
  });
});

// ── makeSpawnAgentsTool subagentStop ─────────────────────────────────────────

describe("makeSpawnAgentsTool subagentStop hooks", () => {
  it("subagentStop veto overrides a child's verdict with an error", async () => {
    // makeSpawnAgentsTool children are streaming AgentRuntimes (LlmStreamFn).
    const llm: LlmStreamFn = async function* () {
      yield "child says: all good";
    };
    const vetoed: number[] = [];
    const tool = makeSpawnAgentsTool(llm, {
      hooks: {
        subagentStop: (input) => {
          if (input.taskIndex === 1) {
            vetoed.push(input.taskIndex);
            return { continue: false, stopReason: "child leaked secrets" };
          }
          return;
        },
      },
    });
    const toolSet = new RuntimeToolSet().add(tool);
    const res = await toolSet.invoke("spawn_agents", {
      tasks: [{ instruction: "a" }, { instruction: "b" }],
    });

    const results = res.output as SpawnAgentResult[];
    expect(results).toHaveLength(2);
    expect(results[0]!.finalContent).toContain("all good");
    expect(results[0]!.error).toBeUndefined();
    expect(vetoed).toEqual([1]);
    expect(results[1]!.finalContent).toBe("");
    expect(results[1]!.error).toContain("hook_veto: child leaked secrets");
  });

  it("without hooks, child verdicts pass through unchanged", async () => {
    const llm: LlmStreamFn = async function* () {
      yield "fine";
    };
    const tool = makeSpawnAgentsTool(llm);
    const toolSet = new RuntimeToolSet().add(tool);
    const res = await toolSet.invoke("spawn_agents", {
      tasks: [{ instruction: "x" }],
    });
    const results = res.output as SpawnAgentResult[];
    expect(results[0]!.finalContent).toBe("fine");
    expect(results[0]!.error).toBeUndefined();
  });
});
