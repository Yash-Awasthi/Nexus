// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for the migration-discipline rule, plus the real tree it guards.
 *
 * The cases are the ones the rule has to get right in order to be worth anything:
 * a comment that mentions a DELETE is not a DELETE (three migrations here say
 * `DELETE FROM` in a cleanup hint), an exception with no ADR is not a permit, and the
 * tree as shipped is clean — so a failure later means somebody added the statement,
 * not that the rule was always red.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { audit, migrations, statements, stripComments } from "./migrations-forward-only.mjs";

/** A throwaway migrations tree with one file per entry. */
function tree(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "nexus-mig-"));
  for (const [name, sql] of Object.entries(files)) {
    mkdirSync(path.join(dir, name), { recursive: true });
    writeFileSync(path.join(dir, name, "migration.sql"), sql);
  }
  return dir;
}

function exceptionsFile(entries) {
  const dir = mkdtempSync(path.join(tmpdir(), "nexus-mig-exc-"));
  const file = path.join(dir, "exceptions.json");
  writeFileSync(file, JSON.stringify({ entries }));
  return file;
}

test("comments are not statements", () => {
  const sql = `-- Periodic cleanup hint: DELETE FROM refresh_tokens
/* DROP TABLE users; */
CREATE TABLE kept (id int);`;
  const found = statements(sql).filter((s) => /DELETE|DROP/i.test(s));
  assert.deepEqual(found, []);
  assert.match(stripComments(sql).trim(), /^CREATE TABLE kept/);
});

test("a migration that drops a column is refused", () => {
  const dir = tree({
    "0001_add": "ALTER TABLE users ADD COLUMN nick text;",
    "0002_drop": "ALTER TABLE users DROP COLUMN nick;",
  });
  try {
    const { found } = audit(dir, exceptionsFile([]));
    assert.equal(found.length, 1);
    assert.equal(found[0].rule, "drop column");
    assert.equal(found[0].migration, "0002_drop");
    assert.equal(found[0].permitted, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an exception needs a reason and an ADR that exists", () => {
  const dir = tree({ "0002_drop": "ALTER TABLE users DROP COLUMN nick;" });
  const withoutAdr = exceptionsFile([
    { migration: "0002_drop", match: "DROP COLUMN nick", reason: "column never used" },
  ]);
  const withMissingAdr = exceptionsFile([
    {
      migration: "0002_drop",
      match: "DROP COLUMN nick",
      reason: "column never used",
      adr: "docs/adr/9999-does-not-exist.md",
    },
  ]);
  const realAdr = exceptionsFile([
    {
      migration: "0002_drop",
      match: "DROP COLUMN nick",
      reason: "column never used",
      adr: "docs/adr/0019-transitive-dependency-without-a-licence.md",
    },
  ]);
  try {
    for (const file of [withoutAdr, withMissingAdr]) {
      const { found } = audit(dir, file);
      assert.equal(found[0].permitted, null, `${file} must not permit the drop`);
    }
    const { found, stale } = audit(dir, realAdr);
    assert.ok(found[0].permitted, "a named, existing ADR permits the drop");
    assert.deepEqual(stale, [], "a used exception is not stale");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an exception that matches nothing is reported, not silently ignored", () => {
  const dir = tree({ "0001_add": "ALTER TABLE users ADD COLUMN nick text;" });
  const file = exceptionsFile([
    {
      migration: "0001_add",
      match: "DROP COLUMN nick",
      reason: "remove a column that was never added",
      adr: "docs/adr/0019-transitive-dependency-without-a-licence.md",
    },
  ]);
  try {
    const { found, stale } = audit(dir, file);
    assert.deepEqual(found, []);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].migration, "0001_add");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rewrite is flagged for a look without failing the build", () => {
  const dir = tree({ "0001_widen": "ALTER TABLE users ALTER COLUMN nick TYPE varchar(120);" });
  try {
    const { found } = audit(dir, exceptionsFile([]));
    assert.equal(found.length, 1);
    assert.equal(found[0].rule, "type change");
    assert.equal(found[0].suspect, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the migrations this repo ships remove nothing", () => {
  const all = migrations();
  assert.ok(all.length >= 20, `only ${all.length} migrations found — the scan is broken`);
  const { found, stale } = audit();
  const failures = found.filter((hit) => !hit.permitted && !hit.suspect);
  assert.deepEqual(failures, [], "a shipped migration removes something");
  assert.deepEqual(stale, [], ".github/migration-exceptions.json has an unused entry");
});
