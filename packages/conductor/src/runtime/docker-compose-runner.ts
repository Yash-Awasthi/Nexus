// SPDX-License-Identifier: Apache-2.0
import { spawn } from "child_process";
import * as path from "path";

export type ComposeRunResult = { code: number; stdout: string; stderr: string };

export function runDockerCompose(
  repoRoot: string,
  composeFiles: string[],
  args: string[],
): Promise<ComposeRunResult> {
  const files = composeFiles.map((f) => (path.isAbsolute(f) ? f : path.join(repoRoot, f)));
  const fileArgs = files.flatMap((f) => ["-f", f]);
  const cmd = process.platform === "win32" ? "docker" : "docker";
  const fullArgs = ["compose", ...fileArgs, ...args];

  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, fullArgs, {
      cwd: repoRoot,
      shell: process.platform === "win32",
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
