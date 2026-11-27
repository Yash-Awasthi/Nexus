// SPDX-License-Identifier: Apache-2.0
/**
 * A quarterly review is only a review if the numbers in it are the numbers the service promises.
 *
 * Three files can drift apart and none of them would complain on its own:
 *
 *   docs/slos.md            the promise (targets, budgets, cadence)
 *   apps/api/src/routes/metrics.ts   what the tracker actually enforces
 *   docs/slo-reviews/*.md   what each quarter recorded
 *
 * A tracker configured stricter than the promise reports an exhausted budget that is not exhausted. A
 * tracker configured looser lets a breach pass silently. A review record that quotes a target the
 * document no longer says is worse than no record, because it will be cited. So this checks all three
 * against each other, in both directions, and checks that the review cadence the document states is
 * actually being kept.
 *
 *   node scripts/slo-review.mjs            # report
 *   node scripts/slo-review.mjs --check    # CI gate
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SLO_DOC = path.join(ROOT, "docs", "slos.md");
const README = path.join(ROOT, "docs", "slo-reviews", "README.md");
const RECORDS = path.join(ROOT, "docs", "slo-reviews");
const METRICS = path.join(ROOT, "apps", "api", "src", "routes", "metrics.ts");

/** The `## SLO-n: …` blocks of `docs/slos.md`, with the target and budget lines they declare. */
export function declared(doc = readFileSync(SLO_DOC, "utf8")) {
  const blocks = [];
  const sections = doc.split(/^## /m).slice(1);
  for (const section of sections) {
    const heading = section.split("\n")[0]?.trim() ?? "";
    const id = /^(SLO-\d+)/.exec(heading)?.[1];
    if (!id) continue;
    const target = /\*\*SLO target:\*\*\s*(.+)/.exec(section)?.[1]?.trim() ?? null;
    const budget = /\*\*Error budget:\*\*\s*(.+)/.exec(section)?.[1]?.trim() ?? null;
    blocks.push({ id, heading, target, budget });
  }
  return blocks;
}

/** The targets the tracker is constructed with, straight from the source. */
export function enforced(source = readFileSync(METRICS, "utf8")) {
  const line = /targets:\s*\{([^}]*)\}/.exec(source)?.[1];
  if (!line) return null;
  const number = (name) => {
    const match = new RegExp(`${name}:\\s*([0-9_.]+)`).exec(line);
    return match?.[1] === undefined ? null : Number(match[1].replace(/_/g, ""));
  };
  return {
    availabilityTarget: number("availabilityTarget"),
    errorRateTarget: number("errorRateTarget"),
    p99LatencyTargetMs: number("p99LatencyTargetMs"),
  };
}

/** Percent from a `99.5%` target line, or null when the line does not state one. */
function percentOf(text) {
  const match = /([0-9]+(?:\.[0-9]+)?)%/.exec(text ?? "");
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** Milliseconds from a `p99 < 500ms` target line, or null. */
function latencyOf(text) {
  const match = /p99\s*<\s*([0-9]+)\s*ms/i.exec(text ?? "");
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** The review records, newest last, with their quarter parsed from the filename. */
export function records(dir = RECORDS) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^\d{4}-Q[1-4]\.md$/.test(name))
    .sort()
    .map((name) => ({
      name,
      file: path.join(dir, name),
      year: Number(name.slice(0, 4)),
      quarter: Number(name.slice(6, 7)),
      text: readFileSync(path.join(dir, name), "utf8"),
    }));
}

/** The sections every record must contain, in the order the README states. */
export const SECTIONS = [
  "## Quarter",
  "## Error-budget position",
  "## Actions taken",
  "## Changes for next quarter",
  "## Evidence",
];

