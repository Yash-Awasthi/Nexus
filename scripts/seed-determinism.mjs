// SPDX-License-Identifier: Apache-2.0
/**
 * A suite that passes only in one order is a suite with hidden shared state:
 * a test that needs the previous test's leftovers, a module-level cache nobody
 * reset, a fixture written by file A and read by file B. It also hides real bugs
 * from the person who runs the failing test alone and finds it green.
 *
 * This runs the suite twice with the same shuffle seed and compares the two
 * results test by test. Same seed means the same order, so a difference cannot be
 * order noise: it is shared state, timing, or randomness that the seed does not
 * reach.
 *
 *   node scripts/seed-determinism.mjs                       # whole suite, seed 1337
 *   node scripts/seed-determinism.mjs --seed 7 --scope packages/llm
 *
 * Exits 1 and lists every test whose status differed between the two runs.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DEFAULT_SEED = 1337;

/** `--flag value` / `--flag=value` / repeated `--scope` → plain strings. */
export function parseArgs(argv) {
  const args = { seed: String(DEFAULT_SEED), scope: [], keep: false };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split("=", 2);
    if (flag === "--seed") args.seed = inline ?? argv[++i];
    else if (flag === "--scope") args.scope.push(inline ?? argv[++i]);
    else if (flag === "--keep") args.keep = true;
  }
  return args;
}

/** JSON reporter output → one entry per test, keyed by the name a human reads. */
export function resultsOf(report) {
  const results = new Map();
  for (const file of report.testResults ?? []) {
    const filePath = path.basename(file.name ?? "");
    for (const assertion of file.assertionResults ?? []) {
      const ancestors = (assertion.ancestorTitles ?? []).join(" › ");
      const name = ancestors
        ? `${filePath} › ${ancestors} › ${assertion.title}`
        : `${filePath} › ${assertion.title}`;
      results.set(name, assertion.status);
    }
  }
  return results;
}

/**
 * Names whose status differs between the runs, plus tests that only one run
 * reported at all (a test that stops existing mid-suite is a disagreement too).
 */
export function disagreements(first, second) {
  const differing = [];
  for (const [name, status] of first) {
    const other = second.get(name);
    if (other === undefined) differing.push({ name, first: status, second: "missing" });
    else if (other !== status) differing.push({ name, first: status, second: other });
  }
  for (const [name, status] of second) {
    if (!first.has(name)) differing.push({ name, first: "missing", second: status });
  }
  return differing;
}

function runOnce(scope, seed, outputFile) {
  const vitestArgs = ["exec", "vp", "test", "run", ...scope];
  vitestArgs.push("--sequence.shuffle", `--sequence.seed=${seed}`, "--reporter=json");
  vitestArgs.push(`--outputFile=${outputFile}`);
  const res = spawnSync("pnpm", vitestArgs, {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  // A non-zero exit is expected when tests fail; the report is what matters.
  try {
    return JSON.parse(readFileSync(outputFile, "utf8"));
  } catch {
    const tail = `${res.stdout ?? ""}\n${res.stderr ?? ""}`
      .trim()
      .split("\n")
      .slice(-12)
      .join("\n");
    throw new Error(`seed-determinism: no report from run ${outputFile}\n${tail}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = mkdtempSync(path.join(tmpdir(), "seed-determinism-"));
  const firstPath = path.join(dir, "run1.json");
  const secondPath = path.join(dir, "run2.json");

  console.log(
    `seed-determinism: seed ${args.seed}, ${args.scope.length > 0 ? args.scope.join(" ") : "whole suite"}`,
  );
  try {
    const first = resultsOf(runOnce(args.scope, args.seed, firstPath));
    const second = resultsOf(runOnce(args.scope, args.seed, secondPath));
    const differing = disagreements(first, second);

    if (first.size === 0) {
      // Both runs agreeing on nothing is not a pass.
      console.error("seed-determinism: the runs reported no tests — nothing was compared");
      return 2;
    }
    if (differing.length > 0) {
      console.error(
        `\nseed-determinism: ${differing.length} of ${first.size} tests changed status:`,
      );
      for (const d of differing)
        console.error(`  ${d.name}\n    run 1: ${d.first}\n    run 2: ${d.second}`);
      return 1;
    }
    console.log(
      `seed-determinism: ${first.size} tests, identical result twice at seed ${args.seed}`,
    );
    return 0;
  } finally {
    if (!args.keep) rmSync(dir, { recursive: true, force: true });
    else console.log(`seed-determinism: reports kept in ${dir}`);
  }
}

if (process.argv[1]?.endsWith("seed-determinism.mjs")) process.exit(main());
