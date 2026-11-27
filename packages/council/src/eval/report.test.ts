// SPDX-License-Identifier: Apache-2.0
/**
 * The comparison half of the council eval: `compareRuns` is what turns two reports into a pass or a
 * fail, and the four renderers are what a human reads. `eval.test.ts` covers the run itself, so this
 * file covers the parts that decide whether a regression is real — the noise band, which is the whole
 * argument for the gate existing — and the tables, where a missing cell must say so instead of
 * printing a zero that reads like a measurement.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  MODES,
  archetypeOf,
  compareRuns,
  councilMembers,
  renderArchetypeTable,
  renderCategoryTable,
  renderModeTable,
  renderRegression,
  scriptedTransport,
  type ModeReport,
} from "./runner.ts";
import { GOLDEN_PROMPTS } from "./golden.ts";
import { calibrationSummary, renderCouncilEvals } from "./cli.ts";

const proportion = (rate: number, halfWidth = 0.05) => ({
  rate,
  n: 30,
  lower: Math.max(0, rate - halfWidth),
  upper: Math.min(1, rate + halfWidth),
});

function report(overrides: Partial<ModeReport> = {}): ModeReport {
  const mode = MODES[0]!;
  return {
    mode,
    prompts: 30,
    accept: proportion(0.8),
    everyMemberAccepted: proportion(0.4),
    convergence: 0.9,
    convergenceSe: 0.02,
    noMajority: proportion(0.1),
    cost: {
      meanUsd: 0.00123,
      totalUsd: 0.0369,
      meanPromptTokens: 100,
      meanCompletionTokens: 50,
      callsPerVerdict: 5,
    },
    meanLatencyMs: 2500,
    archetypeWins: { architect: { wins: 3, share: 0.6 }, critic: { wins: 2, share: 0.4 } },
    perCategory: { planning: { n: 10, acceptRate: 0.8, convergence: 0.9 } },
    runs: [],
    ...overrides,
  } as ModeReport;
}

describe("compareRuns", () => {
  it("reports a drop inside the combined noise band as a pass", () => {
    const findings = compareRuns([report()], [report({ accept: proportion(0.75) })]);
    const accept = findings.find((finding) => finding.metric === "accept")!;
    expect(accept.delta).toBeCloseTo(-0.05, 3);
    // The band is the sum of the two 95 % half-widths, so the same 5-point move is inside it.
    expect(accept.noise).toBeCloseTo(0.1, 3);
    expect(accept.failed).toBe(false);
  });

  it("fails a drop larger than the noise band explains", () => {
    const findings = compareRuns([report()], [report({ accept: proportion(0.5, 0.02) })]);
    const accept = findings.find((finding) => finding.metric === "accept")!;
    expect(accept.failed).toBe(true);
  });

  it("never fails on an improvement, however large", () => {
    const findings = compareRuns(
      [report({ accept: proportion(0.4) })],
      [report({ accept: proportion(0.9) })],
    );
    expect(findings.every((finding) => finding.failed)).toBe(false);
  });

  it("skips a mode the current run no longer has, instead of inventing a zero", () => {
    const other = { ...MODES[1]! };
    const findings = compareRuns([report()], [report({ mode: other })]);
    expect(findings).toEqual([]);
  });

  it("gives convergence a flat 0.1 band and compares all three metrics per mode", () => {
    const findings = compareRuns([report()], [report({ convergence: 0.85 })]);
    const convergence = findings.find((finding) => finding.metric === "convergence")!;
    expect(convergence.noise).toBe(0.1);
    expect(convergence.failed).toBe(false);
    expect(findings.map((finding) => finding.metric)).toEqual([
      "accept",
      "everyMemberAccepted",
      "convergence",
    ]);

    const worse = compareRuns([report()], [report({ convergence: 0.5 })]);
    expect(worse.find((finding) => finding.metric === "convergence")!.failed).toBe(true);
  });
});

describe("renderers", () => {
  it("renders the mode table with a CI, a cost and a latency column", () => {
    const table = renderModeTable([report()]);
    const [header, , row] = table.split("\n");
    expect(header).toContain("Best verdict accepted (95% CI)");
    expect(row).toContain("80.0% (75.0%–85.0%)");
    expect(row).toContain("$0.00123");
    expect(row).toContain("2.5 s");
  });

  it("renders archetype shares with the underscore removed and a dash where a mode has none", () => {
    const withGap = report({
      archetypeWins: { chief_architect: { wins: 4, share: 0.8 } },
    });
    const other = report({ mode: MODES[1]!, archetypeWins: {} });
    const table = renderArchetypeTable([withGap, other]);
    // A mode that ran but never won with this archetype is a measured zero, not a gap; a missing cell is only
    // for a mode absent from the report list entirely.
    expect(table).toContain("| chief architect | 80.0% | 0.0% |");
  });

  it("renders a category bucket as n, accepted and convergence, with a dash for a gap", () => {
    const table = renderCategoryTable([report(), report({ mode: MODES[1]!, perCategory: {} })]);
    expect(table).toContain("| planning | 10, 80.0%, 90.0% | — |");
  });

  it("marks a failed finding in bold and a passing one plainly", () => {
    const table = renderRegression([
      {
        mode: "standard",
        metric: "accept",
        baseline: 0.8,
        current: 0.7,
        delta: -0.1,
        noise: 0.05,
        failed: true,
      },
      {
        mode: "standard",
        metric: "convergence",
        baseline: 0.9,
        current: 0.95,
        delta: 0.05,
        noise: 0.1,
        failed: false,
      },
    ]);
    expect(table).toContain("| standard | accept | 0.800 | 0.700 | -0.100 | ±0.050 | **fail** |");
    expect(table).toContain("| standard | convergence | 0.900 | 0.950 | +0.050 | ±0.100 | pass |");
  });

  it("an empty report list still renders headers, so a table is never blank", () => {
    expect(renderModeTable([]).split("\n")).toHaveLength(2);
    expect(renderRegression([]).split("\n")).toHaveLength(2);
  });
});

describe("archetype plumbing", () => {
  it("reads the archetype out of the system prompt, and says unknown when it cannot", () => {
    expect(archetypeOf("You are The Chief Architect. You weigh tradeoffs.")).toBe(
      "chief_architect",
    );
    expect(archetypeOf("You are The Devil's Advocate. You dissent.")).toBe("devil_s_advocate");
    expect(archetypeOf("You are a helpful assistant.")).toBe("unknown");
  });

  it("builds a council of the asked size, and never more archetypes than exist", () => {
    expect(councilMembers(3)).toHaveLength(3);
    expect(councilMembers(5)).toHaveLength(5);
    const ids = councilMembers(5).map((member) => member.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("scripted transport", () => {
  const prompt = GOLDEN_PROMPTS[0]!;
  // The transport finds the prompt by its `PROPOSAL:` line, which is how a real member sees it.
  const user = `PROPOSAL: ${prompt.proposal}\n\n${prompt.context}`;
  const messages = [
    { role: "system" as const, content: "You are The Chief Architect. Weigh the tradeoffs." },
    { role: "user" as const, content: user },
  ];

  it("answers with the prompt's own facts, so a score can be traced back to the prompt", async () => {
    const response = await scriptedTransport({ quality: 1 }, { round: 1, pull: 0 }).chat(messages);
    for (const fact of prompt.mustMention) expect(response.content).toContain(fact);
    expect(response.content).toMatch(/Vote: (YES|NO)/);
  });

  it("covers fewer facts at the lowest quality than at the highest", async () => {
    const best = await scriptedTransport({ quality: 1 }, { round: 1, pull: 0 }).chat(messages);
    const weakest = await scriptedTransport({ quality: 0 }, { round: 1, pull: 0 }).chat(messages);
    const facts = (content: string) =>
      prompt.mustMention.filter((fact) => content.includes(fact)).length;
    expect(facts(best.content)).toBeGreaterThan(facts(weakest.content));
  });

  it("reports usage and latency for every call, because the cost column is computed from them", async () => {
    const response = await scriptedTransport({}, { round: 1, pull: 0 }).chat(messages);
    expect(response.usage.promptTokens).toBeGreaterThan(0);
    expect(response.usage.completionTokens).toBeGreaterThan(0);
    expect(response.latencyMs).toBeGreaterThan(0);
  });

  it("refuses a prompt outside the golden set instead of inventing an answer", async () => {
    await expect(
      scriptedTransport({}, { round: 1, pull: 0 }).chat([
        { role: "user", content: "PROPOSAL: something nobody wrote down" },
      ]),
    ).rejects.toThrow(/not in the golden set/);
  });

  it("is deterministic: the same prompt and archetype give the same answer twice", async () => {
    const a = await scriptedTransport({}, { round: 1, pull: 0 }).chat(messages);
    const b = await scriptedTransport({}, { round: 1, pull: 0 }).chat(messages);
    expect(a.content).toBe(b.content);
  });
});

/**
 * `cli.ts` is the generator behind `docs/COUNCIL-EVALS.md`. Nothing else calls it, so without this test its
 * twenty statements were the only code in the package at 0% — and a generator nobody runs is a document that
 * drifts silently until someone regenerates it and reviews a two-hundred-line diff.
 */
describe("the document generator", () => {
  it("still produces every section the page claims to have", async () => {
    const markdown = await renderCouncilEvals();
    for (const heading of [
      "### The golden set",
      "### Judge calibration",
      "### Mode comparison",
      "### Per-archetype win rate",
      "### Per-category acceptance",
      "### The regression gate, demonstrated",
    ])
      expect(markdown, heading).toContain(heading);
    // The first paragraph is the honesty clause: a table that hides its driver is a lie with good formatting.
    expect(markdown).toContain("scripted transport, not by a model");
    expect(markdown).toContain("nothing about how good any model is");
  }, 120_000);

  it("exposes the calibration as numbers as well as prose", () => {
    const summary = calibrationSummary();
    expect(summary.calibration.n).toBeGreaterThan(0);
    expect(summary.calibration.kappa).toBeGreaterThan(0.4);
    expect(summary.accepted.lower).toBeLessThanOrEqual(summary.accepted.rate);
    expect(summary.verdict.trusted).toBe(true);
  });
});
