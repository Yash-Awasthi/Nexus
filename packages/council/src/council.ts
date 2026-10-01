// SPDX-License-Identifier: Apache-2.0
/**
 * Council — the SDK's multi-model vote: every member driver answers the same question, and the
 * votes are tallied by the chosen mode (see tallyVotes). Members are any driver with
 * `complete`, such as those in @nexus/llm-drivers.
 */
import type { ModelVote } from "@nexus/contracts";

import { parseConfidence, parseVote, tallyVotes, type VotingMode } from "./engine.js";

export interface CouncilMemberDriver {
  provider: string;
  model: string;
  complete(opts: {
    messages: { role: "user"; content: string }[];
    systemPrompt?: string;
    maxTokens?: number;
  }): Promise<{ content: string }>;
}

export interface CouncilMember {
  driver: CouncilMemberDriver;
  /** Counts in weighted mode, times the member's stated confidence. */
  weight?: number;
}

export interface CouncilVote extends Pick<ModelVote, "vote" | "confidence" | "reasoning"> {
  provider: string;
  model: string;
  weight: number;
}

const VOTER_PROMPT =
  "You are one member of a council. Reason briefly about the question, then end with two " +
  'lines: "Vote: YES" or "Vote: NO" (or ABSTAIN), and "Confidence: <0 to 1>".';

export class Council {
  constructor(
    private readonly opts: { members: CouncilMember[]; mode?: VotingMode; systemPrompt?: string },
  ) {}

  async deliberate(question: string) {
    const votes: CouncilVote[] = await Promise.all(
      this.opts.members.map(async ({ driver, weight = 1 }) => {
        const who = { provider: driver.provider, model: driver.model, weight };
        try {
          const { content } = await driver.complete({
            systemPrompt: this.opts.systemPrompt ?? VOTER_PROMPT,
            messages: [{ role: "user", content: question }],
            maxTokens: 512,
          });
          return {
            ...who,
            vote: parseVote(content),
            confidence: parseConfidence(content),
            reasoning: content,
          };
        } catch (err) {
          return {
            ...who,
            vote: "abstain" as const,
            confidence: 0,
            reasoning: `Vote failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }),
    );
    const { consensus, majority, outcome } = tallyVotes(votes, this.opts.mode);
    return { outcome, majority, consensus: Math.round(consensus * 100) / 100, votes };
  }
}
