// SPDX-License-Identifier: Apache-2.0
/** A 25% regression is a cache that stopped working; the number has to be published to notice. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { regression, summaryRow } from "./job-times.mjs";

test("a job inside the 25% band passes", () => {
  assert.equal(regression(400, 400), null);
  assert.equal(regression(400, 480), null);
  assert.equal(regression(400, 500), null);
});

test("a job beyond the 25% band fails and says by how much", () => {
  const verdict = regression(400, 501);
  assert.match(verdict ?? "", /501s, 25% over the 400s baseline/);
  assert.match(verdict ?? "", /limit 25%/);
});

test("a job with no baseline is not judged", () => {
  assert.equal(regression(undefined, 9_999), null);
  assert.equal(regression(0, 9_999), null);
  assert.equal(regression(null, 9_999), null);
});

test("the tolerance is configurable", () => {
  assert.equal(regression(400, 500, 0.5), null);
  assert.match(regression(400, 620, 0.5) ?? "", /limit 50%/);
});

test("the summary row says when there is no baseline yet", () => {
  assert.equal(summaryRow("build", 420, undefined), "| build | 420s (no baseline yet) |");
  assert.equal(summaryRow("build", 420, 400), "| build | 420s vs 400s baseline |");
});
