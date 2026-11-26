// SPDX-License-Identifier: Apache-2.0
/** The comparison is the whole check: a bug here reports agreement that never happened. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { disagreements, parseArgs, resultsOf } from "./seed-determinism.mjs";

const report = (tests) => ({
  testResults: [
    {
      name: "C:/repo/packages/llm/src/compress/token-saver.test.ts",
      assertionResults: tests.map(([title, status]) => ({
        ancestorTitles: ["token-saver"],
        title,
        status,
      })),
    },
  ],
});

test("defaults to a fixed seed over the whole suite", () => {
  const args = parseArgs([]);
  assert.equal(args.seed, "1337");
  assert.deepEqual(args.scope, []);
});

test("takes a seed and repeated scopes, inline or spaced", () => {
  const args = parseArgs(["--seed=7", "--scope", "packages/llm", "--scope=apps/api"]);
  assert.equal(args.seed, "7");
  assert.deepEqual(args.scope, ["packages/llm", "apps/api"]);
});

test("keys tests by the file, the describe chain and the title", () => {
  const results = resultsOf(report([["stays fast", "passed"]]));
  assert.deepEqual([...results.keys()], ["token-saver.test.ts › token-saver › stays fast"]);
  assert.equal(results.get("token-saver.test.ts › token-saver › stays fast"), "passed");
});

test("two runs that agree disagree about nothing", () => {
  const first = resultsOf(
    report([
      ["a", "passed"],
      ["b", "failed"],
    ]),
  );
  const second = resultsOf(
    report([
      ["b", "failed"],
      ["a", "passed"],
    ]),
  );
  assert.deepEqual(disagreements(first, second), []);
});

test("a status that changes between runs is reported with both statuses", () => {
  const first = resultsOf(report([["a", "passed"]]));
  const second = resultsOf(report([["a", "failed"]]));
  assert.deepEqual(disagreements(first, second), [
    { name: "token-saver.test.ts › token-saver › a", first: "passed", second: "failed" },
  ]);
});

test("a test that exists in only one run is a disagreement, both ways", () => {
  const both = resultsOf(
    report([
      ["a", "passed"],
      ["b", "passed"],
    ]),
  );
  const missingSecond = resultsOf(report([["a", "passed"]]));
  assert.deepEqual(disagreements(both, missingSecond), [
    { name: "token-saver.test.ts › token-saver › b", first: "passed", second: "missing" },
  ]);
  assert.deepEqual(disagreements(missingSecond, both), [
    { name: "token-saver.test.ts › token-saver › b", first: "missing", second: "passed" },
  ]);
});
