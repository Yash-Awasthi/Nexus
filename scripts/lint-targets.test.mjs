// SPDX-License-Identifier: Apache-2.0
/**
 * The gate behind the derived lists: a workspace package that lint or tsc does
 * not see is a package whose code is unverified, and a hand-written list is how
 * that happens. These assertions read the tree, not a list.
 *
 *   node --test scripts/lint-targets.test.mjs
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { goModules, lintTargets, root, workspaces } from "./lint-targets.mjs";

const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));

test("every workspace package has a lint target", () => {
  const targets = new Set(lintTargets());
  assert.ok(targets.size > 0, "lint-targets.mjs found no targets at all");
  const missing = workspaces().filter(
    (workspace) => !targets.has(`${workspace}/src`) && !targets.has(`${workspace}/app`),
  );
  assert.deepEqual(missing, [], `workspace packages with no lint target: ${missing.join(", ")}`);
});

test("every workspace package has a tsconfig and a source directory", () => {
  const noTsconfig = workspaces().filter(
    (workspace) => !existsSync(join(root, workspace, "tsconfig.json")),
  );
  assert.deepEqual(
    noTsconfig,
    [],
    `workspace packages without tsconfig.json: ${noTsconfig.join(", ")}`,
  );
});

test("every package is a reference in the typecheck build graph", () => {
  const references = new Set(
    (readJson("tsconfig.build.json").references ?? []).map((reference) =>
      reference.path.replace(/^\.\//, ""),
    ),
  );
  const packages = workspaces().filter((workspace) => workspace.startsWith("packages/"));
  const missing = packages.filter((workspace) => !references.has(workspace));
  assert.deepEqual(
    missing,
    [],
    `packages missing from tsconfig.build.json references: ${missing.join(", ")}. tsc -b only builds what that file names, so run 'node scripts/tsconfig-refs.mjs' to regenerate it`,
  );
  const stale = [...references].filter(
    (reference) => reference.startsWith("packages/") && !packages.includes(reference),
  );
  assert.deepEqual(
    stale,
    [],
    `tsconfig.build.json references a package that is gone: ${stale.join(", ")}`,
  );
});

test("the root typecheck project covers the packages and the server apps", () => {
  const include = readJson("tsconfig.node.json").include ?? [];
  const covered = (workspace, dir) =>
    include.some((pattern) => {
      const normalized = pattern.replace(/\/$/, "");
      if (normalized === `${workspace}/${dir}`) return true;
      // "packages/*/src" covers every packages/<name>/src.
      const [head, tail] = normalized.split("/*/");
      return (
        normalized.includes("/*/") &&
        workspace.startsWith(`${head.replace(/\/$/, "")}/`) &&
        workspace.split("/").length === 2 &&
        tail === dir
      );
    });
  const missing = workspaces().filter(
    (workspace) =>
      (workspace.startsWith("packages/") && !covered(workspace, "src")) ||
      (["apps/api", "apps/worker", "apps/cli"].includes(workspace) === true &&
        !covered(workspace, "src")),
  );
  assert.deepEqual(missing, [], `not in tsconfig.node.json include: ${missing.join(", ")}`);
});

test("Go services are found, and only Go services are", () => {
  const modules = goModules();
  assert.deepEqual(modules, ["services/board"]);
  for (const module of modules) assert.ok(existsSync(join(root, module, "go.mod")));
});
