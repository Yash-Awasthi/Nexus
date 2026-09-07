// SPDX-License-Identifier: Apache-2.0
// agent-engine tool-execution loop + registry — focused tests with a
// stubbed fetch driving the OpenAI tool-calling protocol.
import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAIEngine, EngineRegistry, type EngineConfig, type ToolCall } from "./index.js";

const CFG: EngineConfig = { model: "gpt-4o-mini", systemPrompt: "You are a test agent", maxTurns: 5 };

/** Stub global fetch with a scripted sequence of OpenAI responses. */
function stubFetch(responses: unknown[]): ReturnType<typeof vi.fn> {
  let i = 0;
  const fn = vi.fn(async () => ({
    ok: true,
    json: async () => responses[Math.min(i++, responses.length - 1)],
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

function lastRequestBody(): Record<string, unknown> {
  const calls = vi.mocked(fetch).mock.calls;
  return JSON.parse(calls[calls.length - 1][1]?.body as string) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAIEngine tool execution", () => {
  it("executes tool calls and feeds results back to the model", async () => {
    const executed: ToolCall[] = [];
    stubFetch([
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: "call_1", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
              ],
            },
          },
        ],
      },
      { choices: [{ message: { content: "It is sunny in Paris" } }] },
    ]);
    const engine = new OpenAIEngine(undefined, undefined, async (call) => {
      executed.push(call);
      return "22C";
    });
    const res = await engine.run("What is the weather in Paris?", CFG);
    expect(res.output).toBe("It is sunny in Paris");
    expect(executed).toEqual([{ name: "get_weather", arguments: { city: "Paris" } }]);
    expect(res.toolCallCount).toBe(1);
    expect(res.turns).toBe(2);
    // The assistant message carries the tool_calls; the tool result follows
    // with the matching tool_call_id.
    const body = lastRequestBody();
    const msgs = body.messages as Array<Record<string, unknown>>;
    expect(msgs[2]).toMatchObject({
      role: "assistant",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather" } }],
    });
    expect(msgs[3]).toMatchObject({ role: "tool", tool_call_id: "call_1", content: "22C" });
  });

  it("executes multiple tool calls from a single response", async () => {
    const executed: string[] = [];
    stubFetch([
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: "c1", function: { name: "f_a", arguments: "{}" } },
                { id: "c2", function: { name: "f_b", arguments: "{}" } },
              ],
            },
          },
        ],
      },
      { choices: [{ message: { content: "done" } }] },
    ]);
    const engine = new OpenAIEngine(undefined, undefined, (call) => {
      executed.push(call.name);
      return "ok";
    });
    const res = await engine.run("go", CFG);
    expect(executed).toEqual(["f_a", "f_b"]);
    expect(res.toolCallCount).toBe(2);
  });

  it("survives malformed tool arguments by executing with an empty object", async () => {
    const executed: ToolCall[] = [];
    stubFetch([
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: "c1", function: { name: "f", arguments: "not json" } }],
            },
          },
        ],
      },
      { choices: [{ message: { content: "recovered" } }] },
    ]);
    const engine = new OpenAIEngine(undefined, undefined, async (call) => {
      executed.push(call);
      return "ok";
    });
    const res = await engine.run("go", CFG);
    expect(executed).toEqual([{ name: "f", arguments: {} }]);
    expect(res.output).toBe("recovered");
  });

  it("feeds executor errors back so the model can adapt", async () => {
    stubFetch([
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: "c1", function: { name: "explode", arguments: "{}" } }],
            },
          },
        ],
      },
      { choices: [{ message: { content: "I will not call that tool" } }] },
    ]);
    const engine = new OpenAIEngine(undefined, undefined, () => {
      throw new Error("boom");
    });
    const res = await engine.run("go", CFG);
    expect(res.output).toBe("I will not call that tool");
    const body = lastRequestBody();
    const msgs = body.messages as Array<Record<string, unknown>>;
    expect(msgs[3]).toMatchObject({ role: "tool", tool_call_id: "c1", content: "Error: boom" });
  });

  it("caps tool loops at maxTurns", async () => {
    stubFetch([
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: "c1", function: { name: "f", arguments: "{}" } }],
            },
          },
        ],
      },
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: "c2", function: { name: "f", arguments: "{}" } }],
            },
          },
        ],
      },
    ]);
    const engine = new OpenAIEngine(undefined, undefined, () => "ok");
    const res = await engine.run("go", { ...CFG, maxTurns: 2 });
    expect(res.turns).toBe(2);
    expect(res.toolCallCount).toBe(2);
  });

  it("reports when no tool executor is configured", async () => {
    stubFetch([
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: "c1", function: { name: "f", arguments: "{}" } }],
            },
          },
        ],
      },
      { choices: [{ message: { content: "no tools available" } }] },
    ]);
    const engine = new OpenAIEngine();
    const res = await engine.run("go", CFG);
    expect(res.output).toBe("no tools available");
    const msgs = lastRequestBody().messages as Array<Record<string, unknown>>;
    expect(msgs[3]).toMatchObject({
      role: "tool",
      content: "No tool executor configured for this engine.",
    });
  });
});

describe("EngineRegistry", () => {
  it("registers, resolves, and auto-detects engines by model name", () => {
    const registry = new EngineRegistry();
    const openai = new OpenAIEngine();
    const claude = new OpenAIEngine(undefined, undefined, () => "claude-tool");
    claude.name = "claude" as typeof claude.name;
    registry.register(openai);
    registry.register(claude);
    expect(registry.list()).toHaveLength(2);
    expect(registry.get("openai")).toBe(openai);
    expect(registry.resolveEngine("claude-3-5-sonnet")).toBe(claude);
    expect(registry.resolveEngine("gpt-4o")).toBe(openai);
    expect(registry.resolveEngine("anything-else")).toBe(openai);
  });
});