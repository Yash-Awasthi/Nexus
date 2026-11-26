// SPDX-License-Identifier: Apache-2.0
/**
 * The dead-code gate is only worth having if it fails when there is something to fail
 * on, so the parser is tested against a report shaped like knip's own output.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { issues } from "./dead-code.mjs";

/** The shape knip emits: one object per file, one key per kind. */
function report(overrides = {}) {
  return {
    issues: [
      {
        file: "apps/api/src/routes/kb.ts",
        binaries: [],
        dependencies: [],
        exports: [],
        files: [],
        types: [],
        ...overrides,
      },
    ],
  };
}

test("an unused export is reported with its file, line and name", () => {
  const found = issues(
    report({ exports: [{ name: "_resetGraphJobsForTests", line: 181, col: 17 }] }),
  );
  assert.deepEqual(found, [
    {
      kind: "exports",
      name: "_resetGraphJobsForTests",
      where: "apps/api/src/routes/kb.ts:181:17",
    },
  ]);
});

test("an unreachable file is reported without pretending to know a line", () => {
  const found = issues(report({ files: [{ name: "packages/x/src/orphan.ts" }] }));
  assert.deepEqual(found, [
    { kind: "files", name: "packages/x/src/orphan.ts", where: "apps/api/src/routes/kb.ts" },
  ]);
});

test("dependency noise is not dead code", () => {
  const found = issues(
    report({ dependencies: [{ name: "left-pad", line: 12, col: 3 }], unlisted: [{ name: "x" }] }),
  );
  assert.deepEqual(found, [], "a dependency problem is a different gate");
});

test("a clean report yields nothing", () => {
  assert.deepEqual(issues({ issues: [] }), []);
  assert.deepEqual(issues({}), []);
});
