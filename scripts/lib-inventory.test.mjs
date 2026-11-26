// SPDX-License-Identifier: Apache-2.0
/**
 * The inventory gate has to be able to say three things: a module with no domain, a
 * module with no test, and an allowlist entry that a test has since covered. If it can
 * only report the tree as healthy, it is a report rather than a gate.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { classify, report, untested } from "./lib-inventory.mjs";

const scratch = mkdtempSync(join(tmpdir(), "lib-inventory-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A lib directory holding the named modules (as empty files). */
function lib(...names) {
  const dir = join(scratch, `lib-${names.join("-") || "empty"}`);
  mkdirSync(dir, { recursive: true });
  for (const name of names) writeFileSync(join(dir, `${name}.ts`), "export const x = 1;\n");
  return dir;
}

test("the real tree is fully mapped and has no unlisted module", () => {
  const measured = report();
  assert.deepEqual(measured.unmapped, []);
  assert.deepEqual(
    measured.untested.filter(
      (name) =>
        ![
          "audit-emitter",
          "board-client",
          "exec-guard",
          "oauth-drivers",
          "plugin-host",
          "sentry-reporter",
          "sign-in-finish",
          "sso-link",
          "semantic-cache",
        ].includes(name),
    ),
    [],
  );
  assert.deepEqual(measured.stale, [], "every allowlisted module is still untested");
});

test("a module no rule claims is reported, not silently filed", () => {
  const { unmapped } = classify(["total-mystery"]);
  assert.deepEqual(unmapped, ["total-mystery"]);
});

test("every module lands in exactly one domain", () => {
  const { rows } = classify(["llm-failover", "org-store", "skill-runner", "reply-errors"]);
  assert.deepEqual(
    rows.map((row) => [row.name, row.domain]),
    [
      ["llm-failover", "models"],
      ["org-store", "org"],
      ["skill-runner", "skills"],
      ["reply-errors", "api-shape"],
    ],
  );
});

test("a module is tested by an import, or by a test file named after it", () => {
  const names = ["channels", "semantic-cache", "unimported"];
  const imports = untested(
    { text: 'import x from "../../src/lib/channels.ts";', names: [] },
    names,
  );
  assert.deepEqual(imports, ["semantic-cache", "unimported"]);
  const named = untested({ text: "", names: ["semantic-cache-ttl"] }, names);
  assert.deepEqual(named, ["channels", "unimported"], "a test file named for it counts");
});

test("`lib/foo` does not cover `lib/foo-bar`, which is a different module", () => {
  const names = ["foo", "foo-bar"];
  assert.deepEqual(untested({ text: 'from "../../src/lib/foo-bar.ts"', names: [] }, names), [
    "foo",
  ]);
});

test("an allowlisted module that gains a test is drift the other way", () => {
  const dir = lib("audit-emitter");
  const measured = report(dir, { text: 'import a from "../src/lib/audit-emitter.ts";', names: [] });
  assert.deepEqual(measured.untested, [], "the module is covered now");
  assert.deepEqual(measured.stale, ["audit-emitter"], "so the allowlist must lose it");
});
