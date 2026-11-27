// SPDX-License-Identifier: Apache-2.0
/**
 * The SLO review gate has one job with two halves: catch a tracker that enforces something other than
 * the promise, and catch a record that quotes a promise nobody makes any more. A gate that only checked
 * one of those would pass while the other drifted, so every test here has a "and now sabotage it" twin.
 *
 * The cases use fabricated documents rather than the real ones, because a test that reads the real files
 * only proves the real files are fine today.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { declared, enforced, problems, records, SECTIONS } from "./slo-review.mjs";

const scratch = mkdtempSync(join(tmpdir(), "slo-review-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const DOC = `# SLOs

## SLO-1: API availability

**SLO target:** 99.5% over a 30-day rolling window
**Error budget:** 0.5% ≈ 3.6 hours/month

## SLO-2: API latency (p99)

**SLO target:** p99 < 500ms

## SLO-5: Audit log chain integrity

**SLO target:** 100% — zero tolerance for chain breaks
`;

const TRACKER = `export const sloTracker = new SloTracker({
  windowMs: 5 * 60_000,
  targets: { availabilityTarget: 0.995, errorRateTarget: 0.005, p99LatencyTargetMs: 500 },
});`;

const README_OK = `| SLO | Target |
| --- | --- |
| SLO-1 | 99.5% over a 30-day rolling window |
| SLO-2 | p99 < 500ms |
| SLO-5 | 100% — zero tolerance for chain breaks |
`;

const recordText = (extra = "") => `${SECTIONS.join("\n\n")}\n\n${extra}\n`;

/** A filename for the quarter we are in, so a record used in a test is never stale by accident. */
function currentQuarter(offset = 0) {
  const now = new Date();
  let year = now.getUTCFullYear();
  let quarter = Math.floor(now.getUTCMonth() / 3) + 1 - offset;
  while (quarter < 1) {
    quarter += 4;
    year -= 1;
  }
  return `${year}-Q${quarter}.md`;
}

const record = (name, text = recordText()) => ({
  name,
  file: join(scratch, name),
  year: Number(name.slice(0, 4)),
  quarter: Number(name.slice(6, 7)),
  text,
});

/** A review directory on disk, for the filename-driven reader. */
function withRecords(files) {
  const dir = join(
    scratch,
    `records-${Object.keys(files).length}-${Math.random().toString(36).slice(2, 7)}`,
  );
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

test("the promise is read from the document rather than assumed", () => {
  const slos = declared(DOC);
  assert.deepEqual(
    slos.map((slo) => [slo.id, slo.target]),
    [
      ["SLO-1", "99.5% over a 30-day rolling window"],
      ["SLO-2", "p99 < 500ms"],
      ["SLO-5", "100% — zero tolerance for chain breaks"],
    ],
  );
  assert.equal(slos[0].budget, "0.5% ≈ 3.6 hours/month");
});

test("the tracker's targets are read from its construction, not from a comment", () => {
  assert.deepEqual(enforced(TRACKER), {
    availabilityTarget: 0.995,
    errorRateTarget: 0.005,
    p99LatencyTargetMs: 500,
  });
  assert.equal(enforced("const x = 1;"), null, "no targets block is reported, not guessed");
});

test("a tracker stricter than the promise fails, and says why", () => {
  const strict = TRACKER.replace("availabilityTarget: 0.995", "availabilityTarget: 0.999");
  const found = problems({ doc: DOC, tracker: enforced(strict), readme: README_OK, list: [] });
  assert.equal(found.length, 1);
  assert.match(found[0], /stricter tracker reports an exhausted budget that is not exhausted/);
});

test("a tracker looser than the promise fails too — the silent direction", () => {
  const loose = TRACKER.replace("p99LatencyTargetMs: 500", "p99LatencyTargetMs: 2000");
  const found = problems({ doc: DOC, tracker: enforced(loose), readme: README_OK, list: [] });
  assert.equal(found.length, 1);
  assert.match(found[0], /stays silent through a breach/);
});

test("the error-rate half of the budget is checked as well", () => {
  const wrong = TRACKER.replace("errorRateTarget: 0.005", "errorRateTarget: 0.001");
  const found = problems({ doc: DOC, tracker: enforced(wrong), readme: README_OK, list: [] });
  assert.match(found.join("\n"), /budget arithmetic uses this number/);
});

test("a README that quotes a stale target fails, in both directions", () => {
  const stale = README_OK.replace("p99 < 500ms", "p99 < 2000ms");
  const found = problems({ doc: DOC, tracker: enforced(TRACKER), readme: stale, list: [] });
  assert.match(found.join("\n"), /quotes a different target for SLO-2/);

  const missing = README_OK.replace("| SLO-5 | 100% — zero tolerance for chain breaks |\n", "");
  const gone = problems({ doc: DOC, tracker: enforced(TRACKER), readme: missing, list: [] });
  assert.match(gone.join("\n"), /no decision row for SLO-5/);
});

test("a record missing a section is named, with the section", () => {
  const partial = recordText().replace("## Actions taken\n\n", "");
  const name = currentQuarter();
  const found = problems({
    doc: DOC,
    tracker: enforced(TRACKER),
    readme: README_OK,
    list: [record(name, partial)],
  });
  assert.deepEqual(found, [`${name} is missing the "## Actions taken" section`]);
});

test("a record that names an SLO the document does not define fails", () => {
  const found = problems({
    doc: DOC,
    tracker: enforced(TRACKER),
    readme: README_OK,
    list: [record(currentQuarter(), recordText("SLO-9 was fine."))],
  });
  assert.match(found.join("\n"), /SLO-9, which docs\/slos.md does not define/);
});

test("a cadence that stops being kept fails: two empty quarters is the trigger", () => {
  const onTime = problems({
    doc: DOC,
    tracker: enforced(TRACKER),
    readme: README_OK,
    list: [record(currentQuarter())],
  });
  assert.deepEqual(onTime, [], "a review for this quarter is on time");

  const stale = problems({
    doc: DOC,
    tracker: enforced(TRACKER),
    readme: README_OK,
    list: [record(currentQuarter(2))],
  });
  assert.match(stale.join("\n"), /is 2 quarters old/);
});

test("only review records are read, and they are read in order", () => {
  const dir = withRecords({
    "2026-Q1.md": recordText(),
    "2026-Q3.md": recordText(),
    "README.md": "# not a review",
    "notes.md": "scratch",
  });
  assert.deepEqual(
    records(dir).map((entry) => entry.name),
    ["2026-Q1.md", "2026-Q3.md"],
  );
  assert.deepEqual(
    records(join(scratch, "does-not-exist")),
    [],
    "a missing directory is empty, not a crash",
  );
});

test("the readers find the real files, so the gate cannot pass by finding nothing", () => {
  assert.ok(declared().length >= 6, "docs/slos.md should declare six SLOs");
  assert.ok(enforced() !== null, "the tracker's targets should be readable from its source");
  assert.ok(records().length >= 1, "at least one review record exists");
});
