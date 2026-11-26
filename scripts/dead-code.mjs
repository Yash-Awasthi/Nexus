// SPDX-License-Identifier: Apache-2.0
/**
 * Dead code does not announce itself: an export stops being imported, a file stops being
 * reachable, and eighteen months later a reader has to decide whether removing it is safe.
 *
 * `knip` finds those, and this makes the answer a gate rather than a report. The report
 * is empty today — the last two entries were `_resetDiscussionsForTests` and
 * `_resetGraphJobsForTests`, helpers nothing called — so a new line here is a new
 * orphan, not inherited debt.
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * Flatten knip's JSON into `{ kind, name, where }` rows.
 *
 * knip reports one object per file with a key per kind (`exports`, `files`, `types`,
 * `dependencies`, …), each an array of entries. Only the kinds that mean "code nothing
 * reaches" are collected: an unused export or an unreachable file.
 */
export function issues(report, kinds = ["exports", "files", "types", "namespaceMembers"]) {
  const rows = [];
  for (const issue of report.issues ?? []) {
    for (const kind of kinds) {
      for (const entry of issue[kind] ?? []) {
        const name = entry.symbol ?? entry.name ?? issue.file;
        const where = entry.line ? `${issue.file}:${entry.line}:${entry.col ?? 0}` : issue.file;
        rows.push({ kind, name, where });
      }
    }
  }
  return rows;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  let raw = "";
  try {
    raw = execFileSync(
      process.execPath,
      ["node_modules/knip/bin/knip.js", "--reporter", "json", "--no-progress"],
      { encoding: "utf8" },
    );
  } catch (error) {
    // knip exits non-zero when it finds something; the JSON is still on stdout.
    raw = error.stdout ?? "";
  }
  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    console.error("✖ knip produced no JSON report — run `node_modules/.bin/knip` by hand");
    process.exit(1);
  }
  const found = issues(report);
  for (const row of found) console.error(`✖ ${row.where}: ${row.kind} ${row.name}`);
  console.log(`dead code: ${found.length} unused export(s) or file(s)`);
  if (found.length > 0) {
    console.error(
      "Remove them, or add the entry to knip.json with the reason it is kept — an unused export is a promise nobody kept.",
    );
    process.exit(1);
  }
}
