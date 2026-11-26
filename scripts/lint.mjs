// SPDX-License-Identifier: Apache-2.0
/**
 * `pnpm lint` — one gate over every workspace source directory, plus the Go
 * modules and the license headers.
 *
 * Target discovery is in `scripts/lint-targets.mjs`: a package that appears in
 * `pnpm-workspace.yaml` is linted the moment it exists, with no list to update.
 *
 *   node scripts/lint.mjs          check
 *   node scripts/lint.mjs --fix    apply the safe fixes
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { goModules, lintTargets, root } from "./lint-targets.mjs";

const fix = process.argv.includes("--fix");
const failures = [];

function report(name, status, detail) {
  const label = status === 0 ? "ok" : "FAILED";
  console.log(`[${label}] ${name}${detail ? `: ${detail}` : ""}`);
  if (status !== 0) failures.push(name);
}

/** Run a package's CLI through Node so `.cmd` shims never need a shell. */
function bin(cwd, pkgName, binName, argv) {
  const { createRequire } = process.getBuiltinModule("node:module");
  const require = createRequire(join(cwd, "package.json"));
  const pkgPath = require.resolve(`${pkgName}/package.json`);
  const manifest = JSON.parse(process.getBuiltinModule("node:fs").readFileSync(pkgPath, "utf8"));
  const entry = join(pkgPath, "..", manifest.bin?.[binName] ?? manifest.bin);
  return spawnSync(process.execPath, [entry, ...argv], {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
}

const targets = lintTargets();
if (targets.length === 0) {
  console.error(
    "No workspace source directories found — refusing to pass a lint run with no targets.",
  );
  process.exit(1);
}
console.log(`Linting ${targets.length} workspace source directories`);

// vp lint is the type-aware pass and the one that owns the rules; eslint runs the
// import/ordering rules vp does not carry.
report(
  "vp lint",
  bin(root, "vite-plus", "vp", ["lint", "--type-aware", ...(fix ? ["--fix"] : []), ...targets])
    .status ?? 1,
);
report(
  "eslint",
  bin(root, "eslint", "eslint", [...(fix ? ["--fix"] : []), ...targets]).status ?? 1,
);

// The CLI and its reference page have to agree, in both directions.
report(
  "cli parity",
  spawnSync(process.execPath, [join(root, "scripts/cli-parity.mjs")], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  }).status ?? 1,
);

// Go modules: gofmt is formatting, `go vet` is the compiler's opinion. A host
// without the toolchain says so instead of silently passing.
const modules = goModules();
const hasGo = spawnSync("go", ["version"], { encoding: "utf8" }).status === 0;
if (modules.length > 0 && !hasGo) {
  console.log(`[skip] go vet: ${modules.join(", ")} (no Go toolchain on PATH)`);
}
for (const module of modules) {
  if (!hasGo) break;
  const cwd = join(root, module);
  const unformatted = spawnSync("gofmt", ["-l", "."], { cwd, encoding: "utf8" });
  report(
    `gofmt ${module}`,
    unformatted.status === 0 && unformatted.stdout.trim() === "" ? 0 : 1,
    unformatted.stdout.trim().split("\n").filter(Boolean).join(", ") || undefined,
  );
  report(
    `go vet ${module}`,
    spawnSync("go", ["vet", "./..."], { cwd, stdio: "inherit" }).status ?? 1,
  );
}

if (failures.length > 0) {
  console.error(`\nlint failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(`\nlint passed: ${targets.length} source directories, ${modules.length} Go module(s)`);
