// SPDX-License-Identifier: Apache-2.0
// Conversational group chat (AutoGen AgentChat parity) — focused tests for the
// GroupChat module in @nexus/agent-runtime.
import { describe, expect, it } from "vitest";
import {
  GroupChat,
  GroupChatError,
  roundRobinPicker,
  llmSpeakerPicker,
  type ConversableAgent,
  type LlmToolFn,
} from "../src/index.js";

// ── Scripted LLM ─────────────────────────────────────────────────────────────

const AGENTS: ConversableAgent[] = [
  { name: "Alice", systemPrompt: "You are Alice. You answer first." },
  { name: "Bob", systemPrompt: "You are Bob. You push back." },
  { name: "Carol", systemPrompt: "You are Carol. You synthesise." },
];

interface Scripted {
  llm: LlmToolFn;
  /** Per-call systemPrompt seen by the LLM. */
  personas: string[];
  remaining(): number;
}

function scripted(...replies: string[]): Scripted {
  const personas: string[] = [];
  let i = 0;
  const llm: LlmToolFn = async (_messages, opts) => {
    personas.push(opts?.systemPrompt ?? "");
    const content = replies[i] ?? "";
    i += 1;
    return { content, toolCalls: [] };
  };
  return { llm, personas, remaining: () => replies.length - i };
}

// ── Config validation ────────────────────────────────────────────────────────

describe("GroupChat validation", () => {
  it("rejects empty rosters and duplicate names", () => {
    expect(() => new GroupChat({ agents: [], llm: scripted().llm })).toThrow(/at least one agent/);
    expect(
      () =>
        new GroupChat({
          agents: [AGENTS[0]!, { name: "Alice", systemPrompt: "dup" }],
          llm: scripted().llm,
        }),
    ).toThrow(/duplicate agent name "Alice"/);
  });
});

// ── Round robin ──────────────────────────────────────────────────────────────

describe("GroupChat round-robin", () => {
  it("cycles speakers in configured order and gives each its persona", async () => {
    const s = scripted("hi", "no", "combine", "bye");
    const gc = new GroupChat({ agents: AGENTS, llm: s.llm, maxRounds: 4 });
    const result = await gc.chat("Should we ship?");

    expect(result.transcript.map((m) => m.speaker)).toEqual(["Alice", "Bob", "Carol", "Alice"]);
    expect(result.turns).toBe(4);
    expect(s.personas).toEqual([
      "You are Alice. You answer first.",
      "You are Bob. You push back.",
      "You are Carol. You synthesise.",
      "You are Alice. You answer first.",
    ]);
    expect(s.remaining()).toBe(0);
  });

  it("labels each assistant message with its speaker in the transcript feed", async () => {
    const seen: string[] = [];
    const llm: LlmToolFn = async (messages) => {
      const feed = messages
        .filter((m) => m.role === "assistant")
        .map((m) => m.content)
        .join(" | ");
      seen.push(feed);
      return { content: "reply", toolCalls: [] };
    };
    const gc = new GroupChat({ agents: AGENTS.slice(0, 2), llm, maxRounds: 3 });
    const result = await gc.chat("Q?");
    expect(result.turns).toBe(3);
    // Speaker 1 sees no prior assistant feed; speaker 2 sees Alice's labelled
    // message; speaker 3 sees the whole labelled conversation so far.
    expect(seen[0]).toBe("");
    expect(seen[1]).toBe("Alice: reply");
    expect(seen[2]).toContain("Alice: reply");
    expect(seen[2]).toContain("Bob: reply");
  });

  it("ends on TERMINATE, strips the marker, and reports endedBy", async () => {
    const s = scripted("one", "two TERMINATE", "never");
    const gc = new GroupChat({ agents: AGENTS, llm: s.llm });
    const result = await gc.chat("Q?");
    expect(result.endedBy).toBe("terminate");
    expect(result.turns).toBe(2);
    expect(result.transcript).toHaveLength(2);
    expect(result.transcript[1]!.content).toBe("two");
    expect(result.transcript.some((m) => m.content.includes("TERMINATE"))).toBe(false);
    expect(s.remaining()).toBe(1); // third reply never consumed
  });

  it("caps at maxRounds when nobody terminates", async () => {
    const s = scripted("a", "b", "a", "b", "a");
    const gc = new GroupChat({ agents: AGENTS.slice(0, 2), llm: s.llm, maxRounds: 5 });
    const result = await gc.chat("Q?");
    expect(result.endedBy).toBe("max_rounds");
    expect(result.turns).toBe(5);
  });
});

// ── Custom + auto speaker selection ──────────────────────────────────────────

describe("GroupChat speaker selection", () => {
  it("honours an injected picker (always Carol)", async () => {
    const s = scripted("c1", "c2");
    const gc = new GroupChat({
      agents: AGENTS,
      llm: s.llm,
      maxRounds: 2,
      speakerSelection: () => "Carol",
    });
    const result = await gc.chat("Q?");
    expect(result.transcript.map((m) => m.speaker)).toEqual(["Carol", "Carol"]);
  });

  it("exposes the running transcript to the picker", async () => {
    let sawTranscript = false;
    const gc = new GroupChat({
      agents: AGENTS.slice(0, 2),
      llm: scripted("a1", "b1", "a2").llm,
      speakerSelection: (ctx) => {
        if (ctx.transcript.length === 1) sawTranscript = ctx.transcript[0]!.speaker === "Alice";
        return ctx.transcript.length % 2 === 0 ? "Alice" : "Bob";
      },
    });
    await gc.chat("Q?");
    expect(sawTranscript).toBe(true);
  });

  it("auto uses the LLM picker and the picked speaker then talks", async () => {
    // Turn 1 pick → Alice; turn 2 speak → Alice; turn 3 pick → Carol; turn 4 speak → Carol.
    const s = scripted("Alice", "alice says hi", "Carol", "carol replies");
    const gc = new GroupChat({
      agents: AGENTS,
      llm: s.llm,
      maxRounds: 2,
      speakerSelection: "auto",
    });
    const result = await gc.chat("Q?");
    expect(result.transcript.map((m) => m.speaker)).toEqual(["Alice", "Carol"]);
    expect(result.transcript[0]!.content).toBe("alice says hi");
    expect(s.remaining()).toBe(0);
  });

  it("auto picker tolerates quoting and case in the model's reply", async () => {
    const picker = llmSpeakerPicker(scripted('"bob"').llm);
    const pick = await picker({ question: "Q", agents: AGENTS.slice(0, 2), transcript: [] });
    expect(pick.toLowerCase()).toBe("bob");
  });

  it("stops cleanly when a custom picker names an unknown agent", async () => {
    const s = scripted("a");
    const gc = new GroupChat({
      agents: AGENTS.slice(0, 2),
      llm: s.llm,
      speakerSelection: () => "Ghost",
    });
    const result = await gc.chat("Q?");
    expect(result.endedBy).toBe("max_speakers_exhausted");
    expect(result.turns).toBe(0);
  });
});

// roundRobinPicker is exported for reuse — exercised through GroupChat above.
describe("roundRobinPicker", () => {
  it("cycles through the roster independently of a chat instance", () => {
    const picker = roundRobinPicker({ i: 0 });
    const ctx = { question: "Q", agents: AGENTS.slice(0, 2), transcript: [] };
    expect(picker(ctx)).toBe("Alice");
    expect(picker(ctx)).toBe("Bob");
    expect(picker(ctx)).toBe("Alice");
  });
});
