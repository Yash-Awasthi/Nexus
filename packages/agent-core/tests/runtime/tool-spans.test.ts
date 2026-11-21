// SPDX-License-Identifier: Apache-2.0
/**
 * One chat turn that calls two tools must produce exactly one span per tool
 * call, named `tool.call`, carrying the tool name and permission tier and
 * nested under one `agent.turn` span.
 */
import { afterAll, describe, expect, it } from "vite-plus/test";

import { startTracing, stopTracing } from "@nexus/telemetry";

import {
  RuntimeToolSet,
  ToolAgentRuntime,
  type LlmToolFn,
  type RuntimeMessage,
} from "../../src/runtime/index.ts";

interface EndedSpan {
  name: string;
  attributes: Record<string, unknown>;
  parentSpanContext?: { spanId: string };
  spanContext(): { traceId: string; spanId: string };
}

const ended: EndedSpan[] = [];
const exporter = {
  export: (spans: EndedSpan[], done: (result: { code: number }) => void) => {
    ended.push(...spans);
    done({ code: 0 });
  },
  shutdown: () => Promise.resolve(),
  forceFlush: () => Promise.resolve(),
};
startTracing("nexus-agent-test", exporter);

afterAll(async () => {
  await stopTracing();
});

function twoToolTurn(): LlmToolFn {
  let turn = 0;
  return (_messages: RuntimeMessage[]) => {
    turn += 1;
    if (turn === 1) {
      return Promise.resolve({
        content: "",
        toolCalls: [
          { name: "read_file", arguments: { path: "a" }, callId: "c1" },
          { name: "write_file", arguments: { path: "b" }, callId: "c2" },
        ],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      });
    }
    return Promise.resolve({ content: "done", toolCalls: [] });
  };
}

describe("tool call spans", () => {
  it("emits one span per tool call with name and tier", async () => {
    ended.length = 0;
    const toolSet = new RuntimeToolSet()
      .add({ name: "read_file", description: "read", handler: () => Promise.resolve("a") })
      .add({ name: "write_file", description: "write", handler: () => Promise.resolve("b") });
    const runtime = new ToolAgentRuntime({
      llm: twoToolTurn(),
      toolSet,
      maxSteps: 3,
      permissionGate: () => ({ allowed: true }),
    });

    await runtime.run("do both");

    const spans = ended.filter((span) => span.name === "tool.call");
    expect(spans).toHaveLength(2);
    expect(spans.map((span) => span.attributes["tool.name"])).toEqual(["read_file", "write_file"]);
    expect(spans.map((span) => span.attributes["tool.tier"])).toEqual([
      "auto_allowed",
      "requires_permission",
    ]);

    // Both calls are children of the same turn span, so one turn is one trace.
    const [turn] = ended.filter((span) => span.name === "agent.turn");
    expect(turn).toBeDefined();
    const traceId = turn!.spanContext().traceId;
    const turnSpanId = turn!.spanContext().spanId;
    for (const span of spans) {
      expect(span.spanContext().traceId).toBe(traceId);
      expect(span.parentSpanContext?.spanId).toBe(turnSpanId);
    }
    expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(1);
  });
});
