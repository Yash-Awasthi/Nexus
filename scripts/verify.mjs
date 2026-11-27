// SPDX-License-Identifier: Apache-2.0
/**
 * `make verify` — the same gates CI runs, in the same order, on one machine.
 *
 * The point is that "green locally" means "green on the pull request". That only
 * holds if the list is derived from the workflows rather than written by hand,
 * so each gate below names the workflow job it comes from, and a workflow that
 * gains a step shows up here as a failing comparison instead of drifting.
 *
 * Three CI jobs cannot run here and are reported as skipped with the reason:
 * anything that needs a Docker daemon, the xvfb-driven desktop e2e run, and the
 * jobs that start Postgres/Redis service containers.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const fast = argv.includes("--fast");

/** [name, command, workflow job that runs the same thing, needsDocker] */
const GATES = [
  ["lint", ["pnpm", "lint"], "lint.yml / lint"],
  ["lint-targets test", ["node", "--test", "scripts/lint-targets.test.mjs"], "lint.yml / lint"],
  [
    "repository rules",
    [
      "node",
      "--test",
      "scripts/workflow-map.test.mjs",
      "scripts/lockfile-drift.test.mjs",
      "scripts/release-triggers.test.mjs",
      "scripts/ci-cache.test.mjs",
      "scripts/job-times.test.mjs",
      "scripts/required-checks.test.mjs",
      "scripts/seed-determinism.test.mjs",
      "scripts/coverage-floors.test.mjs",
      "scripts/e2e-waits.test.mjs",
      "scripts/audit-gate.test.mjs",
      "scripts/actions-pinned.test.mjs",
      "scripts/license-audit.test.mjs",
      "scripts/rotation-drill.test.mjs",
      "scripts/retention-policy.test.mjs",
      "scripts/migrations-forward-only.test.mjs",
      "scripts/backup-drill.test.mjs",
      "scripts/quickstart.test.mjs",
      "scripts/dead-code.test.mjs",
      "scripts/error-envelope.test.mjs",
      "scripts/route-types.test.mjs",
      "scripts/lib-inventory.test.mjs",
      "scripts/prerelease-audit.test.mjs",
      "scripts/lint-paths.test.mjs",
      "scripts/electron-current.test.mjs",
      "scripts/perf-budget.test.mjs",
      "scripts/bundle-budget.test.mjs",
    ],
    "lint.yml / lint",
  ],
  ["license-audit", ["node", "scripts/license-audit.mjs"], "lint.yml / lint"],
  ["migrations-forward-only", ["node", "scripts/migrations-forward-only.mjs"], "lint.yml / lint"],
  ["required-checks", ["node", "scripts/required-checks.mjs"], "lint.yml / lint"],
  ["docs-verified", ["node", "scripts/docs-verified.mjs", "--check"], "lint.yml / hygiene"],
  ["arch-diagrams", ["node", "scripts/arch-diagrams.mjs", "--check"], "lint.yml / hygiene"],
  ["dead-code", ["node", "scripts/dead-code.mjs"], "lint.yml / hygiene"],
  ["route-types", ["node", "scripts/route-types.mjs"], "lint.yml / hygiene"],
  ["lib-inventory", ["node", "scripts/lib-inventory.mjs"], "lint.yml / hygiene"],
  ["prerelease-policy", ["node", "scripts/prerelease-audit.mjs", "--check"], "lint.yml / hygiene"],
  ["electron-pins", ["node", "scripts/electron-current.mjs"], "lint.yml / hygiene"],
  ["evals:check", ["node", "scripts/evals.mjs", "--check"], "lint.yml / hygiene"],
  ["council-evals:check", ["node", "scripts/council-evals.mjs", "--check"], "lint.yml / hygiene"],
  [
    "release-notes:check",
    ["node", "scripts/sync-release-notes.mjs", "--check"],
    "lint.yml / hygiene",
  ],
  ["support-matrix", ["node", "--test", "scripts/support-matrix.test.mjs"], "lint.yml / hygiene"],
  ["adr-coverage", ["node", "--test", "scripts/adr-coverage.test.mjs"], "lint.yml / hygiene"],
  ["oncall-doc", ["node", "--test", "scripts/oncall-doc.test.mjs"], "lint.yml / hygiene"],
  ["capacity-doc", ["node", "--test", "scripts/capacity-doc.test.mjs"], "lint.yml / hygiene"],
  ["slo:review", ["node", "scripts/slo-review.mjs", "--check"], "lint.yml / hygiene"],
  ["slo-review-rules", ["node", "--test", "scripts/slo-review.test.mjs"], "lint.yml / hygiene"],
  ["format:check", ["pnpm", "format:check"], "lint.yml / lint"],
  ["check:headers", ["pnpm", "check:headers"], "lint.yml / hygiene"],
  ["check:docs", ["pnpm", "check:docs"], "lint.yml / hygiene"],
  ["check:release", ["pnpm", "check:release"], "lint.yml / hygiene"],
  ["baseline:check", ["pnpm", "baseline:check"], "lint.yml / baseline"],
  ["openapi:check", ["pnpm", "openapi:check"], "test.yml / contracts"],
  ["types:check", ["pnpm", "types:check"], "test.yml / contracts"],
  ["cli:parity", ["pnpm", "cli:parity"], "lint.yml / lint (via scripts/lint.mjs)"],
  [
    "coverage-floors",
    ["node", "scripts/coverage-floors.mjs", "--strict"],
    "test.yml / unit (per-package floors)",
  ],
  [
    "bundle-budget",
    ["node", "scripts/bundle-budget.mjs"],
    "build.yml / budgets (needs the UI build)",
  ],
  ["api-boot-budget", ["node", "scripts/api-boot-budget.mjs"], "build.yml / budgets"],
  ["typecheck", ["pnpm", "typecheck"], "test.yml / unit (tsc -b --noEmit)"],
  ["build", ["pnpm", "build"], "build.yml / build"],
  ["test", ["pnpm", "test"], "test.yml / unit"],
  ["seed-determinism", ["node", "scripts/seed-determinism.mjs"], "test.yml / seeded"],
];

