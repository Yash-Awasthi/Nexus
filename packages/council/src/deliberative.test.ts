// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { ARCHETYPES } from "./archetypes.js";
import {
  DeliberativeCouncil,
  anonymizePositions,
  parseCouncilVerdict,
  parseReview,
} from "./deliberative.js";
import type { ILLMResponse, ILLMTransport } from "./engine.js";

/** Deterministic transport: phases are recognised from the user prompt. */
function fakeTransport(): ILLMTransport {
  const calls: string[] = [];
  return {
    async chat(messages): Promise<ILLMResponse> {
      const user = messages.find((m) => m.role === "user")?.content ?? "";
      calls.push(user.slice(0, 60));
      let content = "";
      if (user.includes("brought this question to the council")) {
        // Convene phase — one position per advisor.
        content = "Position: the plan is workable if scoped tightly.";
      } else if (user.includes("advisors independently answered this question")) {
        // Review phase — letters referenced per the reviewer prompt.
        content =
          "1. Strongest: B — grounded in the evidence.\n" +
          "2. Biggest blind spot: D — it ignores rollout cost.\n" +
          "3. Missed by all: the timeline is unrealistic.";
      } else if (user.includes("Produce the COUNCIL VERDICT")) {
        content =
          "AGREEMENTS:\n" +
          "- everyone agrees scope matters\n" +
          "- two advisors independently flagged cost\n" +
          "\n" +
          "CLASHES:\n" +
          "- The Architect wants modularity now; the Minimalist wants to defer it\n" +
          "\n" +
          "BLIND SPOTS:\n" +
          "- only the review round surfaced the rollout risk\n" +
          "\n" +
          "RECOMMENDATION:\n" +
          "Start small and ship the module behind a flag.\n" +
          "\n" +
          "NEXT ACTION:\n" +
          "Draft the RFC this week.";
      }
      return {
        content,
        model: "fake",
        usage: { promptTokens: 10, completionTokens: 20 },
        latencyMs: 1,
      };
    },
    get calls() {
      return calls;
    },
  };
}

describe("anonymizePositions", () => {
  const positions = [
    { advisor: "A1", content: "one" },
    { advisor: "A2", content: "two" },
    { advisor: "A3", content: "three" },
    { advisor: "A4", content: "four" },
    { advisor: "A5", content: "five" },
  ];

  it("is a bijective letter mapping, deterministic per seed", () => {
    const { positions: lettered, mapping } = anonymizePositions(positions, 7);
    expect(lettered.map((p) => p.letter).sort()).toEqual(["A", "B", "C", "D", "E"]);
    expect(Object.keys(mapping).sort()).toEqual(["A", "B", "C", "D", "E"]);
    expect(new Set(Object.values(mapping)).size).toBe(5); // each advisor once
    // Same seed → same mapping; contents travel with the letter.
    const again = anonymizePositions(positions, 7);
    expect(again.mapping).toEqual(mapping);
    const first = anonymizePositions(positions, 7).positions[0]!;
    const owner = positions.find((p) => p.advisor === mapping[first.letter]);
    expect(first.content).toBe(owner!.content);
  });
});

describe("parseCouncilVerdict", () => {
  it("extracts the five verdict sections", () => {
    const raw =
      "AGREEMENTS:\n- a\n- b\n\nCLASHES:\n- c vs d\n\nBLIND SPOTS:\n- e\n\nRECOMMENDATION:\nDo X.\n\nNEXT ACTION:\nDo Y first.";
    const v = parseCouncilVerdict(raw);
    expect(v.agreements).toEqual(["a", "b"]);
    expect(v.clashes).toEqual(["c vs d"]);
    expect(v.blindSpots).toEqual(["e"]);
    expect(v.recommendation).toBe("Do X.");
    expect(v.nextAction).toBe("Do Y first.");
    expect(v.raw).toBe(raw);
  });

  it("tolerates missing sections and bullet prefixes", () => {
    const v = parseCouncilVerdict("AGREEMENTS:\n- just one");
    expect(v.agreements).toEqual(["just one"]);
    expect(v.clashes).toEqual([]);
    expect(v.blindSpots).toEqual([]);
    expect(v.recommendation).toBe("");
  });
});

describe("parseReview", () => {
  it("extracts letter references and details per answer line", () => {
    const r = parseReview(
      "1. Strongest: B — grounded in the evidence.\n" +
        "2. Biggest blind spot: D — ignores rollout cost.\n" +
        "3. Missed by all: the timeline is unrealistic.",
    );
    expect(r.strongestResponse).toBe("B");
    expect(r.strongestReason).toContain("grounded");
    expect(r.biggestBlindSpot).toBe("D");
    expect(r.blindSpotDetail).toContain("rollout cost");
    expect(r.missedByAll).toContain("timeline");
  });
});

describe("DeliberativeCouncil", () => {
  it("runs convene → anonymised review → chairman verdict end to end", async () => {
    const llm = fakeTransport();
    const council = new DeliberativeCouncil({
      llm,
      advisors: [
        ARCHETYPES.contrarian,
        ARCHETYPES.architect,
        ARCHETYPES.empiricist,
        ARCHETYPES.pragmatist,
        ARCHETYPES.ethicist,
      ],
    });

    const outcome = await council.run("Should we adopt a monorepo?", undefined, 11);

    // Convene: 5 independent positions from the 5 panel advisors.
    expect(outcome.positions).toHaveLength(5);
    expect(outcome.positions.map((p) => p.advisor)).toEqual([
      "The Contrarian",
      "The Architect",
      "The Empiricist",
      "The Pragmatist",
      "The Ethicist",
    ]);
    for (const p of outcome.positions) expect(p.content.length).toBeGreaterThan(0);

    // Review: one review per advisor, all letters are valid and reviewers named.
    expect(outcome.reviews).toHaveLength(5);
    for (const r of outcome.reviews) {
      expect(r.reviewer.length).toBeGreaterThan(0);
      expect(r.strongestResponse).toHaveLength(1);
      expect("ABCDE".includes(r.strongestResponse)).toBe(true);
      expect(r.biggestBlindSpot).toHaveLength(1);
      expect("ABCDE".includes(r.biggestBlindSpot)).toBe(true);
      expect(r.strongestReason.length).toBeGreaterThan(0);
    }

    // The anonymization mapping is a permutation of the advisor names.
    const mappedNames = Object.values(outcome.anonymization);
    expect([...mappedNames].sort()).toEqual(
      [
        "The Contrarian",
        "The Architect",
        "The Empiricist",
        "The Pragmatist",
        "The Ethicist",
      ].sort(),
    );

    // Verdict parsed into the five structured fields.
    expect(outcome.verdict.agreements).toHaveLength(2);
    expect(outcome.verdict.clashes).toHaveLength(1);
    expect(outcome.verdict.blindSpots).toHaveLength(1);
    expect(outcome.verdict.recommendation).toContain("Start small");
    expect(outcome.verdict.nextAction).toContain("RFC");
  });
});
