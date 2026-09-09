// SPDX-License-Identifier: Apache-2.0
/**
 * Multi-agent debate — the parallel "answer, then revise from the others'
 * answers" protocol (Du et al., "Improving Factuality and Reasoning in
 * Language Models through Multiagent Debate", arXiv:2305.14325) for
 * @nexus/debate-engine.
 *
 * {@link DebateSession} runs a judge-scored supporter/opposer contest. This
 * module is the other canonical debate shape: N agents each answer the question
 * independently; from round 2 on, every agent is shown the other agents'
 * previous answers and re-answers, refining under peer pressure. No judge, no
 * winner — the value is in the convergence of the final answers (the paper
 * takes the majority answer).
 *
 * The transport is a plain function so the loop is deterministic to test and
 * provider-agnostic (OpenAI, local, mocked).
 *
 * The loop is normally a fixed round budget (paper default: 2). Passing
 * `convergence` turns it into an iterative-refinement loop with early
 * stopping: after `minRounds`, the detector (default: every agent's answer
 * stopped changing) is checked each round, and the debate ends as soon as the
 * answers are stable for `patience` consecutive rounds — the self-refine
 * reading of the paper's "the value is in the convergence of the final
 * answers", and the named remaining gap of the-ai-counsel's LLM-Advisors
 * mode (iterative rounds with convergence detection).
 */

export interface AgentMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface MultiAgentDebateOptions {
  /** The question the agents debate. */
  question: string;
  /** Agent names (paper default: 3 anonymous agents). */
  agents: readonly string[];
  /** Number of answer+revision rounds (paper default: 2). */
  rounds?: number;
  /** Optional shared system instruction (persona, style, output format). */
  systemPrompt?: string;
  /**
   * Instruction appended to every ask, e.g. "Your final answer should be a
   * single numerical number at the end of your response."
   */
  answerInstruction?: string;
  /**
   * Enable convergence detection + early stopping. When set, `rounds` becomes
   * the maximum budget: the loop stops as soon as the detector fires for
   * `patience` consecutive rounds instead of always exhausting the budget.
   * A bare `true` uses the defaults; omit the field for the exact legacy
   * fixed-round behaviour.
   */
  convergence?: ConvergenceOptions | boolean;
  /** Executes one model call; returns the assistant reply text. */
  transport: (req: {
    agent: string;
    round: number;
    messages: readonly AgentMessage[];
  }) => Promise<string>;
}

export interface AgentTranscript {
  agent: string;
  /** Full alternating user/assistant history for this agent. */
  history: AgentMessage[];
}

export interface MultiAgentDebateResult {
  question: string;
  /** The configured round budget (what `rounds` meant pre-convergence). */
  rounds: number;
  /** Rounds actually executed — less than `rounds` when convergence stopped it early. */
  roundsRun: number;
  /** True when the detector fired and stopped the loop before the budget. */
  converged: boolean;
  /** Per-agent transcripts, in question order. */
  transcripts: AgentTranscript[];
  /** Each agent's final answer (its last assistant message). */
  finalAnswers: { agent: string; answer: string }[];
}

/** Options controlling convergence detection and early stopping. */
export interface ConvergenceOptions {
  /**
   * Minimum completed rounds before stopping is allowed. Default 2 — the
   * initial answers plus one refinement, so the detector always has a prior
   * round to compare against.
   */
  minRounds?: number;
  /** How many consecutive converged rounds end the debate. Default 1. */
  patience?: number;
  /** Lexical-similarity threshold for the default detector. Default 0.9. */
  threshold?: number;
  /**
   * Custom convergence check: previous completed round's final answers vs the
   * round just completed (same agent order). Return true to count the round
   * as converged. Defaults to per-agent positional stability.
   */
  detector?: (prevAnswers: string[], currAnswers: string[]) => boolean;
}

/**
 * Word-set Jaccard similarity — the cheap, dependency-free lexical measure
 * behind the default convergence detector. Exact repeats score 1; answers that
 * share no words score 0.
 */
export function lexicalSimilarity(a: string, b: string): number {
  const words = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 0),
    );
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 && wb.size === 0) return 1;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  const union = wa.size + wb.size - inter;
  return union === 0 ? 1 : inter / union;
}

/**
 * True when every agent's answer from the two given rounds is at least
 * `threshold`-similar to its own previous answer (positions stopped moving).
 */
export function positionalStability(
  prevAnswers: string[],
  currAnswers: string[],
  threshold = 0.9,
): boolean {
  if (prevAnswers.length !== currAnswers.length || prevAnswers.length === 0) return false;
  return currAnswers.every((answer, i) => lexicalSimilarity(answer, prevAnswers[i]!) >= threshold);
}

/**
 * True when all of a single round's answers are mutually similar — consensus
 * rather than positional stability. Injectable as `detector` when the debate
 * should stop once the agents agree, regardless of how much they changed.
 */
