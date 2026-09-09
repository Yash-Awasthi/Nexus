// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  makeUserRateLimitPreHandler,
  makeRateLimitPreHandler,
} from "../../src/lib/rate-limiter.js";
import { safeResolve } from "../../src/routes/drive.js";

// Real path-traversal regression tests for the Nexus Drive guard. safeResolve
// is the single chokepoint every /drive/* fs operation routes through, so a
// traversal/symlink escape here is the whole vulnerability — these assert the
// attack is blocked, not just the happy path.
describe("Nexus Drive — safeResolve path guard", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "drive-test-"));
    await mkdir(path.join(root, "sub"), { recursive: true });
    await writeFile(path.join(root, "sub", "file.txt"), "hello");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("resolves a legitimate sub-path to inside the drive root", async () => {
    const resolved = await safeResolve(root, "sub/file.txt");
    expect(resolved.startsWith(root)).toBe(true);
  });

  it("rejects ../ traversal escaping the drive root", async () => {
    await expect(safeResolve(root, "../../../../etc/passwd")).rejects.toThrow(/escapes drive/);
  });

  it("rejects an absolute path outside the drive root", async () => {
    await expect(safeResolve(root, "/etc/passwd")).rejects.toThrow(/escapes drive/);
  });

  it("rejects a symlink that points outside the drive root", async (ctx) => {
    const linkPath = path.join(root, "evil-link");
    try {
      await symlink("/etc/passwd", linkPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // The guard being tested is symlink *resolution*, not creation. Windows
      // (and some CI sandboxes) require elevated privileges to create symlinks
      // at all, so skip the assertion there rather than fail an environment gap.
      if (code === "EPERM" || code === "EACCES" || code === "ENOSYS" || code === "EXDEV") {
        return ctx.skip(
          `symlink creation is not permitted on ${process.platform} (${code}) — needs symlink privilege`,
        );
      }
      throw err;
    }
    await expect(safeResolve(root, "evil-link")).rejects.toThrow(/escapes drive/);
  });
});

describe("Per-user rate limiting", () => {
  it("makeUserRateLimitPreHandler returns a preHandler", () => {
    const rl = makeUserRateLimitPreHandler({ limit: 50, windowMs: 60_000, keyPrefix: "test" });
    expect(typeof rl).toBe("function");
  });

  it("makeRateLimitPreHandler returns a preHandler", () => {
    const rl = makeRateLimitPreHandler({ limit: 10, windowMs: 60_000 });
    expect(typeof rl).toBe("function");
  });

  it("both limiters chain without error", () => {
    const ip = makeRateLimitPreHandler({ limit: 30, windowMs: 60_000, keyPrefix: "admin" });
    const user = makeUserRateLimitPreHandler({ limit: 50, windowMs: 60_000, keyPrefix: "admin" });
    expect(typeof ip).toBe("function");
    expect(typeof user).toBe("function");
  });
});
