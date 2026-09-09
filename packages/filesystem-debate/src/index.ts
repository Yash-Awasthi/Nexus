// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/filesystem-debate — Filesystem-based multi-model debate with voting.
 *
 * Inspired by ensemble's coordinator pattern.
 * Models propose, peer-review, rebut, vote, and synthesize — all via
 * filesystem artifacts for auditability and reproducibility.
 */

import type { LLMRouter } from "@nexus/llm-router";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

export type DebatePhase =
  "proposing" | "reviewing" | "rebutting" | "voting" | "synthesizing" | "converged" | "deadlocked";

export interface Debater {
  alias: string;
  label: string; // anonymized label like "Participant A"
  systemPrompt: string;
}

export interface Vote {
  debaterLabel: string;
  targetLabel: string;
  score: number;
  reason: string;
}

export interface PhaseResult {
  phase: DebatePhase;
  outputs: Map<string, string>; // label -> content
  timestamp: number;
}

export interface DebateResult {
  debateId: string;
  prompt: string;
  phases: PhaseResult[];
  votes: Vote[];
  synthesis: string;
  converged: boolean;
  totalDurationMs: number;
}

// ── Debate State ─────────────────────────────────────────────────────────────

export class DebateState {
  private debateId: string;
  private prompt: string;
  private phases: PhaseResult[] = [];
  private currentPhase: DebatePhase = "proposing";
  private round = 1;
  private votes: Vote[] = [];
  private basePath: string;

  constructor(prompt: string, basePath?: string) {
    this.debateId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.prompt = prompt;
    this.basePath = basePath ?? join(process.env.HOME ?? "/tmp", ".nexus-debates", this.debateId);

    // Create debate directory
    mkdirSync(this.basePath, { recursive: true });
    writeFileSync(join(this.basePath, "prompt.md"), `# Debate Prompt\n\n${prompt}\n`);
  }

  getDebateId(): string {
    return this.debateId;
  }

  getCurrentPhase(): DebatePhase {
    return this.currentPhase;
  }

  addPhaseResult(result: PhaseResult): void {
    this.phases.push(result);
    this.savePhase(result);
  }

  setPhase(phase: DebatePhase): void {
    this.currentPhase = phase;
  }

  addVote(vote: Vote): void {
    this.votes.push(vote);
  }

  getVotes(): Vote[] {
    return [...this.votes];
  }

  getPhases(): PhaseResult[] {
    return [...this.phases];
  }

  private savePhase(result: PhaseResult): void {
    const phaseDir = join(this.basePath, `round-${this.round}`, result.phase);
    mkdirSync(phaseDir, { recursive: true });

    for (const [label, content] of result.outputs) {
      writeFileSync(join(phaseDir, `${label.replace(/\s+/g, "-").toLowerCase()}.md`), content);
    }
  }
}

// ── Debate Coordinator ───────────────────────────────────────────────────────

export class DebateCoordinator {
  private router: LLMRouter;
  private maxRounds: number;
  private stallTimeoutMs: number;

  constructor(
    router: LLMRouter,
    options?: {
      maxRounds?: number;
      stallTimeoutMs?: number;
    },
  ) {
    this.router = router;
    this.maxRounds = options?.maxRounds ?? 3;
    this.stallTimeoutMs = options?.stallTimeoutMs ?? 300_000;
  }

  /**
   * Run a full debate.
   */
  async run(prompt: string, debaters: Debater[]): Promise<DebateResult> {
    const start = Date.now();
    const state = new DebateState(prompt);

    // Phase 1: Proposing — each debater independently answers
    state.setPhase("proposing");
    const proposals = await this.runPhase(
      prompt,
      debaters,
      "proposing",
      (d) =>
        `You are ${d.label}. Answer this question independently:\n\n${prompt}\n\nProvide your analysis with your final answer clearly stated.`,
    );
    state.addPhaseResult({ phase: "proposing", outputs: proposals, timestamp: Date.now() });

    let converged = false;

    for (let round = 0; round < this.maxRounds && !converged; round++) {
      // Phase 2: Reviewing — each debater reviews others' proposals
      state.setPhase("reviewing");
      const reviews = await this.runReviewPhase(debaters, proposals);
      state.addPhaseResult({ phase: "reviewing", outputs: reviews, timestamp: Date.now() });

      // Phase 3: Rebutting — each debater responds to reviews
      state.setPhase("rebutting");
      const rebuttals = await this.runRebuttalPhase(debaters, proposals, reviews);
      state.addPhaseResult({ phase: "rebutting", outputs: rebuttals, timestamp: Date.now() });

      // Phase 4: Voting — each debater votes on the best proposal
      state.setPhase("voting");
      const votes = await this.runVotingPhase(debaters, proposals, reviews, rebuttals);
      for (const vote of votes) state.addVote(vote);

      // Check convergence
      if (this.checkConvergence(state.getVotes(), debaters)) {
        converged = true;
      }
    }

    // Phase 5: Synthesis
    state.setPhase("synthesizing");
    const synthesis = await this.runSynthesis(prompt, proposals, state.getVotes(), debaters);

    state.setPhase(converged ? "converged" : "deadlocked");

    return {
      debateId: state.getDebateId(),
      prompt,
      phases: state.getPhases(),
      votes: state.getVotes(),
      synthesis,
      converged,
      totalDurationMs: Date.now() - start,
    };
  }

  // ── Phase Runners ─────────────────────────────────────────────────────

