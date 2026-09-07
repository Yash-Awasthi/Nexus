// SPDX-License-Identifier: Apache-2.0
// Borda-tallied peer rankings (llm-council-app v2 parity) — focused tests for
// the pure tally core and the DeliberativeCouncil rankedReview/runRanked wiring.
import { describe, expect, it } from "vitest";
import {
  parseBordaRanking,
  tallyBorda,
  maxBordaPoints,
  formatBordaStandings,
} from "./borda.js";
import { DeliberativeCouncil } from "./deliberative.js";
import type { Archetype } from "./archetypes.js";
import type { ILLMResponse, ILLMTransport } from "./engine.js";

// ── parseBordaRanking ────────────────────────────────────────────────────────

describe("parseBordaRanking", () => {
  it("parses a comma-list ranking and dedupes", () => {
    const r = parseBordaRanking("Reviewer", "B, A, C, A, D", 4);
    expect(r.order).toEqual(["B", "A", "C", "D"]);
    expect(r.reviewer).toBe("Reviewer");
  });

  it("tolerates numbered lines and prose", () => {
    const r = parseBordaRanking(
      "R",
      "1. B — strongest grounding.\n2. A\n3. D\n4. C — weakest evidence.",
      4,
    );
    expect(r.order).toEqual(["B", "A", "D", "C"]);
  });

  it("accepts arrow chains and truncates to the expected count", () => {
    const r = parseBordaRanking("R", "B > A > C > D > E", 3);
    expect(r.order).toEqual(["B", "A", "C"]);
  });

  it("keeps the raw text for inspectability", () => {
    const raw = "B, A, C";
    expect(parseBordaRanking("R", raw, 3).raw).toBe(raw);
  });
});

// ── tallyBorda / maxBordaPoints ──────────────────────────────────────────────

describe("tallyBorda", () => {
  it("scores N−p points per position and sorts by points", () => {
    // 3 responses, 3 reviewers: first=2, second=1, third=0.
    const rankings = [
      parseBordaRanking("r1", "B, A, C", 3),
      parseBordaRanking("r2", "B, C, A", 3),
      parseBordaRanking("r3", "A, B, C", 3),
    ];
    const tally = tallyBorda(rankings);
    expect(maxBordaPoints(rankings)).toBe(6);
    expect(tally.winner).toBe("B");
    expect(tally.strength).toBe("consensus"); // gap 2 ≥ 0.1 × 6
    expect(tally.standings.map((s) => s.letter)).toEqual(["B", "A", "C"]);
    expect(tally.standings[0]).toMatchObject({ points: 5, firstPlaceVotes: 2 });
    expect(tally.standings[2]).toMatchObject({ points: 1, firstPlaceVotes: 0 });
    // meanPosition: B ranked 1st,1st,2nd → 4/3
    expect(tally.standings[0]!.meanPosition).toBeCloseTo(4 / 3, 5);
  });

  it("breaks point ties by first-place votes, then mean position, then letter", () => {
    const rankings = [
      parseBordaRanking("r1", "A, B", 2),
      parseBordaRanking("r2", "B, A", 2),
    ];
    const tally = tallyBorda(rankings);
    // Symmetric → identical points/firsts/meanPosition → alphabetical.
    expect(tally.standings.map((s) => s.letter)).toEqual(["A", "B"]);

    const firstPlaceWins = tallyBorda([
      parseBordaRanking("r1", "A, B", 2),
      parseBordaRanking("r2", "A, B", 2),
      parseBordaRanking("r3", "B, A", 2),
    ]);
    // A: 2+2+0 = 4 pts, 2 firsts; B: 0+0+2 = 2 pts, 1 first.
    expect(firstPlaceWins.winner).toBe("A");
    expect(firstPlaceWins.strength).toBe("consensus"); // gap 2 ≥ 0.1 × 6
  });

  it("marks a split council as fragmented", () => {
    const tally = tallyBorda([
      parseBordaRanking("r1", "A, B", 2),
      parseBordaRanking("r2", "B, A", 2),
    ]);
    expect(tally.strength).toBe("fragmented");
  });

  it("handles empty rankings without dividing by zero", () => {
    const tally = tallyBorda([]);
    expect(tally.standings).toEqual([]);
    expect(tally.winner).toBe("");
    expect(tally.strength).toBe("fragmented");
  });

  it("supports partial rankings (missing letters truncate)", () => {
    const tally = tallyBorda([parseBordaRanking("r1", "A, B, C", 5)]);
    // Only 3 letters ranked → n=3 per the ranking itself.
    expect(tally.standings.map((s) => s.letter)).toEqual(["A", "B", "C"]);
    expect(tally.standings[0]!.points).toBe(2);
    expect(maxBordaPoints([parseBordaRanking("r1", "A, B, C", 5)])).toBe(2);
  });
});

