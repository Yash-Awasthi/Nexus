// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { RuntimeToolSet } from "@nexus/agent-runtime";
import type { LlmToolFn } from "@nexus/agent-runtime";

import { MissionRunner, type MissionRecord, type MissionStore } from "./mission.js";

const THINK = "Think step by step about the best approach.";

function makeLlm(opts: {
  think?: string;
  /** Scripted acting responses (one per acting call). */
  acting?: string[];
  /** Scripted reviewer JSON payloads (one per review call). */
  reviews: string[];
  /** Content returned to a spawned child (matched by its instruction text). */
  child?: string;
}): LlmToolFn {
  let actingCall = 0;
  let reviewCall = 0;
  return async (messages, o) => {
    const text = messages[messages.length - 1]?.content ?? "";
    // Acting (and child) calls come from ToolAgentRuntime with a tools key.
    if (o.tools !== undefined) {
      if (opts.child && text.startsWith("Subagent task")) {
        return {
          content: opts.child,
          toolCalls: [],
          usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        };
      }
      const scripted = opts.acting ?? ["work v1"];
      const content = scripted[Math.min(actingCall, scripted.length - 1)] ?? "work vN";
      actingCall += 1;
      return {
        content,
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      };
    }
    if (text.includes("Work to review")) {
      const json = opts.reviews[Math.min(reviewCall, opts.reviews.length - 1)] ?? "{}";
      reviewCall += 1;
      return {
        content: json,
        toolCalls: [],
        usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
      };
    }
    // Think pass.
    return {
      content: opts.think ?? "thought",
      toolCalls: [],
      usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
    };
  };
}

function memoryStore(): { store: MissionStore; saved: MissionRecord[] } {
  const saved: MissionRecord[] = [];
  return {
    store: { save: async (r) => saved.push(JSON.parse(JSON.stringify(r)) as MissionRecord) },
    saved,
  };
}

