// SPDX-License-Identifier: Apache-2.0
/**
 * Stage D2 — the streamed debate lives in the council package, applies the
 * personas it is given, and ends with an honest agreement result.
 */
import { describe, it, expect } from "vitest";

import type { ILLMMessage } from "./engine.js";
import {
  runCouncilDebate,
  type DebateMember,
  type IStreamingTransport,
  type DebateEvents,
} from "./debate.js";

interface Turn {
  label: string;
  messages: ILLMMessage[];
  temperature: number | undefined;
}

/** Transport that replies with whatever the script says for that member. */
function scriptedTransport(replies: Record<string, string[]>, turns: Turn[]): IStreamingTransport {
  const seen: Record<string, number> = {};
  return {
    async streamMember(member, messages, onDelta) {
      turns.push({ label: member.label, messages, temperature: member.temperature });
      const index = seen[member.label] ?? 0;
      seen[member.label] = index + 1;
      const script = replies[member.label] ?? [];
      const text = script[Math.min(index, script.length - 1)] ?? "";
      for (const chunk of text.split(" ")) onDelta(`${chunk} `);
      return { text, usage: { promptTokens: 1, completionTokens: 1 } };
    },
  };
}

function collector(): DebateEvents & { deltas: string[]; errors: unknown[] } {
  const deltas: string[] = [];
  const errors: unknown[] = [];
  return {
    deltas,
    errors,
    onDelta: (_m, text) => deltas.push(text),
    onMemberError: (_m, err) => errors.push(err),
  };
}

const MEMBERS: DebateMember[] = [
  { label: "Alpha", provider: "p", model: "m1", systemPrompt: "You are The Auditor." },
  {
    label: "Beta",
    provider: "p",
    model: "m2",
    systemPrompt: "You are The Futurist.",
    temperature: 0.2,
  },
];

