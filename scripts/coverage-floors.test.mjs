// SPDX-License-Identifier: Apache-2.0
/** A floor that can be lowered silently is not a floor: the arithmetic is the guarantee. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { belowFloor, byPackage, ratchet, unmeasured, unrecorded } from "./coverage-floors.mjs";

const file = (statements, branches, functions, lines) => ({
  statements: { covered: statements[0], total: statements[1] },
  branches: { covered: branches[0], total: branches[1] },
  functions: { covered: functions[0], total: functions[1] },
  lines: { covered: lines[0], total: lines[1] },
});

const summary = {
  total: file([10, 100], [10, 100], [10, 100], [10, 100]),
  "C:/repo/packages/llm/src/a.ts": file([90, 100], [8, 10], [9, 10], [90, 100]),
  "C:/repo/packages/llm/src/b.ts": file([10, 100], [2, 10], [1, 10], [10, 100]),
  "/home/ci/packages/pty/src/c.ts": file([50, 50], [5, 5], [5, 5], [50, 50]),
  "/home/ci/apps/api/src/d.ts": file([20, 40], [0, 0], [2, 4], [20, 40]),
  "/home/ci/e2e/spec.ts": file([1, 1], [1, 1], [1, 1], [1, 1]),
};

test("aggregates are weighted sums, not averages of percentages", () => {
  const measured = byPackage(summary);
  // 90/100 + 10/100 = 50%, where the mean of 90% and 10% would also be 50% —
  // use the branch counts to tell a weighted sum from a mean: (8+2)/(10+10) = 50%,
  // but the mean of 80% and 20% is also 50%, so compare a lopsided pair below.
  assert.deepEqual(measured["packages/llm"], {
    statements: 50,
    branches: 50,
    functions: 50,
    lines: 50,
  });
});

test("a small file does not weigh as much as a large one", () => {
  const lopsided = {
    "packages/x/src/big.ts": file([100, 100], [0, 0], [0, 0], [100, 100]),
    "packages/x/src/small.ts": file([0, 1], [0, 0], [0, 0], [0, 1]),
  };
  // A mean of percentages would say 50%; the truth is 100/101 ≈ 99%.
  assert.equal(byPackage(lopsided)["packages/x"].lines, 99);
});

test("ignores the total row and files outside packages/apps", () => {
  const measured = byPackage(summary);
  assert.deepEqual(Object.keys(measured).sort(), ["apps/api", "packages/llm", "packages/pty"]);
  assert.equal(measured["packages/pty"].lines, 100);
});

test("a package with nothing measurable is 100, not 0", () => {
  const empty = { "packages/y/src/z.ts": file([0, 0], [0, 0], [0, 0], [0, 0]) };
  assert.equal(byPackage(empty)["packages/y"].lines, 100);
});

test("reports every metric below its floor", () => {
  const measured = { "packages/llm": { statements: 50, branches: 50, functions: 50, lines: 49.4 } };
  const floors = {
    "packages/llm": { lines: 50, statements: 50 },
    "packages/gone": { lines: 80 },
  };
  // A floor for a package this run did not measure is not a failure: a scoped run
  // measures the package it was given, and a barrel-only package never measures.
  assert.deepEqual(belowFloor(measured, floors), [
    { pkg: "packages/llm", metric: "lines", floor: 50, measured: 49.4 },
  ]);
  assert.deepEqual(unmeasured(measured, floors), ["packages/gone"]);
});

test("the ratchet raises and never lowers", () => {
  const measured = {
    "packages/llm": { statements: 55, branches: 40, functions: 55, lines: 60 },
  };
  const floors = { "packages/llm": { statements: 50, branches: 73, functions: 50, lines: 50 } };
  const { next, raised } = ratchet(measured, floors);
  assert.deepEqual(next["packages/llm"], {
    statements: 55,
    // Branches fell from 73 to 40, and stay at 73: lowering is a hand edit.
    branches: 73,
    functions: 55,
    lines: 60,
  });
  assert.deepEqual(
    raised.map((r) => `${r.metric}:${r.floor}→${r.measured}`),
    ["statements:50→55", "functions:50→55", "lines:50→60"],
  );
});

test("a package measured for the first time gets a floor", () => {
  const measured = { "apps/api": { statements: 12, branches: 3, functions: 12, lines: 12 } };
  const { next, raised } = ratchet(measured, {});
  assert.deepEqual(next["apps/api"], measured["apps/api"]);
  assert.deepEqual(raised, [{ pkg: "apps/api", metric: "new", floor: "none", measured: 12 }]);
});

test("a measured package with no floor is named", () => {
  const measured = { "packages/llm": {}, "packages/new": {} };
  assert.deepEqual(unrecorded(measured, { "packages/llm": { lines: 1 } }), ["packages/new"]);
});

/**
 * A floor for a package that no longer exists is the quiet version of a lowered floor: the check
 * reports it as "recorded, not measured", nobody reads that line, and the file slowly becomes a
 * list of history. Folding four single-consumer packages is exactly how that starts.
 */
test("every floor names a workspace package that still exists", () => {
  const floors = JSON.parse(readFileSync(".github/coverage-floors.json", "utf8"));
  const gone = Object.keys(floors).filter((key) => !existsSync(key));
  assert.deepEqual(gone, [], `floors for packages that are gone: ${gone.join(", ")}`);
});