describe("formatBordaStandings", () => {
  it("renders one line per standing with points and first-place votes", () => {
    const tally = tallyBorda([
      parseBordaRanking("r1", "B, A", 2),
      parseBordaRanking("r2", "B, A", 2),
    ]);
    const text = formatBordaStandings(tally);
    expect(text.split("\n")).toHaveLength(2);
    expect(text).toContain("1. Response B — 2 pts (2 first-place");
    expect(text).toContain("2. Response A — 0 pts");
  });
});

// ── DeliberativeCouncil integration ──────────────────────────────────────────

const PANEL: Archetype[] = [
  {
    id: "arch",
    name: "The Architect",
    thinkingStyle: "systems and structure",
    asks: "what are the invariants?",
    blindSpot: "overengineering",
    systemPrompt: "You are The Architect.",
  },
  {
    id: "mini",
    name: "The Minimalist",
    thinkingStyle: "subtraction",
    asks: "what can go?",
    blindSpot: "underengineering",
    systemPrompt: "You are The Minimalist.",
  },
  {
    id: "skep",
    name: "The Skeptic",
    thinkingStyle: "evidence first",
    asks: "how do we know?",
    blindSpot: "analysis paralysis",
    systemPrompt: "You are The Skeptic.",
  },
];

const RANKINGS_BY_ADVISOR: Record<string, string> = {
  "The Architect": "B, A, C",
  "The Minimalist": "B, C, A",
  "The Skeptic": "A, B, C",
};

/** Transport recognising all four phases; rankings vary per advisor. */
function fakeRankedTransport(): ILLMTransport {
  return {
    async chat(messages): Promise<ILLMResponse> {
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      const user = messages.find((m) => m.role === "user")?.content ?? "";
      let content = "";
      if (user.includes("brought this question to the council")) {
        content = "Position: ship the smallest safe slice.";
      } else if (user.includes("Answer these three questions")) {
        content =
          "1. Strongest: B — grounded.\n2. Biggest blind spot: C — no fallback.\n3. Missed by all: timeline.";
      } else if (user.includes("Rank ALL")) {
        const advisor = /You are (.+?) reviewing/.exec(system)?.[1] ?? "";
        content = RANKINGS_BY_ADVISOR[advisor] ?? "A, B, C";
      } else if (user.includes("Produce the COUNCIL VERDICT")) {
        content =
          "AGREEMENTS:\n- scope it small\n\nCLASHES:\n- modularity now vs later\n\nBLIND SPOTS:\n- rollout risk\n\nRECOMMENDATION:\nShip behind a flag.\n\nNEXT ACTION:\nDraft the RFC.";
      }
      return {
        content,
        model: "fake",
        usage: { promptTokens: 5, completionTokens: 10 },
        latencyMs: 1,
      };
    },
  };
}

describe("DeliberativeCouncil ranked review (llm-council-app v2)", () => {
  it("rankedReview anonymises, collects full rankings per advisor, and tallies", async () => {
    const council = new DeliberativeCouncil({ llm: fakeRankedTransport(), advisors: PANEL });
    const positions = await council.convene("How do we roll out the feature?");
    const { rankings, tally, anonymization } = await council.rankedReview(
      "How do we roll out the feature?",
      positions,
    );

    expect(rankings).toHaveLength(3);
    expect(rankings.map((r) => r.order)).toEqual([
      ["B", "A", "C"],
      ["B", "C", "A"],
      ["A", "B", "C"],
    ]);
    expect(tally.winner).toBe("B");
    expect(tally.strength).toBe("consensus");
    // Winner de-anonymises through the same seeded mapping as the review phase.
    expect(anonymization["B"]).toBeTruthy();
    expect(Object.keys(anonymization)).toEqual(["A", "B", "C"]);
  });

  it("runRanked appends the tally to the chairman's recommendation", async () => {
    const council = new DeliberativeCouncil({ llm: fakeRankedTransport(), advisors: PANEL });
    const outcome = await council.runRanked("How do we roll out the feature?");

    expect(outcome.tally.winner).toBe("B");
    expect(outcome.verdict.agreements).toContain("scope it small");
    expect(outcome.verdict.recommendation).toContain("[Borda tally: consensus");
    expect(outcome.verdict.recommendation).toContain(`Response B (${outcome.anonymization["B"]})`);
    // The v1 flow stays intact alongside.
    expect(outcome.reviews).toHaveLength(3);
  });

  it("run() without rankings is unchanged (back-compatible)", async () => {
    const council = new DeliberativeCouncil({ llm: fakeRankedTransport(), advisors: PANEL });
    const outcome = await council.run("q");
    expect("tally" in outcome).toBe(false);
    expect(outcome.verdict.recommendation).not.toContain("[Borda tally");
  });
});
