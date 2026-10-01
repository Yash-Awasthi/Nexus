// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
  majorityFinalAnswer,
  runMultiAgentDebate,
  type AgentMessage,
  type MultiAgentDebateResult,
} from "./multiagent-debate.js";

/** Echo transport: answer with the agent's own number plus prior answers seen. */
function echoTransport(seen: { agent: string; round: number; sawOthers: string[] }[] = []): {
  transport: (req: {
    agent: string;
    round: number;
    messages: readonly AgentMessage[];
  }) => Promise<string>;
  seen: typeof seen;
} {
  return {
    transport: async ({ agent, round, messages }) => {
      // The paper embeds the OTHER agents' solutions inside user messages
      // ("One agent solution: ```...```") — parse those references.
      const userText = messages
        .filter((m) => m.role === "user")
        .map((m) => m.content)
        .join("\n");
      const refs = [...userText.matchAll(/```([a-z]+)\|answer-r\d+```/g)].map((m) => m[1]!);
      seen.push({
        agent,
        round,
        sawOthers: refs.filter((a) => a !== agent),
      });
      return `${agent}|answer-r${round}`;
    },
    seen,
  };
}

describe("runMultiAgentDebate", () => {
  it("round 0 answers independently, later rounds include other agents' answers", async () => {
    const { transport, seen } = echoTransport();
    const result = await runMultiAgentDebate({
      question: "What is 17 * 23?",
      agents: ["alice", "bob", "carol"],
      rounds: 2,
      transport,
    });

    expect(result.transcripts).toHaveLength(3);
    expect(result.finalAnswers.map((f) => f.agent)).toEqual(["alice", "bob", "carol"]);
    expect(result.finalAnswers.map((f) => f.answer)).toEqual([
      "alice|answer-r1",
      "bob|answer-r1",
      "carol|answer-r1",
    ]);

    // Round 0: nobody saw anyone else's answer yet.
    const round0 = seen.filter((s) => s.round === 0);
    expect(round0).toHaveLength(3);
    for (const s of round0) expect(s.sawOthers).toEqual([]);

    // Round 1: agents see the others' freshest answers, never their own.
    const round1 = seen.filter((s) => s.round === 1);
    expect(round1).toHaveLength(3);
    for (const s of round1) {
      expect(s.sawOthers).toHaveLength(2);
      expect(s.sawOthers).not.toContain(s.agent);
      expect(s.sawOthers).toEqual(
        expect.arrayContaining(["alice", "bob", "carol"].filter((a) => a !== s.agent)),
      );
    }
  });

  it("cumulative history: transcripts alternate user/assistant per round", async () => {
    const { transport } = echoTransport();
    const result = await runMultiAgentDebate({
      question: "q",
      agents: ["a", "b"],
      rounds: 2,
      transport,
    });
    const a = result.transcripts[0]!;
    expect(a.history.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    // First user message contains the question; second contains others' answer.
    expect(a.history[0]!.content).toContain("q");
    expect(a.history[2]!.content).toContain("One agent solution");
  });
});

describe("majorityFinalAnswer", () => {
  const base: MultiAgentDebateResult = {
    question: "q",
    rounds: 1,
    roundsRun: 1,
    converged: false,
    transcripts: [],
    finalAnswers: [
      { agent: "a", answer: "42" },
      { agent: "b", answer: "42" },
      { agent: "c", answer: "7" },
    ],
  };

  it("returns the majority answer", () => {
    const m = majorityFinalAnswer(base);
    expect(m.answer).toBe("42");
    expect(m.count).toBe(2);
  });

  it("falls back to the first answer when there is no majority", () => {
    const m = majorityFinalAnswer({
      ...base,
      finalAnswers: [
        { agent: "a", answer: "1" },
        { agent: "b", answer: "2" },
        { agent: "c", answer: "3" },
      ],
    });
    expect(m.answer).toBe("1");
    expect(m.count).toBe(1);
  });
});
