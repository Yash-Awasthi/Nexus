// SPDX-License-Identifier: Apache-2.0
/**
 * Two rules that keep the toolchain to one path per job.
 *
 * Linting: `vp lint --type-aware` owns every rule; ESLint runs exactly one
 * (`import-x/order`), because ordering needs no type information. The failure this
 * prevents is a second rule engine growing in parallel — the same code flagged twice,
 * fixed twice, and drifting.
 *
 * Compiling: `typescript` resolves to `@typescript/typescript6`, a preview channel, while
 * `@typescript/native` is the TypeScript 7 compiler. A construct that only the preview
 * accepts would ship and then fail for a user on stable 6.x, so one CI job compiles with
 * the latest published stable TypeScript until the alias can go.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const read = (relative) =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");

/** The rule names enabled by `eslint.config.mjs`, read without running ESLint. */
export function eslintRules() {
  const source = read("eslint.config.mjs");
  // Everything after `rules:` — a non-greedy brace match would stop at the first inline
  // options object (`{ "newlines-between": ... }`) and miss any rule added after it.
  const start = source.indexOf("rules:");
  if (start === -1) return [];
  return [...source.slice(start).matchAll(/^\s*"([^"]+)":/gm)].map((match) => match[1]);
}

/** The tool invocations `scripts/lint.mjs` reports on. */
export function lintInvocations() {
  const source = read("scripts/lint.mjs");
  const calls = [...source.matchAll(/bin\(root,\s*"([^"]+)",\s*"([^"]+)",\s*\[([^\]]*)\]/g)];
  return calls.map((match) => ({ pkg: match[1], argv: match[3] }));
}

const WORKFLOWS = ["build.yml", "lint.yml", "test.yml"];
const workflow = (name) => read(`.github/workflows/${name}`);

test("ESLint keeps one rule, and it is the one that needs no types", () => {
  assert.deepEqual(eslintRules(), ["import-x/order"]);
});

test("the type-aware pass runs once, and it is `vp lint`", () => {
  const invocations = lintInvocations();
  const typeAware = invocations.filter((call) => call.argv.includes("--type-aware"));
  assert.equal(typeAware.length, 1, "exactly one type-aware invocation");
  assert.equal(typeAware[0].pkg, "vite-plus");
  assert.deepEqual(
    invocations
      .filter((call) => call.pkg === "eslint")
      .map((call) => call.argv.includes("--type-aware")),
    [false],
    "eslint must not become a second type-aware pass",
  );
});

test("there is one lint entry point, so nobody can run half of it", () => {
  const scripts = JSON.parse(read("package.json")).scripts;
  const lintScripts = Object.keys(scripts).filter((name) => /^lint/.test(name));
  assert.deepEqual(lintScripts.sort(), ["lint", "lint:fix"]);
  for (const name of lintScripts) assert.match(scripts[name], /scripts\/lint\.mjs/);
});

test("a stable-TypeScript job exists while the compiler is a preview", () => {
  const jobs = WORKFLOWS.map((name) => ({ name, body: workflow(name) })).filter((file) =>
    /^\s{2}typescript-stable:/m.test(file.body),
  );
  assert.equal(jobs.length, 1, "one job, in one workflow");
  const body = jobs[0].body;
  // Stable major, not a channel tag: `typescript@6`, never `@typescript/typescript6`.
  assert.match(body, /typescript@6\b/);
  assert.doesNotMatch(body, /typescript@[^ \n]*(rc|beta|next|canary)/);
  assert.match(body, /"\$TSC" -b/, "and it compiles the tree, not just --version");
});

test("the preview compilers are named where somebody would look", () => {
  const catalogText = read("pnpm-workspace.yaml");
  assert.match(
    catalogText,
    /typescript: npm:@typescript\/typescript6/,
    "the alias is still a preview",
  );
  assert.match(read("docs/OPS.md"), /typescript-stable/, "OPS says which job covers the gap");
});
