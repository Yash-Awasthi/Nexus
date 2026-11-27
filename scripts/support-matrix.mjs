// SPDX-License-Identifier: Apache-2.0
/**
 * The support matrix, read as data.
 *
 * `docs/SUPPORT-MATRIX.md` claims which Node versions, operating systems, container base and model backends a
 * release is tested with. Every one of those claims is already a fact elsewhere in the tree — the `engines` field,
 * the `build.yml` matrix, a Dockerfile `FROM` line, the driver registry's provider union — so the document can be
 * checked against the facts instead of being trusted.
 *
 * The check runs in both directions on purpose: a version the matrix claims but the build never exercises is an
 * overclaim, and a version the build exercises but the matrix omits is an undocumented promise.
 */
import { readFileSync } from "node:fs";

export const MATRIX_DOC = "docs/SUPPORT-MATRIX.md";

/** The `json nexus-support-matrix` fenced block, parsed. */
export function matrixFrom(text) {
  const match = text.match(/```json nexus-support-matrix\n([\s\S]*?)```/);
  if (!match) throw new Error("no ```json nexus-support-matrix block in " + MATRIX_DOC);
  return JSON.parse(match[1]);
}

/** The `node:` versions a workflow runs: `matrix.node` lists plus any literal `node-version: "N"`. */
export function workflowNodeVersions(yaml) {
  const found = new Set();
  const matrix = yaml.match(/node:\s*\[([^\]]+)\]/);
  // Hand-parsed rather than regex-only: the matrix form (`node: ["24", "26"]`) and the scalar form
  // (`node-version: "26"`) both appear in build.yml, and only the first one is a list to split.
  if (matrix)
    for (const raw of matrix[1].split(",")) {
      const value = raw.trim().replace(/["']/g, "");
      if (/^\d+$/.test(value)) found.add(value);
    }
  for (const [, value] of yaml.matchAll(/node-version:\s*["']?(\d+)["']?/g)) found.add(value);
  return [...found].sort((a, b) => Number(a) - Number(b));
}

/** The OS runners a workflow matrix uses. */
export function workflowOs(yaml) {
  const matrix = yaml.match(/os:\s*\[([^\]]+)\]/);
  if (!matrix) return [];
  return matrix[1]
    .split(",")
    .map((raw) => raw.trim().replace(/["']/g, ""))
    .filter(Boolean)
    .sort();
}

/** The first `FROM node:<tag>` in a Dockerfile, as `node:<tag>` without the digest. */
export function dockerBase(text) {
  const match = text.match(/^FROM\s+(\S+)/m);
  if (!match) return null;
  return match[1].split("@")[0];
}

/** Provider ids from the registry's `ProviderName` union. */
export function providerNames(source) {
  const union = source.match(/export type ProviderName\s*=([\s\S]*?);/);
  if (!union) return [];
  return [...union[1].matchAll(/"([a-z0-9_]+)"/g)].map((hit) => hit[1]);
}

/** Read everything the matrix is compared against. */
export function facts({ doc = MATRIX_DOC, workflows = ".github/workflows/build.yml" } = {}) {
  const matrix = matrixFrom(readFileSync(doc, "utf8"));
  const yaml = readFileSync(workflows, "utf8");
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const docker = dockerBase(readFileSync("apps/api/Dockerfile", "utf8"));
  const providers = providerNames(readFileSync("packages/llm/src/drivers/index.ts", "utf8"));
  return { matrix, yaml, pkg, docker, providers };
}

/** Every disagreement, as `[problem, detail]`. Empty means the document is true. */
export function mismatches({ matrix, yaml, pkg, docker, providers }) {
  const problems = [];
  const workflowNode = workflowNodeVersions(yaml);
  const claimedNode = [...matrix.node].sort((a, b) => Number(a) - Number(b));

  const advertised = String(pkg.engines?.node ?? "")
    .replace(/[>=^~ ]/g, "")
    .trim();
  const floor = Number(advertised);
  if (!Number.isFinite(floor))
    problems.push(["engines", `package.json has no parseable node engine: ${pkg.engines?.node}`]);
  else if (Number(claimedNode[0]) < floor)
    problems.push([
      "engines",
      `matrix claims Node ${claimedNode[0]} but engines require >=${floor}`,
    ]);
  if (Number(claimedNode[0]) > floor)
    problems.push([
      "engines",
      `engines allow Node ${floor} but the matrix starts at ${claimedNode[0]}`,
    ]);

  for (const version of claimedNode)
    if (!workflowNode.includes(version))
      problems.push(["node", `matrix claims Node ${version}; build.yml never runs it`]);
  for (const version of workflowNode)
    if (!claimedNode.includes(version))
      problems.push(["node", `build.yml runs Node ${version}; the matrix omits it`]);

  const claimedOs = [...matrix.os].sort();
  const buildOs = workflowOs(yaml);
  for (const runner of claimedOs)
    if (!buildOs.includes(runner))
      problems.push(["os", `matrix claims ${runner}; build.yml never runs it`]);
  for (const runner of buildOs)
    if (!claimedOs.includes(runner))
      problems.push(["os", `build.yml runs ${runner}; the matrix omits it`]);

  if (matrix.docker?.base !== docker)
    problems.push([
      "docker",
      `matrix claims ${matrix.docker?.base}; apps/api/Dockerfile starts FROM ${docker}`,
    ]);
  if (matrix.docker?.distro && !String(docker).endsWith(matrix.docker.distro))
    problems.push([
      "docker",
      `matrix claims distro ${matrix.docker.distro}; the image is ${docker}`,
    ]);

  for (const provider of matrix.modelBackends ?? [])
    if (!providers.includes(provider))
      problems.push([
        "backends",
        `matrix claims provider ${provider}; the driver registry has no such id`,
      ]);

  return problems;
}
