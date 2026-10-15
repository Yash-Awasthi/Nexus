// SPDX-License-Identifier: Apache-2.0
/**
 * Drives live on local disk, which a free Render instance loses whenever it sleeps or redeploys.
 * With DRIVE_BACKUP_S3_* set, the API backs changed drives up on a timer (the worker's backup job,
 * run here so it needs no Redis) and brings a missing drive back from its newest backup the first
 * time it is used.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";

import {
  extractTarGz,
  s3Bucket,
  s3ConfigFromEnv,
  userDrivePath,
  type S3Bucket,
} from "@nexus/sandbox";
import { handleDriveBackupJob } from "@nexus/worker/drive-lifecycle";

import { withKeyLock } from "./with-key-lock.ts";

/** Unpack `dir`'s newest backup into it; false when the bucket holds none. */
export async function restoreDrive(
  dir: string,
  bucket: S3Bucket | null = null,
  prefix = s3ConfigFromEnv()?.prefix ?? "drives/",
): Promise<boolean> {
  const cfg = s3ConfigFromEnv();
  const store = bucket ?? (cfg ? s3Bucket(cfg) : null);
  if (!store) return false;
  const keys = (await store.list(`${prefix}${path.basename(dir)}/`))
    .map((o) => o.key)
    .filter((k) => k.endsWith(".tar.gz"))
    .sort();
  const newest = keys.at(-1);
  const body = newest ? await store.get(newest) : null;
  if (!body) return false;
  // Unpacked beside the drive and renamed in, so a failed restore never looks like a drive.
  const staging = `${dir}.restoring-${process.pid}`;
  await fs.rm(staging, { recursive: true, force: true });
  try {
    await extractTarGz(Readable.from([body]), staging);
    await fs.rename(staging, dir);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
  return true;
}

/**
 * `userId`'s drive directory, restored from backup first when it is missing. A restore that fails
 * throws rather than leaving an empty drive, which the next backup would record as the newest copy.
 */
export function ensureDrive(userId: string, bucket?: S3Bucket): Promise<string> {
  const dir = userDrivePath(userId);
  return withKeyLock(`drive:${dir}`, async () => {
    const present = await fs.stat(dir).then(
      () => true,
      () => false,
    );
    if (!present) await restoreDrive(dir, bucket ?? null);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  });
}

/** Back up changed drives every DRIVE_BACKUP_INTERVAL_MS (10 min); the stopper takes a last one. */
export function startDriveBackups(log: {
  warn: (o: object, m: string) => void;
}): () => Promise<void> {
  if (!s3ConfigFromEnv()) return async () => {};
  let running: Promise<void> | null = null;
  const tick = () =>
    (running ??= handleDriveBackupJob({})
      .then(() => undefined)
      .catch((err: unknown) =>
        log.warn({ err: String(err) }, "drive backup failed; retrying next interval"),
      )
      .finally(() => {
        running = null;
      }));
  const timer = setInterval(
    () => void tick(),
    Number(process.env.DRIVE_BACKUP_INTERVAL_MS) || 600_000,
  );
  timer.unref();
  return async () => {
    clearInterval(timer);
    await tick();
  };
}