/** CI jobs this script deliberately does not attempt, with the reason. */
const NOT_RUN = [
  ["test.yml / desktop-e2e", "needs xvfb-run and a Playwright browser install"],
  ["test.yml / postgres-*", "needs a Postgres service container whose extension hooks run in CI"],
  ["test.yml / embed-concurrency", "opens concurrent connections to a CI-only Postgres"],
  ["build.yml / docker", "needs a Docker daemon"],
];

function sh([cmd, ...args]) {
  const started = Date.now();
  const res = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
  return { ok: res.status === 0, ms: Date.now() - started };
}

/** CI steps that are variants of a gate above, or that only make sense on a clean
 * runner (per-package runs, builds, migrations, the e2e harness). Each pattern
 * names why it is not a gate here. */
const CI_ONLY = [
  [/^pnpm install/, "installs the tree"],
  [/--changed|--coverage/, "changed-only and coverage runs are CI scheduling choices"],
  [/^pnpm --filter [^ ]+ (test|build)$/, "per-package subsets of the suite/build gates"],
  [/^pnpm --filter [^ ]+ exec/, "browser and Electron binaries CI installs"],
  [
    /^pnpm db:push|^pnpm test:e2e/,
    "migration and Playwright jobs need the CI database and browsers",
  ],
  [
    /migrate-concurrent|e2e-server|e2e-offline|unit-offline|tests\/e2e|playwright|xvfb/,
    "e2e jobs need xvfb, a Playwright install and service containers",
  ],
  [/docker|psql|CREATE EXTENSION/, "needs a Docker daemon or a Postgres service container"],
  [
    /lockfile-drift\.mjs --base/,
    "the lockfile check diffs against the pull request base; run it with --base locally",
  ],
  [
    /scripts\/job-times\.mjs --job/,
    "job wall times are recorded in CI where a runner exists; the script and its rules are gated by tests",
  ],
  [
    /turbo run test --filter/,
    "the app-suite job runs per-app subsets on a pull request; the full suite is the `test` gate",
  ],
  [
    /npm_config_prefix|\$TSC|typescript@6/,
    "the stable-TypeScript job installs its own compiler to prove the tree builds without the preview one; the local gate is `pnpm typecheck`",
  ],
  [
    /perf-budget\.mjs --only/,
    "slow-path wall times are recorded on a runner, where the number means something",
  ],
];

/**
 * The workflows' own step list, so this script can be checked against them: a
 * `run:` line CI has that no gate covers is printed instead of going silent.
 */
function workflowCommands() {
  const out = [];
  for (const file of ["lint.yml", "test.yml", "build.yml"]) {
    let text;
    try {
      text = readFileSync(`.github/workflows/${file}`, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const m = /^\s*-?\s*run:\s*(?:[|>]-?\s*)?(pnpm .+|node .+)$/.exec(line);
      if (m?.[1]) out.push(m[1].trim());
    }
  }
  // Every command the gated list covers, plus the steps CI_ONLY explains.
  const covered = new Set(GATES.map(([, cmd]) => cmd.join(" ")));
  return out.filter((cmd) => !covered.has(cmd) && !CI_ONLY.some(([pattern]) => pattern.test(cmd)));
}

const gaps = workflowCommands();
if (argv.includes("--gaps")) {
  console.log(gaps.join("\n") || "no uncovered workflow steps");
  process.exit(0);
}
let failed = 0;
const skipped = [];

console.log(`verify: ${GATES.length} gates from .github/workflows, fast=${fast}\n`);
for (const [name, cmd, workflow] of GATES) {
  if (
    fast &&
    (name === "test" ||
      name === "typecheck" ||
      name === "build" ||
      name === "bundle-budget" ||
      name === "seed-determinism" ||
      name === "audit-gate (dev)")
  ) {
    skipped.push(name);
    continue;
  }
  const { ok, ms } = sh(cmd);
  const seconds = (ms / 1000).toFixed(1);
  console.log(`${ok ? "✔" : "✖"} ${name} (${seconds}s) — ${workflow}`);
  if (!ok) failed++;
}

console.log("");
for (const [job, why] of NOT_RUN) console.log(`skip ${job}: ${why}`);
if (gaps.length) {
  console.log(`\nWorkflow steps no gate here runs (add them to GATES):`);
  for (const cmd of gaps) console.log(`  ${cmd}`);
}
if (skipped.length) console.log(`\n--fast skipped: ${skipped.join(", ")}`);
const ran = GATES.length - skipped.length;
console.log(
  `\n${ran - failed}/${ran} gates passed${skipped.length ? `, ${skipped.length} skipped` : ""}`,
);
process.exit(failed === 0 ? 0 : 1);
