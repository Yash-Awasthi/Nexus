// SPDX-License-Identifier: Apache-2.0
/**
 * Deliberative council — the Karpathy LLM-council flow for @nexus/council.
 *
 * The {@link DeliberationEngine} runs one phase: archetypes vote in parallel and
 * the votes are tallied. The council-of-advisors methodology popularised by
 * Karpathy's llm-council (and shipped as claude-council / ai-debate-council /
 * council-of-high-intelligence skills) adds two more phases that are exactly
 * where the value is:
 *
 *   1. Convene — advisors answer independently, in parallel, each leaning fully
 *      into its assigned thinking style (no hedging, no balancing).
 *   2. Peer review — responses are anonymised (randomised A/B/C/D/E labels so
 *      there is no positional bias) and each advisor reviews ALL of them,
 *      answering: which is strongest and why; which has the biggest blind spot;
 *      what every response missed.
 *   3. Synthesis — a chairman sees the de-anonymised positions plus the
 *      reviews and produces a COUNCIL VERDICT: where the advisors agree, where
 *      they clash (not smoothed over), blind spots the review round caught,
 *      a clear recommendation (may overrule the majority), and one concrete
 *      next action.
 *
 * The LLM transport is injected via the same {@link ILLMTransport} interface
 * the engine uses, so nothing here is provider-coupled.
 */

import type { Archetype } from "./archetypes.js";
import { summonArchetypes } from "./archetypes.js";
import type { ILLMResponse, ILLMTransport } from "./engine.js";
import { mulberry32 } from "@nexus/shared";
import {
  parseBordaRanking,
  tallyBorda,
  formatBordaStandings,
  type BordaResult,
  type BordaRanking,
} from "./borda.js";

export {
  parseBordaRanking,
  tallyBorda,
  formatBordaStandings,
  maxBordaPoints,
  type BordaResult,
  type BordaRanking,
  type BordaTally,
} from "./borda.js";

// ── Core types ───────────────────────────────────────────────────────────────

export interface AdvisorPosition {
  /** Advisor name, e.g. "The Contrarian". */
  advisor: string;
  /** The advisor's independent position on the question. */
  content: string;
}

/** An anonymised letter (A–E) mapped back to its advisor. */
export interface AnonymizedPosition {
  letter: string;
  content: string;
}

export interface PeerReview {
  /** Advisor name that produced this review. */
  reviewer: string;
  /** Letter of the response they rated strongest. */
  strongestResponse: string;
  strongestReason: string;
  /** Letter of the response with the biggest blind spot. */
  biggestBlindSpot: string;
  blindSpotDetail: string;
  /** What the reviewer thinks ALL responses missed. */
  missedByAll: string;
}

export interface CouncilVerdict {
  /** Points multiple advisors converged on independently. */
  agreements: string[];
  /** Genuine disagreements — presented, not smoothed over. */
  clashes: string[];
  /** Blind spots that only surfaced through the peer-review round. */
  blindSpots: string[];
  /** A clear, actionable recommendation (may overrule the majority). */
  recommendation: string;
  /** The single concrete thing to do first. */
  nextAction: string;
  /** Raw chairman output, preserved for inspectability. */
  raw: string;
}

export interface DeliberativeOutcome {
  question: string;
  positions: AdvisorPosition[];
  /** letter → advisor for the review round. */
  anonymization: Record<string, string>;
  reviews: PeerReview[];
  verdict: CouncilVerdict;
}

export interface DeliberativeCouncilConfig {
  /** LLM transport used for every call. */
  llm: ILLMTransport;
  /**
   * The advisor panel. Defaults to summonArchetypes("default", 5) — the same
   * thinking-style personas the engine votes with.
   */
  advisors?: Archetype[];
  /** Passed to the transport per call. */
  model?: string;
  /** Advisor length guidance, "keep your response under N words". */
  wordLimit?: number;
}

// ── Seeded anonymisation ─────────────────────────────────────────────────────
// mulberry32 lives in @nexus/shared/math (single home, shared with the
// HNSW level generator) so the shuffles stay reproducible in tests.

/**
 * Anonymise advisor positions as letters A, B, C, … with a seeded random
 * permutation (Karpathy's "randomise which advisor maps to which letter so
 * there's no positional bias"). Deterministic per seed for reproducibility.
 */
