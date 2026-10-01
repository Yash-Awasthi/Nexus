// SPDX-License-Identifier: Apache-2.0
/** The documented SDK: a council of drivers, each with a weight, voting on a question. */
import { describe, expect, it } from "vitest";

import { Council } from "../src/index.js";

const member = (reply: string) => ({
  provider: "fake",
  model: "fake-model",
  calls: 0,
  async complete() {
    this.calls++;
    return { content: reply };
  },
});

describe("Council", () => {
  it("weighs each member's vote by its weight in weighted mode", async () => {
    const yes = member("YES, refactor it. Confidence: 0.9");
    const no = member("NO, leave it. Confidence: 0.9");
    const council = new Council({
      members: [
        { driver: yes, weight: 1 },
        { driver: no, weight: 2 },
      ],
      mode: "weighted",
    });
    const { consensus, votes, outcome } = await council.deliberate("Should we refactor auth?");
    expect(yes.calls + no.calls).toBe(2);
    expect(votes.map((v) => v.vote)).toEqual(["yes", "no"]);
    expect(consensus).toBeCloseTo(1 / 3, 2);
    expect(outcome).toBe("rejected");
  });

  it("counts heads in majority mode", async () => {
    const council = new Council({
      members: [{ driver: member("YES") }, { driver: member("YES") }, { driver: member("NO") }],
    });
    const { outcome, consensus } = await council.deliberate("Ship it?");
    expect(outcome).toBe("approved");
    expect(consensus).toBeCloseTo(2 / 3, 2);
  });

  it("records a failing member as an abstention", async () => {
    const broken = {
      provider: "down",
      model: "m",
      async complete(): Promise<{ content: string }> {
        throw new Error("offline");
      },
    };
    const { votes } = await new Council({
      members: [{ driver: member("YES") }, { driver: broken }],
      mode: "unanimous",
    }).deliberate("Ship it?");
    expect(votes[1]).toMatchObject({ vote: "abstain", provider: "down" });
  });
});
