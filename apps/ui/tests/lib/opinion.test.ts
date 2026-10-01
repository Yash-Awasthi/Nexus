// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { opinionParts, verdictParts } from "~/lib/opinion";

describe("opinionParts", () => {
  it("splits a member's stream at each debate round and pulls out the final answer", () => {
    const text =
      "Opening view.\n\n――― round 2 (sees other members' answers) ―――\nRevised view.\n\nFINAL: Ship it.";
    expect(opinionParts(text)).toEqual([
      { body: "Opening view." },
      { body: "Revised view.", final: "Ship it." },
    ]);
  });

  it("reads a bold final marker", () => {
    expect(opinionParts("Reasoning.\n**FINAL:** Wait a quarter.")).toEqual([
      { body: "Reasoning.", final: "Wait a quarter." },
    ]);
  });

  it("leaves plain text whole", () => {
    expect(opinionParts("Just an answer.")).toEqual([{ body: "Just an answer." }]);
  });
});

describe("verdictParts", () => {
  it("turns the agreement line into a status and keeps the synthesis", () => {
    expect(
      verdictParts(
        "Debate complete (2 rounds): 2/3 members converged — Ship it.\n\n**Answer:** Ship.",
      ),
    ).toEqual({ status: "2 of 3 members converged", body: "**Answer:** Ship." });
  });

  it("names a split council plainly", () => {
    expect(
      verdictParts(
        "Debate complete (2 rounds): no majority position — the 2 member(s) that answered did not converge.",
      ).status,
    ).toBe("No majority — the members did not converge");
  });

  it("keeps who agrees and who does not, and reads an early stop", () => {
    expect(
      verdictParts(
        "Debate complete (stopped after 1 of 2 rounds): 2/3 members converged (agree: A, B; disagree: C says wait) — Ship.\n\n**Answer:** Ship.",
      ).status,
    ).toBe("2 of 3 members converged (agree: A, B; disagree: C says wait)");
    expect(
      verdictParts(
        "Debate complete (2 rounds): no majority position (A: adopt; B: do not adopt) — the 2 member(s) that answered did not converge.",
      ).status,
    ).toBe("No majority (A: adopt; B: do not adopt)");
  });

  it("passes a verdict without an agreement line through", () => {
    expect(verdictParts("**Answer:** Yes.")).toEqual({ body: "**Answer:** Yes." });
  });
});