export function anonymizePositions(
  positions: readonly AdvisorPosition[],
  seed = 42,
): { positions: AnonymizedPosition[]; mapping: Record<string, string> } {
  const idx = positions.map((_, i) => i);
  const rand = mulberry32(seed);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  const mapping: Record<string, string> = {};
  const lettered = idx.map((original, slot) => {
    const letter = String.fromCharCode(65 + slot); // A, B, C, …
    mapping[letter] = positions[original]!.advisor;
    return { letter, content: positions[original]!.content };
  });
  return { positions: lettered, mapping };
}

// ── Verdict parsing ──────────────────────────────────────────────────────────

const VERDICT_MARKERS = [
  "AGREEMENTS",
  "CLASHES",
  "BLIND SPOTS",
  "RECOMMENDATION",
  "NEXT ACTION",
] as const;

/** True when a line is a verdict-section heading (case/bullet/markdown tolerant). */
function isMarkerLine(line: string, marker: string): boolean {
  const t = line
    .trim()
    .toUpperCase()
    .replace(/^[\s*#\->]+/, "")
    .replace(/[:.]\s*$/, "")
    .trim();
  return t === marker;
}

/** Split a line list at a heading marker, returning the lines under it. */
function sectionLines(text: string, marker: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => isMarkerLine(l, marker));
  if (start < 0) return [];
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (VERDICT_MARKERS.some((m) => isMarkerLine(lines[i]!, m))) {
      end = i;
      break;
    }
  }
  return lines
    .slice(start + 1, end)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.replace(/^[-*•]|\d+[.)]\s*/, "").trim())
    .filter((l) => l.length > 0);
}

/**
 * Parse a chairman's COUNCIL VERDICT into structured fields. The chairman is
 * instructed to write five headed sections; this tolerates missing sections and
 * bullet/number prefixes and always returns the full raw text.
 */
export function parseCouncilVerdict(raw: string): CouncilVerdict {
  const lines = (s: string): string[] => {
    const out = sectionLines(raw, s);
    return out;
  };
  const agreements = lines("AGREEMENTS");
  const clashes = lines("CLASHES");
  const blindSpots = lines("BLIND SPOTS");
  const recommendation = lines("RECOMMENDATION").join(" ");
  const nextAction = lines("NEXT ACTION").join(" ");
  return { agreements, clashes, blindSpots, recommendation, nextAction, raw };
}

// ── DeliberativeCouncil ──────────────────────────────────────────────────────

const WORD_LIMIT_HINT = (n: number): string =>
  `Keep your response under ${n} words. No preamble. Go straight into your analysis.`;

/**
 * Runs the full deliberative council flow (convene → anonymised peer review →
 * chairman synthesis). Each phase is exposed separately so callers can reuse or
 * instrument a single phase.
 */
export class DeliberativeCouncil {
  private readonly config: Required<Pick<DeliberativeCouncilConfig, "wordLimit">> &
    DeliberativeCouncilConfig;
  private readonly advisors: Archetype[];

  constructor(config: DeliberativeCouncilConfig) {
    this.config = { wordLimit: 300, ...config };
    this.advisors = config.advisors ?? summonArchetypes("default", 5);
  }

  get panel(): readonly Archetype[] {
    return this.advisors;
  }

  /** Phase 1 — every advisor answers the question independently, in parallel. */
  async convene(question: string, context?: string): Promise<AdvisorPosition[]> {
    const prompt = [question, ...(context ? ["", `CONTEXT:\n${context}`] : [])].join("\n");
    const limit = WORD_LIMIT_HINT(this.config.wordLimit);
    const positions = await Promise.all(
      this.advisors.map(async (a) => {
        const content = await this.respond(
          [
            { role: "system", content: a.systemPrompt },
            {
              role: "user",
              content: `A user has brought this question to the council:\n---\n${prompt}\n---\n\nRespond from your perspective. Be direct and specific. Don't hedge or try to be balanced. Lean fully into your assigned angle — the other advisors will cover the angles you are not covering.\n\n${limit}`,
            },
          ],
          a.name,
        );
        return { advisor: a.name, content };
      }),
    );
    return positions;
  }

