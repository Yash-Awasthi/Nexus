// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/council — streamed multi-round debate.
 *
 * The second shape a council runs in. `DeliberationEngine` asks each member for
 * one structured vote and aggregates; this asks each member for prose, shows
 * every member what the others said, and lets them revise. Both now live in
 * this package and share the archetype personas they are given and the
 * agreement scoring that ends them, so the two paths cannot drift into two
 * different councils again.
 *
 * Round 0 is independent and parallel. Each later round hands every member the
 * other members' latest answers and asks for a revised answer, with each member
 * keeping its own cumulative history — the protocol from
 * `@nexus/debate-engine`'s multi-agent debate.
 *
 * Transport is injected, as with `ILLMTransport`, so this package stays free of
 * provider drivers.
 */

import {
  AGREEMENT_THRESHOLD,
  FINAL_ANSWER_INSTRUCTION,
  answerSimilarity,
  extractFinalAnswer,
  judgeAgreement,
  overlapJudgement,
  statesFinal,
  type AgreementJudgement,
  type AgreementResult,
  type PositionGroup,
} from "./agreement.js";
import type { ILLMMessage } from "./engine.js";

/** Upper bound on debate depth, guarding resource use from caller-supplied values. */
export const MAX_DEBATE_ROUNDS = 4;

export interface DebateMember {
  /** Client-facing name; also the key this member's answers are tracked under. */
  label: string;
  provider: string;
  model: string;
  /** Persona from the archetype registry. Absent means no persona is applied. */
  systemPrompt?: string;
  /** Archetype name behind the persona, for clients that want to show it. */
  archetype?: string;
  temperature?: number;
}

export interface DebateStreamResult {
  text: string;
  usage?: { promptTokens: number; completionTokens: number };
}

/** Streams one member's turn, invoking `onDelta` per chunk. */
export interface IStreamingTransport {
  streamMember(
    member: DebateMember,
    messages: ILLMMessage[],
    onDelta: (text: string) => void,
  ): Promise<DebateStreamResult>;
}

export interface DebateEvents {
  /** A chunk of one member's answer. */
  onDelta: (member: DebateMember, text: string, debateRound: number) => void;
  /** One member's turn failed. The debate continues without it. */
  onMemberError: (member: DebateMember, error: unknown, debateRound: number) => void;
  /** Fired before each round after the first. */
  onRoundStart?: (debateRound: number, members: readonly DebateMember[]) => void;
  /** Token usage for one completed turn, for cost tracking. */
  onUsage?: (member: DebateMember, usage: DebateStreamResult["usage"]) => void;
}

export interface DebateOptions {
  message: string;
  members: readonly DebateMember[];
  /** Clamped to 1..MAX_DEBATE_ROUNDS. 1 means no debate, just parallel answers. */
  rounds?: number;
  /** Standing user instructions, prepended to every member's history. */
  systemPreamble?: string;
  /**
   * Ask for a final line every round and stop early once every member holds the same position,
   * or once a round changes nobody's position.
   */
  untilAgreed?: boolean;
  /** Members answer one after another within a round, each seeing the turns before it. */
  sequential?: boolean;
  /**
   * Ask a model which members agree (see judgeAgreement). Without one, or when
   * its reply cannot be read, agreement falls back to word overlap.
   */
  judge?: (prompt: string) => Promise<string>;
}

export interface DebateOutcome {
  /** Each member that produced an answer, with its last one. */
  finals: { label: string; text: string }[];
  /** The shared position, or null when the members did not converge. */
  agreement: AgreementResult | null;
  /** Every position the members took, largest first. */
  positions: PositionGroup[];
  /** Whether a model grouped the positions or word overlap did. */
  judgedBy: AgreementJudgement["method"];
  /** Rounds actually run, after clamping. */
  rounds: number;
}

/**
 * Refinement prompt for rounds >= 1: surfaces the other members' latest
 * answers. With no other answers available (a solo member, or every other
 * member failed) the member reviews its own prior answer, which is already in
 * its cumulative history.
 */
function debatePrompt(message: string, others: readonly string[]): string {
  if (others.length === 0) {
    return (
      "No other council members produced answers this round. Review your own " +
      "previous answer above; if new reasoning contradicts it, revise it, " +
      "otherwise restate and defend it. Provide your final answer to the " +
      `original question:\n\n${message}`
    );
  }
  const bodies = others.map((t) => `\n\n One agent solution: \`\`\`${t}\`\`\``).join("");
  return (
    `These are the solutions to the problem from other agents: ${bodies}\n\n` +
    `Using the solutions from other agents as additional information, can you provide your ` +
    `answer to the question? The original question is:\n\n${message}`
  );
}