describe("runCouncilDebate", () => {
  it("gives each member its own persona and temperature", async () => {
    const turns: Turn[] = [];
    const events = collector();
    await runCouncilDebate(
      scriptedTransport({ Alpha: ["FINAL: yes"], Beta: ["FINAL: no"] }, turns),
      { message: "Should we?", members: MEMBERS, rounds: 1 },
      events,
    );

    const alpha = turns.find((t) => t.label === "Alpha");
    const beta = turns.find((t) => t.label === "Beta");
    expect(alpha?.messages[0]).toEqual({ role: "system", content: "You are The Auditor." });
    expect(beta?.messages[0]).toEqual({ role: "system", content: "You are The Futurist." });
    expect(alpha?.temperature).toBeUndefined();
    expect(beta?.temperature).toBe(0.2);
  });

  it("shows each member the others' answers in the second round", async () => {
    const turns: Turn[] = [];
    await runCouncilDebate(
      scriptedTransport(
        { Alpha: ["Alpha opening", "FINAL: ship it"], Beta: ["Beta opening", "FINAL: ship it"] },
        turns,
      ),
      { message: "Should we?", members: MEMBERS, rounds: 2 },
      collector(),
    );

    const alphaSecond = turns.filter((t) => t.label === "Alpha")[1];
    const lastUser = alphaSecond?.messages.at(-1)?.content ?? "";
    expect(lastUser).toContain("Beta opening");
    expect(lastUser).not.toContain("Alpha opening");
  });

  it("reports agreement when members converge on one position", async () => {
    const outcome = await runCouncilDebate(
      scriptedTransport(
        {
          Alpha: ["a", "FINAL: Ship it behind a feature flag."],
          Beta: ["b", "FINAL: Ship behind a feature flag."],
        },
        [],
      ),
      { message: "Should we?", members: MEMBERS, rounds: 2 },
      collector(),
    );

    expect(outcome.agreement?.agreeing.sort()).toEqual(["Alpha", "Beta"]);
    expect(outcome.agreement?.agreement).toBe(1);
  });

  it("reports no agreement when they do not converge", async () => {
    const outcome = await runCouncilDebate(
      scriptedTransport(
        {
          Alpha: ["a", "FINAL: Ship it today."],
          Beta: ["b", "FINAL: Cancel the project and refund customers."],
        },
        [],
      ),
      { message: "Should we?", members: MEMBERS, rounds: 2 },
      collector(),
    );

    expect(outcome.agreement).toBeNull();
    expect(outcome.finals).toHaveLength(2);
  });

  it("continues the debate when one member fails, and excludes it from the finals", async () => {
    const events = collector();
    const failing: IStreamingTransport = {
      async streamMember(member, _messages, onDelta) {
        if (member.label === "Beta") throw new Error("provider exploded");
        onDelta("FINAL: ship it");
        return { text: "FINAL: ship it" };
      },
    };

    const outcome = await runCouncilDebate(
      failing,
      { message: "Should we?", members: MEMBERS, rounds: 2 },
      events,
    );

    expect(events.errors).toHaveLength(2); // one per round
    expect(outcome.finals.map((f) => f.label)).toEqual(["Alpha"]);
    expect(outcome.agreement).toBeNull();
  });

  it("stops early when nobody changes their answer, agreed or not", async () => {
    const turns: Turn[] = [];
    const outcome = await runCouncilDebate(
      scriptedTransport(
        {
          Alpha: ["FINAL: Ship it today.", "FINAL: Ship it today."],
          Beta: ["FINAL: Cancel the project.", "FINAL: Cancel the project."],
        },
        turns,
      ),
      { message: "Should we?", members: MEMBERS, rounds: 4, untilAgreed: true },
      collector(),
    );

    expect(outcome.rounds).toBe(2);
    expect(turns).toHaveLength(4);
    expect(outcome.agreement).toBeNull();
  });

  it("clamps the round count", async () => {
    const outcome = await runCouncilDebate(
      scriptedTransport({ Alpha: ["x"], Beta: ["y"] }, []),
      { message: "m", members: MEMBERS, rounds: 99 },
      collector(),
    );
    expect(outcome.rounds).toBe(4);
  });

  it("takes turns in order when sequential, each member seeing the turns before it", async () => {
    const turns: Turn[] = [];
    const three: DebateMember[] = [...MEMBERS, { label: "Gamma", provider: "p", model: "m3" }];
    await runCouncilDebate(
      scriptedTransport(
        { Alpha: ["alpha one", "alpha two"], Beta: ["beta one", "beta two"], Gamma: ["gamma one"] },
        turns,
      ),
      { message: "Pick one", members: three, rounds: 2, sequential: true },
      collector(),
    );
    const lastUser = (t: Turn) => t.messages.filter((m) => m.role === "user").at(-1)!.content;
    expect(turns.map((t) => t.label)).toEqual(["Alpha", "Beta", "Gamma", "Alpha", "Beta", "Gamma"]);
    expect(lastUser(turns[0]!)).not.toContain("alpha");
    expect(lastUser(turns[1]!)).toContain("alpha one");
    expect(lastUser(turns[2]!)).toContain("beta one");
    // In round two Beta already sees Alpha's second turn, not its first.
    expect(lastUser(turns[4]!)).toContain("alpha two");
    expect(lastUser(turns[4]!)).not.toContain("alpha one");
  });
});

describe("runCouncilDebate early stop", () => {
  it("does not stop on openings that only share phrasing", async () => {
    const turns: Turn[] = [];
    const outcome = await runCouncilDebate(
      scriptedTransport(
        {
          Alpha: ["Opening take from Alpha, long enough.", "FINAL: Use Postgres."],
          Beta: ["Opening take from Beta, long enough.", "FINAL: Use SQLite."],
        },
        turns,
      ),
      { message: "Which database?", members: MEMBERS, rounds: 2, untilAgreed: true },
      collector(),
    );
    expect(outcome.rounds).toBe(2);
  });
});