describe("MissionRunner", () => {
  it("think → act → review accept → completed (usage accumulated, store persisted)", async () => {
    const { store, saved } = memoryStore();
    const runner = new MissionRunner({
      llm: makeLlm({
        think: "the plan",
        reviews: ['{"score": 90, "verdict": "accept", "issues": [], "suggestions": []}'],
      }),
      thinkPrompt: THINK,
      maxIterations: 3,
      store,
    });

    const record = await runner.run("Ship the feature");

    expect(record.status).toBe("completed");
    expect(record.accepted).toBe(true);
    expect(record.iteration).toBe(0);
    expect(record.finalContent).toBe("work v1");
    expect(record.usage.totalTokens).toBe(36); // 10 think + 15 acting + 11 review
    expect(record.lastReview?.score).toBe(90);
    const phases = record.phases.map((p) => p.phase);
    expect(phases).toContain("started");
    expect(phases).toContain("thinking");
    expect(phases).toContain("acting");
    expect(phases).toContain("reviewing");
    expect(phases).toContain("completed");
    // Every phase transition hit the durable store.
    expect(saved.length).toBe(record.phases.length);
    expect(saved[saved.length - 1]!.status).toBe("completed");
  });

  it("reject → improve (reviewer feedback fed back) → accept on iteration 2", async () => {
    let sawImprovement = false;
    const reviews = [
      '{"score": 40, "verdict": "reject", "issues": ["missing tests"], "suggestions": ["add tests", "document"]}',
      '{"score": 85, "verdict": "accept", "issues": [], "suggestions": []}',
    ];
    const llm = makeLlm({ reviews, acting: ["work v1", "work v2 with tests"] });
    const runner = new MissionRunner({
      llm: async (messages, o) => {
        if (
          o.tools !== undefined &&
          messages.some((m) => m.content.includes("Suggested improvements"))
        ) {
          sawImprovement = true;
        }
        return llm(messages, o);
      },
      thinkPrompt: THINK,
      maxIterations: 3,
    });

    const record = await runner.run("Ship the feature");
    expect(record.status).toBe("completed");
    expect(record.accepted).toBe(true);
    expect(record.iteration).toBe(1);
    expect(record.finalContent).toBe("work v2 with tests");
    expect(sawImprovement).toBe(true);
    expect(record.phases.map((p) => p.phase)).toContain("improving");
  });

  it("budget exhaustion → best-effort completion, honestly marked (accepted: false)", async () => {
    const runner = new MissionRunner({
      llm: makeLlm({
        reviews: ['{"score": 30, "verdict": "reject", "issues": ["x"], "suggestions": []}'],
      }),
      maxIterations: 2,
    });
    const record = await runner.run("Hard goal");
    expect(record.status).toBe("completed");
    expect(record.accepted).toBe(false);
    expect(record.maxIterationsReached).toBe(true);
    expect(record.iteration).toBe(1); // last iteration attempted
  });

  it("an accept with no output and no tool activity is deterministically blocked — empty work never passes", async () => {
    const runner = new MissionRunner({
      // The acting model produces NOTHING (no text, no tool calls) yet the
      // reviewer "accepts" at 95 — the harness must block that, whatever the
      // model says, and keep the reviewer's score on the record for audit.
      llm: makeLlm({
        acting: [""],
        reviews: ['{"score": 95, "verdict": "accept", "issues": [], "suggestions": []}'],
      }),
      thinkPrompt: THINK,
      maxIterations: 2,
    });
    const record = await runner.run("Produce the report");
    expect(record.status).toBe("completed");
    expect(record.accepted).toBe(false);
    expect(record.maxIterationsReached).toBe(true);
    // The override is auditable: the reviewer's accept is kept, marked noWork.
    expect(record.lastReview?.verdict).toBe("accept");
    expect(record.lastReview?.noWork).toBe(true);
    // The loop kept pushing instead of self-approving, with an explicit note.
    expect(record.phases.some((p) => p.phase === "improving")).toBe(true);
    expect(
      record.phases.some((p) => p.phase === "improving" && (p.note ?? "").includes("no work produced")),
    ).toBe(true);
  });

  it("an accept with tool activity but no closing text is NOT blocked", async () => {
    let toolCall = true;
    const llm = makeLlm({
      acting: [""], // final text empty — but a tool ran this iteration
      reviews: ['{"score": 90, "verdict": "accept", "issues": [], "suggestions": []}'],
    });
    const runner = new MissionRunner({
      llm: async (messages, o) => {
        if (o.tools !== undefined && toolCall) {
          toolCall = false;
          return {
            content: "",
            toolCalls: [{ name: "write", arguments: { path: "out.md", content: "# Done" }, callId: "c1" }],
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          };
        }
        return llm(messages, o);
      },
      thinkPrompt: THINK,
      maxIterations: 3,
      toolSet: new RuntimeToolSet().add({
        name: "write",
        description: "",
        handler: () => Promise.resolve("written"),
      }),
    });
    const record = await runner.run("Write out.md");
    expect(record.status).toBe("completed");
    expect(record.accepted).toBe(true);
    expect(record.lastReview?.noWork).toBeUndefined();
  });

  it("aborts cleanly when the signal fires", async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = new MissionRunner({
      llm: makeLlm({ reviews: ["{}"] }),
      signal: controller.signal,
      maxIterations: 3,
    });
    const record = await runner.run("Goal");
    expect(record.status).toBe("aborted");
    expect(record.phases.at(-1)?.phase).toBe("aborted");
  });

  it("spawn phase runs subagents (self-spawn) and folds their reports into the conversation", async () => {
    const { store } = memoryStore();
    const runner = new MissionRunner({
      llm: makeLlm({
        reviews: ['{"score": 80, "verdict": "accept", "issues": [], "suggestions": []}'],
        child: "changelog drafted",
      }),
      thinkPrompt: THINK,
      maxIterations: 2,
      store,
      spawnTasks: async ({ iteration }) =>
        iteration === 0 ? [{ instruction: "Subagent task: draft the changelog" }] : [],
    });
    const record = await runner.run("Ship the feature");
    expect(record.spawnCount).toBe(1);
    expect(record.phases.map((p) => p.phase)).toContain("spawning");
    // Usage includes the child's 5 tokens (10 think + 15 act + 5 child + 11 review).
    expect(record.usage.totalTokens).toBe(41);
    // The subagent's report was folded into the carried conversation for the
    // next acting iteration to see.
    expect(record.phases.filter((p) => p.phase === "acting").length).toBe(1);
  });

  it("fails honestly when the acting phase throws", async () => {
    const runner = new MissionRunner({
      llm: async () => {
        throw new Error("provider down");
      },
      maxIterations: 2,
    });
    const record = await runner.run("Goal");
    expect(record.status).toBe("failed");
    expect(record.error).toContain("provider down");
  });

  it("seeds the memory directive onto the acting USER turn (not the system prompt)", async () => {
    let userTurnSeen = "";
    let systemPromptSeen = "";
    const runner = new MissionRunner({
      llm: async (messages, o) => {
        if (o.tools !== undefined) {
          // Acting call — capture the user turn and the system prompt it saw.
          userTurnSeen = messages[messages.length - 1]?.content ?? "";
          systemPromptSeen = o.systemPrompt ?? "";
        }
        return makeLlm({
          reviews: ['{"score": 80, "verdict": "accept", "issues": [], "suggestions": []}'],
        })(messages, o);
      },
      memoryDirective: "FIX the missing tests. VERIFY the file exists. RESUME from prior output.",
      maxIterations: 2,
      actingSystemPrompt: "You are a mission agent.",
    });

    await runner.run("Ship the feature");

    // The directive leads the acting user turn — the channel the model attends to.
    expect(userTurnSeen).toContain("FIX the missing tests.");
    expect(userTurnSeen).toContain("GOAL: Ship the feature");
    // And it must NOT be buried in the system prompt, which the local model ignores.
    expect(systemPromptSeen).not.toContain("FIX the missing tests");
    expect(systemPromptSeen).toBe("You are a mission agent.");
  });

  it("positive prose review yields a real passing score, never a reject 0/100", async () => {
    // Reviewer wrote prose (qwen2.5:7b failure mode) — no JSON at all.
    const runner = new MissionRunner({
      llm: makeLlm({
        reviews: ["That looks great! Well done, the script works correctly."],
        acting: ["work v1"],
      }),
      thinkPrompt: THINK,
      maxIterations: 3,
    });
    const record = await runner.run("Write the script");
    // The prose review reflects content: a real passing score (70), accept —
    // the mission completes on iteration 0 instead of burning iterations on a
    // fabricated rejection.
    expect(record.status).toBe("completed");
    expect(record.accepted).toBe(true);
    expect(record.iteration).toBe(0);
    expect(record.lastReview?.verdict).toBe("accept");
    expect(record.lastReview?.score).toBe(70);
    expect(record.lastReview?.unparsed).toBeUndefined();
  });

  it("an unparseable review never reads as reject 0/100 on the record", async () => {
    const runner = new MissionRunner({
      llm: makeLlm({
        reviews: ["lorem ipsum dolor sit amet"],
        acting: ["work v1"],
      }),
      thinkPrompt: THINK,
      maxIterations: 2,
    });
    const record = await runner.run("Goal");
    // Budget exhausted: honest terminal state. The last review is UNKNOWN, not
    // a reject — no fabricated issues, no 0/100.
    expect(record.status).toBe("completed");
    expect(record.accepted).toBe(false);
    expect(record.maxIterationsReached).toBe(true);
    expect(record.lastReview?.verdict).toBe("unknown");
    expect(record.lastReview?.unparsed).toBe(true);
    expect(record.lastReview?.issues).toEqual([]);
    expect(record.phases.some((p) => p.note?.includes("no structured verdict"))).toBe(true);
  });

  it("honors the caller's id — the runner never mints a phantom id (regression)", async () => {
    const { store, saved } = memoryStore();
    const runner = new MissionRunner({
      llm: makeLlm({ reviews: ['{"score": 80, "verdict": "accept", "issues": [], "suggestions": []}'] }),
      maxIterations: 2,
      store,
      id: "route-created-id",
    });
    const record = await runner.run("Goal");
    expect(record.id).toBe("route-created-id");
    // Every persisted phase write went out under the SAME id — a store consumer
    // keyed by the route's record id sees the full phase history.
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.every((r) => r.id === "route-created-id")).toBe(true);
    expect(saved.at(-1)?.status).toBe("completed");
    expect(saved.at(-1)?.phases.at(-1)?.phase).toBe("completed");
  });
});
