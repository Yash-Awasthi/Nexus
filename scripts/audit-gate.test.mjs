// SPDX-License-Identifier: Apache-2.0
/** The gate is only as good as its decision: what blocks, what expired, what is stale. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { advisoriesOf, decide } from "./audit-gate.mjs";

const pnpmReport = {
  advisories: {
    1001: {
      github_advisory_id: "GHSA-aaaa-bbbb-cccc",
      module_name: "left-pad",
      severity: "high",
      title: "prototype pollution",
    },
    1002: { id: 1002, module_name: "tiny", severity: "moderate", title: "ReDoS" },
  },
};

const npmReport = {
  advisories: {},
  vulnerabilities: {
    lodash: {
      severity: "critical",
      via: [{ source: "GHSA-dddd-eeee-ffff", title: "code injection", severity: "critical" }],
    },
  },
};

const now = new Date("2026-11-24T12:00:00Z");

test("reads pnpm's advisories, keyed by the GitHub id", () => {
  assert.deepEqual(advisoriesOf(pnpmReport), [
    {
      id: "GHSA-aaaa-bbbb-cccc",
      package: "left-pad",
      severity: "high",
      title: "prototype pollution",
    },
    { id: "1002", package: "tiny", severity: "moderate", title: "ReDoS" },
  ]);
});

test("reads npm-style vulnerabilities too, so a pnpm major cannot pass silently", () => {
  assert.deepEqual(advisoriesOf(npmReport), [
    {
      id: "GHSA-dddd-eeee-ffff",
      package: "lodash",
      severity: "critical",
      title: "code injection",
    },
  ]);
});

test("high and critical block, moderate does not", () => {
  const { unallowed } = decide(advisoriesOf(pnpmReport), [], now);
  assert.deepEqual(
    unallowed.map((a) => a.id),
    ["GHSA-aaaa-bbbb-cccc"],
  );
});

test("an allowlisted advisory with a live expiry date does not block", () => {
  const allowlist = [
    {
      id: "GHSA-aaaa-bbbb-cccc",
      package: "left-pad",
      reason: "no fix released; not reachable from the server",
      expires: "2026-12-31",
    },
  ];
  const decision = decide(advisoriesOf(pnpmReport), allowlist, now);
  assert.deepEqual(decision.unallowed, []);
  assert.deepEqual(decision.expired, []);
  assert.deepEqual(decision.stale, []);
});

test("an expired allowlist entry fails even though the advisory is listed", () => {
  const allowlist = [
    { id: "GHSA-aaaa-bbbb-cccc", package: "left-pad", reason: "waiting", expires: "2026-11-01" },
  ];
  const decision = decide(advisoriesOf(pnpmReport), allowlist, now);
  assert.equal(decision.expired.length, 1);
  assert.match(decision.expired[0].why, /expired 2026-11-01/);
  // The advisory is not silently allowed by an expired entry.
  assert.deepEqual(
    decision.unallowed.map((a) => a.id),
    ["GHSA-aaaa-bbbb-cccc"],
  );
});

test("an entry with no usable date is an expired entry, not an allowance", () => {
  const allowlist = [{ id: "GHSA-aaaa-bbbb-cccc", package: "left-pad", reason: "forgot" }];
  const decision = decide(advisoriesOf(pnpmReport), allowlist, now);
  assert.equal(decision.expired.length, 1);
  assert.match(decision.expired[0].why, /no valid expiry date/);
});

test("an allowlisted advisory that is gone is stale, and stale alone does not fail", () => {
  const allowlist = [
    {
      id: "GHSA-gone-0000-0000",
      package: "fixed-pkg",
      reason: "was unfixable",
      expires: "2027-01-01",
    },
  ];
  const decision = decide(advisoriesOf(pnpmReport), allowlist, now);
  assert.deepEqual(decision.stale, ["GHSA-gone-0000-0000"]);
  assert.equal(decision.unallowed.length, 1, "the real high advisory still blocks");
});

test("a clean report blocks nothing", () => {
  const decision = decide([], [], now);
  assert.deepEqual(decision, {
    unallowed: [],
    expired: [],
    stale: [],
    blockedCount: 0,
  });
});
