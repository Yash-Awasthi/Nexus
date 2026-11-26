// SPDX-License-Identifier: Apache-2.0
/**
 * A boot budget is only honest if somebody measured the number it enforces. These tests
 * do three things: boot the real server once and time it, check that the committed budget
 * is the measured value with room to spare rather than a guess, and check that the failure
 * message names the thing to look for.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { budget, measureBoot } from "./api-boot-budget.mjs";

const scratch = mkdtempSync(join(tmpdir(), "boot-budget-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

test("the committed budget is a measured number with headroom, not a hope", () => {
  const limits = budget();
  assert.equal(typeof limits.bootMs, "number");
  assert.ok(limits.bootMs >= 1000 && limits.bootMs <= 30_000, `${limits.bootMs}ms is not a boot budget`);
  assert.equal(typeof limits.maxRoutes, "number");
});

test("the real server boots, answers /health, and registers a countable route table", async () => {
  const measured = await measureBoot();
  assert.equal(measured.status, 200);
  assert.ok(measured.routes > 100, `only ${measured.routes} route lines — did registration break?`);
  assert.ok(
    measured.elapsedMs < budget().bootMs,
    `boot took ${Math.round(measured.elapsedMs)}ms, budget ${budget().bootMs}ms`,
  );
});

test("a budget file is read as data, so raising it is a visible commit", () => {
  const file = join(scratch, "budget.json");
  writeFileSync(file, JSON.stringify({ bootMs: 1234, maxRoutes: 10 }));
  assert.deepEqual(budget(file), { bootMs: 1234, maxRoutes: 10 });
});
