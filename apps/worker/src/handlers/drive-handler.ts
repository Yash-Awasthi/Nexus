// SPDX-License-Identifier: Apache-2.0
/**
 * drive-handler — `drive.exec` BullMQ job: execute a shell command in the
 * user's per-drive Docker sandbox.
 *
 * Dispatched by the API layer after auth + quota pre-checks. The handler
 * wraps @nexus/sandbox (buildSafeEnv + createDockerRunner) with a hard
 * timeout, 64 KiB output truncation, and structured JSON audit logging.
 */

import { buildSafeEnv, createDockerRunner, type DockerSandboxConfig } from "@nexus/sandbox";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DriveExecPayload {
  userId: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface DriveExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_OUTPUT_BYTES = 64 * 1024; // 64 KiB
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;

const DEFAULT_DOCKER_CONFIG: DockerSandboxConfig = {
  image: process.env.SANDBOX_SHELL_IMAGE ?? "node:20-alpine",
  memoryMb: 128,
  cpuPercent: 50,
  pidsLimit: 64,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} bytes]`;
}

/** Structured audit log matching the agent-tools.ts pattern. */
function auditLog(userId: string, event: string, detail: Record<string, unknown>): void {
  console.error(
    JSON.stringify({
      level: "info",
      event: `drive.exec.${event}`,
      userId,
      ts: new Date().toISOString(),
      ...detail,
    }),
  );
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function handleDriveExecJob(payload: DriveExecPayload): Promise<DriveExecResult> {
  const { userId, command, cwd, env, timeoutMs } = payload;
  const start = Date.now();
  const timeout = Math.min(timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

  auditLog(userId, "started", {
    command: command.slice(0, 200),
    cwd: cwd ?? null,
    timeoutMs: timeout,
  });

  const safeEnv = buildSafeEnv(env);
  const runner = createDockerRunner(DEFAULT_DOCKER_CONFIG);

  const result = await runner("/bin/sh", ["-c", command], {
    timeoutMs: timeout,
    env: safeEnv,
  }).catch((err: Error) => ({
    stdout: "",
    stderr: err.message,
    exitCode: null as number | null,
    timedOut: false,
  }));

  const durationMs = Date.now() - start;

  auditLog(userId, "finished", {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs,
    outLen: Buffer.byteLength(result.stdout, "utf8"),
    errLen: Buffer.byteLength(result.stderr, "utf8"),
  });

  return {
    stdout: clip(result.stdout, MAX_OUTPUT_BYTES),
    stderr: clip(result.stderr, MAX_OUTPUT_BYTES),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs,
  };
}
