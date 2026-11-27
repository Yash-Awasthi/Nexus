// SPDX-License-Identifier: Apache-2.0
/**
 * A budget that cannot fail is a sentence, not a gate. These tests pin the four
 * decisions `--check` makes: a number with no baseline is recorded, a number from
 * another machine is not compared, a regression past the tolerance fails, and a
 * regression inside it does not. They also pin the workload list, so deleting the
 * build or test measurement is a failing test rather than a quieter table.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  SAMPLES,
  TOLERANCE_PCT,
  WORKLOADS,
  fastest,
  hostLabel,
  judge,
  readBaseline,
} from "./perf-budget.mjs";

const scratch = mkdtempSync(join(tmpdir(), "perf-budget-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const HOST = "test-host";

test("the four things the plan names are measured", () => {
  for (const name of ["buildCold", "buildWarm", "test", "uiDev"]) {
    assert.ok(WORKLOADS[name], `${name} is not measured`);
    assert.equal(typeof WORKLOADS[name].run, "function");
    assert.ok(WORKLOADS[name].what.length > 10, `${name} does not say what its number means`);
  }
  assert.equal(WORKLOADS.test.samples, 2, "the expensive suite is sampled twice, not five times");
});

test("every workload is sampled more than once, and the fastest sample is the one judged", () => {
  assert.ok(SAMPLES >= 2, "the plan asks for at least two samples");
  // Noise is one-sided: another process can only add time, so the minimum is the code.
  assert.equal(fastest([27_455, 12_400, 19_000]), 12_400);
  assert.equal(fastest([900]), 900);
  assert.throws(() => fastest([]), /at least one sample/);
});

test("a workload with no baseline is recorded, not judged", () => {
  assert.deepEqual(judge("buildCold", 1000, {}), { ok: true, reason: "no baseline recorded" });
});

test("a baseline from another machine is not compared with this one", () => {
  const baseline = { test: { ms: 1000, host: "a-different-laptop" } };
  const verdict = judge("test", 5000, baseline, HOST);
  assert.equal(verdict.ok, true);
  assert.match(verdict.reason, /baseline is from a-different-laptop/);
});

test("a regression past the tolerance fails and says by how much", () => {
  const baseline = { buildCold: { ms: 10_000, host: HOST } };
  const over = Math.round(10_000 * (1 + (TOLERANCE_PCT + 5) / 100));
  const verdict = judge("buildCold", over, baseline, HOST);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, new RegExp(`${TOLERANCE_PCT + 5}% over the 10000ms baseline`));
});

test("a regression inside the tolerance passes, and the number is still reported", () => {
  const baseline = { buildCold: { ms: 10_000, host: HOST } };
  const verdict = judge("buildCold", 11_000, baseline, HOST);
  assert.equal(verdict.ok, true);
  assert.match(verdict.reason, /\+10% vs 10000ms/);
});

test("a faster run is reported as negative, not silently equal", () => {
  const baseline = { test: { ms: 10_000, host: HOST } };
  assert.match(judge("test", 8000, baseline, HOST).reason, /-20% vs 10000ms/);
});

test("a host label names the machine well enough to compare", () => {
  const label = hostLabel({
    osPlatform: "linux",
    cpuModel: "AMD EPYC  7763 64-Core Processor",
    cores: 4,
    bytes: 16 * 1024 ** 3,
  });
  assert.equal(label, "linux-AMD EPYC 7763 64-Core Processor-4c-16gb");
  // Two different machines must not share a label.
  assert.notEqual(label, hostLabel({ osPlatform: "linux", cpuModel: "AMD EPYC 7763", cores: 2 }));
});

test("an unreadable or missing baseline is an empty set, not a crash", () => {
  const missing = join(scratch, "nope.json");
  assert.deepEqual(readBaseline(missing), {});
  const broken = join(scratch, "broken.json");
  writeFileSync(broken, "{ not json");
  assert.deepEqual(readBaseline(broken), {});
});
