// SPDX-License-Identifier: Apache-2.0
/**
 * The monthly cost report, in one command.
 *
 *   node apps/api/src/cost-report.ts                 # newest month in the log
 *   node apps/api/src/cost-report.ts --month 2026-11 # a specific month
 *   node apps/api/src/cost-report.ts --json          # the same numbers for a script
 *
 * It reads the same persisted day-sharded log the dashboard reads (`costLogStore.load()`, so it agrees with the
 * UI to the entry), not the database directly: a report that reconstructs its own view of spend is a second
 * policy waiting to disagree with the first.
 */
import { costLogStore } from "./lib/cost-log.ts";
import {
  buildCostReport,
  latestMonth,
  renderCostReport,
  silentFamilies,
} from "./lib/cost-report.ts";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

await costLogStore.load();
const entries = costLogStore.entries;

const month = flag("--month") ?? latestMonth(entries);
if (!/^\d{4}-\d{2}$/.test(month)) {
  console.error(`[cost-report] --month must be YYYY-MM, got ${month}`);
  process.exit(1);
}

const report = buildCostReport(entries, { month });

if (argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(renderCostReport(report));
  const silent = silentFamilies(report);
  if (silent.length > 0 && report.entries > 0)
    console.log(`\nNo spend this month in: ${silent.join(", ")}.`);
}
process.exit(0);
