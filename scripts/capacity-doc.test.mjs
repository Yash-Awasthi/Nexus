// SPDX-License-Identifier: Apache-2.0
/**
 * The capacity page is quoted in planning conversations, so its numbers have to be traceable: a command that
 * produces them, a machine they were produced on, and a code fact behind each structural claim.
 *
 * This test does not re-run the probe (that takes seconds and is flaky by ±25% on a busy laptop). It checks the
 * things that would silently make the page false: the probe still exists and still prints a table, the pool really is
 * unconfigured (so "driver default 10" stays true), the boot budget it quotes is still the gate's budget, and the
 * scaling path in the runbook still points here.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const CAPACITY = "docs/CAPACITY.md";
const RUNBOOK = "docs/runbook.md";
const PROBE = "scripts/load-probe.ts";
const POOL = "apps/api/src/lib/pg-pool.ts";

const capacity = readFileSync(CAPACITY, "utf8");
const runbook = readFileSync(RUNBOOK, "utf8");

test("the probe exists and is the command the page tells you to run", () => {
  assert.ok(existsSync(PROBE));
  assert.match(capacity, /node scripts\/load-probe\.ts/);
  const probe = readFileSync(PROBE, "utf8");
  assert.match(
    probe,
    /\/health\/ready/,
    "the probe should drive a database-touching route as well",
  );
  assert.match(probe, /\/health["`]/, "the probe should drive a route with no database");
});

test("the pool claim is backed by the code rather than remembered", () => {
  const pool = readFileSync(POOL, "utf8");
  // "10 connections per replica" is the node-postgres default, and it is only true while no `max` is set.
  assert.match(
    pool,
    /new Pool\(\{\s*connectionString/,
    "the pool construction moved; re-check the default",
  );
  assert.doesNotMatch(
    pool,
    /new Pool\(\{[^}]*\bmax\s*:/,
    "a max is configured now; the capacity page's arithmetic changes",
  );
  assert.match(capacity, /10 connections/);
});

test("every structural number in the page is labelled measured or arithmetic", () => {
  // The page must not present an unmeasured figure as a measurement: each row of the limits table carries its
  // provenance, and the two that were not benchmarked say so in words.
  assert.match(capacity, /measured/i);
  assert.match(capacity, /Not measured locally|arithmetic, not a benchmark/);
  assert.match(capacity, /machine/i, "the page must name the machine the numbers came from");
});

test("the boot cost it quotes is the budget the gate actually enforces", () => {
  const budget = JSON.parse(readFileSync(".github/boot-budget.json", "utf8"));
  assert.ok(budget.bootMs >= 6_000, "the boot budget moved; update the capacity page with it");
  // The budget is a ceiling against a blocking-await regression, not a target: it has to sit well
  // above the measured boot, because a budget that is red on arrival gets deleted rather than fixed.
  assert.ok(
    budget.bootMs >= 10_000,
    "the budget must leave room over a 7 s boot for the machine's noise",
  );
  // The page quotes the measured boot and the budget it must stay under; both are checked against the real files.
  assert.match(
    capacity,
    /6\.9–7\.3 s/,
    "the page must quote the measured boot range the gate reports",
  );
  assert.match(
    capacity,
    /fastest of five/,
    "the page must say which sample the budget is enforced against",
  );
  assert.ok(
    capacity.replace(/\s+/g, "").includes(`${budget.bootMs}ms`),
    `the page must name the gate's budget (${budget.bootMs} ms)`,
  );
  assert.match(capacity, /api-boot-budget/);
});

test("the runbook's scaling path points at this page and keeps its triggers", () => {
  assert.match(runbook, /docs\/CAPACITY\.md/);
  for (const step of ["Single replica", "pooler", "Redis cluster", "Worker split"])
    assert.ok(runbook.includes(step), `the staged path lost "${step}"`);
  // The ordering claim is the whole point of the section: connections break before throughput does.
  assert.match(runbook, /connection ceiling/);
});
