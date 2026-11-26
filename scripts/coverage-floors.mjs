// SPDX-License-Identifier: Apache-2.0
/**
 * One global coverage threshold answers "is the suite covering the code" badly:
 * a package at 40% hides behind twenty at 95%. The floor belongs per package, and
 * it only means something if it can go up and never quietly come down.
 *
 *   node scripts/coverage-floors.mjs             # check against .github/coverage-floors.json
 *   node scripts/coverage-floors.mjs --record    # raise floors to what was measured
 *   node scripts/coverage-floors.mjs --summary path/to/coverage-summary.json
 *
 * `--record` only ever raises a floor. A drop needs a hand edit to the JSON and a
 * reason in the commit, which is the point: coverage falling by a point is either
 * a decision or a mistake, and the file records which.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const FLOORS = ".github/coverage-floors.json";
const SUMMARY = "coverage/coverage-summary.json";
const METRICS = ["statements", "branches", "functions", "lines"];

/**
 * Per-file coverage → per-package totals, keyed `packages/<name>` and `apps/<name>`.
 * The summary reports counts, so the aggregate is a weighted sum, not an average
 * of percentages (a 10-line file must not weigh as much as a 1000-line one).
 */
export function byPackage(summary) {
  const totals = new Map();
  for (const [file, data] of Object.entries(summary)) {
    if (file === "total") continue;
    const match = /^(?:.*[\\/])?(packages|apps)[\\/]([^\\/]+)[\\/]/.exec(file);
    if (!match) continue;
    const key = `${match[1]}/${match[2]}`;
    const bucket =
      totals.get(key) ?? Object.fromEntries(METRICS.map((m) => [m, { covered: 0, total: 0 }]));
    for (const metric of METRICS) {
      bucket[metric].covered += data?.[metric]?.covered ?? 0;
      bucket[metric].total += data?.[metric]?.total ?? 0;
    }
    totals.set(key, bucket);
  }
  const out = {};
  for (const [key, bucket] of totals) {
    out[key] = {};
    for (const metric of METRICS) {
      const { covered, total } = bucket[metric];
      out[key][metric] = total === 0 ? 100 : Math.round((covered / total) * 1000) / 10;
    }
  }
  return out;
}

/**
 * Packages below their floor, with both numbers. A floor for a package this run did
 * not measure is not a failure — a scoped run (`--coverage.include=packages/x/**`)
 * measures one package, and a package whose sources are all excluded (a barrel-only
 * `src/index.ts`) is never measured at all.
 */
export function belowFloor(measured, floors) {
  const short = [];
  for (const [pkg, metrics] of Object.entries(floors)) {
    const now = measured[pkg];
    if (!now) continue;
    for (const metric of METRICS) {
      const floor = metrics[metric];
      if (floor === undefined) continue;
      if (now[metric] < floor) short.push({ pkg, metric, floor, measured: now[metric] });
    }
  }
  return short;
}

/** Floors this run had no measurement for. */
export function unmeasured(measured, floors) {
  return Object.keys(floors)
    .filter((pkg) => !measured[pkg])
    .sort();
}

/** The ratchet: a floor rises to the measurement and never falls on its own. */
export function ratchet(measured, floors) {
  const next = { ...floors };
  const raised = [];
  for (const [pkg, metrics] of Object.entries(measured)) {
    const current = next[pkg];
    // A package measured for the first time gets a floor from the measurement.
    if (!current) {
      next[pkg] = { ...metrics };
      raised.push({ pkg, metric: "new", floor: "none", measured: metrics.lines });
      continue;
    }
    next[pkg] = { ...current };
    for (const metric of METRICS) {
      const floor = current[metric] ?? 0;
      if (metrics[metric] > floor) {
        next[pkg][metric] = metrics[metric];
        raised.push({ pkg, metric, floor, measured: metrics[metric] });
      }
    }
  }
  return { next, raised };
}

/** Packages with measured coverage that nobody wrote a floor for. */
export function unrecorded(measured, floors) {
  return Object.keys(measured)
    .filter((pkg) => !floors[pkg])
    .sort();
}

function main() {
  const argv = process.argv.slice(2);
  const record = argv.includes("--record");
  const summaryPath = argv.includes("--summary") ? argv[argv.indexOf("--summary") + 1] : SUMMARY;

  let summary;
  try {
    summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  } catch {
    const hint = `coverage-floors: no summary at ${summaryPath}. Run:\n  pnpm exec vp test run --coverage`;
    // Locally the suite may never have run with coverage. In CI the unit job runs
    // it with coverage on every push, so a missing summary there is a real gap;
    // --strict is what tells the two apart.
    if (argv.includes("--strict")) {
      console.error(hint);
      return 2;
    }
    console.log(`${hint}\ncoverage-floors: nothing checked (pass --strict to fail instead)`);
    return 0;
  }
  const measured = byPackage(summary);
  const floors = JSON.parse(readFileSync(FLOORS, "utf8"));

  if (record) {
    const { next, raised } = ratchet(measured, floors);
    writeFileSync(`${FLOORS}`, `${JSON.stringify(next, null, 2)}\n`);
    if (raised.length === 0) console.log("coverage-floors: nothing to raise");
    for (const r of raised)
      console.log(`coverage-floors: ${r.pkg} ${r.metric} ${r.floor}% → ${r.measured}%`);
    console.log(`coverage-floors: wrote ${Object.keys(next).length} packages to ${FLOORS}`);
    return 0;
  }

  const short = belowFloor(measured, floors);
  const missing = unrecorded(measured, floors);
  const skipped = unmeasured(measured, floors);
  console.log(
    `coverage-floors: ${Object.keys(measured).length} packages measured, ${Object.keys(floors).length} with a floor`,
  );
  // A package with no floor yet is a gap to close, not a build failure: floors are
  // recorded from a measurement, and a scoped run only measures what it touched.
  for (const pkg of missing) console.log(`  ${pkg}: measured, no floor yet (--record writes one)`);
  for (const pkg of skipped) console.log(`  ${pkg}: floor recorded, not measured in this run`);
  if (short.length > 0) {
    for (const s of short)
      console.error(`  ${s.pkg}: ${s.metric} ${s.measured}% is below the ${s.floor}% floor`);
    return 1;
  }
  console.log("coverage-floors: every measured package is at or above its floor");
  return 0;
}

if (process.argv[1] && path.basename(process.argv[1]) === "coverage-floors.mjs")
  process.exit(main());
