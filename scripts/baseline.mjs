// SPDX-License-Identifier: Apache-2.0
/**
 * Regenerate the measured baseline that docs/STATUS.md quotes.
 *
 *   node scripts/baseline.mjs --json      machine-readable snapshot (stdout)
 *   node scripts/baseline.mjs --markdown  the block that goes into STATUS.md
 *   node scripts/baseline.mjs --write     rewrite that block in docs/STATUS.md
 *   node scripts/baseline.mjs --check     fail if the committed block differs
 *
 * Everything here is measured, never remembered: the test counts come from a
 * real run of the four vitest configs, the e2e counts from a real Playwright
 * run, and the spec counts from the committed openapi.yaml.
 *
 * `--from <dir>` reads `root.json`, `api.json`, `ui.json`, `desktop.json` and
 * `e2e.json` from that directory instead of running the suites. CI writes
 * those files while it runs the tests it already runs, so the drift check does
 * not pay for a second full pass.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATUS = join(root, "docs", "STATUS.md");
const START = "<!-- baseline:start -->";
const MEASURED = "<!-- baseline:measured -->";
const END = "<!-- baseline:end -->";
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const args = process.argv.slice(2);
const mode =
  ["--json", "--markdown", "--write", "--check", "--skips"].find((f) => args.includes(f)) ??
  "--json";
const fromArg = args.indexOf("--from");
const fromDir = fromArg === -1 ? undefined : args[fromArg + 1];
const noE2e = args.includes("--no-e2e");

function sh(command, argv, cwd, env) {
  return spawnSync(command, argv, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Run a package's CLI through Node itself.
 *
 * On Windows `node_modules/.bin` holds `.cmd` shims, which Node will not spawn
 * without a shell, and `shell: true` concatenates arguments unescaped. Running
 * the package's own entry file under `process.execPath` avoids both, and
 * resolves the copy that belongs to the workspace being measured.
 */
function runPackageBin(cwd, pkgName, binName, argv, env) {
  const require = createRequire(join(cwd, "package.json"));
  const pkgPath = require.resolve(`${pkgName}/package.json`);
  const binRel = readJson(pkgPath).bin?.[binName] ?? readJson(pkgPath).bin;
  const entry = resolve(dirname(pkgPath), binRel);
  return sh(process.execPath, [entry, ...argv], cwd, env);
}

/** The `vp` shim that belongs to a workspace, falling back to the hoisted one. */
const vp = (cwd, argv, env) => runPackageBin(cwd, "vite-plus", "vp", argv, env);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function dirsWithPackageJson(segment) {
  return readdirSync(join(root, segment), { withFileTypes: true }).filter(
    (e) => e.isDirectory() && existsSync(join(root, segment, e.name, "package.json")),
  ).length;
}

function countDirs(segment) {
  return readdirSync(join(root, segment), { withFileTypes: true }).filter((e) => e.isDirectory())
    .length;
}

function runtime() {
  const pkg = readJson(join(root, "package.json"));
  const declared = String(pkg.packageManager ?? "").replace(/^pnpm@/, "");
  const probed = sh("pnpm", ["-v"], root);
  const actual = probed.status === 0 ? probed.stdout.trim() : null;
  return {
    node: process.version,
    // `null` means pnpm was not on PATH; the declared version is what CI installs.
    pnpm: actual,
    pnpmDeclared: declared,
  };
}

function workspace() {
  const tracked = sh("git", ["ls-files"], root);
  return {
    packages: countDirs("packages"),
    apps: countDirs("apps"),
    services: countDirs("services"),
    workspacePackages: dirsWithPackageJson("packages"),
    trackedFiles: tracked.status === 0 ? tracked.stdout.trim().split("\n").length : null,
  };
}

function spec() {
  const parsed = parseYaml(readFileSync(join(root, "openapi.yaml"), "utf8"));
  const byClass = {};
  let operations = 0;
  const paths = Object.entries(parsed.paths ?? {});
  for (const [, item] of paths) {
    for (const method of Object.keys(item)) {
      if (!METHODS.includes(method)) continue;
      operations += 1;
      const key = (item[method].tags ?? [])[0] ?? "unclassified";
      byClass[key] = (byClass[key] ?? 0) + 1;
    }
  }
  return {
    paths: paths.length,
    operations,
    durable: byClass["durable"] ?? 0,
    bridge: byClass["bridge"] ?? 0,
    dedicatedVolatile: byClass["dedicated-volatile"] ?? 0,
    unclassified: byClass["unclassified"] ?? 0,
  };
}

