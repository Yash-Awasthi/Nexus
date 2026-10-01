// SPDX-License-Identifier: Apache-2.0
/**
 * drive-lifecycle — the repeatable jobs that look after drives.
 *
 *   drive.reclaim — delete drives untouched for longer than the idle window
 *   drive.sweep   — recompute usage and report which drives are over quota
 *   drive.backup  — copy each changed drive as .tar.gz to DRIVE_BACKUP_DIR or an S3 / R2 bucket
 *
 * Both read the filesystem directly. A drive's size and its last activity are
 * already recorded there, so there is no row to keep in step with the disk.
 */

import { createReadStream, createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  DRIVE_IDLE_MS,
  DRIVE_QUOTA_BYTES,
  DRIVE_ROOT,
  driveLastActiveMs,
  listDrives,
  statDrive,
  tarGzDirectory,
} from "@nexus/sandbox";
import { AwsClient } from "aws4fetch";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DriveReclaimPayload {
  /** Idle window in ms. Defaults to 30 days. */
  idleMs?: number;
  /** Report what would be deleted without deleting it. */
  dryRun?: boolean;
  root?: string;
}

interface ReclaimedDrive {
  dirName: string;
  userId: string | null;
  bytes: number;
  idleMs: number;
}

interface DriveReclaimResult {
  scanned: number;
  reclaimed: ReclaimedDrive[];
  bytesFreed: number;
  dryRun: boolean;
}

export interface DriveSweepPayload {
  quotaBytes?: number;
  root?: string;
}

interface SweptDrive {
  dirName: string;
  userId: string | null;
  bytes: number;
  files: number;
  overQuota: boolean;
}

interface DriveSweepResult {
  drives: SweptDrive[];
  totalBytes: number;
  overQuota: number;
}

export interface DriveBackupPayload {
  root?: string;
  /** A local directory for backups. Defaults to DRIVE_BACKUP_DIR. */
  backupDir?: string;
  /** Backups kept per drive. Defaults to 7. */
  keep?: number;
  /** Where backups go; defaults to the S3 bucket when configured, else the directory. */
  store?: BackupStore;
}

/** Somewhere to keep each drive's timestamped archives. */
export interface BackupStore {
  /** Archive names for one drive, with when each was written. */
  list(drive: string): Promise<{ name: string; at: number }[]>;
  /** Store a finished local archive under `name`. */
  put(drive: string, name: string, file: string): Promise<void>;
  remove(drive: string, name: string): Promise<void>;
}

function dirBackupStore(backupDir: string): BackupStore {
  return {
    async list(drive) {
      const dir = path.join(backupDir, drive);
      const names = await fs.readdir(dir).catch(() => [] as string[]);
      return Promise.all(
        names
          .filter((n) => n.endsWith(".tar.gz"))
          .map(async (name) => ({ name, at: (await fs.stat(path.join(dir, name))).mtimeMs })),
      );
    },
    async put(drive, name, file) {
      const dest = path.join(backupDir, drive);
      await fs.mkdir(dest, { recursive: true });
      const partial = path.join(dest, `${name}.partial`);
      await fs.copyFile(file, partial);
      await fs.rename(partial, path.join(dest, name));
    },
    async remove(drive, name) {
      await fs.rm(path.join(backupDir, drive, name), { force: true });
    },
  };
}

export interface S3BackupConfig {
  /** e.g. https://<account>.r2.cloudflarestorage.com or https://s3.<region>.amazonaws.com */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
}

/** The bucket named by DRIVE_BACKUP_S3_*, or null when it is not configured. */
function s3ConfigFromEnv(env = process.env): S3BackupConfig | null {
  const { DRIVE_BACKUP_S3_BUCKET: bucket, DRIVE_BACKUP_S3_ACCESS_KEY_ID: accessKeyId } = env;
  const secretAccessKey = env.DRIVE_BACKUP_S3_SECRET_ACCESS_KEY;
  if (!bucket || !accessKeyId || !secretAccessKey) return null;
  const region = env.DRIVE_BACKUP_S3_REGION ?? "auto";
  return {
    endpoint: (env.DRIVE_BACKUP_S3_ENDPOINT ?? `https://s3.${region}.amazonaws.com`).replace(
      /\/$/,
      "",
    ),
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    prefix: env.DRIVE_BACKUP_S3_PREFIX ?? "drives/",
  };
}