  /** Phase 2 — each advisor reviews all anonymised positions. */
  async review(
    question: string,
    positions: readonly AdvisorPosition[],
    seed = 42,
  ): Promise<{ reviews: PeerReview[]; anonymization: Record<string, string> }> {
    const { positions: lettered, mapping } = anonymizePositions(positions, seed);
    const body = lettered
      .map((p) => `**Response ${p.letter}:**\n${p.content}`)
      .join("\n\n");
    const reviews = await Promise.all(
      this.advisors.map(async (a) => {
        const content = await this.respond(
          [
            {
              role: "system",
              content: `You are ${a.name} reviewing the outputs of an LLM Council. Your thinking style: ${a.thinkingStyle}.`,
            },
            {
              role: "user",
              content: `Five advisors independently answered this question:\n---\n${question}\n---\n\nHere are their anonymised responses:\n\n${body}\n\nAnswer these three questions. Be specific. Reference responses by letter.\n1. Which response is the strongest? Why?\n2. Which response has the biggest blind spot? What is it missing?\n3. What did ALL responses miss that the council should consider?\n\nKeep your review under 200 words. Be direct.`,
            },
          ],
          a.name,
        );
        return { reviewer: a.name, ...parseReview(content) };
      }),
    );
    return { reviews, anonymization: mapping };
  }

  /** Phase 3 — the chairman synthesises the de-anonymised council into a verdict. */
  async synthesize(
    question: string,
    positions: readonly AdvisorPosition[],
    reviews: readonly PeerReview[],
    anonymization: Record<string, string>,
  ): Promise<CouncilVerdict> {
    const deAnonymized = positions
      .map((p) => `**${p.advisor}:**\n${p.content}`)
      .join("\n\n");
    const reviewBody = reviews
      .map((r) => {
        const target = anonymization[r.strongestResponse] ?? r.strongestResponse;
        const blind = anonymization[r.biggestBlindSpot] ?? r.biggestBlindSpot;
        return (
          `Review by ${r.reviewer}:\n` +
          `- Strongest: ${r.strongestResponse} (${target}) — ${r.strongestReason}\n` +
          `- Biggest blind spot: ${r.biggestBlindSpot} (${blind}) — ${r.blindSpotDetail}\n` +
          `- Missed by all: ${r.missedByAll}`
        );
      })
      .join("\n\n");
    const content = await this.respond(
      [
        {
          role: "system",
          content:
            "You are the Chairman of an LLM Council. Your job is to synthesise the advisors' positions and their peer reviews into a final verdict. You may disagree with the majority if the reasoning supports it.",
        },
        {
          role: "user",
          content: `Original question:\n---\n${question}\n---\n\nAdvisor positions (de-anonymised):\n\n${deAnonymized}\n\nPeer reviews:\n\n${reviewBody}\n\nProduce the COUNCIL VERDICT with exactly these five headed sections:\n\nAGREEMENTS:\n- (points multiple advisors converged on independently)\n\nCLASHES:\n- (genuine disagreements — do not smooth them over)\n\nBLIND SPOTS:\n- (things only the peer-review round surfaced)\n\nRECOMMENDATION:\n(a clear, actionable recommendation — a real answer, not "it depends")\n\nNEXT ACTION:\n(the single concrete thing to do first)`,
        },
      ],
      "Chairman",
    );
    return parseCouncilVerdict(content);
  }

  /**
   * Phase 2b — llm-council-app v2's ranked review: every advisor ranks ALL
   * anonymised responses strongest→weakest and the council tallies the
   * Borda count, so the aggregate reflects whole preference orders rather
   * than top picks. Reuses the same seeded anonymisation as `review`.
   */
  async rankedReview(
    question: string,
    positions: readonly AdvisorPosition[],
    seed = 42,
  ): Promise<{ rankings: BordaRanking[]; tally: BordaResult; anonymization: Record<string, string> }> {
    const { positions: lettered, mapping } = anonymizePositions(positions, seed);
    const body = lettered
      .map((p) => `**Response ${p.letter}:**\n${p.content}`)
      .join("\n\n");
    const rankings = await Promise.all(
      this.advisors.map(async (a) => {
        const content = await this.respond(
          [
            {
              role: "system",
              content: `You are ${a.name} reviewing the outputs of an LLM Council. Your thinking style: ${a.thinkingStyle}.`,
            },
            {
              role: "user",
              content: `Five advisors independently answered this question:\n---\n${question}\n---\n\nHere are their anonymised responses:\n\n${body}\n\nRank ALL ${lettered.length} responses from strongest to weakest. Reply with just the letters in order, e.g. "B, A, D, C, E". Consider rigour, specificity, and blind spots — not agreement with your own style.`,
            },
          ],
          a.name,
        );
        return parseBordaRanking(a.name, content, lettered.length);
      }),
    );
    return { rankings, tally: tallyBorda(rankings), anonymization: mapping };
  }

