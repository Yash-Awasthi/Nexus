// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import { cronMatches, nextCronRun, parseCron } from "../src/index.js";

describe("cron", () => {
  it("rejects malformed expressions", () => {
    for (const bad of ["* * * *", "60 * * * *", "*/0 * * * *", "a * * * *", "5-1 * * * *"]) {
      expect(parseCron(bad)).toBeNull();
    }
  });

  it("matches steps, ranges and lists", () => {
    const at = new Date(2026, 8, 28, 14, 30); // Monday 28 Sep 2026, 14:30
    expect(cronMatches("*/15 * * * *", at)).toBe(true);
    expect(cronMatches("30 9-17 * * 1-5", at)).toBe(true);
    expect(cronMatches("30 14 * * 0,6", at)).toBe(false);
  });

  it("finds the next run", () => {
    const next = nextCronRun("0 9 * * *", new Date(2026, 8, 28, 14, 30));
    expect(next).toEqual(new Date(2026, 8, 29, 9, 0));
  });
});
