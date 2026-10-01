// SPDX-License-Identifier: Apache-2.0
/**
 * Stage D2 — the verdict is accurate or absent.
 *
 * The replaced code grouped raw completion strings, so `bestCount` was 1 for
 * every real deliberation. These tests pin the two cases that matters: real
 * agreement is counted, and disagreement produces no majority claim at all.
 */
import { describe, it, expect } from "vitest";

import { extractFinalAnswer, answerSimilarity, scoreAgreement } from "./agreement.js";

describe("extractFinalAnswer", () => {
  it("takes the explicit FINAL line", () => {
    const text = "Long analysis here.\n\nMore analysis.\n\nFINAL: Ship it behind a flag.";
    expect(extractFinalAnswer(text)).toBe("Ship it behind a flag.");
  });

  it("reads a FINAL line through markdown emphasis", () => {
    expect(extractFinalAnswer("body\n\n**Final Answer:** Do not ship.")).toBe("Do not ship.");
  });

  it("falls back to the last paragraph when the model ignored the instruction", () => {
    const text = "First thought.\n\nSecond thought.\n\nOn balance, ship it behind a flag.";
    expect(extractFinalAnswer(text)).toBe("On balance, ship it behind a flag.");
  });
});

describe("answerSimilarity", () => {
  it("scores differently-worded versions of one position as similar", () => {
    const a = "Ship it behind a feature flag.";
    const b = "Ship behind a feature flag.";
    expect(answerSimilarity(a, b)).toBeGreaterThanOrEqual(0.6);
  });

  it("scores opposite positions as dissimilar", () => {
    expect(
      answerSimilarity("Ship it now.", "Delay the launch until the audit closes."),
    ).toBeLessThan(0.6);
  });
});

describe("scoreAgreement", () => {
  it("counts members who reached the same position in different words", () => {
    const result = scoreAgreement([
      { label: "A", text: "Analysis.\n\nFINAL: Ship it behind a feature flag." },
      { label: "B", text: "Different analysis.\n\nFINAL: Ship behind a feature flag." },
      { label: "C", text: "Other analysis.\n\nFINAL: Delay the launch until the audit closes." },
    ]);
    expect(result).not.toBeNull();
    expect(result?.agreeing.sort()).toEqual(["A", "B"]);
    expect(result?.total).toBe(3);
    expect(result?.agreement).toBeCloseTo(0.67, 2);
  });

  it("reports no majority when every member disagrees", () => {
    expect(
      scoreAgreement([
        { label: "A", text: "FINAL: Ship it now." },
        { label: "B", text: "FINAL: Delay the launch until the audit closes." },
        { label: "C", text: "FINAL: Rewrite the module in another language first." },
      ]),
    ).toBeNull();
  });

  it("reports no majority for a single responding member", () => {
    expect(scoreAgreement([{ label: "A", text: "FINAL: Ship it." }])).toBeNull();
  });

  it("does not treat byte-identical prose as the only form of agreement", () => {
    // The exact case the old implementation got wrong: same position, different
    // prose, counted as one vote each and reported as "1/2 members".
    const result = scoreAgreement([
      { label: "A", text: "FINAL: The migration should run in two phases." },
      { label: "B", text: "FINAL: Run the migration in two phases." },
    ]);
    expect(result?.agreeing).toHaveLength(2);
    expect(result?.agreement).toBe(1);
  });
});
