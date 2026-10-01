// SPDX-License-Identifier: Apache-2.0
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";

import { userDrivePath } from "@nexus/sandbox";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  handleDriveBackupJob,
  handleDriveReclaimJob,
  handleDriveSweepJob,
} from "../../src/handlers/drive-lifecycle.js";

let root: string;

/** A drive directory for `userId` holding one file of `size` bytes, aged `ageMs`. */
async function makeDrive(userId: string, size: number, ageMs = 0): Promise<string> {
  const dir = path.join(root, path.basename(userDrivePath(userId)));
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "data.bin");
  await fs.writeFile(file, Buffer.alloc(size));
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    await fs.utimes(file, when, when);
    await fs.utimes(dir, when, when);
  }
  return dir;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "drive-lifecycle-test-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("handleDriveReclaimJob", () => {
  it("deletes drives past the idle window and leaves active ones", async () => {
    const stale = await makeDrive("idle-user", 100, 40 * 24 * 60 * 60 * 1000);
    const fresh = await makeDrive("busy-user", 50);

    const res = await handleDriveReclaimJob({ root });

    expect(res.scanned).toBe(2);
    expect(res.reclaimed.map((r) => r.userId)).toEqual(["idle-user"]);
    expect(res.bytesFreed).toBe(100);
    await expect(fs.stat(stale)).rejects.toThrow();
    await expect(fs.stat(fresh)).resolves.toBeDefined();
  });

  it("deletes nothing on a dry run", async () => {
    const stale = await makeDrive("idle-user", 100, 40 * 24 * 60 * 60 * 1000);

    const res = await handleDriveReclaimJob({ root, dryRun: true });

    expect(res.reclaimed).toHaveLength(1);
    expect(res.dryRun).toBe(true);
    await expect(fs.stat(stale)).resolves.toBeDefined();
  });

  it("spares a drive created moments ago with nothing in it yet", async () => {
    const empty = path.join(root, path.basename(userDrivePath("new-user")));
    await fs.mkdir(empty, { recursive: true });

    const res = await handleDriveReclaimJob({ root });

    expect(res.reclaimed).toHaveLength(0);
    await expect(fs.stat(empty)).resolves.toBeDefined();
  });
});

describe("handleDriveSweepJob", () => {
  it("totals usage and names the drives over quota", async () => {
    await makeDrive("small-user", 10);
    await makeDrive("big-user", 400);

    const res = await handleDriveSweepJob({ root, quotaBytes: 100 });

    expect(res.totalBytes).toBe(410);
    expect(res.overQuota).toBe(1);
    expect(res.drives.find((d) => d.overQuota)?.userId).toBe("big-user");
  });

  it("reports nothing for an empty root", async () => {
    const res = await handleDriveSweepJob({ root: path.join(root, "absent") });
    expect(res).toEqual({ drives: [], totalBytes: 0, overQuota: 0 });
  });
});

describe("handleDriveBackupJob", () => {
  const backups = async (backupDir: string, drive: string) =>
    (await fs.readdir(path.join(backupDir, path.basename(drive)))).sort();

  it("does nothing without a backup directory", async () => {
    await makeDrive("u1", 10);
    const res = await handleDriveBackupJob({ root, backupDir: "" });
    expect(res.skipped).toBe("no_backup_dir");
  });

  it("archives each drive without its .env, and skips a drive unchanged since", async () => {
    const drive = await makeDrive("u1", 10, 60_000);
    await fs.writeFile(path.join(drive, ".env"), "KEY=secret");
    const backupDir = path.join(root, "..", `${path.basename(root)}-backups`);

    const first = await handleDriveBackupJob({ root, backupDir });
    expect(first.backedUp).toEqual([path.basename(drive)]);
    const [file] = await backups(backupDir, drive);
    const tar = gunzipSync(await fs.readFile(path.join(backupDir, path.basename(drive), file!)));
    expect(tar.includes("data.bin")).toBe(true);
    expect(tar.includes(".env")).toBe(false);
    expect(tar.includes("secret")).toBe(false);

    const second = await handleDriveBackupJob({ root, backupDir });
    expect(second).toEqual({ backedUp: [], unchanged: 1 });
    await fs.rm(backupDir, { recursive: true, force: true });
  });

  it("keeps only the newest copies of a changed drive", async () => {
    const drive = await makeDrive("u1", 10);
    const backupDir = path.join(root, "..", `${path.basename(root)}-backups`);
    for (let i = 0; i < 3; i++) {
      const when = new Date(Date.now() + (i + 1) * 60_000);
      await fs.utimes(path.join(drive, "data.bin"), when, when);
      await handleDriveBackupJob({ root, backupDir, keep: 2 });
    }
    expect(await backups(backupDir, drive)).toHaveLength(2);
    await fs.rm(backupDir, { recursive: true, force: true });
  });
});
