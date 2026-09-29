// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import {
  INTERRUPTED_TOOL_RESULT,
  RuntimeToolSet,
  ToolAgentRuntime,
  reconcileJournal,
  type LlmToolFn,
  type RuntimeMessage,
} from "../src/index.js";

const twoCalls: RuntimeMessage = {
  role: "assistant",
  content: "",
  toolCalls: [
    { name: "a", arguments: {}, callId: "c1" },
    { name: "b", arguments: {}, callId: "c2" },
  ],
};

describe("reconcileJournal", () => {
  it("answers dispatched calls that have no result with an interrupted result", () => {
    const out = reconcileJournal([
      { role: "user", content: "go" },
      twoCalls,
      { role: "tool", content: "a done", toolCallId: "c1" },
    ]);
    expect(out.slice(2)).toEqual([
      { role: "tool", content: "a done", toolCallId: "c1" },
      { role: "tool", content: INTERRUPTED_TOOL_RESULT, toolCallId: "c2" },
    ]);
  });

  it("leaves a complete history unchanged", () => {
    const full: RuntimeMessage[] = [
      { role: "user", content: "go" },
      twoCalls,
      { role: "tool", content: "a", toolCallId: "c1" },
      { role: "tool", content: "b", toolCallId: "c2" },
      { role: "assistant", content: "done" },
    ];
    expect(reconcileJournal(full)).toEqual(full);
  });
});

describe("ToolAgentRuntime turn journal", () => {
  function tools(ran: string[], crashOn?: string): RuntimeToolSet {
    const set = new RuntimeToolSet();
    for (const name of ["a", "b"]) {
      set.add({
        name,
        description: name,
        handler: () => {
          if (name === crashOn) throw new Error("process died");
          ran.push(name);
          return Promise.resolve(`${name} done`);
        },
      });
    }
    return set;
  }

  it("resumes a crashed turn without re-running finished or in-flight calls", async () => {
    let journal: RuntimeMessage[] = [];
    const first: LlmToolFn = () => Promise.resolve({ content: "", toolCalls: twoCalls.toolCalls! });
    const ran: string[] = [];
    const crashing = new ToolAgentRuntime({
      llm: first,
      toolSet: tools(ran),
      maxSteps: 1,
      onJournal: (m) => {
        journal = structuredClone(m);
        if (m.at(-1)?.toolCallId === "c1") throw new Error("process died");
      },
    });
    await expect(crashing.run("go")).rejects.toThrow("process died");
    expect(ran).toEqual(["a"]);

    let seen: RuntimeMessage[] = [];
    const resumed = new ToolAgentRuntime({
      llm: (m) => {
        seen = [...m];
        return Promise.resolve({ content: "finished", toolCalls: [] });
      },
      toolSet: tools(ran),
      initialMessages: journal,
      resumeTurn: true,
    });
    const result = await resumed.run("go");
    expect(ran).toEqual(["a"]);
    expect(seen.filter((m) => m.role === "user")).toHaveLength(1);
    expect(seen.at(-1)).toEqual({
      role: "tool",
      content: INTERRUPTED_TOOL_RESULT,
      toolCallId: "c2",
    });
    expect(result.finalContent).toBe("finished");
  });
});