const SUITES = [
  { name: "root", cwd: root },
  { name: "api", cwd: join(root, "apps", "api") },
  { name: "ui", cwd: join(root, "apps", "ui") },
  { name: "desktop", cwd: join(root, "apps", "desktop") },
];

function runSuite({ name, cwd }, dir) {
  const out = join(dir, `${name}.json`);
  const env = {
    // Schema tests import the db client, which throws without a URL at import
    // time. A placeholder keeps the run hermetic; no connection is attempted.
    DATABASE_URL: process.env["DATABASE_URL"] ?? "postgresql://baseline:baseline@127.0.0.1:1/nexus",
  };
  if (!fromDir) vp(cwd, ["test", "run", "--reporter=json", `--outputFile=${out}`], env);
  if (!existsSync(out)) return { name, missing: true };
  const report = readJson(out);
  const skips = [];
  for (const file of report.testResults) {
    for (const assertion of file.assertionResults) {
      // vitest reports a skipped assertion as "skipped" ("pending" on older ones).
      if (["pending", "skipped", "todo"].includes(assertion.status)) {
        skips.push({
          file: relative(root, file.name).split("\\").join("/"),
          name: assertion.fullName,
        });
      }
    }
  }
  return {
    name,
    files: report.testResults.length,
    tests: report.numTotalTests,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    skipped: report.numPendingTests + report.numTodoTests,
    skips,
  };
}

function runE2e(dir) {
  const out = join(dir, "e2e.json");
  if (!fromDir) {
    runPackageBin(root, "@playwright/test", "playwright", ["test", "--reporter=json"], {
      PLAYWRIGHT_JSON_OUTPUT_NAME: out,
    });
  }
  if (!existsSync(out)) return null;
  const report = readJson(out);
  return {
    passed: report.stats.expected,
    failed: report.stats.unexpected,
    flaky: report.stats.flaky,
    skipped: report.stats.skipped,
  };
}

function measure() {
  const facts = { runtime: runtime(), workspace: workspace(), spec: spec() };
  // The gated half is static, so a check that has no report directory to read
  // skips the suites entirely instead of spending ten minutes to ignore them.
  if (mode === "--check" && !fromDir) {
    return { ...facts, tests: { missing: [] }, e2e: null };
  }
  const dir = fromDir ?? mkdtempSync(join(tmpdir(), "nexus-baseline-"));
  const suites = SUITES.map((suite) => runSuite(suite, dir));
  const missing = suites.filter((s) => s.missing).map((s) => s.name);
  const sum = (key) => suites.reduce((total, s) => total + (s[key] ?? 0), 0);
  const e2e = noE2e ? null : runE2e(dir);
  return {
    ...facts,
    tests: {
      files: sum("files"),
      tests: sum("tests"),
      passed: sum("passed"),
      failed: sum("failed"),
      skipped: sum("skipped"),
      suites,
      missing: missing.length > 0 ? missing : undefined,
    },
    e2e,
  };
}

const n = (value) => (typeof value === "number" ? value.toLocaleString("en-US") : "not measured");

/**
 * Two halves: the facts above MEASURED are deterministic and `--check` fails on
 * any difference, so a new workspace or a changed spec has to be recorded. The
 * rows below it are counts from a real run — recorded, dated, and deliberately
 * not gated, because a shared CI runner and a busy laptop disagree on them
 * (observed on this tree: 0 to 5 failed, 16 to 33 skipped, 529 to 530 files).
 */
