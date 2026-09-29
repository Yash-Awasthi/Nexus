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

  it("reads 7 as Sunday", () => {
    expect(cronMatches("0 9 * * 7", new Date(2026, 8, 27, 9, 0))).toBe(true);
    expect(cronMatches("0 9 * * 5-7", new Date(2026, 8, 27, 9, 0))).toBe(true);
  });

  it("fires on either day field when both are restricted, as cron does", () => {
    // 1st of the month or a Monday; 28 Sep 2026 is a Monday, 1 Oct a Thursday.
    expect(cronMatches("0 9 1 * 1", new Date(2026, 8, 28, 9, 0))).toBe(true);
    expect(cronMatches("0 9 1 * 1", new Date(2026, 9, 1, 9, 0))).toBe(true);
    expect(cronMatches("0 9 1 * 1", new Date(2026, 8, 29, 9, 0))).toBe(false);
    expect(cronMatches("0 9 1-7 * *", new Date(2026, 8, 28, 9, 0))).toBe(false);
  });

  it("finds a leap day more than a year away", () => {
    expect(nextCronRun("0 0 29 2 *", new Date(2026, 8, 28))).toEqual(new Date(2028, 1, 29, 0, 0));
  });

  it("returns null for a date that never comes", () => {
    const t = Date.now();
    expect(nextCronRun("0 0 31 2 *", new Date(2026, 8, 28))).toBeNull();
    expect(Date.now() - t).toBeLessThan(1000);
  });
});
