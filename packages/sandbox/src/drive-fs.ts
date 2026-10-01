// SPDX-License-Identifier: Apache-2.0
/**
 * Where a user's drive lives on disk, and what is in it.
 *
 * The API serves drives and the worker reclaims and sweeps them, so the path
 * rule and the walk belong to neither: two answers to "how big is this drive"
 * that can disagree are worse than one that is merely approximate.
 *
 * There is no table behind this. A drive's size and its last activity are
 * already recorded by the filesystem, and a row would only be a second copy to
 * keep in step.
 */

import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** Root holding every user's drive directory. */
export const DRIVE_ROOT = process.env.NEXUS_DRIVE_ROOT ?? path.join(os.tmpdir(), "nexus-drives");

/** Per-drive size ceiling. */
export const DRIVE_QUOTA_BYTES = 512 * 1024 * 1024;

/** How long a drive may sit untouched before it is reclaimed. */
export const DRIVE_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The directory holding `userId`'s drive.
 *
 * Hex of the whole ID, not a prefix of it: a truncation hands two users whose
 * IDs share a prefix the same drive, and a raw ID is neither filesystem-safe
 * nor distinct once Windows folds case.
 */
export function userDrivePath(userId: string): string {
  return path.join(DRIVE_ROOT, Buffer.from(userId, "utf8").toString("hex"));
}

/** The user ID a drive directory name encodes, or null if it is not one. */
export function userIdFromDrivePath(dirName: string): string | null {
  if (!/^(?:[0-9a-f]{2})+$/.test(dirName)) return null;
  return Buffer.from(dirName, "hex").toString("utf8");
}

export interface DriveStat {
  bytes: number;
  files: number;
  /** Newest mtime in the tree, epoch ms; 0 for an empty or missing drive. */
  lastActiveMs: number;
}

/**
 * Size, file count and last activity in one walk.
 *
 * One pass because every caller wants at least two of the three, and walking a
 * drive twice to answer one question each is the whole cost of the operation.
 */
export async function statDrive(dir: string): Promise<DriveStat> {
  let bytes = 0;
  let files = 0;
  let lastActiveMs = 0;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
  } catch {
    return { bytes, files, lastActiveMs };
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    try {
      const st = await fs.stat(path.join(e.parentPath ?? dir, e.name));
      bytes += st.size;
      files += 1;
      lastActiveMs = Math.max(lastActiveMs, st.mtimeMs);
    } catch {
      // Raced with a delete — it contributes nothing either way.
    }
  }
  return { bytes, files, lastActiveMs };
}

export interface DriveEntry {
  dirName: string;
  dir: string;
  userId: string | null;
}

/** Every drive directory currently on disk. */
export async function listDrives(root = DRIVE_ROOT): Promise<DriveEntry[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => ({
      dirName: e.name,
      dir: path.join(root, e.name),
      userId: userIdFromDrivePath(e.name),
    }));
}

/**
 * A drive's last activity, falling back to the directory's own mtime.
 *
 * An empty drive has no file to date it by, and treating it as active since
 * the epoch would reclaim a workspace the user created minutes ago.
 */
export async function driveLastActiveMs(dir: string, stat?: DriveStat): Promise<number> {
  const s = stat ?? (await statDrive(dir));
  if (s.lastActiveMs > 0) return s.lastActiveMs;
  try {
    return (await fs.stat(dir)).mtimeMs;
  } catch {
    return 0;
  }
}
