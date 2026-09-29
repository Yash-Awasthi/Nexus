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
 *   GET  /drive/export      — the workspace as .tar.gz, every .env left out
 *   POST /drive/link        — a signed, expiring download link for one file
 *   GET  /drive/file        — the file behind a link, no session needed
 *   GET  /drive/links       — the caller's live links
 *   DELETE /drive/links/:id — revoke one link
 *   DELETE /drive/destroy   — tear down workspace
 *
 * Builds on @nexus/sandbox (Docker runner) and agent-tools (path-guarded fs ops).
 * Commands run in capped Docker containers, under gVisor when SANDBOX_RUNTIME=runsc,
 * on a tmpfs the size of the quota so a write past it fails (see runOnDrive).
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ExecAction } from "@nexus/exec-policy";
import { globalFlags } from "@nexus/feature-flags";
import {
  buildSafeEnv,
  DRIVE_QUOTA_BYTES,
  runOnDrive,
  statDrive,
  tarGzDirectory,
  userDrivePath,
  WORKSPACE_MOUNT,
  type DockerSandboxConfig,
} from "@nexus/sandbox";
import type { FastifyInstance } from "fastify";

import { guardExec } from "../lib/exec-guard.js";
import { PersistentStore } from "../lib/persistent-store.js";
import { makeRateLimitPreHandler, makeUserRateLimitPreHandler } from "../lib/rate-limiter.js";
import { withKeyLock } from "../lib/with-key-lock.js";
import { requireAuthWithTier } from "../middleware/auth.js";

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

const QUOTA_BYTES = DRIVE_QUOTA_BYTES;
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

/**
 * The UID:GID the sandbox writes as. The workspace bind mount is owned by the
 * user the API runs as, so a container on the image's default UID would be
 * unable to write to the very directory it was given.
 */
function hostUser(): string | undefined {
  return typeof process.getuid === "function" && typeof process.getgid === "function"
    ? `${process.getuid()}:${process.getgid()}`
    : undefined;
}

/** `workDir` expressed inside the container, where the drive is {@link WORKSPACE_MOUNT}. */
function containerWorkdir(driveDir: string, workDir: string): string {
  const rel = path.relative(driveDir, workDir);
  return rel ? path.posix.join(WORKSPACE_MOUNT, ...rel.split(path.sep)) : WORKSPACE_MOUNT;
}

async function ensureDriveDir(userId: string): Promise<string> {
  const dir = userDrivePath(userId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function getDriveUsage(dir: string): Promise<number> {
  return (await statDrive(dir)).bytes;
}

/** Fastify answers an error carrying `statusCode` with that status, so every route gets a 403. */
function escapeError(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 403 });
}

/** Path-traversal guard + symlink resolution, ported from agent-tools. */
export async function safeResolve(rootDir: string, p: string): Promise<string> {
  const resolved = path.resolve(rootDir, p);
  const rel = path.relative(rootDir, resolved);
  if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) {
    throw escapeError(`path escapes drive: ${p}`);
  }
  try {
    const real = await fs.realpath(resolved);
    const realRel = path.relative(rootDir, real);
    if (realRel !== "" && (realRel.startsWith("..") || path.isAbsolute(realRel))) {
      throw escapeError(`symlink escapes drive: ${p} → ${real}`);
    }
    return real;
  } catch (err) {
    if (err instanceof Error && err.message.includes("escapes drive")) throw err;
    return resolved;
  }
}

/** Rotating the secrets key (or the JWT secret it falls back to) revokes every link. */
function linkKey(): string | undefined {
  const s = process.env.NEXUS_SECRETS_KEY || process.env.NEXUS_JWT_SECRET;
  return s ? crypto.createHash("sha256").update(`drive-link:${s}`).digest("hex") : undefined;
}

function linkSig(key: string, body: string): string {
  return crypto.createHmac("sha256", key).update(body).digest("base64url");
}

/** A link serves only while its row exists, so deleting the row revokes it. */
interface DriveLink {
  id: string;
  ownerId: string;
  path: string;
  expiresAt: number;
}
const driveLinks = new PersistentStore<DriveLink>("drive_links");

