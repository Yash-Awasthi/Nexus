// SPDX-License-Identifier: Apache-2.0
/**
 * Docker Compose runner — thin wrapper around the `docker compose` CLI.
 *
 * Used by FederationSupervisor to start/stop Floci and related services.
 */

import { spawn } from "child_process";

interface DockerComposeResult {
  /** Exit code of the docker compose process. */
  code: number;
  /** Alias for code — kept for compatibility. */
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a `docker compose` command against one or more Compose files.
 *
 * @param workingDir  Root directory from which to run the command.
 * @param composeFiles Relative paths to docker-compose YAML files.
 * @param args        Additional arguments passed to `docker compose` (e.g. `["up", "-d"]`).
 */
export function runDockerCompose(
  workingDir: string,
  composeFiles: string[],
  args: string[],
): Promise<DockerComposeResult> {
  return new Promise((resolve, reject) => {
    const fileArgs = composeFiles.flatMap((f) => ["-f", f]);
    const child = spawn("docker", ["compose", ...fileArgs, ...args], {
      cwd: workingDir,
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));

    child.on("error", reject);
    child.on("close", (exitCode) => {
      const code = exitCode ?? 0;
      resolve({ code, exitCode: code, stdout, stderr });
    });
  });
}
