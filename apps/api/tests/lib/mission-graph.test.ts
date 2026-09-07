// SPDX-License-Identifier: Apache-2.0
/**
 * Mission-graph recorder tests — zero-write-cost execution memory.
 *
 * Covers: phase transitions becoming graph nodes, tool calls → call node +
 * result node with edges, error outcomes marked as error nodes, and bounded
 * argument/result summaries (a runaway tool can't flood the graph).
 */

import { describe, it, expect } from "vitest";
import type { RuntimeTool } from "@nexus/agent-runtime";

import {
  MissionGraphRecorder,
  summarizeArgs,
  summarizeResult,
  type GraphSink,
} from "../../src/lib/mission-graph.js";
import type { GraphEvent } from "../../src/lib/session-graph.js";

function collectingSink(): { sink: GraphSink; events: GraphEvent[] } {
  const events: GraphEvent[] = [];
  return {
    sink: (e) => {
      events.push(e);
    },
    events,
  };
}

describe("summarizeArgs / summarizeResult", () => {
  it("serializes and bounds arguments", () => {
    const s = summarizeArgs({ path: "x".repeat(10_000), mode: "w" });
    expect(s.length).toBeLessThanOrEqual(301);
    expect(s.endsWith("…")).toBe(true);
    expect(summarizeArgs({ a: 1 })).toBe('{"a":1}');
  });

  it("bounds result summaries", () => {
    expect(summarizeResult("ok")).toBe("ok");
    expect(summarizeResult({ n: 1 })).toBe('{"n":1}');
    expect(summarizeResult("y".repeat(10_000)).length).toBeLessThanOrEqual(301);
    expect(summarizeResult(undefined)).toBe("undefined");
  });
});

describe("MissionGraphRecorder", () => {
  it("records phase transitions with unique ids and last-edges", () => {
    const { sink, events } = collectingSink();
    const rec = new MissionGraphRecorder("u1", "m1", sink);
    rec.recordPhase("acting", 0, "steps: 3");
    rec.recordPhase("reviewing", 0, "score 70/100 — accept");

    expect(events).toHaveLength(2);
    expect(events[0]!.title).toBe("m1");
    expect(events[0]!.node.kind).toBe("phase");
    expect(events[0]!.node.label).toBe("acting");
    expect(events[0]!.node.detail).toBe("steps: 3");
    expect(events[0]!.edge?.from).toBe("last");
    expect(events[1]!.node.id).not.toBe(events[0]!.node.id);
  });

  it("wraps tools: call node + result node, chained edges", async () => {
    const { sink, events } = collectingSink();
    const rec = new MissionGraphRecorder("u1", "m1", sink);
    const tool: RuntimeTool = {
      name: "read_file",
      description: "read",
      handler: async () => "file contents",
    };
    const wrapped = rec.wrapTool(tool);
    const out = await wrapped.handler({ path: "a.txt" }, {});

    expect(out).toBe("file contents"); // behavior unchanged
    const kinds = events.map((e) => e.node.kind);
    expect(kinds).toEqual(["tool", "report"]);
    expect(events[0]!.node.label).toBe("read_file");
    expect(events[0]!.node.detail).toBe('{"path":"a.txt"}');
    expect(events[1]!.node.label).toBe("read_file result");
    expect(events[1]!.node.detail).toContain("ok");
    expect(events[1]!.edge?.from).toBe(events[0]!.node.id);
  });

  it("marks failed tool outcomes as error nodes and still rethrows", async () => {
    const { sink, events } = collectingSink();
    const rec = new MissionGraphRecorder("u1", "m1", sink);
    const tool: RuntimeTool = {
      name: "edit_file",
      description: "edit",
      handler: async () => {
        throw new Error("path outside workspace");
      },
    };
    const wrapped = rec.wrapTool(tool);
    await expect(wrapped.handler({}, {})).rejects.toThrow("path outside workspace");

    const kinds = events.map((e) => e.node.kind);
    expect(kinds).toEqual(["tool", "error"]);
    expect(events[1]!.node.detail).toContain("path outside workspace");
  });

  it("never throws when the sink fails (capture is best-effort)", async () => {
    const rec = new MissionGraphRecorder("u1", "m1", () => {
      throw new Error("kv down");
    });
    expect(() => rec.recordPhase("acting", 0)).not.toThrow();
    const tool: RuntimeTool = { name: "x", description: "x", handler: async () => 1 };
    await expect(rec.wrapTool(tool).handler({}, {})).resolves.toBe(1);
  });

  it("produces unique tool node ids across calls", async () => {
    const { sink, events } = collectingSink();
    const rec = new MissionGraphRecorder("u1", "m1", sink);
    const tool: RuntimeTool = { name: "ls", description: "ls", handler: async () => [] };
    const wrapped = rec.wrapTool(tool);
    await wrapped.handler({}, {});
    await wrapped.handler({}, {});
    const callNodes = events.filter((e) => e.node.kind === "tool");
    expect(callNodes[0]!.node.id).not.toBe(callNodes[1]!.node.id);
  });

  it("records runtime skill executions as started → completed skill nodes", () => {
    const { sink, events } = collectingSink();
    const rec = new MissionGraphRecorder("u1", "m1", sink);
    const startedId = rec.recordSkillExecution({
      skillId: "skill-1",
      skillName: "report-writer",
      status: "started",
      detail: "python · 30000ms budget",
    });
    rec.recordSkillExecution({
      skillId: "skill-1",
      skillName: "report-writer",
      status: "completed",
      detail: "completed in 42ms (exit 0)",
      from: startedId,
    });

    expect(events).toHaveLength(2);
    const [started, terminal] = events;
    expect(started!.node.kind).toBe("skill");
    expect(started!.node.status).toBe("started");
    expect(started!.node.label).toBe("report-writer");
    expect(started!.node.detail).toContain("[skill-1]");
    expect(started!.edge?.kind).toBe("skill");
    expect(terminal!.node.kind).toBe("skill");
    expect(terminal!.node.status).toBe("completed");
    expect(terminal!.node.label).toBe("report-writer result");
    expect(terminal!.node.detail).toContain("completed in 42ms");
    expect(terminal!.edge?.from).toBe(started!.node.id); // chained to its start
    expect(terminal!.edge?.kind).toBe("skill_result");
  });

  it("marks failed skill runs with status failed and keeps node ids unique", () => {
    const { sink, events } = collectingSink();
    const rec = new MissionGraphRecorder("u1", "m1", sink);
    const startedId = rec.recordSkillExecution({
      skillId: "skill-1",
      skillName: "report-writer",
      status: "started",
    });
    rec.recordSkillExecution({
      skillId: "skill-1",
      skillName: "report-writer",
      status: "failed",
      detail: "failed (exit 2) — Traceback: boom",
      from: startedId,
    });
    const second = rec.recordSkillExecution({
      skillId: "skill-2",
      skillName: "counter",
      status: "started",
    });

    expect(events).toHaveLength(3);
    expect(events[1]!.node.status).toBe("failed");
    expect(events[1]!.edge?.from).toBe(events[0]!.node.id);
    const skillIds = new Set(events.map((e) => e.node.id));
    expect(skillIds.size).toBe(3); // started + failed + next started all unique
    expect(second).not.toBe(startedId);
  });

  it("skill nodes use the generic last-edge when no started node is linked", () => {
    const { sink, events } = collectingSink();
    const rec = new MissionGraphRecorder("u1", "m1", sink);
    rec.recordSkillExecution({ skillId: "s", skillName: "x", status: "started" });
    expect(events[0]!.edge?.from).toBe("last");
  });
});