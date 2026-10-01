// SPDX-License-Identifier: Apache-2.0
/**
 * Fail when packages/contracts/src/generated/openapi.ts is out of date.
 *
 * The file is committed so the SDK and every consumer typecheck without a
 * codegen step, which only works while the committed copy matches the spec.
 * Regenerate with `pnpm types:generate`.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const target = "packages/contracts/src/generated/openapi.ts";
const scratch = mkdtempSync(join(tmpdir(), "nexus-types-"));
const candidate = join(scratch, "openapi.ts");

try {
  // The CLI is resolved and run as a script rather than through a shell: a
  // shell here would need the arguments concatenated, and the temp path is
  // OS-supplied rather than fixed.
  // Run through the package manager that launched this script: pnpm keeps each
  // package's binaries local, so the generator resolves from @nexus/contracts,
  // which declares it. `npm_execpath` is either pnpm's JS entry point or, for the
  // standalone build (@pnpm/exe), a native binary that runs on its own; either
  // way this stays a plain process spawn rather than a shell invocation.
  const pnpm = process.env.npm_execpath;
  if (!pnpm) {
    console.error("Run this through the package manager: pnpm types:check");
    process.exit(1);
  }
  const native = /\.exe$/i.test(pnpm) || !/\.[cm]?js$/i.test(pnpm);
  execFileSync(
    native ? pnpm : process.execPath,
    [
      ...(native ? [] : [pnpm]),
      "--filter",
      "@nexus/contracts",
      "exec",
      "openapi-typescript",
      join(process.cwd(), "openapi.yaml"),
      "--output",
      candidate,
    ],
    { stdio: "inherit" },
  );

  const lf = (text) => text.split("\r\n").join("\n");
  if (lf(readFileSync(target, "utf8")) !== lf(readFileSync(candidate, "utf8"))) {
    console.error(`${target} is out of sync with openapi.yaml. Run \`pnpm types:generate\`.`);
    process.exit(1);
  }
  console.log(`${target} is in sync.`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
