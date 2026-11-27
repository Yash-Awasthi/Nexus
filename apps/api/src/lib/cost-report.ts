// SPDX-License-Identifier: Apache-2.0
/**
 * The monthly cost report (M6.3.1): one command, four questions answered.
 *
 * Who spent it, which company it belongs to, what part of the product caused it, and which model billed it. The
 * per-user and per-company totals reconcile to the same grand total as the per-family and per-model ones, and a
 * test asserts that — a report whose columns add up to different numbers is a report people stop trusting after
 * the first meeting.
 *
 * Two deliberate accounting choices:
 *
 *  - **Unattributed spend is a line, not a deduction.** Calls made before attribution existed, and calls from
 *    background workers with no request, have no family. Folding them into `other` would make `other` look like a
 *    product area; showing them separately makes the gap visible and closes over time on its own.
 *  - **A month is defined in UTC.** The cost log's day keys are UTC too, so the report and the storage agree about
 *    where a boundary is, even if it moves for the reader.
 */

import { COST_FAMILIES, type CostFamily } from "./cost-attribution.ts";
import type { CostEntry } from "./cost-log.ts";

export interface Bucket {
  key: string;
  /** Human label for the row, when the key is an id. */
  label?: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

export interface CostReport {
  /** `YYYY-MM` in UTC. */
  month: string;
  entries: number;
  usd: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Spend that carries no family (workers, pre-attribution rows). */
  unattributedUsd: number;
  /** Spend whose model has no price row: it is counted, but its cost is 0 and it is called out. */
  unpricedUsd: { entries: number };
  byUser: Bucket[];
  byCompany: Bucket[];
  byFamily: Bucket[];
  byModel: Bucket[];
}

/** `YYYY-MM` of an ISO timestamp, in UTC. */
export function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

/** The month a report defaults to: the newest one in the log, or the current month when it is empty. */
export function latestMonth(entries: readonly CostEntry[], now = new Date()): string {
  let newest = "";
  for (const entry of entries) {
    const month = monthOf(entry.ts);
    if (month > newest) newest = month;
  }
  return newest || monthOf(now.toISOString());
}

const empty = (): Bucket => ({ key: "", requests: 0, inputTokens: 0, outputTokens: 0, usd: 0 });

function add(bucket: Bucket, entry: CostEntry): void {
  bucket.requests += 1;
  bucket.inputTokens += entry.inputTokens;
  bucket.outputTokens += entry.outputTokens;
  bucket.usd += entry.costUsd;
}

/** Accumulate into a map keyed by `keyOf`, then sort by spend so the top line of each table is the answer. */
function bucketise(
  entries: readonly CostEntry[],
  keyOf: (entry: CostEntry) => string,
  label?: (key: string) => string | undefined,
): Bucket[] {
  const map = new Map<string, Bucket>();
  for (const entry of entries) {
    const key = keyOf(entry);
    const bucket = map.get(key) ?? { ...empty(), key, label: label?.(key) };
    add(bucket, entry);
    map.set(key, bucket);
  }
  return [...map.values()].sort((a, b) => b.usd - a.usd || b.requests - a.requests);
}

/**
 * Build the report for one month.
 *
 * Every entry lands in exactly one user, company, family and model bucket, so the four tables are four views of the
 * same money. Entries without a user or company get the key `unattributed` rather than being dropped — dropping
 * them would make the totals disagree with the invoice.
 */
export function buildCostReport(
  entries: readonly CostEntry[],
  options: {
    month?: string;
    userLabels?: Record<string, string>;
    companyLabels?: Record<string, string>;
  } = {},
): CostReport {
  const month = options.month ?? latestMonth(entries);
  const inMonth = entries.filter((entry) => monthOf(entry.ts) === month);

  const report: CostReport = {
    month,
    entries: inMonth.length,
    usd: 0,
    requests: inMonth.length,
    inputTokens: 0,
    outputTokens: 0,
    unattributedUsd: 0,
    unpricedUsd: { entries: 0 },
    byUser: [],
    byCompany: [],
    byFamily: [],
    byModel: [],
  };

  for (const entry of inMonth) {
    report.usd += entry.costUsd;
    report.inputTokens += entry.inputTokens;
    report.outputTokens += entry.outputTokens;
    if (!entry.family) report.unattributedUsd += entry.costUsd;
    if (entry.pricingKnown === false) report.unpricedUsd.entries += 1;
  }

  report.byUser = bucketise(
    inMonth,
    (entry) => entry.userId ?? "unattributed",
    (key) =>
      key === "unattributed"
        ? "unattributed (system or pre-attribution)"
        : options.userLabels?.[key],
  );
  report.byCompany = bucketise(
    inMonth,
    (entry) => entry.companyId ?? "unattributed",
    (key) =>
      key === "unattributed"
        ? "unattributed (personal or unassigned)"
        : options.companyLabels?.[key],
  );
  report.byFamily = bucketise(inMonth, (entry) => entry.family ?? "unattributed");
  report.byModel = bucketise(inMonth, (entry) => entry.model);

  // Families come out in a fixed order (spend ordering hides a family that stopped being used, and that is
  // usually the interesting row), with unattributed last because it is a leftover rather than a product area.
  const order = new Map<string, number>(
    [...COST_FAMILIES, "unattributed"].map((family, index) => [family, index]),
  );
  report.byFamily.sort((a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99));

  return report;
}

const money = (usd: number): string => `$${usd.toFixed(4)}`;
const compact = (key: string): string => (key.length > 28 ? `${key.slice(0, 27)}…` : key);

function table(title: string, rows: Bucket[], unit: string): string[] {
  if (rows.length === 0) return [`${title}: nothing recorded`, ""];
  const width = Math.max(title.length, ...rows.map((row) => compact(row.label ?? row.key).length));
  const lines = [`${title.padEnd(width)}  ${unit.padStart(8)}  requests`];
  for (const row of rows)
    lines.push(
      `${compact(row.label ?? row.key).padEnd(width)}  ${money(row.usd).padStart(8)}  ${String(row.requests).padStart(8)}`,
    );
  return [...lines, ""];
}

/** The text a person reads: totals first, then the four tables, then the two honest caveats. */
export function renderCostReport(report: CostReport): string {
  const lines = [
    `Cost report — ${report.month} (UTC)`,
    `${report.requests} request(s), ${report.inputTokens.toLocaleString("en-US")} input + ${report.outputTokens.toLocaleString("en-US")} output tokens, ${money(report.usd)} total`,
    "",
    ...table("By route family", report.byFamily, "spend"),
    ...table("By user", report.byUser.slice(0, 20), "spend"),
    ...table("By company", report.byCompany.slice(0, 20), "spend"),
    ...table("By model", report.byModel.slice(0, 20), "spend"),
  ];
  if (report.unattributedUsd > 0)
    lines.push(
      `Unattributed: ${money(report.unattributedUsd)} of ${money(report.usd)} (${((report.unattributedUsd / report.usd) * 100).toFixed(1)}%) came from rows with no route family — background runs and rows written before attribution.`,
    );
  if (report.unpricedUsd.entries > 0)
    lines.push(
      `${report.unpricedUsd.entries} request(s) used a model with no price row: their tokens are counted and their spend is 0, not guessed.`,
    );
  return lines.join("\n").trimEnd();
}

/** Which families exist but recorded nothing this month — the row a reader looks for and does not find. */
export function silentFamilies(report: CostReport): CostFamily[] {
  const seen = new Set(report.byFamily.map((row) => row.key));
  return COST_FAMILIES.filter((family) => !seen.has(family));
}