export async function runCouncilDebate(
  transport: IStreamingTransport,
  options: DebateOptions,
  events: DebateEvents,
): Promise<DebateOutcome> {
  const { message, members, systemPreamble } = options;
  const rounds = Math.min(MAX_DEBATE_ROUNDS, Math.max(1, Math.round(options.rounds ?? 1)));

  const latest = new Map<string, string>();
  const histories = new Map<string, ILLMMessage[]>();

  /** One member's turn: stream it, record the text, keep its history. */
  const takeTurn = async (
    member: DebateMember,
    prompt: string,
    debateRound: number,
  ): Promise<void> => {
    let history = histories.get(member.label);
    if (!history) {
      history = [];
      if (member.systemPrompt) history.push({ role: "system", content: member.systemPrompt });
      if (systemPreamble) history.push({ role: "system", content: systemPreamble });
      histories.set(member.label, history);
    }
    history.push({ role: "user", content: prompt });

    let text = "";
    try {
      const res = await transport.streamMember(
        member,
        // A copy: the transport must not be able to mutate the member's history.
        [...history],
        (delta) => {
          text += delta;
          events.onDelta(member, delta, debateRound);
        },
      );
      // A transport that buffers rather than streams still returns the text.
      if (!text) text = res.text;
      events.onUsage?.(member, res.usage);
      latest.set(member.label, text);
      history.push({ role: "assistant", content: text });
    } catch (err) {
      events.onMemberError(member, err, debateRound);
      // Drop the unanswered prompt so the next round does not stack two user
      // turns in a row on a member whose turn failed.
      history.pop();
    }
  };

  const finalsOf = () =>
    [...latest.entries()]
      .map(([label, text]) => ({ label, text }))
      .filter((f) => f.text.trim().length > 0);
  const untilAgreed = options.untilAgreed === true;
  const sequential = options.sequential === true;
  /** One round: in parallel on a snapshot of the answers, or in order on the live ones. */
  const runRound = async (round: number, isLast: boolean) => {
    const seen = sequential ? latest : new Map(latest);
    const turn = (member: DebateMember) => {
      const others = members
        .filter((o) => o.label !== member.label)
        .map((o) => seen.get(o.label))
        .filter((t): t is string => !!t && t.length > 0);
      // The opening round asks the question itself; only a sequential turn has answers to show.
      const prompt = round === 0 && others.length === 0 ? message : debatePrompt(message, others);
      return takeTurn(member, isLast ? `${prompt}\n\n${FINAL_ANSWER_INSTRUCTION}` : prompt, round);
    };
    if (sequential) for (const member of members) await turn(member);
    else await Promise.allSettled(members.map(turn));
  };

  const positions = () => new Map(finalsOf().map((f) => [f.label, extractFinalAnswer(f.text)]));
  // Word overlap is only trusted on stated positions; two openings share too much phrasing.
  const allStated = () => finalsOf().every((f) => statesFinal(f.text));
  /** True when every member that answered both rounds kept its position. */
  const unmoved = (before: Map<string, string>, after: Map<string, string>) => {
    const both = [...after].filter(([label]) => before.has(label));
    return (
      both.length > 0 &&
      both.every(([label, now]) => answerSimilarity(before.get(label)!, now) >= AGREEMENT_THRESHOLD)
    );
  };

  let judged: { key: string; result: AgreementJudgement } | null = null;
  const judgeFinals = async (finals: { label: string; text: string }[]) => {
    const key = JSON.stringify(finals);
    if (judged?.key === key) return judged.result;
    let result = overlapJudgement(finals);
    if (options.judge) {
      try {
        result = await judgeAgreement(options.judge, message, finals);
      } catch {
        // An unreadable or failed judgement keeps the overlap grouping.
      }
    }
    judged = { key, result };
    return result;
  };

  await runRound(0, rounds === 1 || untilAgreed);
  let ran = 1;
  let before = positions();
  for (let round = 1; round < rounds; round += 1) {
    if (untilAgreed && allStated() && (await judgeFinals(finalsOf())).agreement?.agreement === 1)
      break;
    ran += 1;
    events.onRoundStart?.(round, members);
    await runRound(round, round === rounds - 1 || untilAgreed);
    const after = positions();
    if (untilAgreed && allStated() && unmoved(before, after)) break;
    before = after;
  }

  const finals = finalsOf();
  const { agreement, groups, method } = await judgeFinals(finals);
  return { finals, agreement, positions: groups, judgedBy: method, rounds: ran };
}
