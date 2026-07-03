// SPDX-License-Identifier: Apache-2.0
/**
 * Nexus Drive — per-user sandboxed CLI + storage.
 *
 * API routes under /api/v1/drive:
 *   GET  /drive/status      — workspace status + quota
 *   POST /drive/exec        — execute command in sandbox
 *   POST /drive/upload      — write file to workspace
 *   GET  /drive/ls          — list workspace files
 *   GET  /drive/read        — read workspace file
 *   POST /drive/destroy     — tear down workspace
 *
 * Builds on @nexus/sandbox (Docker runner) and agent-tools (path-guarded fs ops).
 * Phase 6 will upgrade to Firecracker microVMs; current implementation uses
 * Docker containers with resource caps for multi-tenant isolation.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { buildSafeEnv, createDockerRunner, type DockerSandboxConfig } from "@nexus/sandbox";
import type { FastifyInstance } from "fastify";

import { makeUserRateLimitPreHandler } from "../lib/rate-limiter.js";
import { requireAuthWithTier } from "../middleware/auth.js";

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

const DRIVE_ROOT = process.env.NEXUS_DRIVE_ROOT ?? path.join(os.tmpdir(), "nexus-drives");
const QUOTA_BYTES = 512 * 1024 * 1024; // 512 MB
const QUOTA_WARN_PCT = 0.9; // warn at 90%
const MAX_OUTPUT_BYTES = 64 * 1024;
const CMD_TIMEOUT_MS = 30_000;

const DEFAULT_DOCKER_CONFIG: DockerSandboxConfig = {
  image: process.env.SANDBOX_SHELL_IMAGE ?? "node:20-alpine",
  memoryMb: 128,
  cpuPercent: 50,
  pidsLimit: 64,
};

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function userDrivePath(userId: string): string {
  return path.join(DRIVE_ROOT, userId.slice(0, 8));
}

async function ensureDriveDir(userId: string): Promise<string> {
  const dir = userDrivePath(userId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function getDriveUsage(dir: string): Promise<number> {
  try {
    const files = await fs.readdir(dir, { withFileTypes: true, recursive: true });
    let total = 0;
    for (const f of files) {
      if (f.isFile()) {
        try {
          const stat = await fs.stat(path.join(f.parentPath ?? dir, f.name));
          total += stat.size;
        } catch {
          /* file may have been deleted */
        }
      }
    }
    return total;
  } catch {
    return 0;
  }
}

