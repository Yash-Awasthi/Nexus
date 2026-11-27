// SPDX-License-Identifier: Apache-2.0
/**
 * The council runner: golden prompts in, per-mode and per-archetype numbers out.
 *
 * What this measures, and what it does not.
 *
 * The transport here is scripted, not a model. It answers from the golden prompt's `mustMention` facts with
 * a controllable amount of coverage, concession and action, which makes every number reproducible on any
 * machine with no key and no spend. That means the tables this produces measure the *machinery* — the vote
 * tally, the mode's rounds, the cost arithmetic, the regression gate — and not the quality of any model.
 * The pipeline is the same one a live run uses (`DeliberationEngine.deliberate` with an injected
 * `ILLMTransport` and a resolved member list), so pointing it at a real provider replaces one function and
 * leaves the report intact. The generated document says this in its first paragraph, because a win-rate
 * table that hides its driver is a lie with good formatting.
 */

import type { ModelVote, ProposalInput } from "@nexus/contracts";

import { ARCHETYPES, summonArchetypes, type Archetype } from "../archetypes.ts";
import { DeliberationEngine, type ILLMTransport, type ILLMMessage } from "../engine.ts";

import { GOLDEN_PROMPTS, type GoldenPrompt } from "./golden.ts";
import { scoreAnswer, type AnswerScore } from "./judge.ts";
import {
  verdictCost,
  voteAgreement,
  wilson,
  type ModelPrice,
  type VerdictCost,
  type VoteAgreement,
} from "./metrics.ts";

/** Archtype ids carry this prefix as their model, so a vote can be traced back to the member who cast it. */
const MEMBER_PREFIX = "scripted/";

// ── Modes ─────────────────────────────────────────────────────────────────────

export type ReasoningMode = "standard" | "red_blue" | "socratic";

export interface ModeSpec {
  id: ReasoningMode;
  label: string;
  /** Rounds of voting. Round 2 and later see the previous tally, which is what makes them converge. */
  rounds: number;
  councilSize: number;
  /** How much a later round pulls a member towards the running majority (0–1). */
  pull: number;
  aggregation: "majority" | "unanimous" | "weighted";
  description: string;
}

export const MODES: ModeSpec[] = [
  {
    id: "standard",
    label: "Standard",
    rounds: 1,
    councilSize: 5,
    pull: 0,
    aggregation: "majority",
    description: "One round, five independent votes, 60% of decided votes approves.",
  },
  {
    id: "red_blue",
    label: "Red / blue",
    rounds: 2,
    councilSize: 5,
    pull: 0.35,
    aggregation: "majority",
    description: "Two rounds: the council re-votes after seeing the split, so positions sharpen.",
  },
  {
    id: "socratic",
    label: "Socratic",
    rounds: 3,
    councilSize: 5,
    pull: 0.2,
    aggregation: "majority",
    description:
      "Three rounds of cross-examination; the most expensive and the least likely to deadlock.",
  },
];

/** Published price used for the cost column. One model, so the arithmetic is checkable by hand. */
export const MODEL_PRICE: ModelPrice = { inputPerMillionUsd: 0.59, outputPerMillionUsd: 0.79 };
export const MODEL_ID = "llama-3.3-70b-versatile";

// ── Scripted transport ────────────────────────────────────────────────────────

function hash01(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 100_000) / 100_000;
}

export interface ScriptedOptions {
  /** 0 = fluent and empty, 1 = uses every fact and names a cost. */
  quality: number;
  /** Per-archetype quality offset, so a win-rate table is not uniform by construction. */
  archetypeQuality?: Record<string, number>;
  latencyMs?: number;
}

const ARCHETYPE_OFFSET: Record<string, number> = {
  architect: 0.05,
  empiricist: 0.1,
  pragmatist: 0.06,
  contrarian: -0.02,
  ethicist: 0.02,
  futurist: -0.06,
  historian: -0.04,
  empath: -0.03,
  outsider: -0.08,
  strategist: 0.04,
  minimalist: -0.01,
  creator: 0,
  judge: 0.08,
  devils_advocate: -0.05,
};

function promptFor(prompt: string): GoldenPrompt | undefined {
  return GOLDEN_PROMPTS.find((candidate) => prompt.includes(`PROPOSAL: ${candidate.proposal}`));
}

