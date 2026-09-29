// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import {
  RuntimeToolSet,
  TRIMMED_OUTPUT_NOTE,
  ToolAgentRuntime,
  trimOldToolOutputs,
  type LlmToolFn,
  type RuntimeMessage,
} from "../src/index.js";

const big = "x".repeat(2_000);

describe("trimOldToolOutputs", () => {
  const history: RuntimeMessage[] = [
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ name: "write_file", arguments: { path: "a.ts", content: big }, callId: "c1" }],
    },
    { role: "tool", content: big, toolCallId: "c1" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ name: "write_file", arguments: { path: "b.ts", content: big }, callId: "c2" }],
    },
    { role: "tool", content: big, toolCallId: "c2" },
  ];

  it("keeps the latest outputs and arguments whole and cuts older ones", () => {
    const out = trimOldToolOutputs(history, 1, 100);
    expect(out[2]!.content).toBe("x".repeat(100) + TRIMMED_OUTPUT_NOTE);
    expect(out[1]!.toolCalls![0]!.arguments).toEqual({
      path: "a.ts",
      content: "x".repeat(100) + TRIMMED_OUTPUT_NOTE,
    });
    expect(out[3]).toBe(history[3]);
    expect(out[4]).toBe(history[4]);
  });

  it("leaves the history it was given untouched", () => {
    trimOldToolOutputs(history, 0, 100);
    expect(history[2]!.content).toBe(big);
    expect(history[1]!.toolCalls![0]!.arguments.content).toBe(big);
  });
});

describe("ToolAgentRuntime keepToolOutputs", () => {
  it("sends trimmed history to the model but returns it whole", async () => {
    let turn = 0;
    let lastSent: RuntimeMessage[] = [];
    const llm: LlmToolFn = (messages) => {
      lastSent = messages;
      turn += 1;
      return Promise.resolve(
        turn <= 2
          ? { content: "", toolCalls: [{ name: "dump", arguments: {}, callId: `c${turn}` }] }
          : { content: "done", toolCalls: [] },
      );
    };
    const toolSet = new RuntimeToolSet().add({
      name: "dump",
      description: "dump",
      handler: () => Promise.resolve(big),
    });
    const result = await new ToolAgentRuntime({
      llm,
      toolSet,
      keepToolOutputs: 1,
      compressToolOutput: false,
    }).run("go");
    const sentTools = lastSent.filter((m) => m.role === "tool");
    expect(sentTools[0]!.content.endsWith(TRIMMED_OUTPUT_NOTE)).toBe(true);
    expect(sentTools[1]!.content).toBe(big);
    expect(result.messages.filter((m) => m.role === "tool").every((m) => m.content === big)).toBe(
      true,
    );
  });
});
