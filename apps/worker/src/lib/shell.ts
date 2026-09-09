// SPDX-License-Identifier: Apache-2.0
/**
 * Portable shell invocation for worker-side child processes.
 *
 * Single owner (the one-owner rule): every worker spawn of a user/operator
 * command goes through `shellInvocation` — agent-tools.ts imports it here
 * since the consolidation pass (its former inline copy was removed). Do not
 * add a second copy.
 *
 * Worker handlers previously hardcoded `/bin/sh`, which ENOENTs on Windows
 * (spawn ENOENT −4058): WorkspaceManager/WorkspaceRunner were unusable on a
 * Windows host. On win32 commands run through cmd.exe (`/d /s /c`) — verified
 * in agent-tools: node serializes the arg, so the raw command runs exactly,
 * and /d skips autorun scripts.
 */
import { spawn, type ChildProcess } from "node:child_process";

export function shellInvocation(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  return { file: "/bin/sh", args: ["-c", command] };
}

/** spawn() a shell command through the portable shell pick. */
export function spawnShell(
  command: string,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
): ChildProcess {
  const { file, args } = shellInvocation(command);
  return spawn(file, args, opts);
}
