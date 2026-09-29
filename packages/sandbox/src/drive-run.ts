// SPDX-License-Identifier: Apache-2.0
/**
 * A drive command with a hard quota. The drive is copied onto a tmpfs capped at
 * the quota, so the kernel refuses a write past it (ENOSPC) mid-command; the
 * result is copied out to a staging directory and swapped in only when the copy
 * finished, so a killed or timed-out command leaves the drive as it was.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";

import {
  buildDockerArgs,
  buildSafeEnv,
  defaultRunner,
  DRIVE_OUTPUT_MOUNT,
  DRIVE_SOURCE_MOUNT,
  WORKSPACE_MOUNT,
  type DockerSandboxConfig,
  type Runner,
  type RunnerResult,
} from "./index.js";

/** Written last by the container; its presence means the staged copy is whole. */
export const RUN_COMPLETE = ".nexus-run-complete";

// $1 = working directory inside the tmpfs, $2 = the user's command. A function, not a constant:
// index.ts re-exports this module, so its values are not ready while this one loads.
// Entries are copied one by one: `cp -a dir/.` would also copy the tmpfs root's 1777 mode onto
// the drive directory.
const copyEntries = (from: string, to: string) =>
  `find ${from} -mindepth 1 -maxdepth 1 -exec cp -a {} ${to}/ ';'`;
const wrapper = () =>
  `${copyEntries(DRIVE_SOURCE_MOUNT, WORKSPACE_MOUNT)} && cd "$1" && ` +
  `{ sh -c "$2"; s=$?; ${copyEntries(WORKSPACE_MOUNT, DRIVE_OUTPUT_MOUNT)} && ` +
  `: > ${DRIVE_OUTPUT_MOUNT}/${RUN_COMPLETE}; exit $s; }`;

export interface DriveRunOptions {
  driveDir: string;
  quotaBytes: number;
  command: string;
  /** Working directory inside the container, under {@link WORKSPACE_MOUNT}. */
  workdir?: string;
  timeoutMs: number;
  /** Environment of the docker client (the container gets none of it). */
  env?: Record<string, string>;
  docker?: DockerSandboxConfig;
  /** Runs `docker` with the given args; the real CLI unless a test injects one. */
  run?: Runner;
}

export async function runOnDrive(
  opts: DriveRunOptions,
): Promise<RunnerResult & { applied: boolean }> {
  const run = opts.run ?? defaultRunner;
  const id = randomUUID();
  const staging = `${opts.driveDir}.run-${id}`;
  const mode = (await fs.stat(opts.driveDir)).mode & 0o7777;
  await fs.mkdir(staging, { recursive: true });
  // The container may run as another uid than this process; the drive gets its mode back below.
  await fs.chmod(staging, 0o777);
  const quotaMb = Math.max(1, Math.ceil(opts.quotaBytes / (1024 * 1024)));
  const name = `nexus-drive-${id}`;
  const env = opts.env ?? buildSafeEnv();
  const args = [
    ...buildDockerArgs({
      ...opts.docker,
      workspacePath: opts.driveDir,
      workdir: WORKSPACE_MOUNT,
      quotaMb,
      outputPath: staging,
      name,
      interactive: false,
    }),
    "/bin/sh",
    "-c",
    wrapper(),
    "nexus",
    opts.workdir ?? WORKSPACE_MOUNT,
    opts.command,
  ];
  let result: RunnerResult;
  try {
    result = await run("docker", args, { timeoutMs: opts.timeoutMs, env });
  } catch (err) {
    result = { stdout: "", stderr: (err as Error).message, exitCode: null, timedOut: false };
  }
  // Stopping the docker client does not stop its container.
  if (result.timedOut)
    await run("docker", ["rm", "-f", name], { timeoutMs: 15_000, env }).catch(() => null);

  const complete =
    !result.timedOut && (await fs.stat(`${staging}/${RUN_COMPLETE}`).catch(() => null));
  if (!complete) {
    await fs.rm(staging, { recursive: true, force: true });
    return { ...result, applied: false };
  }
  await fs.rm(`${staging}/${RUN_COMPLETE}`, { force: true });
  const old = `${opts.driveDir}.old-${id}`;
  await fs.rename(opts.driveDir, old);
  await fs.rename(staging, opts.driveDir);
  await fs.chmod(opts.driveDir, mode);
  await fs.rm(old, { recursive: true, force: true });
  return { ...result, applied: true };
}