  private async runPhase(
    prompt: string,
    debaters: Debater[],
    phaseName: string,
    promptBuilder: (d: Debater) => string,
  ): Promise<Map<string, string>> {
    const outputs = new Map<string, string>();

    const results = await Promise.all(
      debaters.map(async (debater) => {
        const resp = await this.router.complete({
          model: debater.alias,
          messages: [
            { role: "system", content: debater.systemPrompt },
            { role: "user", content: promptBuilder(debater) },
          ],
          maxTokens: 2048,
        });
        return { label: debater.label, content: resp.content };
      }),
    );

    for (const r of results) {
      outputs.set(r.label, r.content);
    }

    return outputs;
  }

  private async runReviewPhase(
    debaters: Debater[],
    proposals: Map<string, string>,
  ): Promise<Map<string, string>> {
    const outputs = new Map<string, string>();

    const results = await Promise.all(
      debaters.map(async (debater) => {
        const otherProposals = Array.from(proposals.entries())
          .filter(([label]) => label !== debater.label)
          .map(([label, content]) => `${label}:\n${content.slice(0, 500)}`)
          .join("\n\n");

        const resp = await this.router.complete({
          model: debater.alias,
          messages: [
            { role: "system", content: debater.systemPrompt },
            {
              role: "user",
              content: [
                `You are ${debater.label}. Review the other participants' proposals.`,
                `Your own proposal:\n${(proposals.get(debater.label) ?? "").slice(0, 300)}`,
                `\nOther proposals:\n${otherProposals}`,
                `\nProvide a structured review: strengths, weaknesses, and suggestions for each.`,
              ].join("\n"),
            },
          ],
          maxTokens: 1024,
        });
        return { label: debater.label, content: resp.content };
      }),
    );

    for (const r of results) outputs.set(r.label, r.content);
    return outputs;
  }

  private async runRebuttalPhase(
    debaters: Debater[],
    proposals: Map<string, string>,
    reviews: Map<string, string>,
  ): Promise<Map<string, string>> {
    const outputs = new Map<string, string>();

    const results = await Promise.all(
      debaters.map(async (debater) => {
        const reviewsOfMe = Array.from(reviews.entries())
          .filter(([label]) => label !== debater.label)
          .map(([label, content]) => `${label} reviewed you:\n${content.slice(0, 300)}`)
          .join("\n\n");

        const resp = await this.router.complete({
          model: debater.alias,
          messages: [
            { role: "system", content: debater.systemPrompt },
            {
              role: "user",
              content: [
                `You are ${debater.label}. Respond to the reviews of your proposal.`,
                `Your proposal:\n${(proposals.get(debater.label) ?? "").slice(0, 300)}`,
                `\nReviews:\n${reviewsOfMe}`,
                `\nProvide your rebuttal: defend valid points, concede errors, and revise your answer.`,
              ].join("\n"),
            },
          ],
          maxTokens: 1024,
        });
        return { label: debater.label, content: resp.content };
      }),
    );

    for (const r of results) outputs.set(r.label, r.content);
    return outputs;
  }

  private async runVotingPhase(
    debaters: Debater[],
    proposals: Map<string, string>,
    reviews: Map<string, string>,
    rebuttals: Map<string, string>,
  ): Promise<Vote[]> {
    const votes: Vote[] = [];

    const results = await Promise.all(
      debaters.map(async (debater) => {
        const summaries = Array.from(proposals.entries())
          .map(([label, content]) => `${label}: ${content.slice(0, 200)}`)
          .join("\n");

        const resp = await this.router.complete({
          model: debater.alias,
          messages: [
            {
              role: "user",
              content: [
                `You are ${debater.label}. Vote on the best proposal.`,
                `Proposals:\n${summaries}`,
                `\nFor each proposal (except your own), provide a score 1-10 and brief reason.`,
                `\nReply with JSON: [{"target": "label", "score": N, "reason": "..."}]`,
              ].join("\n"),
            },
          ],
          maxTokens: 512,
        });

        // Parse votes
        try {
          const jsonMatch = resp.content.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return parsed.map((v: any) => ({
              debaterLabel: debater.label,
              targetLabel: v.target,
              score: v.score,
              reason: v.reason,
            }));
          }
        } catch {}
        return [];
      }),
    );

    for (const r of results) votes.push(...r);
    return votes;
  }

  private async runSynthesis(
    prompt: string,
    proposals: Map<string, string>,
    votes: Vote[],
    debaters: Debater[],
  ): Promise<string> {
    const proposalSummaries = Array.from(proposals.entries())
      .map(([label, content]) => `${label}:\n${content.slice(0, 400)}`)
      .join("\n\n");

    const voteSummary = votes
      .map((v) => `${v.debaterLabel} voted for ${v.targetLabel} (${v.score}/10): ${v.reason}`)
      .join("\n");

    const resp = await this.router.complete({
      model: debaters[0]!.alias,
      messages: [
        {
          role: "user",
          content: [
            `Synthesize the following debate into a single final answer.`,
            `Question: ${prompt}`,
            `\nProposals:\n${proposalSummaries}`,
            `\nVotes:\n${voteSummary}`,
            `\nProvide a balanced synthesis that acknowledges different perspectives.`,
          ].join("\n"),
        },
      ],
      maxTokens: 2048,
    });

    return resp.content;
  }

  private checkConvergence(votes: Vote[], debaters: Debater[]): boolean {
    // Count votes per target
    const voteCounts = new Map<string, number>();
    for (const vote of votes) {
      voteCounts.set(vote.targetLabel, (voteCounts.get(vote.targetLabel) ?? 0) + 1);
    }

    // Check if any target has majority
    const majority = Math.floor(debaters.length / 2) + 1;
    for (const count of voteCounts.values()) {
      if (count >= majority) return true;
    }

    return false;
  }
}

export default DebateCoordinator;
