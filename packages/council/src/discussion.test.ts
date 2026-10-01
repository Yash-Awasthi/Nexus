// SPDX-License-Identifier: Apache-2.0
/**
 * Discussion mode: participants on independent clocks, a ledger they read by
 * watermark, a supervisor that only keeps the record, and caps that are part of
 * the loop condition rather than a hope.
 */
import { describe, it, expect } from "vitest";

import type { DebateMember, IStreamingTransport } from "./debate.js";
import { runDiscussion, SUPERVISOR_PROMPT, type DiscussionOptions } from "./discussion.js";
import type { ILLMMessage } from "./engine.js";

interface Script {
  /** Latency of this member's turn, in milliseconds. */
  delay?: number;
  /** One entry per turn; the last entry repeats once exhausted. */
  replies?: string[];
  fail?: boolean;
  usage?: { promptTokens: number; completionTokens: number };
}

interface Turn {
  member: string;
  messages: ILLMMessage[];
}

function stub(scripts: Record<string, Script>): { transport: IStreamingTransport; turns: Turn[] } {
  const turns: Turn[] = [];
  const transport: IStreamingTransport = {
    async streamMember(member, messages, onDelta) {
      const script = scripts[member.label] ?? {};
      const seen = turns.filter((t) => t.member === member.label).length;
      turns.push({ member: member.label, messages });
      await new Promise((r) => setTimeout(r, script.delay ?? 0));
      if (script.fail) throw new Error(`${member.label} is unreachable`);
      const replies = script.replies ?? [`${member.label} says something.`];
      const text = replies[Math.min(seen, replies.length - 1)] ?? "";
      onDelta(text);
      return { text, ...(script.usage ? { usage: script.usage } : {}) };
    },
  };
  return { transport, turns };
}

const SUPERVISOR: DebateMember = { label: "Recorder", provider: "openai", model: "sup" };

function member(label: string, systemPrompt?: string): DebateMember {
  return { label, provider: "openai", model: label, ...(systemPrompt ? { systemPrompt } : {}) };
}

function options(overrides: Partial<DiscussionOptions> = {}): DiscussionOptions {
  return {
    topic: "Should the cache be invalidated on write?",
    participants: [member("Fast"), member("Slow")],
    supervisor: SUPERVISOR,
    settlePauseMs: 2,
    maxContributions: 8,
    maxWallMs: 10_000,
    ...overrides,
  };
}

describe("runDiscussion — participants on their own clock", () => {
  it("lets a fast participant contribute repeatedly while a slow one is still thinking", async () => {
    const { transport, turns } = stub({
      Fast: { delay: 1 },
      Slow: { delay: 60 },
      Recorder: { replies: ["Positions: two.\n\nSTATUS: CONTINUE"] },
    });

    const outcome = await runDiscussion(transport, options({ maxContributions: 10 }));

    const fast = turns.filter((t) => t.member === "Fast").length;
    const slow = turns.filter((t) => t.member === "Slow").length;
    expect(fast).toBeGreaterThan(slow);
    expect(slow).toBeGreaterThan(0);
    expect(outcome.reason).toBe("contribution-cap");
  });

  it("shows a participant the others' entries since its watermark and not its own", async () => {
    const { transport, turns } = stub({
      Fast: { delay: 1, replies: ["Fast opening.", "Fast follow-up."] },
      Slow: { delay: 1, replies: ["Slow opening."] },
      Recorder: { replies: ["Positions: recorded.\n\nSTATUS: CONTINUE"] },
    });

    await runDiscussion(transport, options({ maxContributions: 6 }));

    const fastTurns = turns.filter((t) => t.member === "Fast");
    const later = fastTurns.slice(1).map((t) => String(t.messages.at(-1)?.content ?? ""));
    expect(later.some((p) => p.includes("Slow opening."))).toBe(true);
    expect(later.every((p) => !p.includes("Fast opening."))).toBe(true);
  });
});