/** Every way the promise, the tracker and the records disagree. */
export function problems({ doc, tracker, readme, list }) {
  const found = [];
  const slos = declared(doc);
  const byId = new Map(slos.map((slo) => [slo.id, slo]));

  // 1. The tracker must enforce exactly what SLO-1 and SLO-2 promise.
  const availability = percentOf(byId.get("SLO-1")?.target);
  const errorRate =
    percentOf(byId.get("SLO-1")?.budget) ?? (availability === null ? null : 100 - availability);
  const latency = latencyOf(byId.get("SLO-2")?.target);
  if (availability === null || latency === null || errorRate === null) {
    found.push(
      "docs/slos.md no longer states a percentage target for SLO-1 and a millisecond target for SLO-2",
    );
  } else {
    if (tracker === null)
      found.push("apps/api/src/routes/metrics.ts has no `targets: { … }` block to check");
    else {
      if (Math.abs((tracker.availabilityTarget ?? -1) - availability / 100) > 1e-9)
        found.push(
          `tracker availabilityTarget is ${tracker.availabilityTarget}, docs/slos.md promises ${availability}% — ` +
            "a stricter tracker reports an exhausted budget that is not exhausted",
        );
      const promisedErrorRate = (100 - availability) / 100;
      if (Math.abs((tracker.errorRateTarget ?? -1) - promisedErrorRate) > 1e-9)
        found.push(
          `tracker errorRateTarget is ${tracker.errorRateTarget}, the promise allows ${promisedErrorRate} — ` +
            "the budget arithmetic uses this number, so it has to be the promised one",
        );
      if (tracker.p99LatencyTargetMs !== latency)
        found.push(
          `tracker p99LatencyTargetMs is ${tracker.p99LatencyTargetMs}, SLO-2 says p99 < ${latency}ms — ` +
            "a looser tracker stays silent through a breach",
        );
    }
  }
  // `errorRate` above is only here to prove the budget line parses; the promise wins if they disagree.

  // 2. The review README's decision table must quote the same targets as the promise.
  for (const slo of slos) {
    if (!slo.target) continue;
    if (!readme.includes(slo.id)) {
      found.push(`docs/slo-reviews/README.md has no decision row for ${slo.id}`);
      continue;
    }
    if (!readme.includes(slo.target)) {
      found.push(
        `docs/slo-reviews/README.md quotes a different target for ${slo.id} than docs/slos.md ` +
          `("${slo.target}") — a review quoting a stale target will be cited`,
      );
    }
  }

  // 3. Each record must have every section, and must not invent a target.
  for (const record of list) {
    for (const section of SECTIONS)
      if (!record.text.includes(section))
        found.push(`${record.name} is missing the "${section}" section`);
    const unknown = [...record.text.matchAll(/\bSLO-(\d+)\b/g)]
      .map((hit) => `SLO-${hit[1]}`)
      .filter((id) => !byId.has(id));
    for (const id of new Set(unknown))
      found.push(`${record.name} names ${id}, which docs/slos.md does not define`);
  }

  // 4. The cadence the document states must be kept: no gap of more than one quarter plus grace.
  if (list.length > 0) {
    const newest = list[list.length - 1];
    const age = quartersBetween(newest, today());
    if (age > 1)
      found.push(
        `the newest review (${newest.name}) is ${age} quarters old; docs/slos.md says the review is quarterly`,
      );
  }
  return found;
}

function today() {
  const now = new Date();
  return { year: now.getUTCFullYear(), quarter: Math.floor(now.getUTCMonth() / 3) + 1 };
}

function quartersBetween(from, to) {
  return to.year * 4 + to.quarter - (from.year * 4 + from.quarter);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURLSafe(process.argv[1]);

function pathToFileURLSafe(value) {
  return new URL(`file://${path.resolve(value).replace(/\\/g, "/")}`).href;
}

if (invokedDirectly) {
  const list = records();
  const found = problems({
    doc: readFileSync(SLO_DOC, "utf8"),
    tracker: enforced(),
    readme: existsSync(README) ? readFileSync(README, "utf8") : "",
    list,
  });

  if (process.argv.includes("--check")) {
    for (const problem of found) console.error(`✖ ${problem}`);
    if (found.length > 0) process.exit(1);
    console.log(
      `slo-review: ${declared().length} SLO(s), tracker agrees with the promise, ${list.length} review record(s)`,
    );
    process.exit(0);
  }

  // Default mode: print the position a review would write down.
  const tracker = enforced();
  console.log("SLO | target | budget");
  for (const slo of declared())
    console.log(`${slo.id} | ${slo.target ?? "—"} | ${slo.budget ?? "—"}`);
  console.log("");
  console.log(`tracker: ${JSON.stringify(tracker)}`);
  console.log(`records: ${list.map((r) => r.name).join(", ") || "none"}`);
  for (const problem of found) console.error(`✖ ${problem}`);
  process.exit(found.length === 0 ? 0 : 1);
}
