// SPDX-License-Identifier: Apache-2.0
/**
 * `tsconfig.build.json` lists every package project `tsc -b` should build.
 * TypeScript project references cannot be globs, so that list has to exist —
 * but it does not have to be typed by hand, and a package missing from it is
 * never built or typechecked.
 *
 *   node scripts/tsconfig-refs.mjs           rewrite the references
 *   node scripts/tsconfig-refs.mjs --check   fail if they are stale
 *
 * `scripts/lint-targets.test.mjs` runs the same comparison, so CI fails either
 * way; this exists to make the fix one command.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { root, workspaces } from "./lint-targets.mjs";

const TARGET = join(root, "tsconfig.build.json");

export function expectedReferences() {
  // Only packages are built by this project; apps carry their own configs.
  return workspaces()
    .filter((workspace) => workspace.startsWith("packages/"))
    .map((workspace) => ({ path: workspace }));
}

const current = JSON.parse(readFileSync(TARGET, "utf8"));
const expected = expectedReferences();
const checkOnly = process.argv.includes("--check");

if (checkOnly) {
  const before = JSON.stringify(current.references ?? []);
  const after = JSON.stringify(expected);
  if (before !== after) {
    console.error("tsconfig.build.json references are stale. Expected:");
    console.error(expected.map((reference) => `  ${reference.path}`).join("\n"));
    process.exit(1);
  }
  console.log(`tsconfig.build.json references all ${expected.length} packages`);
} else {
  // Keep every other key: this file may grow options that are not references.
  writeFileSync(TARGET, `${JSON.stringify({ ...current, references: expected }, null, 2)}\n`);
  console.log(`Wrote ${expected.length} references to tsconfig.build.json`);
}