describe("runDiscussion — the ledger", () => {
  it("numbers every entry monotonically and renders as a standalone document", async () => {
    const { transport } = stub({
      Fast: { delay: 1, replies: ["Invalidate on write."] },
      Slow: { delay: 1, replies: ["Invalidate on read instead."] },
      Recorder: { replies: ["Positions: two, unresolved.\n\nSTATUS: SETTLED"] },
    });

    const outcome = await runDiscussion(transport, options());

    expect(outcome.entries.map((e) => e.line)).toEqual(outcome.entries.map((_e, i) => i + 1));
    expect(outcome.entries.every((e) => Date.parse(e.at) > 0)).toBe(true);
    expect(outcome.markdown).toContain("Should the cache be invalidated on write?");
    expect(outcome.markdown).toContain("Invalidate on write.");
    expect(outcome.markdown).toContain("Recorder");
  });

  it("keeps a failing participant's silence out of the ledger and carries on", async () => {
    const { transport } = stub({
      Fast: { delay: 1, replies: ["Only voice here."] },
      Slow: { fail: true },
      Recorder: { replies: ["Positions: one.\n\nSTATUS: CONTINUE"] },
    });

    const errors: string[] = [];
    const outcome = await runDiscussion(transport, options({ maxContributions: 4 }), {
      onError: (m) => errors.push(m.label),
    });

    expect(errors).toContain("Slow");
    expect(outcome.entries.some((e) => e.author === "Slow")).toBe(false);
    expect(outcome.entries.some((e) => e.author === "Fast")).toBe(true);
  });

  it("does not spend contribution slots on failed turns", async () => {
    const { transport } = stub({
      Fast: { delay: 5 },
      Slow: { fail: true },
      Recorder: { replies: ["Positions: one.\n\nSTATUS: CONTINUE"] },
    });

    const outcome = await runDiscussion(transport, options({ maxContributions: 4 }));

    expect(outcome.entries.filter((e) => e.kind === "contribution")).toHaveLength(4);
    expect(outcome.contributions).toBe(4);
  });

  it("ends at once when every participant keeps failing", async () => {
    const { transport, turns } = stub({ Fast: { fail: true }, Slow: { fail: true } });

    const started = Date.now();
    const outcome = await runDiscussion(
      transport,
      options({ maxContributions: 12, maxWallMs: 5_000 }),
    );

    expect(outcome.reason).toBe("participants-failed");
    expect(outcome.contributions).toBe(0);
    expect(turns.length).toBeLessThan(12);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("runDiscussion — the supervisor", () => {
  it("ends the discussion when it judges a result reached, and stores the record without the control line", async () => {
    const { transport, turns } = stub({
      Fast: { delay: 1 },
      Slow: { delay: 1 },
      Recorder: { replies: ["Settled: invalidate on write.\n\nSTATUS: SETTLED"] },
    });

    const outcome = await runDiscussion(transport, options({ maxContributions: 50 }));

    expect(outcome.settled).toBe(true);
    expect(outcome.reason).toBe("settled");
    expect(outcome.digest).toBe("Settled: invalidate on write.");
    expect(outcome.digest).not.toContain("STATUS");
    expect(outcome.contributions).toBeLessThan(50);

    // It is briefed to keep the record, not to answer the question.
    const brief = turns.find((t) => t.member === "Recorder")?.messages[0]?.content ?? "";
    expect(brief).toBe(SUPERVISOR_PROMPT);
    expect(brief).toContain("You have no opinion");
    expect(brief).toContain("Never answer the question");
  });

  it("folds the contributions that landed after its last read before returning", async () => {
    const { transport } = stub({
      Fast: { delay: 1, replies: ["Tail contribution."] },
      Recorder: {
        replies: ["Positions: one.\n\nSTATUS: CONTINUE", "Final record.\n\nSTATUS: CONTINUE"],
      },
    });

    const outcome = await runDiscussion(
      transport,
      options({ participants: [member("Fast")], maxContributions: 3 }),
    );

    expect(outcome.entries.at(-1)?.kind).toBe("digest");
    expect(outcome.digest).toBe("Final record.");
  });
});

describe("runDiscussion — caps", () => {
  it("holds the cap with more participants than free slots", async () => {
    const { transport, turns } = stub({
      A: { delay: 1 },
      B: { delay: 1 },
      C: { delay: 1 },
      D: { delay: 1 },
      Recorder: { replies: ["Positions: four.\n\nSTATUS: CONTINUE"] },
    });

    const outcome = await runDiscussion(
      transport,
      options({
        participants: [member("A"), member("B"), member("C"), member("D")],
        maxContributions: 5,
      }),
    );

    // Four loops against five slots: the cap is a total, not a per-participant
    // budget, so the fourth participant's second turn never starts.
    expect(outcome.contributions).toBe(5);
    expect(turns.filter((t) => t.member !== "Recorder")).toHaveLength(5);
  });

  it("stops at the contribution cap", async () => {
    const { transport } = stub({
      Fast: { delay: 1 },
      Slow: { delay: 1 },
      Recorder: { replies: ["Positions: two.\n\nSTATUS: CONTINUE"] },
    });

    const outcome = await runDiscussion(transport, options({ maxContributions: 4 }));

    expect(outcome.reason).toBe("contribution-cap");
    expect(outcome.contributions).toBe(4);
  });

  it("stops at the wall-time cap", async () => {
    const { transport } = stub({
      Fast: { delay: 20 },
      Slow: { delay: 20 },
      Recorder: { replies: ["Positions: two.\n\nSTATUS: CONTINUE"] },
    });

    const outcome = await runDiscussion(
      transport,
      options({ maxContributions: 1_000, maxWallMs: 60 }),
    );

    expect(outcome.reason).toBe("time-cap");
    expect(outcome.contributions).toBeLessThan(1_000);
  });

  it("stops at the token cap", async () => {
    const usage = { promptTokens: 40, completionTokens: 60 };
    const { transport } = stub({
      Fast: { delay: 1, usage },
      Slow: { delay: 1, usage },
      Recorder: { replies: ["Positions: two.\n\nSTATUS: CONTINUE"], usage },
    });

    const outcome = await runDiscussion(
      transport,
      options({ maxContributions: 1_000, maxTotalTokens: 300 }),
    );

    expect(outcome.reason).toBe("token-cap");
    expect(outcome.totalTokens).toBeGreaterThanOrEqual(300);
  });
});
