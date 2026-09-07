// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { Glicko2System } from "./index";

describe("Glicko2System", () => {
  it("matches Glickman's canonical worked example (paper §4.1)", () => {
    // Player: rating 1500, RD 200, volatility 0.06.
    // Opponents: (1400, RD 30, win), (1550, RD 100, loss), (1700, RD 300, loss).
    // Paper result: rating ≈ 1464.06, RD ≈ 151.52, volatility ≈ 0.05999.
    const system = new Glicko2System({ rating: 1500, rd: 200, vol: 0.06 });
    const a = system.makePlayer("A", "Player A", 1500, 200, 0.06);
    const o1 = system.makePlayer("O1", "O1", 1400, 30, 0.06);
    const o2 = system.makePlayer("O2", "O2", 1550, 100, 0.06);
    const o3 = system.makePlayer("O3", "O3", 1700, 300, 0.06);

    system.updateRatings([
      { winnerId: "A", loserId: "O1", draw: false, timestamp: 1 },
      { winnerId: "O2", loserId: "A", draw: false, timestamp: 1 },
      { winnerId: "O3", loserId: "A", draw: false, timestamp: 1 },
    ]);

    expect(a.rating).toBeCloseTo(1464.06, 0);
    expect(a.ratingDeviation).toBeCloseTo(151.52, 0);
    expect(a.volatility).toBeCloseTo(0.05999, 2);

    expect(system.hasPlayed("A")).toBe(true);
    void o1;
    void o2;
    void o3;
  });

  it("tracks cumulative match history (matches / wins / winRate)", () => {
    const system = new Glicko2System();
    const a = system.makePlayer("A", "A");
    const b = system.makePlayer("B", "B");

    system.recordMatch({ winnerId: "A", loserId: "B", draw: false, timestamp: 1 });
    system.recordMatch({ winnerId: "A", loserId: "B", draw: false, timestamp: 2 });
    system.recordMatch({ winnerId: "B", loserId: "A", draw: false, timestamp: 3 });

    const [aStats] = system.getLeaderboard();
    expect(aStats.matches).toBe(3);
    expect(aStats.winRate).toBeCloseTo(2 / 3, 5);
  });

  it("handles draws as 0.5 outcomes for both players", () => {
    const system = new Glicko2System();
    const a = system.makePlayer("A", "A");
    const b = system.makePlayer("B", "B");

    system.recordMatch({ winnerId: "A", loserId: "B", draw: true, timestamp: 1 });

    expect(a.rating).toBe(1500); // draw against equal rating → no movement
    expect(b.rating).toBe(1500);
    expect(a.ratingDeviation).toBeLessThan(350);
    expect(b.ratingDeviation).toBeLessThan(350);
    expect(system.getLeaderboard()[0]!.matches).toBe(1);
  });

  it("immediate recordMatch treats each call as its own rating period (no double-apply)", () => {
    const system = new Glicko2System();
    const a = system.makePlayer("A", "A");
    const b = system.makePlayer("B", "B");
    const c = system.makePlayer("C", "C");

    system.recordMatch({ winnerId: "A", loserId: "B", draw: false, timestamp: 1 });
    const afterFirst = a.rating;
    system.recordMatch({ winnerId: "A", loserId: "C", draw: false, timestamp: 2 });

    // A's second win moves from the post-first-match rating, not from 1500 twice.
    expect(a.rating).toBeGreaterThan(afterFirst);
    expect(a.rating).toBeGreaterThan(1500);
    expect(b.rating).toBeLessThan(1500);
    expect(c.rating).toBeLessThan(1500);
  });

  it("orders the leaderboard by rating and exports/imports players", () => {
    const system = new Glicko2System();
    system.makePlayer("A", "A", 1600);
    system.makePlayer("B", "B", 1400);
    system.makePlayer("C", "C", 1500);

    const board = system.getLeaderboard();
    expect(board.map((s) => s.name)).toEqual(["A", "C", "B"]);

    const clone = new Glicko2System();
    clone.import(system.export());
    expect(clone.getPlayer("A")?.rating).toBe(1600);
  });

  it("predicts a favourite winning more often than an underdog", () => {
    const system = new Glicko2System();
    system.makePlayer("strong", "strong", 1800);
    system.makePlayer("weak", "weak", 1200);

    const { winnerProb, loserProb } = system.predict("strong", "weak");
    expect(winnerProb).toBeGreaterThan(0.9);
    expect(loserProb).toBeLessThan(0.1);
  });
});