/** Path-traversal guard + symlink resolution, ported from agent-tools. */
export async function safeResolve(rootDir: string, p: string): Promise<string> {
  const resolved = path.resolve(rootDir, p);
  const rel = path.relative(rootDir, resolved);
  if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) {
    throw new Error(`path escapes drive: ${p}`);
  }
  try {
    const real = await fs.realpath(resolved);
    const realRel = path.relative(rootDir, real);
    if (realRel !== "" && (realRel.startsWith("..") || path.isAbsolute(realRel))) {
      throw new Error(`symlink escapes drive: ${p} → ${real}`);
    }
    return real;
  } catch (err) {
    if (err instanceof Error && err.message.includes("escapes drive")) throw err;
    return resolved;
  }
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n…[truncated]` : s;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Route plugin
// ═══════════════════════════════════════════════════════════════════════════════

export async function driveRoutes(app: FastifyInstance): Promise<void> {
  // Per-user rate limiters for drive routes (defense against abuse / DoS).
  const driveRL = makeUserRateLimitPreHandler({ limit: 30, windowMs: 60_000, keyPrefix: "drive" });
  // Tighter limit for command execution — far more expensive than fs ops.
  const driveExecRL = makeUserRateLimitPreHandler({
    limit: 10,
    windowMs: 60_000,
    keyPrefix: "drive-exec",
  });

  // ── Status + quota ──────────────────────────────────────────────────────────

  app.get(
    "/drive/status",
    { preHandler: [requireAuthWithTier, driveRL] },
    async (request, reply) => {
      const userId = request.nexusUserId;
      if (!userId) return reply.code(401).send({ error: "auth_required" });

      const driveDir = await ensureDriveDir(userId);
      const usage = await getDriveUsage(driveDir);
      const pct = usage / QUOTA_BYTES;
      const warning = pct >= QUOTA_WARN_PCT;

      return reply.send({
        root: driveDir,
        quota: { used: usage, limit: QUOTA_BYTES, pct: Math.round(pct * 100) },
        warning: warning
          ? `Drive at ${Math.round(pct * 100)}% — nearing ${QUOTA_BYTES / 1024 / 1024}MB limit`
          : null,
        dockerAvailable: Boolean(process.env.SANDBOX_SHELL_IMAGE) || true,
      });
    },
  );

  // ── Execute command ─────────────────────────────────────────────────────────

  app.post<{ Body: { command?: string; cwd?: string; timeoutMs?: number } }>(
    "/drive/exec",
    { preHandler: [requireAuthWithTier, driveExecRL] },
    async (request, reply) => {
      const userId = request.nexusUserId;
      if (!userId) return reply.code(401).send({ error: "auth_required" });

      const { command, cwd, timeoutMs } = request.body ?? {};
      if (!command?.trim()) return reply.code(400).send({ error: "command is required" });

      const driveDir = await ensureDriveDir(userId);
      const workDir = cwd ? await safeResolve(driveDir, cwd) : driveDir;
      const safeEnv = buildSafeEnv();
      const timeout = Math.min(timeoutMs ?? CMD_TIMEOUT_MS, 60_000);

      // Use Docker sandbox when available, fall back to scrubbed subprocess
      const useDocker = process.env.DISABLE_DOCKER_SANDBOX !== "true";

      if (useDocker) {
        const runner = createDockerRunner(DEFAULT_DOCKER_CONFIG);
        const result = await runner("/bin/sh", ["-c", command], {
          timeoutMs: timeout,
          env: safeEnv,
        }).catch((err: Error) => ({
          stdout: "",
          stderr: err.message,
          exitCode: null,
          timedOut: false,
        }));

        return reply.send({
          stdout: clip(result.stdout, MAX_OUTPUT_BYTES),
          stderr: clip(result.stderr, MAX_OUTPUT_BYTES),
          exitCode: result.exitCode,
          timedOut: result.timedOut,
        });
      }

      // Fallback: direct subprocess with scrubbed env.
      // SECURITY: this path runs the user-supplied command UNSANDBOXED on the
      // host. It is only acceptable for local dev. In production, refuse rather
      // than execute arbitrary shell on the host — the Docker sandbox is the
      // only supported execution path there.
      if (process.env.NODE_ENV === "production") {
        return reply.code(503).send({ error: "sandbox_unavailable" });
      }

      const child = spawn("/bin/sh", ["-c", command], {
        cwd: workDir,
        env: safeEnv,
      });

      return new Promise((resolve) => {
        let out = "";
        let killed = false;
        const timer = setTimeout(() => {
          killed = true;
          child.kill("SIGKILL");
        }, timeout);
        timer.unref();

        child.stdout.on("data", (d: Buffer) => {
          if (out.length < MAX_OUTPUT_BYTES) out += d.toString();
        });
        child.stderr.on("data", (d: Buffer) => {
          if (out.length < MAX_OUTPUT_BYTES) out += d.toString();
        });

        child.on("close", (code) => {
          clearTimeout(timer);
          resolve(
            reply.send({
              stdout: clip(out, MAX_OUTPUT_BYTES),
              stderr: "",
              exitCode: code,
              timedOut: killed,
            }),
          );
        });

        child.on("error", (err) => {
          clearTimeout(timer);
          resolve(reply.code(500).send({ error: err.message }));
        });
      });
    },
  );

  // ── List files ──────────────────────────────────────────────────────────────

  app.get<{ Querystring: { dir?: string } }>(
    "/drive/ls",
    { preHandler: [requireAuthWithTier, driveRL] },
    async (request, reply) => {
      const userId = request.nexusUserId;
      if (!userId) return reply.code(401).send({ error: "auth_required" });

      const driveDir = await ensureDriveDir(userId);
      const listDir = request.query.dir ? await safeResolve(driveDir, request.query.dir) : driveDir;

      try {
        const entries = await fs.readdir(listDir, { withFileTypes: true });
        const files = await Promise.all(
          entries.map(async (e) => {
            const full = path.join(listDir, e.name);
            let size = 0;
            let mtime = "";
            try {
              const stat = await fs.stat(full);
              size = stat.size;
              mtime = stat.mtime.toISOString();
            } catch {
              /* ignore */
            }
            return {
              name: e.name,
              type: e.isDirectory() ? "dir" : "file",
              size,
              mtime,
            };
          }),
        );
        return reply.send({ path: path.relative(driveDir, listDir) || "/", files });
      } catch {
        return reply.code(404).send({ error: "directory not found" });
      }
    },
  );

  // ── Read file ───────────────────────────────────────────────────────────────

  app.get<{ Querystring: { path: string } }>(
    "/drive/read",
    { preHandler: [requireAuthWithTier, driveRL] },
    async (request, reply) => {
      const userId = request.nexusUserId;
      if (!userId) return reply.code(401).send({ error: "auth_required" });

      const filePath = request.query.path;
      if (!filePath) return reply.code(400).send({ error: "path is required" });

      const driveDir = await ensureDriveDir(userId);
      try {
        const resolved = await safeResolve(driveDir, filePath);
        const content = await fs.readFile(resolved, "utf8");
        return reply.send({ path: filePath, content: clip(content, MAX_OUTPUT_BYTES) });
      } catch (e) {
        if (e instanceof Error && e.message.includes("escapes drive")) {
          return reply.code(403).send({ error: e.message });
        }
        return reply.code(404).send({ error: "file not found" });
      }
    },
  );

  // ── Upload / write file ─────────────────────────────────────────────────────

  app.post<{ Body: { path: string; content: string } }>(
    "/drive/upload",
    { preHandler: [requireAuthWithTier, driveRL] },
    async (request, reply) => {
      const userId = request.nexusUserId;
      if (!userId) return reply.code(401).send({ error: "auth_required" });

      const { path: filePath, content } = request.body ?? {};
      if (!filePath?.trim()) return reply.code(400).send({ error: "path is required" });
      if (content === undefined) return reply.code(400).send({ error: "content is required" });

      const driveDir = await ensureDriveDir(userId);
      const usage = await getDriveUsage(driveDir);
      const newSize = Buffer.byteLength(content, "utf8");

      if (usage + newSize > QUOTA_BYTES) {
        return reply.code(413).send({
          error: "quota_exceeded",
          used: usage,
          limit: QUOTA_BYTES,
          attempted: newSize,
        });
      }

      try {
        const resolved = await safeResolve(driveDir, filePath);
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, content, "utf8");
        return reply.code(201).send({
          path: filePath,
          size: newSize,
          quotaRemaining: QUOTA_BYTES - usage - newSize,
        });
      } catch (e) {
        if (e instanceof Error && e.message.includes("escapes drive")) {
          return reply.code(403).send({ error: e.message });
        }
        throw e;
      }
    },
  );

  // ── Destroy workspace ───────────────────────────────────────────────────────

  app.delete(
    "/drive/destroy",
    { preHandler: [requireAuthWithTier, driveRL] },
    async (request, reply) => {
      const userId = request.nexusUserId;
      if (!userId) return reply.code(401).send({ error: "auth_required" });

      const driveDir = userDrivePath(userId);
      try {
        await fs.rm(driveDir, { recursive: true, force: true });
        return reply.send({ message: "workspace destroyed" });
      } catch {
        return reply.send({ message: "workspace already clean" });
      }
    },
  );
}
