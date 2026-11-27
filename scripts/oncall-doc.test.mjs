// SPDX-License-Identifier: Apache-2.0
/**
 * An on-call document is a set of promises about other documents: the playbooks it tells you to run, the alert
 * table that decides whether a page is real, the template a postmortem is written from. Every one of those is a
 * filename, and filenames rot — a renamed section turns "run P4" into a shrug at 3am.
 *
 * This test reads the on-call page and checks its references against the tree, and it checks the page itself for the
 * two things that make it honest: a stated response target and a stated limit. The point is not that the words are
 * good; it is that the promises still point at something.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ONCALL = "docs/ONCALL.md";
const RUNBOOK = "docs/runbook.md";
const SLOs = "docs/slos.md";
const TEMPLATE = "docs/internal/postmortem-template.md";

const oncall = readFileSync(ONCALL, "utf8");
const runbook = readFileSync(RUNBOOK, "utf8");
const slos = readFileSync(SLOs, "utf8");

test("the page states a rotation, a response target and a limit", () => {
  assert.match(oncall, /rotation is one person/i);
  assert.match(oncall, /Acknowledge within/);
  assert.match(oncall, /No 24×7 cover/i);
  // A response target with no hours attached is a target nobody can miss.
  assert.match(oncall, /waking hours/i);
});

test("every playbook it names exists in the runbook", () => {
  const cited = new Set([...oncall.matchAll(/\bP([1-5])\b/g)].map((hit) => `### P${hit[1]}`));
  assert.ok(cited.size >= 3, "the on-call page should cite the playbooks it tells you to run");
  for (const section of cited)
    assert.ok(runbook.includes(section), `runbook is missing ${section}`);
});

test("it points at the alert table that decides what a page means", () => {
  assert.ok(oncall.includes("docs/slos.md"));
  assert.ok(runbook.includes("### 10.1"), "the runbook's alert table is gone");
  assert.match(
    slos,
    /## Error budget tracking/,
    "the error-budget section the review depends on is gone",
  );
});

test("the postmortem template exists and asks for the things that make it useful", () => {
  assert.ok(existsSync(TEMPLATE));
  const template = readFileSync(TEMPLATE, "utf8");
  for (const heading of [
    "Timeline",
    "Contributing causes",
    "What would have caught it earlier",
    "Follow-ups",
  ])
    assert.match(template, new RegExp(`## \\d\\. ${heading}`), `template lost "${heading}"`);
  // An action item with no owner and no date is a wish.
  assert.match(template, /\| Owner \| Due \|/);
});

test("the rollback it tells you to reach for is documented with its constraints", () => {
  assert.match(oncall, /§8/);
  assert.match(runbook, /## 8\. Upgrade and rollback/);
  assert.ok(oncall.includes("docs/UPGRADING.md"), "rollback reasoning lives in the upgrade policy");
});

test("the incident note location it names is a real directory convention", () => {
  assert.match(oncall, /docs\/internal\/incidents\//);
  // The directory need not exist before the first incident, but the parent must.
  assert.ok(existsSync("docs/internal"));
  assert.ok(existsSync(path.join("docs/internal", "postmortem-template.md")));
});
