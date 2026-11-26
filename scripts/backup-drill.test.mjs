// SPDX-License-Identifier: Apache-2.0
/**
 * The backup drill is read as data and checked against the tree, because the day it
 * matters is the day nobody has run it for six months: the script has to still exist,
 * the command that verifies the audit chain has to point at a real route, and the
 * record table has to still say `_unrun_` if it has not been done.
 *
 * The drill itself needs a real server and a scratch database, so it is not run here —
 * `scripts/db-backup-drill.sh` is what a human runs, and its dangerous half (restoring
 * over the source) is what these assertions keep in place.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { envNames, section } from "./markdown-sections.mjs";

const RUNBOOK = "docs/runbook.md";
const SCRIPT = "scripts/db-backup-drill.sh";
const drill = section(readFileSync(RUNBOOK, "utf8"), /^### 7\.5 /) ?? "";
const script = existsSync(SCRIPT) ? readFileSync(SCRIPT, "utf8") : "";

test("the drill exists and carries a record table", () => {
  assert.ok(drill.length > 800, "docs/runbook.md 7.5 is missing or too short to be a procedure");
  assert.match(drill, /scripts\/db-backup-drill\.sh/, "the procedure names no script");
  assert.match(drill, /Drill record/, "no place to record the measured wall time");
  assert.match(drill, /\| _unrun_ \|/, "the record must show the drill has not been run yet");
  for (const column of ["Restore wall time", "Total wall time", "Dump size", "Rows restored"])
    assert.match(drill, new RegExp(column), `the record has no ${column} column`);
});

test("the script exists and every variable it needs is in the procedure", () => {
  assert.ok(script.length > 1_000, `${SCRIPT} is missing`);
  for (const name of ["DATABASE_URL", "SCRATCH_DATABASE_URL", "RUN_SUITE", "PG_URL"]) {
    assert.match(script, new RegExp(`\\b${name}\\b`), `the script no longer uses ${name}`);
  }
  const named = new Set(envNames(drill));
  for (const name of ["DATABASE_URL", "SCRATCH_DATABASE_URL", "RUN_SUITE", "PG_URL"])
    assert.ok(named.has(name), `the procedure does not mention ${name}`);
});

test("the script refuses to restore over the source database", () => {
  assert.match(
    script,
    /if \[ "\$DATABASE_URL" = "\$SCRATCH_DATABASE_URL" \]/,
    "the identical-URL guard is gone: this is the assertion that keeps a drill from being an incident",
  );
  assert.match(script, /DROP DATABASE IF EXISTS \\"\$scratch_name\\"/, "the scratch drop changed");
  // The drop must target the scratch name, never the source URL.
  assert.doesNotMatch(script, /DROP DATABASE[^\n]*DATABASE_URL/);
});

test("the checks the procedure promises are the checks the script runs", () => {
  for (const step of [
    /pg_dump --no-owner/,
    /gunzip -c "\$dump" \| psql/,
    /count\(\*\) FROM \\"\$table\\"/,
    /audit_log/,
  ])
    assert.match(script, step, `the script no longer performs ${step}`);
});

test("the audit-chain check points at things that exist", () => {
  const routes = readFileSync("apps/api/src/routes/audit.ts", "utf8");
  assert.match(routes, /"\/audit\/log\/verify"/, "the verify route moved");
  assert.match(drill, /\/api\/v1\/audit\/log\/verify/, "");
  const cli = JSON.parse(readFileSync("apps/cli/package.json", "utf8"));
  assert.equal(cli.name, "@nexus/cli", "the CLI package was renamed");
  assert.match(drill, /nexus audit verify/, "the CLI half of the check is gone");
});
