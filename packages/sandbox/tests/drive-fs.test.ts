// SPDX-License-Identifier: Apache-2.0
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, it, expect, beforeAll, afterAll } from "vitest";

import {
  driveLastActiveMs,
  listDrives,
  statDrive,
  userDrivePath,
  userIdFromDrivePath,
} from "../src/drive-fs.js";

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "drive-fs-test-"));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("userDrivePath", () => {
  it("separates users whose IDs share a long prefix", () => {
    const a = userDrivePath("user-0000000000000000-alice");
    const b = userDrivePath("user-0000000000000000-bob");
    expect(a).not.toBe(b);
  });

  it("round-trips through the directory name", () => {
    const id = "user-42";
    const dirName = path.basename(userDrivePath(id));
    expect(userIdFromDrivePath(dirName)).toBe(id);
  });

  it("rejects a directory that is not a drive", () => {
    expect(userIdFromDrivePath("lost+found")).toBeNull();
  });

  it("stays distinct when the filesystem folds case", () => {
    const a = path.basename(userDrivePath("Alice"));
    const b = path.basename(userDrivePath("alice"));
    expect(a.toLowerCase()).not.toBe(b.toLowerCase());
  });
});

describe("statDrive", () => {
  it("reports size, count and newest mtime in one walk", async () => {
    const dir = path.join(root, "drive-a");
    await fs.mkdir(path.join(dir, "nested"), { recursive: true });
    await fs.writeFile(path.join(dir, "top.txt"), "12345");
    await fs.writeFile(path.join(dir, "nested", "deep.txt"), "123");

    const stat = await statDrive(dir);
    expect(stat.bytes).toBe(8);
    expect(stat.files).toBe(2);
    expect(stat.lastActiveMs).toBeGreaterThan(0);
  });

  it("returns zeroes for a drive that does not exist", async () => {
    expect(await statDrive(path.join(root, "absent"))).toEqual({
      bytes: 0,
      files: 0,
      lastActiveMs: 0,
    });
  });
});

describe("driveLastActiveMs", () => {
  it("dates an empty drive by its own directory, not the epoch", async () => {
    const dir = path.join(root, "drive-empty");
    await fs.mkdir(dir, { recursive: true });
    expect(await driveLastActiveMs(dir)).toBeGreaterThan(0);
  });
});

describe("listDrives", () => {
  it("lists drive directories and decodes their owners", async () => {
    const owned = path.join(root, path.basename(userDrivePath("user-7")));
    await fs.mkdir(owned, { recursive: true });

    const drives = await listDrives(root);
    const found = drives.find((d) => d.dir === owned);
    expect(found?.userId).toBe("user-7");
    expect(drives.every((d) => typeof d.dirName === "string")).toBe(true);
  });

  it("returns empty for a root that does not exist", async () => {
    expect(await listDrives(path.join(root, "nope"))).toEqual([]);
  });
});
