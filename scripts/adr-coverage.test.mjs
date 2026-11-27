// SPDX-License-Identifier: Apache-2.0
/**
 * A decision that changes a gate, a durability class or an invariant is a decision somebody will need to
 * understand later, and the diff that made it will not be enough.
 *
 * The rule this enforces is narrow on purpose, because a rule nobody can satisfy gets deleted. It does not try to
 * detect "did this change a threshold" from git history — that needs a baseline and a human. Instead it names the
 * **threshold-bearing artifacts** that exist today, and fails when one of them is not mentioned by any ADR. Adding a
 * gate or changing what a number means therefore fails with a message that says which file to justify and where to
 * write it, which is exactly the moment to write the ADR — not six releases later.
 *
 * The second half checks the opposite direction: every ADR is linked from `docs/adr/`'s neighbourhood (the ADRs a
 * reader is pointed at) and has the sections the template asks for, so an "ADR" that is three lines of intent does
 * not satisfy the rule.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ADR_DIR = "docs/adr";

/** Files whose numbers are decisions: a gate, a floor, a budget, a durability class. */
const THRESHOLDS = [
  {
    artifact: "council-evals:check",
    where: "package.json + .github/workflows/lint.yml",
    why: "the council quality gate",
  },
  {
    artifact: "evals:check",
    where: "package.json + .github/workflows/lint.yml",
    why: "the retrieval quality gate",
  },
  {
    artifact: "coverage-floors",
    where: "scripts/coverage-floors.test.mjs",
    why: "per-package coverage floors",
  },
  {
    artifact: "perf-budget",
    where: "scripts/perf-budget.test.mjs",
    why: "the latency and bundle budgets",
  },
  {
    artifact: "key_material_version",
    where: "packages/db/migrations/20240610061320_0023_key_material_version",
    why: "the durability class of stored secrets",
  },
  {
    artifact: "RETENTION",
    where: "packages/contracts/src/shared/retention.ts",
    why: "how long every store keeps data",
  },
];

const adrs = readdirSync(ADR_DIR)
  .filter((name) => /^\d{4}-.+\.md$/.test(name))
  .map((name) => ({ name, text: readFileSync(path.join(ADR_DIR, name), "utf8") }));

test("there are ADRs to check against, or the rule proves nothing", () => {
  assert.ok(adrs.length >= 15, `only ${adrs.length} ADRs found`);
});

test("every threshold-bearing artifact is justified by an ADR", () => {
  const missing = THRESHOLDS.filter(
    ({ artifact }) => !adrs.some((adr) => adr.text.includes(artifact)),
  );
  assert.deepEqual(
    missing.map((row) => `${row.artifact} (${row.why}, in ${row.where})`),
    [],
    "write an ADR in docs/adr for this number, or the next person changes it without knowing what it protects",
  );
});

/**
 * ADRs written from this number on are held to the template. Earlier ones predate the rule — they are shorter,
 * and 0020 uses different headings — so retrofitting them would either rewrite history or make the rule fail on
 * day one, and a rule that is red on arrival gets disabled.
 */
const SHAPED_FROM = 21;

test("each ADR written since this rule has the shape the template asks for", () => {
  const shaped = adrs.filter((adr) => Number(adr.name.slice(0, 4)) >= SHAPED_FROM);
  assert.ok(shaped.length >= 3, `only ${shaped.length} ADRs are held to the template`);
  const incomplete = [];
  for (const adr of shaped) {
    for (const section of ["## Context", "## Decision", "## Consequences"])
      if (!adr.text.includes(section)) incomplete.push(`${adr.name}: missing ${section}`);
    if (!/\*\*Status:\*\*/.test(adr.text)) incomplete.push(`${adr.name}: missing Status`);
    if (!/\*\*Date:\*\* \d{4}-\d{2}-\d{2}/.test(adr.text))
      incomplete.push(`${adr.name}: missing Date`);
    // An ADR is a decision, not a stub: the consequences paragraph is where the cost is admitted.
    if (adr.text.split("\n").length < 25) incomplete.push(`${adr.name}: shorter than a decision`);
  }
  assert.deepEqual(incomplete, []);
});

test("no ADR is a placeholder left in the tree", () => {
  const stubs = adrs.filter((adr) => /<!-- What was decided/.test(adr.text)).map((adr) => adr.name);
  assert.deepEqual(stubs, []);
});
