// SPDX-License-Identifier: Apache-2.0
/**
 * Copies audit entries out of the database into an S3-compatible bucket (NX-FEAT-011, threat
 * model T3): once an entry sits in a bucket with object lock, someone who can write to the
 * database can no longer rewrite the chain unnoticed, because the exported copy disagrees.
 *
 * Objects are `<prefix><first>-<last>.jsonl`, one entry per line, sequences zero-padded so they
 * sort. The last exported sequence is kept in the security KV; losing it only re-exports.
 */
import crypto from "node:crypto";

import { db } from "@nexus/db";
import { auditLog } from "@nexus/db/schema";
import type { KVStore } from "@nexus/kv";
import { s3Bucket, s3ConfigFromEnv, type S3Bucket } from "@nexus/sandbox";
import { asc, gt } from "drizzle-orm";

import { getSecurityKV } from "./shared-kv.ts";

const CURSOR = "audit-export:cursor";

interface ExportOptions {
  prefix: string;
  /** Per-object COMPLIANCE retention; unset leaves locking to the bucket's own rules (e.g. R2). */
  retainDays?: number;
  batch?: number;
  kv: Pick<KVStore, "get" | "set">;
}

const pad = (n: number) => String(n).padStart(12, "0");

/** Export every entry past the cursor; returns how many were written. */
export async function exportAuditLog(bucket: S3Bucket, opts: ExportOptions): Promise<number> {
  const batch = opts.batch ?? 1000;
  let cursor = (await opts.kv.get<number>(CURSOR)) ?? 0;
  let written = 0;
  for (;;) {
    const rows = await db
      .select()
      .from(auditLog)
      .where(gt(auditLog.sequence, cursor))
      .orderBy(asc(auditLog.sequence))
      .limit(batch);
    if (rows.length === 0) return written;
    const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    const first = rows[0]!.sequence;
    const last = rows.at(-1)!.sequence;
    const headers: Record<string, string> = {
      "Content-Type": "application/x-ndjson",
      // S3 refuses an object-lock PUT without an integrity header.
      "Content-MD5": crypto.createHash("md5").update(body).digest("base64"),
    };
    if (opts.retainDays) {
      headers["x-amz-object-lock-mode"] = "COMPLIANCE";
      headers["x-amz-object-lock-retain-until-date"] = new Date(
        Date.now() + opts.retainDays * 86_400_000,
      ).toISOString();
    }
    await bucket.put(`${opts.prefix}${pad(first)}-${pad(last)}.jsonl`, body, headers);
    await opts.kv.set(CURSOR, last);
    cursor = last;
    written += rows.length;
    if (rows.length < batch) return written;
  }
}

/**
 * Export on a timer when AUDIT_EXPORT_S3_* names a bucket. Runs in the API process because
 * that is where entries are written, with or without a separate worker. Returns a stopper.
 */
export function startAuditExport(log: { warn: (o: object, m: string) => void }): () => void {
  const cfg = s3ConfigFromEnv(process.env, "AUDIT_EXPORT_S3", "audit/");
  if (!cfg) return () => {};
  const bucket = s3Bucket(cfg);
  const retainDays = Number(process.env.AUDIT_EXPORT_RETAIN_DAYS) || undefined;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await exportAuditLog(bucket, { prefix: cfg.prefix, retainDays, kv: getSecurityKV() });
    } catch (err) {
      log.warn({ err: String(err) }, "audit export failed; retrying next interval");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, Number(process.env.AUDIT_EXPORT_INTERVAL_MS) || 600_000);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