export function answersAgree(answers: string[], threshold = 0.9): boolean {
  if (answers.length < 2) return true;
  for (let i = 0; i < answers.length; i++) {
    for (let j = i + 1; j < answers.length; j++) {
      if (lexicalSimilarity(answers[i]!, answers[j]!) < threshold) return false;
    }
  }
  return true;
}

/** Wrap the question as the paper's opening user message. */
function initialAsk(question: string, instruction: string): AgentMessage {
  return {
    role: "user",
    content: `Can you solve the following question?\n\n${question}\n\nExplain your reasoning. ${instruction}`,
  };
}

/** The paper's "solutions from other agents" message for one target agent. */
function othersMessage(
  question: string,
  instruction: string,
  others: readonly AgentMessage[],
): AgentMessage {
  const bodies = others.map((m) => `\n\n One agent solution: \`\`\`${m.content}\`\`\``).join("");
  return {
    role: "user",
    content:
      `These are the solutions to the problem from other agents: ${bodies}\n\n` +
      `Using the solutions from other agents as additional information, can you provide your ` +
      `answer to the question? The original question is:\n\n${question}\n\n${instruction}`,
  };
}

/**
 * Run the parallel multi-agent debate loop.
 *
 * Round 0: every agent answers independently. Rounds >= 1: each agent receives
 * the other agents' most recent answers and answers again; the context is
 * cumulative per agent (the paper's design — agents remember their own prior
 * answers while being influenced by the others').
 */
function resolveConvergence(
  convergence: ConvergenceOptions | boolean | undefined,
): ConvergenceOptions | undefined {
  if (convergence === undefined || convergence === false) return undefined;
  return convergence === true ? {} : convergence;
}

export async function runMultiAgentDebate(
  opts: MultiAgentDebateOptions,
): Promise<MultiAgentDebateResult> {
  const { question, agents, transport } = opts;
  const rounds = Math.max(1, opts.rounds ?? 2);
  const instruction =
    opts.answerInstruction ?? "Your final answer should appear at the end of your response.";
  const systemPrompt = opts.systemPrompt;
  const convergence = resolveConvergence(opts.convergence);
  const threshold = convergence?.threshold ?? 0.9;
  const minRounds = convergence?.minRounds ?? 2;
  const patience = convergence?.patience ?? 1;
  const detector =
    convergence?.detector ??
    ((prev: string[], curr: string[]) => positionalStability(prev, curr, threshold));

  const transcripts: AgentTranscript[] = agents.map((agent) => ({
    agent,
    history: [],
  }));
  let converged = false;
  let stabilityStreak = 0;
  let roundsRun = 0;
  let prevAnswers: string[] | undefined;

  for (let round = 0; round < rounds; round++) {
    for (let i = 0; i < agents.length; i++) {
      const transcript = transcripts[i]!;
      // Previous assistant answers of every OTHER agent (paper's construct_message).
      const others = transcripts
        .filter((_, j) => j !== i)
        .map((t) => t.history[t.history.length - 1]!)
        .filter((m) => m !== undefined);

      const next: AgentMessage =
        round === 0
          ? initialAsk(question, instruction)
          : othersMessage(question, instruction, others);

      // The shared system prompt leads every call; the persisted per-agent
      // history stays user/assistant only, mirroring the paper's message list.
      const reply = await transport({
        agent: agents[i]!,
        round,
        messages: [
          ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
          ...transcript.history,
          next,
        ],
      });

      transcript.history.push(next);
      transcript.history.push({ role: "assistant", content: reply });
    }

    roundsRun = round + 1;

    if (convergence && prevAnswers !== undefined && roundsRun >= minRounds) {
      const currAnswers = transcripts.map((t) => t.history[t.history.length - 1]!.content);
      if (detector(prevAnswers, currAnswers)) {
        stabilityStreak++;
        if (stabilityStreak >= patience) {
          converged = true;
          break;
        }
      } else {
        stabilityStreak = 0;
      }
    }
    prevAnswers = transcripts.map((t) => t.history[t.history.length - 1]!.content);
  }

  return {
    question,
    rounds,
    roundsRun,
    converged,
    transcripts,
    finalAnswers: transcripts.map((t) => ({
      agent: t.agent,
      answer: t.history[t.history.length - 1]!.content,
    })),
  };
}

/**
 * The paper's aggregation: the majority final answer. Exact-string match on the
 * final answers; ties and non-majorities fall back to the first agent's answer.
 */
export function majorityFinalAnswer(result: MultiAgentDebateResult): {
  answer: string;
  count: number;
} {
  const counts = new Map<string, number>();
  for (const fa of result.finalAnswers) {
    counts.set(fa.answer, (counts.get(fa.answer) ?? 0) + 1);
  }
  let best = result.finalAnswers[0]!.answer;
  let bestCount = 0;
  for (const [answer, count] of counts) {
    if (count > bestCount) {
      best = answer;
      bestCount = count;
    }
  }
  return { answer: best, count: bestCount };
}
