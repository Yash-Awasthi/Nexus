// SPDX-License-Identifier: Apache-2.0
/**
 * The lint and typecheck targets, derived from `pnpm-workspace.yaml`.
 *
 * The root `lint` script used to name `apps/api/src`, `apps/worker/src` and a few
 * package test directories by hand, so `apps/desktop/src` was never linted and a
 * new package was silently outside the gate. This module answers "what is in the
 * workspace, and which directory of it is source" from the tree itself.
 *
 * Exported for `scripts/lint.mjs` and for the coverage test in
 * `scripts/lint-targets.test.mjs`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Directory names that hold a workspace's source. `apps/ui` uses `app`. */
const SOURCE_DIRS = ["src", "app"];

export function workspacePatterns(cwd = root) {
  const parsed = parseYaml(readFileSync(join(cwd, "pnpm-workspace.yaml"), "utf8"));
  return (parsed.packages ?? []).map(String).filter((pattern) => !pattern.startsWith("!"));
}

/** `packages/adapters/*` → the directories that exist at this moment. */
export function expandPattern(cwd, pattern) {
  let current = [""];
  for (const segment of pattern.split("/").filter(Boolean)) {
    const next = [];
    for (const base of current) {
      const dir = join(cwd, base);
      if (!existsSync(dir)) continue;
      if (segment === "*") {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) next.push(join(base, entry.name));
        }
      } else if (existsSync(join(dir, segment))) {
        next.push(join(base, segment));
      }
    }
    current = next;
  }
  return current.map((dir) => dir.split(sep).join("/"));
}

/** Every directory `pnpm install` treats as a workspace package. */
export function workspaces(cwd = root) {
  const found = new Set();
  for (const pattern of workspacePatterns(cwd)) {
    for (const dir of expandPattern(cwd, pattern)) {
      if (existsSync(join(cwd, dir, "package.json"))) found.add(dir);
    }
  }
  return [...found].sort();
}

/** The source directories lint and tsc are pointed at, one per workspace. */
export function lintTargets(cwd = root) {
  const targets = [];
  for (const workspace of workspaces(cwd)) {
    for (const candidate of SOURCE_DIRS) {
      if (existsSync(join(cwd, workspace, candidate))) targets.push(`${workspace}/${candidate}`);
    }
  }
  return targets;
}

/** Go modules under `services/`: they get gofmt and `go vet`, not ESLint. */
export function goModules(cwd = root) {
  const services = join(cwd, "services");
  if (!existsSync(services)) return [];
  return readdirSync(services, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(services, entry.name, "go.mod")))
    .map((entry) => `services/${entry.name}`)
    .sort();
}