export function archetypeOf(system: string): string {
  const match = /You are The ([A-Za-z /'-]+)\./i.exec(system);
  return match?.[1] ? match[1].toLowerCase().replace(/[^a-z]+/g, "_") : "unknown";
}

/** Compose a verdict with a chosen amount of substance, deterministically. */
export function composeVerdict(
  prompt: GoldenPrompt,
  strength: number,
  archetype = "council",
): string {
  // A weak answer does not name half the facts, it names none of them and says the system will be fine:
  // that is what a generic model actually writes. Coverage therefore ramps from nothing after 0.5 rather
  // than from "two of four facts", which no real low-quality answer ever lands on.
  const covered =
    strength <= 0.5
      ? 0
      : Math.min(
          prompt.mustMention.length,
          1 + Math.round((strength - 0.5) * 2 * (prompt.mustMention.length - 1)),
        );
  const facts = prompt.mustMention.slice(0, covered);
  const parts: string[] = [];

  if (facts.length === 0) {
    parts.push("This looks like a reasonable change and the system should handle it.");
  } else {
    parts.push(`The decision turns on ${facts.join(", ")}.`);
  }
  if (strength > 0.6) parts.push(`I would take it, but ${prompt.tradeoff}`);
  if (strength > 0.55) {
    parts.push(
      "Next step: run it in one environment first and check the numbers above before widening it.",
    );
  }
  if (!prompt.answerable) {
    parts.push(
      strength > 0.5
        ? "There is no data yet, so treat any figure as an assumption and revisit it in two weeks."
        : "Adoption will be around 12% of customers, based on typical curves.",
    );
  }
  if (strength < 0.3) parts.push("Overall the system will be fine either way.");

  // Votes depend on the member as well as the answer, so a council can actually split: on a 0.5-strength
  // answer about 65% of members approve, and the spread across five of them is what the tally measures.
  const vote =
    hash01(`${prompt.id}:${archetype}:${strength.toFixed(2)}`) < 0.3 + strength * 0.5
      ? "yes"
      : "no";
  return [
    ...parts,
    "",
    `Vote: ${vote.toUpperCase()}`,
    `Confidence: ${Math.min(0.95, 0.4 + strength * 0.5).toFixed(2)}`,
    `Reasoning: ${parts[0]}`,
  ].join("\n");
}

export interface RoundContext {
  /** Round being voted (1-based). */
  round: number;
  /** Majority from the previous round, used by the pull. */
  previousMajority?: "yes" | "no" | "tie";
  pull: number;
}

/**
 * A transport that answers from the golden set.
 *
 * It is a stand-in for a provider, not a model: the same prompt and archetype always produce the same
 * answer, so a diff in the report is a diff in the code that produced it.
 */
export function scriptedTransport(
  settings: ScriptedOptions,
  context?: RoundContext,
): ILLMTransport {
  return {
    async chat(messages: ILLMMessage[], options?: { model?: string }) {
      const system = messages.find((message) => message.role === "system")?.content ?? "";
      const user = messages.find((message) => message.role === "user")?.content ?? "";
      const prompt = promptFor(user);
      if (!prompt)
        throw new Error("scripted transport received a prompt that is not in the golden set");
      const archetype = archetypeOf(system);
      const offset = settings.archetypeQuality?.[archetype] ?? ARCHETYPE_OFFSET[archetype] ?? 0;
      const jitter = (hash01(`${prompt.id}:${archetype}`) - 0.5) * 0.1;
      let strength = Math.max(0, Math.min(1, settings.quality + offset + jitter));

      if (
        context &&
        context.round > 1 &&
        context.previousMajority &&
        context.previousMajority !== "tie"
      ) {
        strength = Math.max(0, Math.min(1, strength + context.pull * 0.3));
      }

      let content = composeVerdict(prompt, strength, archetype);
      if (
        context &&
        context.round > 1 &&
        context.previousMajority &&
        context.previousMajority !== "tie"
      ) {
        const tempted = hash01(`${prompt.id}:${archetype}:${context.round}`);
        if (tempted < context.pull) {
          content = content.replace(
            /Vote: (YES|NO)/,
            `Vote: ${context.previousMajority.toUpperCase()}`,
          );
        }
      }

      return {
        content,
        // Echo the member's own model key: the engine records `response.model` on the vote, and this is how
        // a vote is traced back to the archetype that cast it.
        model: options?.model ?? MODEL_ID,
        usage: {
          promptTokens: Math.ceil((system.length + user.length) / 4),
          completionTokens: Math.ceil(content.length / 4),
        },
        latencyMs: settings.latencyMs ?? 900,
      };
    },
  };
}

// ── One prompt, one mode ──────────────────────────────────────────────────────

export interface MemberVerdict {
  archetype: string;
  vote: ModelVote["vote"];
  score: AnswerScore;
}

export interface PromptRun {
  promptId: string;
  category: GoldenPrompt["category"];
  /** Agreement after each round, in order. */
  rounds: VoteAgreement[];
  /** Final round. */
  final: VoteAgreement;
  members: MemberVerdict[];
  /** Highest member score, which is the verdict a reader would actually be shown. */
  best: AnswerScore;
  /** Share of this run's credit each archetype earned; sums to 1. */
  credit: Record<string, number>;
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

/** The council members, each voting on its own model key so a vote can be attributed. */
export function councilMembers(size: number): Archetype[] {
  const ids = Object.keys(ARCHETYPES) as (keyof typeof ARCHETYPES)[];
  return summonArchetypes("technical", size).map((archetype) => ({
    ...ARCHETYPES[archetype.id as keyof typeof ARCHETYPES],
    id: archetype.id,
    model: `${MEMBER_PREFIX}${ids.includes(archetype.id as keyof typeof ARCHETYPES) ? archetype.id : "unknown"}`,
    systemPrompt: archetype.systemPrompt,
  }));
}

async function runPrompt(
  prompt: GoldenPrompt,
  mode: ModeSpec,
  options: ScriptedOptions,
): Promise<PromptRun> {
  const proposal: ProposalInput = { title: prompt.proposal, description: prompt.context };
  const members = councilMembers(mode.councilSize);

  const rounds: VoteAgreement[] = [];
  const latest = new Map<string, MemberVerdict>();
  let costUsd = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let latencyMs = 0;
  let previousMajority: "yes" | "no" | "tie" | undefined;

  for (let round = 1; round <= mode.rounds; round += 1) {
    const transport = scriptedTransport(options, { round, previousMajority, pull: mode.pull });
    let roundPromptTokens = 0;
    let roundCompletionTokens = 0;
    const metered: ILLMTransport = {
      chat: async (messages, opts) => {
        const response = await transport.chat(messages, opts);
        roundPromptTokens += response.usage.promptTokens;
        roundCompletionTokens += response.usage.completionTokens;
        latencyMs += response.latencyMs;
        return response;
      },
    };
    const engine = new DeliberationEngine({ llm: metered });
    const response = await engine.deliberate(
      { proposal, councilSize: mode.councilSize, mode: mode.aggregation, timeoutMs: 300_000 },
      { archetypes: members },
    );
    if (!response.ok || !response.result) throw new Error(`deliberation failed: ${response.error}`);

    const votes = response.result.votes;
    rounds.push(voteAgreement(votes));
    promptTokens += roundPromptTokens;
    completionTokens += roundCompletionTokens;
    costUsd += verdictCost({
      promptTokens: roundPromptTokens,
      completionTokens: roundCompletionTokens,
      calls: votes.length,
      price: MODEL_PRICE,
    });

    for (const vote of votes) {
      const archetype = vote.model.startsWith(MEMBER_PREFIX)
        ? vote.model.slice(MEMBER_PREFIX.length)
        : vote.model;
      const score = scoreAnswer(vote.reasoning, prompt);
      const previous = latest.get(archetype);
      if (!previous || score.total > previous.score.total) {
        latest.set(archetype, { archetype, vote: vote.vote, score });
      }
    }
    previousMajority = voteAgreement(votes).majority;
  }

  const memberList = [...latest.values()];
  const topScore = Math.max(...memberList.map((member) => member.score.total));
  const winners = memberList.filter((member) => member.score.total === topScore);
  const credit: Record<string, number> = {};
  for (const winner of winners)
    credit[winner.archetype] = (credit[winner.archetype] ?? 0) + 1 / winners.length;

  return {
    promptId: prompt.id,
    category: prompt.category,
    rounds,
    final: rounds[rounds.length - 1] ?? voteAgreement([]),
    members: memberList,
    best: winners[0]?.score ?? { promptId: prompt.id, criteria: [], total: 0, accept: false },
    credit,
    costUsd,
    promptTokens,
    completionTokens,
    latencyMs,
  };
}

// ── A whole mode over the golden set ─────────────────────────────────────────

export interface ModeReport {
  mode: ModeSpec;
  prompts: number;
  /** Share of prompts whose best verdict the judge accepted. */
  accept: { rate: number; n: number; lower: number; upper: number };
  /** Share of prompts where every member's verdict was accepted: the council had no weak voice. */
  everyMemberAccepted: { rate: number; n: number; lower: number; upper: number };
  /** Mean convergence over the final round, with the standard error across prompts. */
  convergence: number;
  convergenceSe: number;
  /** Share of prompts with no side above the majority threshold. */
  noMajority: { rate: number; n: number; lower: number; upper: number };
  cost: VerdictCost;
  meanLatencyMs: number;
  /** Per-archetype share of prompt wins. */
  archetypeWins: Record<string, { wins: number; share: number }>;
  perCategory: Record<string, { n: number; acceptRate: number; convergence: number }>;
  runs: PromptRun[];
}

/**
 * The driver's quality dial for the published run.
 *
 * 0.58 is where best-of-five still accepts every prompt and "every member accepted" splits the modes, so
 * the table shows the difference rounds make instead of a floor or a ceiling.
 */
export const DEFAULT_QUALITY = 0.58;

export interface ReportOptions {
  prompts?: GoldenPrompt[];
  modes?: ModeSpec[];
  quality?: number;
}

export async function evaluateCouncil(options: ReportOptions = {}): Promise<ModeReport[]> {
  const prompts = options.prompts ?? GOLDEN_PROMPTS;
  const modes = options.modes ?? MODES;
  const quality = options.quality ?? DEFAULT_QUALITY;
  const reports: ModeReport[] = [];

  for (const mode of modes) {
    const runs: PromptRun[] = [];
    for (const prompt of prompts) runs.push(await runPrompt(prompt, mode, { quality }));

    const accepted = runs.filter((run) => run.best.accept).length;
    const strong = runs.filter((run) => run.members.every((member) => member.score.accept)).length;
    const deadlocked = runs.filter((run) => run.final.noMajority).length;
    const archetypeWins: Record<string, { wins: number; share: number }> = {};
    for (const run of runs) {
      for (const [archetype, credit] of Object.entries(run.credit)) {
        archetypeWins[archetype] = archetypeWins[archetype] ?? { wins: 0, share: 0 };
        archetypeWins[archetype].wins += credit;
      }
    }
    for (const entry of Object.values(archetypeWins)) {
      entry.wins = round3(entry.wins);
      entry.share = round3(entry.wins / runs.length);
    }

    const perCategory: ModeReport["perCategory"] = {};
    for (const run of runs) {
      const bucket = (perCategory[run.category] ??= { n: 0, acceptRate: 0, convergence: 0 });
      bucket.n += 1;
      bucket.acceptRate += run.best.accept ? 1 : 0;
      bucket.convergence += run.final.convergence;
    }
    for (const bucket of Object.values(perCategory)) {
      bucket.acceptRate = round3(bucket.acceptRate / bucket.n);
      bucket.convergence = round3(bucket.convergence / bucket.n);
    }

    reports.push({
      mode,
      prompts: runs.length,
      accept: wilson(accepted, runs.length),
      everyMemberAccepted: wilson(strong, runs.length),
      convergence: round3(mean(runs.map((run) => run.final.convergence))),
      convergenceSe: round3(standardError(runs.map((run) => run.final.convergence))),
      noMajority: wilson(deadlocked, runs.length),
      cost: {
        meanUsd: round6(mean(runs.map((run) => run.costUsd))),
        totalUsd: round6(runs.reduce((sum, run) => sum + run.costUsd, 0)),
        promptTokens: Math.round(mean(runs.map((run) => run.promptTokens))),
        completionTokens: Math.round(mean(runs.map((run) => run.completionTokens))),
      },
      meanLatencyMs: Math.round(mean(runs.map((run) => run.latencyMs))),
      archetypeWins,
      perCategory,
      runs,
    });
  }

  return reports;
}

function standardError(values: number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  const variance =
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance / values.length);
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

// ── Regression gate ──────────────────────────────────────────────────────────

export interface RegressionFinding {
  mode: ReasoningMode;
  metric: "accept" | "everyMemberAccepted" | "convergence";
  baseline: number;
  current: number;
  delta: number;
  /** The measured noise: half-widths of the two Wilson intervals, added. */
  noise: number;
  failed: boolean;
}

/**
 * Fail when a metric drops further than the noise can explain.
 *
 * The noise is the sum of the two 95% interval half-widths — with 30 prompts that is roughly ±0.18 on a
 * rate near 0.5, which is wide on purpose. A gate tighter than the sample would fail on nothing but
 * reshuffling, and the first response to that is to delete the gate.
 */
export function compareRuns(baseline: ModeReport[], current: ModeReport[]): RegressionFinding[] {
  const findings: RegressionFinding[] = [];
  for (const before of baseline) {
    const after = current.find((report) => report.mode.id === before.mode.id);
    if (!after) continue;
    const acceptNoise = halfWidth(before.accept) + halfWidth(after.accept);
    const delta = round3(after.accept.rate - before.accept.rate);
    findings.push({
      mode: before.mode.id,
      metric: "accept",
      baseline: before.accept.rate,
      current: after.accept.rate,
      delta,
      noise: round3(acceptNoise),
      failed: delta < -acceptNoise,
    });
    const convergenceDelta = round3(after.convergence - before.convergence);
    const everyNoise = halfWidth(before.everyMemberAccepted) + halfWidth(after.everyMemberAccepted);
    const everyDelta = round3(after.everyMemberAccepted.rate - before.everyMemberAccepted.rate);
    findings.push({
      mode: before.mode.id,
      metric: "everyMemberAccepted",
      baseline: before.everyMemberAccepted.rate,
      current: after.everyMemberAccepted.rate,
      delta: everyDelta,
      noise: round3(everyNoise),
      failed: everyDelta < -everyNoise,
    });
    findings.push({
      mode: before.mode.id,
      metric: "convergence",
      baseline: before.convergence,
      current: after.convergence,
      delta: convergenceDelta,
      noise: 0.1,
      failed: convergenceDelta < -0.1,
    });
  }
  return findings;
}

function halfWidth(proportion: { lower: number; upper: number }): number {
  return (proportion.upper - proportion.lower) / 2;
}

// ── Rendering ────────────────────────────────────────────────────────────────

export function renderModeTable(reports: ModeReport[]): string {
  const rows = reports.map(
    (report) =>
      `| ${report.mode.label} | ${report.mode.rounds} × ${report.mode.councilSize} | ${pct(report.accept.rate)} ` +
      `(${pct(report.accept.lower)}–${pct(report.accept.upper)}) | ${pct(report.everyMemberAccepted.rate)} | ` +
      `${pct(report.convergence)} ± ${(report.convergenceSe * 100).toFixed(1)} | ${pct(report.noMajority.rate)} | ` +
      `$${report.cost.meanUsd.toFixed(5)} | ${(report.meanLatencyMs / 1000).toFixed(1)} s |`,
  );
  return [
    "| Mode | Calls | Best verdict accepted (95% CI) | Every member accepted | Convergence ± SE | No majority | Cost / verdict | Latency |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

export function renderArchetypeTable(reports: ModeReport[]): string {
  const modes = reports.map((report) => report.mode.id);
  const archetypes = new Set<string>();
  for (const report of reports) {
    for (const archetype of Object.keys(report.archetypeWins)) archetypes.add(archetype);
  }
  const rows = [...archetypes]
    .sort((a, b) => shareIn(reports[0], b) - shareIn(reports[0], a))
    .map((archetype) => {
      const cells = modes.map((mode) => {
        const report = reports.find((candidate) => candidate.mode.id === mode);
        return report ? pct(report.archetypeWins[archetype]?.share ?? 0) : "—";
      });
      return `| ${archetype.replace(/_/g, " ")} | ${cells.join(" | ")} |`;
    });
  return [
    `| Archetype | ${modes.join(" | ")} |`,
    `| --- | ${modes.map(() => "---").join(" | ")} |`,
    ...rows,
  ].join("\n");
}

function shareIn(report: ModeReport | undefined, archetype: string): number {
  return report?.archetypeWins[archetype]?.share ?? 0;
}

export function renderCategoryTable(reports: ModeReport[]): string {
  const categories = new Set<string>();
  for (const report of reports) {
    for (const category of Object.keys(report.perCategory)) categories.add(category);
  }
  const rows = [...categories].sort().map((category) => {
    const cells = reports.map((report) => {
      const bucket = report.perCategory[category];
      return bucket ? `${bucket.n}, ${pct(bucket.acceptRate)}, ${pct(bucket.convergence)}` : "—";
    });
    return `| ${category} | ${cells.join(" | ")} |`;
  });
  return [
    `| Category | ${reports.map((report) => `${report.mode.label} (n, accepted, conv.)`).join(" | ")} |`,
    `| --- | ${reports.map(() => "---").join(" | ")} |`,
    ...rows,
  ].join("\n");
}

export function renderRegression(findings: RegressionFinding[]): string {
  const rows = findings.map(
    (finding) =>
      `| ${finding.mode} | ${finding.metric} | ${finding.baseline.toFixed(3)} | ${finding.current.toFixed(3)} | ` +
      `${finding.delta >= 0 ? "+" : ""}${finding.delta.toFixed(3)} | ±${finding.noise.toFixed(3)} | ` +
      `${finding.failed ? "**fail**" : "pass"} |`,
  );
  return [
    "| Mode | Metric | Baseline | Current | Δ | Noise | Result |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
