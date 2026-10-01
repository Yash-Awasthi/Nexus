// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { COUNCIL_TEMPLATES } from "./archetypes.js";
import { parsePortfolioRating, summarizeRatings } from "./engine.js";

describe("parsePortfolioRating", () => {
  it("reads the labelled rating line first", () => {
    expect(parsePortfolioRating("Buyers are cautious.\nRATING: Underweight")).toBe("Underweight");
    expect(parsePortfolioRating("**Rating:** strong buy")).toBe("Buy");
  });

  it("does not mistake a negation or a longer word for a rating", () => {
    expect(parsePortfolioRating("I would not sell yet; hold for now.")).toBe("Hold");
    expect(parsePortfolioRating("The buyer market is thin. Overweight.")).toBe("Overweight");
    expect(parsePortfolioRating("No view.")).toBe("Hold");
  });
});

describe("summarizeRatings", () => {
  it("averages the members' signals into one rating", () => {
    const s = summarizeRatings([
      { label: "A", text: "RATING: Buy" },
      { label: "B", text: "RATING: Overweight" },
      { label: "C", text: "RATING: Sell" },
    ]);
    expect(s.ratings.map((r) => `${r.label}:${r.rating}:${r.signal}`)).toEqual([
      "A:Buy:2",
      "B:Overweight:1",
      "C:Sell:-2",
    ]);
    expect(s.average).toBeCloseTo(1 / 3);
    expect(s.consensus).toBe("Hold");
    expect(s.line).toBe("Ratings: A Buy, B Overweight, C Sell · average +0.33 (Hold)");
  });
});

describe("COUNCIL_TEMPLATES", () => {
  it("has an investment council whose members give a rating", () => {
    const t = COUNCIL_TEMPLATES.investment!;
    expect(t.rating).toBe(true);
    expect(t.memberPrompts.every((p) => /RATING:/.test(p))).toBe(true);
  });
});
