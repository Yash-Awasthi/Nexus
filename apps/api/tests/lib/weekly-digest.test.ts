// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";

import { getSharedKV } from "../../src/lib/shared-kv.js";
import {
  maybeEmitWeeklyDigest,
  weekKey,
  type WeeklyStats,
} from "../../src/lib/weekly-digest.js";

const SOME_STATS: WeeklyStats = {
  requests: 12,
  tokens: 2200,
  costUsd: 0.32,
  topModel: "groq/llama-3.1-8b-instant",
  researchCount: 1,
  autopilotRuns: 0,
};

const ZERO_STATS: WeeklyStats = {
  requests: 0,
  tokens: 0,
  costUsd: 0,
  researchCount: 0,
  autopilotRuns: 0,
};

beforeEach(async () => {
  await getSharedKV().clear();
});

describe("weekly-digest", () => {
  it("weekKey returns the Monday of the current week, across month boundaries", () => {
    // Sunday 2026-09-06 → Monday 2026-08-31
    expect(weekKey(new Date("2026-09-06T12:00:00Z"))).toBe("2026-08-31");
    // Monday 2026-09-07 → itself
    expect(weekKey(new Date("2026-09-07T12:00:00Z"))).toBe("2026-09-07");
    // Wednesday 2026-09-09 → Monday 2026-09-07
    expect(weekKey(new Date("2026-09-09T12:00:00Z"))).toBe("2026-09-07");
  });

  it("emits on first access of a week and reports the completed calendar week", async () => {
    let seen: { start: string; end: string } | null = null;
    const n = await maybeEmitWeeklyDigest(
      "user-1",
      async (start, end) => {
        seen = { start, end };
        return SOME_STATS;
      },
      new Date("2026-09-07T12:00:00Z"), // Monday
    );
    expect(n).not.toBeNull();
    expect(n!.type).toBe("digest");
    expect(n!.title).toBe("Your week in Nexus");
    expect(n!.message).toContain("12 requests");
    expect(n!.message).toContain("1 deep research run");
    expect(n!.message).toContain("$0.32");
    expect(n!.message).toContain("groq/llama-3.1-8b-instant");
    // Window is the completed week before now (Mon Sep 7): Aug 31 … Sep 6
    expect(seen).toEqual({ start: "2026-08-31", end: "2026-09-07" });
  });

  it("does not double-emit within the same week", async () => {
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return SOME_STATS;
    };
    const now = new Date("2026-09-07T12:00:00Z");
    await maybeEmitWeeklyDigest("user-1", compute, now);
    const again = await maybeEmitWeeklyDigest("user-1", compute, now);
    expect(again).toBeNull();
    expect(calls).toBe(1);
  });

  it("marks a quiet week silently (no notification, no recompute on next load)", async () => {
    const compute = async () => ZERO_STATS;
    const now = new Date("2026-09-07T12:00:00Z");
    const n = await maybeEmitWeeklyDigest("user-1", compute, now);
    expect(n).toBeNull();
    // Same week again → still no compute and no notification.
    const again = await maybeEmitWeeklyDigest("user-1", compute, now);
    expect(again).toBeNull();
  });

  it("emits again when the week rolls over", async () => {
    const compute = async () => SOME_STATS;
    const week1 = new Date("2026-09-07T12:00:00Z"); // Mon Sep 7
    await maybeEmitWeeklyDigest("user-1", compute, week1);
    const week2 = new Date("2026-09-14T12:00:00Z"); // Mon Sep 14
    const n = await maybeEmitWeeklyDigest("user-1", compute, week2);
    expect(n).not.toBeNull();
  });

  it("scopes the marker per user — two users each get their own digest", async () => {
    const compute = async () => SOME_STATS;
    const now = new Date("2026-09-07T12:00:00Z");
    await maybeEmitWeeklyDigest("alice", compute, now);
    const bob = await maybeEmitWeeklyDigest("bob", compute, now);
    expect(bob).not.toBeNull();
    const aliceAgain = await maybeEmitWeeklyDigest("alice", compute, now);
    expect(aliceAgain).toBeNull();
  });
});