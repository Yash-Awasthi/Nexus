// SPDX-License-Identifier: Apache-2.0
/**
 * The cost report is read in a meeting, so the properties that matter are arithmetic and honesty rather than
 * formatting: the four tables must be four views of the same money, a month must mean one month, and spend nobody
 * can attribute must be visible instead of absorbed.
 *
 * The attribution itself is tested where it is created — `trackCost` reads an AsyncLocalStorage scope — because the
 * failure mode is silent: a family that stops being tagged leaves the totals right and the breakdown wrong.
 */
import { describe, expect, it, vi } from "vite-plus/test";

import { familyOf } from "../../src/lib/cost-attribution.ts";
import { trackCost } from "../../src/lib/cost-log.ts";
import { costLogStore } from "../../src/lib/cost-log.ts";
import {
  buildCostReport,
  latestMonth,
  monthOf,
  renderCostReport,
  silentFamilies,
} from "../../src/lib/cost-report.ts";
import { withCostScope } from "../../src/lib/cost-attribution.ts";
import type { CostEntry } from "../../src/lib/cost-log.ts";

const entry = (over: Partial<CostEntry> = {}): CostEntry => ({
  ts: "2026-11-14T10:00:00.000Z",
  model: "llama-3.3-70b-versatile:groq",
  inputTokens: 1_000,
  outputTokens: 500,
  costUsd: 0.01,
  userId: "u1",
  ...over,
});

describe("familyOf", () => {
  it("classifies by route template, ignoring ids and query strings", () => {
    expect(familyOf("/chat/stream")).toBe("chat");
    expect(familyOf("/council/deliberate")).toBe("council");
    expect(familyOf("/org/companies/:id/budgets")).toBe("org");
    expect(familyOf("/agents/wake?x=1")).toBe("agent");
    expect(familyOf("/workflows/123/run")).toBe("agent");
    expect(familyOf("/kb/search")).toBe("knowledge");
  });

  it("prefers the longest prefix, so an org agent route is org and not agent", () => {
    expect(familyOf("/org/agents/wake")).toBe("org");
    expect(familyOf("/agents/wake")).toBe("agent");
  });

  it("says other rather than guessing at an unknown route", () => {
    expect(familyOf("/something-new")).toBe("other");
    expect(familyOf(undefined)).toBe("other");
  });
});

describe("attribution at the call site", () => {
  it("stamps the family from the current scope onto the recorded entry", () => {
    const record = vi.spyOn(costLogStore, "record");
    withCostScope({ family: "chat" }, () =>
      trackCost("llama-3.3-70b-versatile", { inputTokens: 10, outputTokens: 5 }),
    );
    const written = record.mock.calls.at(-1)?.[0] as CostEntry;
    expect(written.family).toBe("chat");
    expect(written.companyId).toBeUndefined();
    record.mockRestore();
  });

  it("carries a company when the call site knows one, and leaves it off when it does not", () => {
    const record = vi.spyOn(costLogStore, "record");
    withCostScope({ family: "org", companyId: "co-1" }, () =>
      trackCost("llama-3.3-70b-versatile", { inputTokens: 10, outputTokens: 5 }),
    );
    expect((record.mock.calls.at(-1)?.[0] as CostEntry).companyId).toBe("co-1");

    withCostScope({ family: "chat" }, () =>
      trackCost("llama-3.3-70b-versatile", { inputTokens: 10, outputTokens: 5 }),
    );
    expect((record.mock.calls.at(-1)?.[0] as CostEntry).companyId).toBeUndefined();
    record.mockRestore();
  });

  it("records no family outside a request, which the report shows as unattributed", () => {
    const record = vi.spyOn(costLogStore, "record");
    trackCost("llama-3.3-70b-versatile", { inputTokens: 10, outputTokens: 5 });
    expect((record.mock.calls.at(-1)?.[0] as CostEntry).family).toBeUndefined();
    record.mockRestore();
  });
});

describe("buildCostReport", () => {
  const entries = [
    entry({ family: "chat", costUsd: 1, userId: "u1" }),
    entry({ family: "council", costUsd: 2, userId: "u1" }),
    entry({ family: "org", costUsd: 4, userId: "u2", companyId: "co-1" }),
    entry({ costUsd: 8, userId: undefined, companyId: undefined }),
    entry({ family: "chat", costUsd: 16, ts: "2026-10-02T00:00:00.000Z" }),
  ];

  it("counts one month and reads the totals off the same rows", () => {
    const report = buildCostReport(entries, { month: "2026-11" });
    expect(report.entries).toBe(4);
    expect(report.usd).toBeCloseTo(15, 6);
    expect(report.requests).toBe(4);
    // The October row is not in November, and its spend is not in the total.
    expect(report.usd).not.toBeCloseTo(31, 6);
  });

  it("keeps the four tables as four views of one total", () => {
    const report = buildCostReport(entries, { month: "2026-11" });
    for (const table of [report.byUser, report.byCompany, report.byFamily, report.byModel])
      expect(table.reduce((sum, row) => sum + row.usd, 0)).toBeCloseTo(report.usd, 6);
  });

  it("shows unattributed spend instead of folding it into a family", () => {
    const report = buildCostReport(entries, { month: "2026-11" });
    expect(report.unattributedUsd).toBeCloseTo(8, 6);
    expect(report.byFamily.map((row) => row.key)).toContain("unattributed");
    expect(report.byFamily.find((row) => row.key === "unattributed")?.usd).toBeCloseTo(8, 6);
  });

  it("lists families in a fixed order so a family that stopped being used is still a row", () => {
    const report = buildCostReport(entries, { month: "2026-11" });
    expect(report.byFamily.map((row) => row.key)).toEqual([
      "chat",
      "council",
      "org",
      "unattributed",
    ]);
    expect(silentFamilies(report)).toEqual(["agent", "knowledge", "other"]);
  });

  it("sorts users and models by spend, because the top line is the answer", () => {
    const report = buildCostReport(entries, { month: "2026-11" });
    expect(report.byUser[0]?.usd).toBeGreaterThanOrEqual(report.byUser[1]?.usd ?? 0);
    expect(report.byModel[0]?.requests).toBeGreaterThan(0);
  });

  it("counts unpriced models separately rather than pretending they cost nothing", () => {
    const report = buildCostReport([entry({ pricingKnown: false, costUsd: 0 })], {
      month: "2026-11",
    });
    expect(report.unpricedUsd.entries).toBe(1);
    expect(report.usd).toBe(0);
    expect(renderCostReport(report)).toContain("no price row");
  });

  it("defaults to the newest month present, and to this month when the log is empty", () => {
    expect(latestMonth(entries)).toBe("2026-11");
    expect(latestMonth([], new Date("2026-12-05T00:00:00.000Z"))).toBe("2026-12");
    expect(monthOf("2026-11-30T23:59:59.999Z")).toBe("2026-11");
  });

  it("prints the caveats, because a bare table invites the wrong conclusion", () => {
    const text = renderCostReport(buildCostReport(entries, { month: "2026-11" }));
    expect(text).toContain("Cost report — 2026-11 (UTC)");
    expect(text).toContain("By route family");
    expect(text).toContain("Unattributed:");
    expect(text).toContain("53.3%");
  });

  it("says nothing recorded rather than printing an empty table", () => {
    const text = renderCostReport(buildCostReport([], { month: "2026-01" }));
    expect(text).toContain("nothing recorded");
    expect(text).not.toContain("NaN");
  });
});
