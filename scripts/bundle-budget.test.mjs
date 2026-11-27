// SPDX-License-Identifier: Apache-2.0
/**
 * The budget has to be able to say no. These tests pin the three decisions it makes
 * against a synthetic manifest — a route over its budget, a route carrying a module
 * that may only arrive through a dynamic import, and a route with no budget at all —
 * plus the attribution itself: what counts as a route's download and what does not.
 * The last test measures the real build when one exists, so the committed budgets are
 * known to be reachable rather than aspirational.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { judgeRoute, readBudget, routeClosures } from "./bundle-budget.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BUILD = join(ROOT, "apps/ui/build/client");
const MANIFEST = join(BUILD, ".vite/manifest.json");

/** One manifest shaped like Vite's, with sizes this test decides. */
const manifest = {
  "app/routes/chat.tsx?__react-router-build-client-route": {
    file: "assets/chat.js",
    isEntry: false,
    imports: ["_shared.js"],
  },
  "app/routes/graph.tsx?__react-router-build-client-route": {
    file: "assets/graph.js",
    imports: ["_shared.js"],
  },
  "app/routes/big.tsx?__react-router-build-client-route": {
    file: "assets/big.js",
  },
  "_shared.js": { file: "assets/shared.js", css: ["assets/shared.css"] },
  "app/root.tsx": { file: "assets/root.js", isEntry: true },
};

/** Sizes in kB, converted to bytes: the script's unit is the gzipped byte. */
const sizesKb = {
  "assets/chat.js": 10,
  "assets/graph.js": 10,
  "assets/big.js": 400,
  "assets/shared.js": 30,
  "assets/shared.css": 5,
  "assets/root.js": 1,
  "assets/three.module-x.js": 540,
};
const readSize = (file) => {
  const bytes = (sizesKb[file] ?? 0) * 1024;
  return { raw: bytes, gzip: bytes };
};

test("a route's weight is its chunk plus every statically imported file, nothing else", () => {
  const closures = routeClosures(manifest, readSize);
  assert.deepEqual([...closures.keys()].sort(), ["big.tsx", "chat.tsx", "graph.tsx"]);
  // chat = chat.js + shared.js + shared.css; the shared chunk is charged to both routes.
  assert.equal(Math.round(closures.get("chat.tsx").gzipBytes / 1024), 45);
  assert.equal(Math.round(closures.get("graph.tsx").gzipBytes / 1024), 45);
  // A file that is not reachable from a route is not counted for it.
  assert.ok(!closures.get("chat.tsx").files.includes("assets/root.js"));
});

test("a route over its budget fails and names the route and the numbers", () => {
  const closures = routeClosures(manifest, readSize);
  const budget = { defaultGzipKb: 100, perRoute: {} };
  const verdict = judgeRoute("big.tsx", closures.get("big.tsx"), budget);
  assert.equal(verdict.problems.length, 1);
  assert.equal(verdict.problems[0].kind, "over-budget");
  assert.match(verdict.problems[0].message, /big\.tsx is 400 kB gzipped, over its 100 kB budget/);
});

test("a per-route budget overrides the default, in both directions", () => {
  const closures = routeClosures(manifest, readSize);
  const budget = { defaultGzipKb: 100, perRoute: { "big.tsx": { gzipKb: 500 } } };
  assert.deepEqual(judgeRoute("big.tsx", closures.get("big.tsx"), budget).problems, []);
  // The default still applies to a route without its own entry.
  const tight = { defaultGzipKb: 40, perRoute: { "big.tsx": { gzipKb: 500 } } };
  assert.equal(
    judgeRoute("chat.tsx", closures.get("chat.tsx"), tight).problems[0].kind,
    "over-budget",
  );
});

test("a module that must stay dynamic fails a route that imports it statically", () => {
  const closures = routeClosures(manifest, readSize);
  const withGraph = {
    ...manifest,
    "app/routes/graph.tsx?__react-router-build-client-route": {
      file: "assets/graph.js",
      imports: ["three.module.js"],
    },
    "three.module.js": { file: "assets/three.module-x.js" },
  };
  const budget = {
    defaultGzipKb: 1000,
    perRoute: {},
    forbidden: { "three.module": { why: "three is 540 kB", allowedIn: [] } },
  };
  const graph = routeClosures(withGraph, readSize).get("graph.tsx");
  const problems = judgeRoute("graph.tsx", graph, budget).problems;
  assert.equal(problems[0].kind, "forbidden");
  assert.match(
    problems[0].message,
    /statically includes assets\/three\.module-x\.js — three is 540 kB/,
  );
  // Listed as allowed, the same route passes: the rule is a decision, not a ban.
  const allowed = { ...budget, forbidden: { "three.module": { allowedIn: ["graph.tsx"] } } };
  assert.deepEqual(judgeRoute("graph.tsx", graph, allowed).problems, []);
});

test("a route with no budget and no default is a problem, not a pass", () => {
  const closures = routeClosures(manifest, readSize);
  const verdict = judgeRoute("chat.tsx", closures.get("chat.tsx"), { perRoute: {} });
  assert.equal(verdict.problems[0].kind, "no-budget");
});

test("a missing budget file still carries a default rule", () => {
  const budget = readBudget(join(ROOT, ".github/does-not-exist.json"));
  assert.equal(budget.defaultGzipKb, 200);
});

test(
  "the committed budgets are met by the build that is in the tree",
  { skip: !existsSync(MANIFEST) },
  () => {
    const tree = JSON.parse(readFileSync(MANIFEST, "utf8"));
    const closures = routeClosures(tree, readSize);
    // A build that produced no route chunks would pass every assertion below for the
    // wrong reason: gate the canary first.
    assert.ok(closures.size >= 30, `only ${closures.size} routes in the manifest`);
    const budget = readBudget();
    const failures = [];
    for (const [route, closure] of closures) {
      for (const problem of judgeRoute(route, closure, budget).problems)
        failures.push(problem.message);
    }
    assert.deepEqual(failures, []);
    // The 3D renderer is the specific promise: no page downloads it before it draws.
    for (const [route, closure] of closures) {
      assert.ok(
        !closure.files.some((file) => file.includes("three.module")),
        `${route} downloads three.js without being asked to`,
      );
    }
  },
);