/**
 * Path-style S3 API calls signed with SigV4, which R2 and S3 both accept.
 * `fetchFn` receives the signed request.
 */
export function s3BackupStore(
  cfg: S3BackupConfig,
  fetchFn: (req: Request) => Promise<Response> = (req) => fetch(req),
): BackupStore {
  const aws = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: "s3",
    region: cfg.region,
  });
  const keyUrl = (key: string) =>
    `${cfg.endpoint}/${cfg.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const call = async (url: string, init: RequestInit & { duplex?: "half" } = {}) => {
    const res = await fetchFn(await aws.sign(url, init));
    if (!res.ok)
      throw new Error(
        `S3 ${init.method ?? "GET"} ${res.status}: ${(await res.text()).slice(0, 200)}`,
      );
    return res;
  };
  return {
    async list(drive) {
      const prefix = `${cfg.prefix}${drive}/`;
      // ponytail: one page (1000 keys) is plenty for `keep` archives per drive.
      const xml = await (
        await call(`${cfg.endpoint}/${cfg.bucket}?list-type=2&prefix=${encodeURIComponent(prefix)}`)
      ).text();
      return [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].flatMap(([, item]) => {
        const key = /<Key>([^<]+)<\/Key>/.exec(item!)?.[1];
        const at = Date.parse(/<LastModified>([^<]+)<\/LastModified>/.exec(item!)?.[1] ?? "");
        return key?.endsWith(".tar.gz") ? [{ name: key.slice(prefix.length), at }] : [];
      });
    },
    async put(drive, name, file) {
      const { size } = await fs.stat(file);
      await call(keyUrl(`${cfg.prefix}${drive}/${name}`), {
        method: "PUT",
        headers: { "Content-Type": "application/gzip", "Content-Length": String(size) },
        body: Readable.toWeb(createReadStream(file)) as ReadableStream,
        duplex: "half",
      });
    },
    async remove(drive, name) {
      await call(keyUrl(`${cfg.prefix}${drive}/${name}`), { method: "DELETE" });
    },
  };
}

interface DriveBackupResult {
  backedUp: string[];
  unchanged: number;
  skipped?: "no_backup_dir";
}

/** The store backups go to without an explicit one: the bucket, else the directory. */
function defaultBackupStore(backupDir?: string): BackupStore | null {
  const s3 = s3ConfigFromEnv();
  if (s3) return s3BackupStore(s3);
  const dir = backupDir ?? process.env.DRIVE_BACKUP_DIR;
  return dir ? dirBackupStore(dir) : null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function auditLog(event: string, detail: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: "info", event, ...detail }));
}

// ── Handlers ──────────────────────────────────────────────────────────────────

/**
 * Delete drives nobody has touched inside the idle window.
 *
 * A drive with no files at all is dated by its own directory: a workspace
 * created minutes ago and not yet written to has no file to date it by, and
 * reclaiming it would delete the drive out from under the user who just asked
 * for it.
 */
export async function handleDriveReclaimJob(
  payload: DriveReclaimPayload = {},
): Promise<DriveReclaimResult> {
  const idleMs = payload.idleMs ?? DRIVE_IDLE_MS;
  const dryRun = payload.dryRun ?? false;
  const root = payload.root ?? DRIVE_ROOT;
  const now = Date.now();

  const drives = await listDrives(root);
  const reclaimed: ReclaimedDrive[] = [];
  let bytesFreed = 0;

  for (const drive of drives) {
    const stat = await statDrive(drive.dir);
    const lastActive = await driveLastActiveMs(drive.dir, stat);
    const idle = now - lastActive;
    if (lastActive === 0 || idle < idleMs) continue;

    if (!dryRun) {
      try {
        await fs.rm(drive.dir, { recursive: true, force: true });
      } catch (err) {
        auditLog("drive.reclaim-failed", { dirName: drive.dirName, error: String(err) });
        continue;
      }
    }
    reclaimed.push({
      dirName: drive.dirName,
      userId: drive.userId,
      bytes: stat.bytes,
      idleMs: idle,
    });
    bytesFreed += stat.bytes;
  }

  auditLog("drive.reclaim", {
    scanned: drives.length,
    reclaimed: reclaimed.length,
    bytesFreed,
    dryRun,
  });
  return { scanned: drives.length, reclaimed, bytesFreed, dryRun };
}

/**
 * Recompute every drive's usage and name the ones over quota.
 *
 * The API checks quota before and after each command, which misses growth from
 * anything else that writes into a drive; this is the periodic correction.
 */
export async function handleDriveSweepJob(
  payload: DriveSweepPayload = {},
): Promise<DriveSweepResult> {
  const quotaBytes = payload.quotaBytes ?? DRIVE_QUOTA_BYTES;
  const root = payload.root ?? DRIVE_ROOT;

  const drives = await listDrives(root);
  const swept: SweptDrive[] = [];
  let totalBytes = 0;

  for (const drive of drives) {
    const stat = await statDrive(drive.dir);
    const overQuota = stat.bytes > quotaBytes;
    swept.push({
      dirName: drive.dirName,
      userId: drive.userId,
      bytes: stat.bytes,
      files: stat.files,
      overQuota,
    });
    totalBytes += stat.bytes;
    if (overQuota) {
      auditLog("drive.over-quota", {
        dirName: drive.dirName,
        bytes: stat.bytes,
        limit: quotaBytes,
      });
    }
  }

  const overQuota = swept.filter((d) => d.overQuota).length;
  auditLog("drive.sweep", { drives: swept.length, totalBytes, overQuota });
  return { drives: swept, totalBytes, overQuota };
}

/**
 * Copy every drive changed since its last backup to `<drive>/<time>.tar.gz` in the store,
 * leaving out each .env, and keep the newest `keep` copies of each drive.
 */
export async function handleDriveBackupJob(
  payload: DriveBackupPayload = {},
): Promise<DriveBackupResult> {
  const store = payload.store ?? defaultBackupStore(payload.backupDir);
  if (!store) return { backedUp: [], unchanged: 0, skipped: "no_backup_dir" };
  const root = payload.root ?? DRIVE_ROOT;
  const keep = Math.max(1, payload.keep ?? 7);

  const backedUp: string[] = [];
  let unchanged = 0;
  for (const drive of await listDrives(root)) {
    const staging = path.join(os.tmpdir(), `nexus-backup-${drive.dirName}-${Date.now()}.tar.gz`);
    try {
      // Timestamped names sort in time order.
      const existing = (await store.list(drive.dirName)).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      const newest = existing.at(-1);
      if (newest) {
        if ((await driveLastActiveMs(drive.dir, await statDrive(drive.dir))) <= newest.at) {
          unchanged++;
          continue;
        }
      }
      const name = `${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz`;
      await pipeline(
        tarGzDirectory(drive.dir, (n) => n === ".env"),
        createWriteStream(staging),
      );
      await store.put(drive.dirName, name, staging);
      backedUp.push(drive.dirName);
      for (const old of [...existing.map((e) => e.name), name].slice(0, -keep)) {
        await store.remove(drive.dirName, old);
      }
    } catch (err) {
      auditLog("drive.backup-failed", { dirName: drive.dirName, error: String(err) });
    } finally {
      await fs.rm(staging, { force: true });
    }
  }

  auditLog("drive.backup", { backedUp: backedUp.length, unchanged });
  return { backedUp, unchanged };
}