const LINK_TTL_MIN = 30;
const LINK_TTL_MAX = 7 * 24 * 60;

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n…[truncated]` : s;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Route plugin
// ═══════════════════════════════════════════════════════════════════════════════

export async function driveRoutes(app: FastifyInstance): Promise<void> {
  await driveLinks.load();
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
        dockerAvailable: process.env.ALLOW_UNSANDBOXED_EXEC !== "true",
      });
    },
  );

  // ── Execute command ─────────────────────────────────────────────────────────

  app.post<{ Body: { command?: string; cwd?: string; timeoutMs?: number; approvalId?: string } }>(
    "/drive/exec",
    { preHandler: [requireAuthWithTier, driveExecRL] },
    async (request, reply) => {
      const userId = request.nexusUserId;
      if (!userId) return reply.code(401).send({ error: "auth_required" });

      if (!globalFlags.isEnabled("drive.exec")) {
        return reply.code(403).send({
          error: "drive_exec_disabled",
          message: "Drive commands are turned off by an admin.",
        });
      }
      const { command, cwd, timeoutMs } = request.body ?? {};
      if (!command?.trim()) return reply.code(400).send({ error: "command is required" });

      const driveDir = await ensureDriveDir(userId);

      const usedBefore = await getDriveUsage(driveDir);
      if (usedBefore >= QUOTA_BYTES) {
        return reply
          .code(413)
          .send({ error: "quota_exceeded", used: usedBefore, limit: QUOTA_BYTES });
      }

      const workDir = cwd ? await safeResolve(driveDir, cwd) : driveDir;
      const safeEnv = buildSafeEnv();
      const timeout = Math.min(timeoutMs ?? CMD_TIMEOUT_MS, 60_000);

      // The Docker sandbox is the only supported path; leaving it takes an
      // explicit flag naming what the alternative is, never a missing NODE_ENV.
      const useDocker = process.env.ALLOW_UNSANDBOXED_EXEC !== "true";
      // The container is the control for the sandbox surface; outside it this is a host shell.
      const action: ExecAction = {
        surface: useDocker ? "sandbox" : "pty",
        command: "sh",
        args: ["-c", command],
        cwd: workDir,
      };
      if ((await guardExec(request, reply, action, request.body.approvalId)) === "handled") return;

      if (useDocker) {
        // The run replaces the drive directory, so nothing else may write to it meanwhile.
        const result = await withKeyLock(`drive:${userId}`, () =>
          runOnDrive({
            driveDir,
            quotaBytes: QUOTA_BYTES,
            command,
            workdir: containerWorkdir(driveDir, workDir),
            timeoutMs: timeout,
            env: safeEnv as Record<string, string>,
            docker: { ...DEFAULT_DOCKER_CONFIG, runAsUser: hostUser() },
          }),
        );

        const usedAfter = await getDriveUsage(driveDir);
        return reply.send({
          stdout: clip(result.stdout, MAX_OUTPUT_BYTES),
          stderr: clip(result.stderr, MAX_OUTPUT_BYTES),
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          // A command that timed out or never finished leaves the drive as it was.
          applied: result.applied,
          quota: { used: usedAfter, limit: QUOTA_BYTES, exceeded: usedAfter > QUOTA_BYTES },
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
    {
      preHandler: [requireAuthWithTier, driveRL],
      schema: {
        body: {
          type: "object",
          required: ["path", "content"],
          properties: { path: { type: "string" }, content: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      const userId = request.nexusUserId;
      if (!userId) return reply.code(401).send({ error: "auth_required" });

      const { path: filePath, content } = request.body ?? {};
      if (!filePath?.trim()) return reply.code(400).send({ error: "path is required" });
      if (content === undefined) return reply.code(400).send({ error: "content is required" });

      const driveDir = await ensureDriveDir(userId);
      const resolved = await safeResolve(driveDir, filePath);
      // An overwrite frees the old file's bytes, so only the difference counts.
      const replaced = (await fs.stat(resolved).catch(() => null))?.size ?? 0;
      const usage = (await getDriveUsage(driveDir)) - replaced;
      const newSize = Buffer.byteLength(content, "utf8");

      if (usage + newSize > QUOTA_BYTES) {
        return reply.code(413).send({
          error: "quota_exceeded",
          used: usage,
          limit: QUOTA_BYTES,
          attempted: newSize,
        });
      }

      await withKeyLock(`drive:${userId}`, async () => {
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, content, "utf8");
      });
      return reply.code(201).send({
        path: filePath,
        size: newSize,
        quotaRemaining: QUOTA_BYTES - usage - newSize,
      });
    },
  );

  // ── Export ──────────────────────────────────────────────────────────────────
  // The user's own keys stay out of every copy of the drive.

  // `dir` exports one folder, such as a generated app, without its installed packages.
  app.get<{ Querystring: { dir?: string } }>(
    "/drive/export",
    { preHandler: [requireAuthWithTier, driveRL] },
    async (request, reply) => {
      const userId = request.nexusUserId;
      if (!userId) return reply.code(401).send({ error: "auth_required" });
      const driveDir = userDrivePath(userId);
      const dir = request.query.dir;
      const root = dir ? await safeResolve(driveDir, dir) : driveDir;
      const st = await fs.stat(root).catch(() => null);
      if (!st?.isDirectory())
        return reply.code(404).send({ error: dir ? "not_found" : "no_drive" });
      const file =
        dir && root !== driveDir ? path.basename(root).replace(/[^\w.-]/g, "_") : "nexus-drive";
      return reply
        .header("Content-Type", "application/gzip")
        .header("Content-Disposition", `attachment; filename="${file}.tar.gz"`)
        .send(
          tarGzDirectory(
            root,
            (name) => name === ".env" || (root !== driveDir && name === "node_modules"),
          ),
        );
    },
  );

  // ── Download links ──────────────────────────────────────────────────────────
  // The user's own keys are never linked, even by a link made before they were written.

  app.post<{ Body: { path?: string; ttlMinutes?: number } }>(
    "/drive/link",
    { preHandler: [requireAuthWithTier, driveRL] },
    async (request, reply) => {
      const userId = request.nexusUserId;
      if (!userId) return reply.code(401).send({ error: "auth_required" });
      const key = linkKey();
      if (!key) return reply.code(503).send({ error: "links_unavailable" });
      const filePath = request.body?.path?.trim();
      if (!filePath) return reply.code(400).send({ error: "path is required" });

      const driveDir = await ensureDriveDir(userId);
      const resolved = await safeResolve(driveDir, filePath);
      if (path.basename(resolved) === ".env")
        return reply.code(403).send({ error: "The drive's key file is never linked." });
      if (!(await fs.stat(resolved).catch(() => null))?.isFile())
        return reply.code(404).send({ error: "file not found" });

      const ttl = Math.min(
        Math.max(Number(request.body?.ttlMinutes) || LINK_TTL_MIN, 1),
        LINK_TTL_MAX,
      );
      const expires = Date.now() + ttl * 60_000;
      const rel = path.relative(driveDir, resolved).split(path.sep).join("/");
      const id = crypto.randomUUID();
      await driveLinks.save(id, { id, ownerId: userId, path: rel, expiresAt: expires });
      const body = Buffer.from(JSON.stringify({ i: id, u: userId, p: rel, e: expires })).toString(
        "base64url",
      );
      return reply.send({
        id,
        url: `/api/v1/drive/file?t=${body}.${linkSig(key, body)}`,
        expiresAt: new Date(expires).toISOString(),
      });
    },
  );

  app.get<{ Querystring: { t?: string } }>(
    "/drive/file",
    {
      preHandler: makeRateLimitPreHandler({ limit: 60, windowMs: 60_000, keyPrefix: "drive-file" }),
    },
    async (request, reply) => {
      const refuse = () => reply.code(403).send({ error: "invalid_or_expired_link" });
      const key = linkKey();
      const [body, sig] = (request.query.t ?? "").split(".");
      if (!key || !body || !sig) return refuse();
      const want = Buffer.from(linkSig(key, body));
      const got = Buffer.from(sig);
      if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return refuse();
      let claim: { i?: unknown; u?: unknown; p?: unknown; e?: unknown };
      try {
        claim = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      } catch {
        return refuse();
      }
      if (typeof claim.u !== "string" || typeof claim.p !== "string") return refuse();
      if (typeof claim.e !== "number" || claim.e < Date.now()) return refuse();
      if (typeof claim.i !== "string" || driveLinks.get(claim.i)?.ownerId !== claim.u)
        return refuse();

      const resolved = await safeResolve(userDrivePath(claim.u), claim.p).catch(() => null);
      if (!resolved || path.basename(resolved) === ".env") return refuse();
      if (!(await fs.stat(resolved).catch(() => null))?.isFile())
        return reply.code(404).send({ error: "file not found" });
      const name = path.basename(resolved);
      const ascii = name.replace(/[^\w.\- ]/g, "_");
      return reply
        .header("Content-Type", "application/octet-stream")
        .header(
          "Content-Disposition",
          ascii === name
            ? `attachment; filename="${name}"`
            : `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        )
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "private, no-store")
        .send(createReadStream(resolved));
    },
  );

  app.get(
    "/drive/links",
    { preHandler: [requireAuthWithTier, driveRL] },
    async (request, reply) => {
      const userId = request.nexusUserId;
      if (!userId) return reply.code(401).send({ error: "auth_required" });
      const now = Date.now();
      const links: { id: string; path: string; expiresAt: string }[] = [];
      for (const l of [...driveLinks.values()]) {
        if (l.expiresAt < now) driveLinks.delete(l.id);
        else if (l.ownerId === userId)
          links.push({ id: l.id, path: l.path, expiresAt: new Date(l.expiresAt).toISOString() });
      }
      return reply.send({ links: links.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt)) });
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/drive/links/:id",
    { preHandler: [requireAuthWithTier, driveRL] },
    async (request, reply) => {
      const link = driveLinks.get(request.params.id);
      if (!link || link.ownerId !== request.nexusUserId)
        return reply.code(404).send({ error: "not_found" });
      driveLinks.delete(link.id);
      return reply.code(204).send();
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
        await withKeyLock(`drive:${userId}`, () =>
          fs.rm(driveDir, { recursive: true, force: true }),
        );
        return reply.send({ message: "workspace destroyed" });
      } catch {
        return reply.send({ message: "workspace already clean" });
      }
    },
  );
}
