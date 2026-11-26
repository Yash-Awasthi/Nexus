// SPDX-License-Identifier: Apache-2.0
/**
 * A cache nobody restores is a cache that does not exist, and a wall time nobody
 * publishes cannot regress visibly.
 *
 * These assertions parse the workflows and check the two things that quietly stop
 * working: a job that installs dependencies without enabling the package manager
 * cache, and a job that runs a turbo task without restoring `.turbo/cache` or
 * without reporting how long it took.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { parse } from "yaml";

const WORKFLOWS = ".github/workflows";

/** Every job in every workflow, as `{ file, name, job }`. */
function jobs() {
  const all = [];
  for (const file of readdirSync(WORKFLOWS).filter((name) => name.endsWith(".yml"))) {
    const doc = parse(readFileSync(`${WORKFLOWS}/${file}`, "utf8"));
    for (const [name, job] of Object.entries(doc?.jobs ?? {})) {
      all.push({ file, name, job: job ?? {} });
    }
  }
  return all;
}

/** The `run:` scripts of a job, one string per step. */
function scripts(job) {
  return (job.steps ?? []).map((step) => String(step?.run ?? "")).filter((run) => run !== "");
}

const INSTALLS = /(^|\s)pnpm install\b/;
/** `pnpm build` and `pnpm test` are turbo tasks; `pnpm --filter … test` is not. */
const TURBO_TASK = /(^|\s)pnpm (build|test)(\s|$)/;
const REPORTS_TIME = /scripts\/job-times\.mjs --job/;

/** Whether the job opts into the package manager cache. */
function cachesPackages(job) {
  return (job.steps ?? []).some(
    (step) =>
      (String(step?.uses ?? "").startsWith("voidzero-dev/setup-vp") && step.with?.cache === true) ||
      (String(step?.uses ?? "").startsWith("actions/setup-node") && step.with?.cache === "pnpm"),
  );
}

/** Whether the job restores turborepo's local cache. */
function cachesTurbo(job) {
  return (job.steps ?? []).some(
    (step) =>
      String(step?.uses ?? "").startsWith("actions/cache") &&
      String(step?.with?.path ?? "").includes(".turbo"),
  );
}

test("every job that installs dependencies enables the package manager cache", () => {
  const offenders = jobs()
    .filter(({ job }) => scripts(job).some((run) => INSTALLS.test(run)))
    .filter(({ job }) => !cachesPackages(job))
    .map(({ file, name }) => `${file}:${name}`);
  assert.deepEqual(offenders, [], "jobs installing without a package cache");
});

test("every job that runs a turbo task restores the turbo cache", () => {
  const offenders = jobs()
    .filter(({ job }) => scripts(job).some((run) => TURBO_TASK.test(run)))
    .filter(({ job }) => !cachesTurbo(job))
    .map(({ file, name }) => `${file}:${name}`);
  assert.deepEqual(offenders, [], "turbo jobs without a .turbo/cache restore");
});

test("every turbo job reports its wall time", () => {
  const offenders = jobs()
    .filter(({ job }) => scripts(job).some((run) => TURBO_TASK.test(run)))
    .filter(({ job }) => !scripts(job).some((run) => REPORTS_TIME.test(run)))
    .map(({ file, name }) => `${file}:${name}`);
  assert.deepEqual(offenders, [], "turbo jobs that never publish a wall time");
});

test("the check knows what a turbo task looks like", () => {
  // Guards the assertions above: a pattern that matches nothing makes them all
  // pass for the wrong reason.
  const turboJobs = jobs().filter(({ job }) => scripts(job).some((run) => TURBO_TASK.test(run)));
  assert.ok(turboJobs.length >= 2, `found ${turboJobs.length} turbo jobs`);
  assert.ok(
    turboJobs.some(({ file }) => file === "build.yml"),
    "build.yml runs pnpm build and should be in the list",
  );
});
