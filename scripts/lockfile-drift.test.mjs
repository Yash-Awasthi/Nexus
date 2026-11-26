// SPDX-License-Identifier: Apache-2.0
/** The lockfile and the manifests decide dependency changes together, or the build fails. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { classify } from "./lockfile-drift.mjs";

test("a lockfile change with no manifest change fails", () => {
  const verdict = classify(["pnpm-lock.yaml", "apps/api/src/server.ts"]);
  assert.match(verdict ?? "", /pnpm-lock.yaml changed without a package.json/);
});

test("a manifest change with no lockfile change fails", () => {
  const verdict = classify(["apps/api/package.json", "apps/api/src/server.ts"]);
  assert.match(verdict ?? "", /apps\/api\/package\.json changed without pnpm-lock\.yaml/);
});

test("a manifest change in a subdirectory counts", () => {
  assert.match(classify(["packages/ui/package.json"]) ?? "", /pnpm-lock\.yaml/);
});

test("the root manifest counts", () => {
  assert.match(classify(["package.json"]) ?? "", /pnpm-lock\.yaml/);
});

test("a dependency change that touches both is silent", () => {
  assert.equal(classify(["package.json", "pnpm-lock.yaml"]), null);
  assert.equal(classify(["packages/llm/package.json", "pnpm-lock.yaml"]), null);
});

test("a change that touches neither is silent", () => {
  assert.equal(classify(["docs/OPS.md", ".github/workflows/lint.yml"]), null);
  assert.equal(classify([]), null);
});

test("a package.json that only looks like a manifest does not count", () => {
  // `package.json.md` is prose, `package-lock.json` belongs to nobody here, so a
  // lockfile change beside them is still a lockfile change on its own.
  assert.match(
    classify(["package.json.md", "package-lock.json", "pnpm-lock.yaml"]) ?? "",
    /pnpm-lock.yaml changed without a package.json/,
  );
  assert.equal(classify(["package.json.md", "package-lock.json"]), null);
});