  /**
   * Full flow + rankings: convene → anonymise → review → Borda tally →
   * synthesize. The chairman additionally sees the standings and whether the
   * council's preference is consensus or fragmented (v2's chairman-seating
   * distinction).
   */
  async runRanked(
    question: string,
    context?: string,
    seed = 42,
  ): Promise<DeliberativeOutcome & { tally: BordaResult }> {
    const positions = await this.convene(question, context);
    const { reviews, anonymization } = await this.review(question, positions, seed);
    const { tally } = await this.rankedReview(question, positions, seed);
    const verdict = await this.synthesizeRanked(question, positions, reviews, tally, anonymization);
    return { question, positions, anonymization, reviews, verdict, tally };
  }

  /** Synthesis with Borda standings in the chairman's briefing. */
  async synthesizeRanked(
    question: string,
    positions: readonly AdvisorPosition[],
    reviews: readonly PeerReview[],
    tally: BordaResult,
    anonymization: Record<string, string>,
  ): Promise<CouncilVerdict> {
    const winnerAdvisor = anonymization[tally.winner] ?? tally.winner;
    const verdict = await this.synthesize(question, positions, reviews, anonymization);
    return {
      ...verdict,
      recommendation: `${verdict.recommendation}\n\n[Borda tally: ${tally.strength} — Response ${tally.winner} (${winnerAdvisor}) leads with ${tally.standings[0]?.points ?? 0} pts]\n${formatBordaStandings(tally)}`,
    };
  }

  /** Full flow: convene → anonymise → review → synthesize. */
  async run(question: string, context?: string, seed = 42): Promise<DeliberativeOutcome> {
    const positions = await this.convene(question, context);
    const { reviews, anonymization } = await this.review(question, positions, seed);
    const verdict = await this.synthesize(question, positions, reviews, anonymization);
    return { question, positions, anonymization, reviews, verdict };
  }

  private async respond(
    messages: { role: "system" | "user"; content: string }[],
    _agent: string,
  ): Promise<string> {
    const res: ILLMResponse = await this.config.llm.chat(messages, {
      ...(this.config.model ? { model: this.config.model } : {}),
      temperature: 0.7,
      maxTokens: 1024,
    });
    return res.content;
  }
}

/** Text after the leading "<label>: " (or em-dash) of an answer line. */
function answerDetail(segment: string): string {
  const dash = segment.indexOf("—");
  if (dash >= 0) return segment.slice(dash + 1).trim();
  const colon = segment.indexOf(":");
  return colon >= 0 ? segment.slice(colon + 1).trim().replace(/^[.\s]+/, "") : segment.trim();
}

/**
 * Parse one reviewer's text into structured answers. Line/number tolerant:
 * each numbered answer line is matched by keyword and the letter reference is
 * extracted from the same line.
 */
export function parseReview(
  text: string,
): Pick<PeerReview, "strongestResponse" | "strongestReason" | "biggestBlindSpot" | "blindSpotDetail" | "missedByAll"> {
  const out = {
    strongestResponse: "",
    strongestReason: "",
    biggestBlindSpot: "",
    blindSpotDetail: "",
    missedByAll: "",
  };
  const segments = text
    .split(/\n+|(?=\d+[.)]\s)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const seg of segments) {
    // Keyword matching ignores a leading "1."/"2." number prefix.
    const head = seg.replace(/^\s*\d+[.)]\s*/, "");
    const lower = head.toLowerCase();
    const letter = /([A-E])\b/.exec(head)?.[1] ?? "";
    if (lower.startsWith("strongest")) {
      out.strongestResponse = letter || out.strongestResponse;
      out.strongestReason = answerDetail(head);
    } else if (lower.includes("blind spot")) {
      out.biggestBlindSpot = letter || out.biggestBlindSpot;
      out.blindSpotDetail = answerDetail(head);
    } else if (lower.includes("missed")) {
      out.missedByAll = answerDetail(head);
    }
  }
  return out;
}
