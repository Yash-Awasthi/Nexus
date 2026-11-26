// SPDX-License-Identifier: Apache-2.0
/**
 * Job wall times: publish them, and fail when one regresses by 25%.
 *
 * A cache you do not measure is a hypothesis. This records how long a job actually
 * took into the run summary (so the number is visible on the pull request) and
 * compares it with `.github/job-times.json`. A job with no baseline in that file
 * is recorded, not judged — the file starts empty because the only honest values
 * are the ones a real runner produced.
 *
 * Usage, at the end of a job:
 *
 *     node scripts/job-times.mjs --job build --started "$STARTED" [--record]
 *
 * `--started` is an epoch-second stamp written to `$GITHUB_ENV` by the job's first
 * step; the wall time is the difference, so it includes checkout and install.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const BASELINE = ".github/job-times.json";

/** The committed baseline, or `{}` when the file is missing. */
export function readBaseline(path = BASELINE) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/**
 * The regression message for one job, or `null` when it is within tolerance.
 *
 * `limit` is the fraction a job may grow before it counts as a regression: 0.25
 * means 25% slower than the baseline.
 */
export function regression(baselineSeconds, currentSeconds, limit = 0.25) {
  if (typeof baselineSeconds !== "number" || baselineSeconds <= 0) return null;
  const ceiling = baselineSeconds * (1 + limit);
  if (currentSeconds <= ceiling) return null;
  const slower = ((currentSeconds - baselineSeconds) / baselineSeconds) * 100;
  return `job took ${currentSeconds}s, ${slower.toFixed(0)}% over the ${baselineSeconds}s baseline (limit ${(limit * 100).toFixed(0)}%)`;
}

/** One markdown row for the run summary. */
export function summaryRow(name, seconds, baselineSeconds) {
  const verdict =
    typeof baselineSeconds === "number" && baselineSeconds > 0
      ? `${seconds}s vs ${baselineSeconds}s baseline`
      : `${seconds}s (no baseline yet)`;
  return `| ${name} | ${verdict} |`;
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (name) => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const job = arg("job");
  const started = Number(arg("started"));
  if (!job || !Number.isFinite(started)) {
    console.error("usage: job-times.mjs --job <name> --started <epoch-seconds> [--record]");
    return 2;
  }

  const seconds = Math.round(Date.now() / 1000 - started);
  const baseline = readBaseline()[job];
  const row = summaryRow(job, seconds, baseline);

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${row}\n`);
  }
  console.log(`job-times: ${job} ${seconds}s (baseline: ${baseline ?? "none"})`);

  if (argv.includes("--record")) {
    const all = readBaseline();
    all[job] = seconds;
    writeFileSync(BASELINE, `${JSON.stringify(all, null, 2)}\n`);
    console.log(`job-times: recorded ${job} as ${seconds}s in ${BASELINE}`);
  }

  const verdict = regression(baseline, seconds);
  if (verdict) {
    console.error(`job-times: ${verdict}`);
    return 1;
  }
  return 0;
}

if (process.argv[1]?.endsWith("job-times.mjs")) process.exit(main());
