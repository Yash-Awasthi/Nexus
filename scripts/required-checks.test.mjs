// SPDX-License-Identifier: Apache-2.0
/** A required check nobody reports blocks every merge, silently — so the mapping is a test. */
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";

import { expandName, readSnapshot, unmatched, workflowCheckNames } from "./required-checks.mjs";

const WORKFLOWS = readdirSync(".github/workflows")
  .filter((file) => file.endsWith(".yml"))
  .map((file) => `.github/workflows/${file}`);

test("a plain job name is itself", () => {
  assert.deepEqual(expandName("ESLint + Prettier", undefined), ["ESLint + Prettier"]);
});

test("named matrix dimensions expand like Actions expands them", () => {
  const names = expandName("Unit tests (Node ${{ matrix.node }})", { node: ["24", "26"] });
  assert.deepEqual(names, ["Unit tests (Node 24)", "Unit tests (Node 26)"]);
});

test("two dimensions produce the cross product", () => {
  const names = expandName("Build (${{ matrix.node }} / ${{ matrix.os }})", {
    node: ["26"],
    os: ["ubuntu-latest", "macos-latest"],
  });
  assert.deepEqual(names, ["Build (26 / ubuntu-latest)", "Build (26 / macos-latest)"]);
});

test("include matrices expand per entry", () => {
  const names = expandName("Build ${{ matrix.service }}", {
    include: [{ service: "api" }, { service: "worker" }],
  });
  assert.deepEqual(names, ["Build api", "Build worker"]);
});

test("the workflows produce every context master requires", () => {
  const snapshot = readSnapshot();
  const produced = workflowCheckNames(WORKFLOWS);
  assert.deepEqual(unmatched(snapshot.contexts, produced), []);
});

test("an orphaned required context is reported", () => {
  const produced = workflowCheckNames(WORKFLOWS);
  assert.deepEqual(unmatched(["ESLint + Prettier", "A job that was renamed"], produced), [
    "A job that was renamed",
  ]);
});
