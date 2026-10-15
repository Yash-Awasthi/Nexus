// SPDX-License-Identifier: Apache-2.0
/**
 * Drive commands on a host without Docker: a bash interpreter written in
 * TypeScript (just-bash) runs in a permission-restricted child that can read
 * installed packages and read or write only the caller's drive. It has no host
 * binaries, processes or network, so the drive is all a command can reach.
 */

import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { SANDBOX_PRELUDE } from "@nexus/agent-runtime";

import { runSandboxedNode, STARTED, type SandboxRunResult } from "./untrusted-js.ts";

const ENTRY = realpathSync(createRequire(import.meta.url).resolve("just-bash"));
/** The outermost node_modules: pnpm links a package's dependencies from elsewhere in it. */
const MODULES = (() => {
  const parts = ENTRY.split(path.sep);
  return parts.slice(0, parts.indexOf("node_modules") + 1).join(path.sep);
})();

// The permission model refuses fchmod, fchown and futimes, which the copy path uses to carry
// file modes and times over; a drive has no use for either, so those become no-ops.
const RUNNER = `${SANDBOX_PRELUDE}
const [entry, root, cwd, budgetArg] = process.argv.slice(-4);
let src = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (src += c));
process.stdin.on("end", async () => {
  const fsp = require("node:fs/promises");
  const handle = await fsp.open(root, "r");
  const FileHandle = Object.getPrototypeOf(handle);
  await handle.close();
  FileHandle.chmod = FileHandle.chown = FileHandle.utimes = async () => {};

  const { Bash, ReadWriteFs } = require(entry);
  let budget = Number(budgetArg);
  const spend = (content) => {
    budget -= typeof content === "string" ? Buffer.byteLength(content) : content.byteLength;
    if (budget < 0) throw new Error("EDQUOT: drive quota exceeded");
  };
  const real = new ReadWriteFs({ root, maxCopySize: Math.max(budget, 1) });
  const fs = new Proxy(real, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === "writeFile" || key === "appendFile")
        return async (p, content, options) => {
          spend(content);
          return value.call(target, p, content, options);
        };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const bash = new Bash({ fs, cwd });
  process.stderr.write(${JSON.stringify(STARTED)});
  try {
    const r = await bash.exec(src);
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    process.exitCode = r.exitCode;
  } catch (e) {
    process.stderr.write((e && e.message) || String(e));
    process.exitCode = 1;
  }
});
`;

/** Run `command` with the drive at `/`, starting in `cwd` (a drive path such as `/notes`). */
// ponytail: cp is capped per file, not in total; the route's quota check refuses the next command
export function runDriveShell(
  command: string,
  driveDir: string,
  cwd: string,
  budgetBytes: number,
  timeoutMs: number,
): Promise<SandboxRunResult> {
  const root = realpathSync(driveDir);
  return runSandboxedNode(
    [
      `--allow-fs-read=${MODULES}`,
      `--allow-fs-read=${root}`,
      `--allow-fs-write=${root}`,
      "--max-old-space-size=192",
    ],
    RUNNER,
    command,
    timeoutMs,
    [ENTRY, root, cwd, String(Math.max(0, budgetBytes))],
  );
}
