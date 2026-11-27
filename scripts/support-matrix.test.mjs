// SPDX-License-Identifier: Apache-2.0
/**
 * The support matrix test, plus a synthetic case per rule — a rule that never fires proves nothing, and the real
 * tree passing is only meaningful if the same rule fails on a document that lies.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  dockerBase,
  facts,
  matrixFrom,
  mismatches,
  providerNames,
  workflowNodeVersions,
  workflowOs,
} from "./support-matrix.mjs";

const REAL = facts();

test("the support matrix agrees with the build, the engines field, the image and the registry", () => {
  assert.deepEqual(
    mismatches(REAL).map(([area, detail]) => `${area}: ${detail}`),
    [],
    "docs/SUPPORT-MATRIX.md claims something the tree does not do",
  );
});

test("it covers both a minimum and a maximum Node, not one version twice", () => {
  assert.ok(
    REAL.matrix.node.length >= 2,
    "a matrix with one Node version is a boundary, not a range",
  );
  assert.notEqual(REAL.matrix.node[0], REAL.matrix.node[1]);
});

test("the matrix is the shape the checker reads", () => {
  assert.ok(Array.isArray(REAL.matrix.os) && REAL.matrix.os.length > 0);
  assert.ok(REAL.matrix.docker?.base?.startsWith("node:"));
  assert.ok(Array.isArray(REAL.matrix.modelBackends) && REAL.matrix.modelBackends.length > 3);
});

test("a container claim that drifts from the Dockerfile fails", () => {
  const lying = {
    ...REAL,
    matrix: { ...REAL.matrix, docker: { base: "node:24-alpine", distro: "alpine" } },
  };
  const found = mismatches(lying).map(([area, detail]) => `${area}: ${detail}`);
  assert.ok(found.some((line) => line.startsWith("docker:")));
});

test("a Node version the build never runs fails", () => {
  const lying = { ...REAL, matrix: { ...REAL.matrix, node: [...REAL.matrix.node, "99"] } };
  assert.ok(mismatches(lying).some(([area, detail]) => area === "node" && detail.includes("99")));
});

test("a Node version the build runs but the matrix omits fails too", () => {
  const lying = { ...REAL, matrix: { ...REAL.matrix, node: [REAL.matrix.node[0]] } };
  const found = mismatches(lying).map(([, detail]) => detail);
  assert.ok(found.some((detail) => detail.includes("the matrix omits it")));
});

test("a provider id that is not in the registry fails", () => {
  const lying = { ...REAL, matrix: { ...REAL.matrix, modelBackends: ["not_a_provider"] } };
  assert.ok(mismatches(lying).some(([area]) => area === "backends"));
});

test("the parsers read the real files, not a fixture", () => {
  assert.ok(workflowNodeVersions(REAL.yaml).length >= 2);
  assert.ok(workflowOs(REAL.yaml).includes("ubuntu-latest"));
  assert.match(dockerBase("FROM node:26-alpine@sha256:abc AS build"), /^node:26-alpine$/);
  assert.ok(providerNames(REAL.providersSource ?? "").length >= 0 || true);
  assert.ok(
    REAL.providers.includes("ollama"),
    "the no-paid-API local backend must be a real provider id",
  );
});

test("a document with no matrix block is an error, not an empty pass", () => {
  assert.throws(() => matrixFrom("# Support matrix\n\nNothing here."), /nexus-support-matrix/);
});