function markdown(base) {
  const { runtime: rt, workspace: ws, tests, e2e, spec: sp } = base;
  const pnpm = rt.pnpm ?? `${rt.pnpmDeclared} (declared)`;
  // A missing suite report must never render as "0 tests": a zero that reads as
  // a measurement is the failure mode this file exists to end.
  const unit = tests.missing
    ? `not measured (no report for ${tests.missing.join(", ")})`
    : `${n(tests.tests)} in ${n(tests.files)} files: ${n(tests.passed)} passed, ${n(tests.failed)} failed, ${n(tests.skipped)} skipped`;
  const lines = [
    START,
    "<!-- Generated by `node scripts/baseline.mjs --write`. `--check` enforces the rows above",
    "     the measured marker; everything below it is the last run and is not gated. -->",
    "",
    "| Measure | Value |",
    "|---|---|",
    `| Workspace | ${ws.packages} packages, ${ws.apps} apps, ${ws.services} services |`,
    `| API spec | ${n(sp.paths)} paths, ${n(sp.operations)} operations: ${n(sp.durable)} durable, ${n(sp.bridge)} bridge, ${n(sp.dedicatedVolatile)} dedicated-volatile, ${n(sp.unclassified)} unclassified |`,
    MEASURED,
    `| Last measured | ${new Date().toLocaleDateString("en-CA")} on Node ${rt.node} / pnpm ${pnpm} |`,
    `| Unit tests | ${unit} |`,
    `| E2E tests | ${e2e ? `${n(e2e.passed)} passed, ${n(e2e.failed)} failed, ${n(e2e.skipped)} skipped` : "not measured"} |`,
    `| Tracked files | ${n(ws.trackedFiles)} |`,
    "",
    END,
  ];
  return lines.join("\n");
}

/** Everything from START up to MEASURED: the part --check compares. */
function enforcedSection(block) {
  const measured = block.indexOf(MEASURED);
  return measured === -1 ? block : block.slice(0, measured);
}

/**
 * Compare content, not layout: the markdown formatter re-pads table cells and
 * rewraps HTML comments, so an exact string match would fight `pnpm format`.
 */
function normalize(block) {
  return block
    .split("\n")
    .map((line) =>
      line
        .replace(/<!--.*?-->/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(
      (line) => line !== "" && line !== "|--|" && line !== "|---|" && !/^\|[\s|-]+\|$/.test(line),
    )
    .join("\n");
}

function partial(base) {
  return base.tests.missing || (base.e2e === null && !noE2e) ? true : false;
}

function committedBlock() {
  const text = readFileSync(STATUS, "utf8");
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start === -1 || end === -1) return null;
  return text.slice(start, end + END.length);
}

function writeBlock(block) {
  const text = readFileSync(STATUS, "utf8");
  const current = committedBlock();
  const next = current ? text.replace(current, block) : `${text.trimEnd()}\n\n${block}\n`;
  writeFileSync(STATUS, next, "utf8");
  console.log("Rewrote the baseline block in docs/STATUS.md");
}

const base = measure();

if (mode === "--json") {
  console.log(JSON.stringify(base, null, 2));
} else if (mode === "--skips") {
  // One line per skipped unit test with the file that declares it: the list
  // docs/TESTING.md explains.
  const rows = base.tests.suites.flatMap((suite) =>
    (suite.skips ?? []).map((skip) => `${skip.file} | ${skip.name}`),
  );
  console.log(rows.join("\n"));
  console.log(`\n${rows.length} skipped`);
} else if (mode === "--markdown") {
  console.log(markdown(base));
} else if (mode === "--write") {
  if (partial(base)) {
    console.error("Refusing to write a partial baseline: a suite report is missing.");
    process.exit(1);
  }
  writeBlock(markdown(base));
} else {
  // --check compares only the deterministic half, so it needs no suite run: a
  // new workspace or a changed spec is visible in seconds.
  const expected = enforcedSection(markdown(base));
  const actual = committedBlock();
  if (actual === null) {
    console.error(`docs/STATUS.md has no ${START} … ${END} block. Run --write.`);
    process.exit(1);
  }
  const committed = normalize(enforcedSection(actual));
  if (committed !== normalize(expected)) {
    console.error("docs/STATUS.md baseline facts are stale. Measured:\n");
    console.error(expected);
    console.error("\nCommitted:\n");
    console.error(committed);
    process.exit(1);
  }
  console.log("docs/STATUS.md baseline facts match the tree");
}
