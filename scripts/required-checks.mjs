// SPDX-License-Identifier: Apache-2.0
/**
 * Required status checks are the merge gate on `master`, and they fail in the
 * worst possible way: a required context that no job reports never turns green,
 * so every pull request is blocked and nothing says why. The reverse — a job
 * renamed out from under a gate, or a gate that was never added for a job that
 * should have one — is invisible too.
 *
 * This checks the two against each other. The GitHub side is a committed snapshot
 * (`.github/required-checks.json`), refreshed with `--fetch` through `gh api` by
 * someone who can read the protection settings; the workflow side is the job names
 * in `.github/workflows`, with matrix values expanded the way Actions expands them.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

import { parse } from "yaml";

const SNAPSHOT = ".github/required-checks.json";
const WORKFLOWS = ".github/workflows";

/** `Build (${{ matrix.node }} / ${{ matrix.os }})` → every name the matrix produces. */
export function expandName(name, matrix) {
  if (!name.includes("${{")) return [name];

  // Named dimensions first: { node: [...], os: [...] } → cartesian product.
  const dims = Object.entries(matrix ?? {}).filter(
    ([key, value]) => key !== "include" && Array.isArray(value),
  );
  if (dims.length > 0) {
    let combos = [{}];
    for (const [key, values] of dims) {
      combos = combos.flatMap((combo) => values.map((value) => ({ ...combo, [key]: value })));
    }
    return combos.map((combo) =>
      name.replace(/\$\{\{\s*matrix\.([a-zA-Z0-9_]+)\s*\}\}/g, (_all, key) =>
        String(combo[key] ?? ""),
      ),
    );
  }

  // `include:` entries: one name per included object.
  const include = matrix?.include;
  if (Array.isArray(include)) {
    return include.map((entry) =>
      name.replace(/\$\{\{\s*matrix\.([a-zA-Z0-9_]+)\s*\}\}/g, (_all, key) =>
        String(entry?.[key] ?? ""),
      ),
    );
  }
  return [name];
}

/** Every check-run name the workflows can produce. */
export function workflowCheckNames(files) {
  const names = new Set();
  for (const file of files) {
    const doc = parse(readFileSync(file, "utf8"));
    for (const job of Object.values(doc?.jobs ?? {})) {
      if (!job?.name) continue;
      for (const name of expandName(String(job.name), job.strategy?.matrix)) names.add(name);
    }
  }
  return [...names].sort();
}

/** Required contexts that no job reports — every one of these blocks all merges. */
export function unmatched(required, produced) {
  const known = new Set(produced);
  return required.filter((context) => !known.has(context));
}

/** Read the committed snapshot. */
export function readSnapshot(path = SNAPSHOT) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Ask GitHub for the live settings and rewrite the snapshot. */
function fetchAndStore() {
  const res = spawnSync(
    "gh",
    [
      "api",
      "repos/:owner/:repo/branches/master/protection/required_status_checks",
      "--jq",
      "{strict: .strict, contexts: [.contexts[]]}",
    ],
    { encoding: "utf8" },
  );
  if (res.status !== 0) {
    console.error(`required-checks: gh api failed: ${res.stderr.trim() || res.status}`);
    return 2;
  }
  const live = JSON.parse(res.stdout);
  const snapshot = {
    branch: "master",
    checkedAt: new Date().toISOString().slice(0, 10),
    strict: live.strict,
    contexts: live.contexts,
  };
  writeFileSync(SNAPSHOT, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`required-checks: wrote ${snapshot.contexts.length} contexts to ${SNAPSHOT}`);
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--fetch")) return fetchAndStore();

  const snapshot = readSnapshot();
  const produced = workflowCheckNames(
    readdirSync(WORKFLOWS)
      .filter((file) => file.endsWith(".yml"))
      .map((file) => `${WORKFLOWS}/${file}`),
  );
  const orphans = unmatched(snapshot.contexts, produced);

  console.log(
    `required-checks: ${snapshot.contexts.length} required contexts on ${snapshot.branch} (checked ${snapshot.checkedAt}), ${produced.length} check names produced by the workflows`,
  );
  if (orphans.length > 0) {
    console.error(`\nrequired-checks: no job reports these, so every pull request blocks forever:`);
    for (const context of orphans) console.error(`  ${context}`);
    return 1;
  }
  console.log("required-checks: every required context matches a job name");
  return 0;
}

if (process.argv[1]?.endsWith("required-checks.mjs")) process.exit(main());
