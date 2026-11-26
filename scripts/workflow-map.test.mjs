// SPDX-License-Identifier: Apache-2.0
/**
 * The workflow table in docs/OPS.md is the only place a maintainer can see what
 * fourteen workflows are for, so it cannot be allowed to rot.
 *
 * One row per workflow in `.github/workflows/`, in both directions: a workflow
 * with no row fails (nobody knows what it prevents), and a row with no workflow
 * fails (the doc describes something that is not there).
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const WORKFLOWS = ".github/workflows";
const DOC = "docs/OPS.md";

/** Workflow file names, e.g. `lint.yml`. */
function workflowFiles() {
  return readdirSync(WORKFLOWS)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();
}

/** The workflow names the doc's table rows claim to describe. */
function documentedWorkflows() {
  const doc = readFileSync(DOC, "utf8");
  const section = doc.split("## 7. What each workflow prevents")[1]?.split("\n## ")[0];
  assert.ok(section, "docs/OPS.md has no '## 7. What each workflow prevents' section");

  const rows = [];
  for (const line of section.split("\n")) {
    if (!line.startsWith("| `")) continue;
    // | `lint.yml` | PR, push | … — the first cell is the workflow, often several.
    for (const name of line.slice(0, line.indexOf("|", 1)).matchAll(/`([^`]+)`/g)) {
      rows.push(name[1]);
    }
  }
  return rows.sort();
}

test("every workflow has a row saying what it prevents", () => {
  const documented = documentedWorkflows();
  const missing = workflowFiles().filter((file) => !documented.includes(file));
  assert.deepEqual(missing, [], `workflows with no row in ${DOC}`);
});

test("no row names a workflow that does not exist", () => {
  const files = workflowFiles();
  const ghosts = documentedWorkflows().filter((name) => !files.includes(name));
  assert.deepEqual(ghosts, [], `rows in ${DOC} naming a missing workflow`);
});

test("every row states a distinct failure", () => {
  const doc = readFileSync(DOC, "utf8");
  const section = doc.split("## 7. What each workflow prevents")[1]?.split("\n## ")[0] ?? "";
  const reasons = section
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) => line.split("|")[3]?.trim() ?? "");
  assert.ok(reasons.length > 0, "no table rows found");
  for (const [i, reason] of reasons.entries()) {
    assert.ok(
      (reason?.length ?? 0) > 30,
      `row ${i + 1} says nothing specific about the failure it prevents: "${reason}"`,
    );
  }
  assert.equal(new Set(reasons).size, reasons.length, "two rows give the same reason");
});
