// SPDX-License-Identifier: Apache-2.0
/**
 * Durable per-user diff history — the store behind /diff/apply + /diff/rollback.
 *
 * Replaces the process-local Map that made rollbacks same-session-only: the
 * record survives API restarts (shared KV) and is scoped to the caller, so a
 * rollback works in a later session and one user can never read another's
 * history. Layout mirrors lib/research-jobs.ts: id index (newest first) +
 * item records, TTL, per-key mutation lock.
 *
 * Callers are auth-gated (requireAuthWithTier) — uid is always resolved.
 */

import { getSharedKV } from "./shared-kv.js";
import { withKeyLock } from "./with-key-lock.js";

const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_RECORDS = 50;
const MAX_CHARS = 200_000; // per field — diffs of huge files are rejected, not truncated

export interface DiffRecord {
  id: string;
  original: string;
  modified: string;
  appliedAt: string;
}

function uidFor(uid: string | undefined): string {
  return (uid ?? "anon").slice(0, 200);
}

function indexKey(uid: string): string {
  return `diffhist:list:${uid}`;
}

function itemKey(uid: string, id: string): string {
  return `diffhist:item:${uid}:${id}`;
}

/**
 * Persist one applied diff and return its rollback id. Rejects oversized
 * fields (they cannot be rolled back meaningfully) rather than truncating.
 */
export async function saveDiffRecord(
  uid: string | undefined,
  rec: { original: string; modified: string },
): Promise<DiffRecord> {
  if (rec.original.length > MAX_CHARS || rec.modified.length > MAX_CHARS) {
    throw new Error("diff_too_large");
  }
  const userId = uidFor(uid);
  const record: DiffRecord = {
    id: crypto.randomUUID().slice(0, 8),
    original: rec.original,
    modified: rec.modified,
    appliedAt: new Date().toISOString(),
  };
  await withKeyLock(indexKey(userId), async () => {
    const kv = getSharedKV();
    const ids = (await kv.get<string[]>(indexKey(userId))) ?? [];
    await kv.set(itemKey(userId, record.id), record, TTL_MS);
    await kv.set(indexKey(userId), [record.id, ...ids].slice(0, MAX_RECORDS), TTL_MS);
  });
  return record;
}

/** Read one record for rollback. Unknown ids / oversized ids → undefined. */
export async function getDiffRecord(
  uid: string | undefined,
  id: string,
): Promise<DiffRecord | undefined> {
  if (!id || id.length > 64) return undefined;
  const userId = uidFor(uid);
  return getSharedKV().get<DiffRecord>(itemKey(userId, id));
}

/**
 * Newest-first page through the caller's applied diffs (the index order).
 * Evicted/TTL-expired items are silently skipped; without the index (fresh
 * user) returns []. Powers GET /diff/history so a rollback survives reloads.
 */
export async function listDiffRecords(
  uid: string | undefined,
  limit = 10,
): Promise<DiffRecord[]> {
  const userId = uidFor(uid);
  const capped = Math.max(1, Math.min(limit, MAX_RECORDS));
  const kv = getSharedKV();
  const ids = (await kv.get<string[]>(indexKey(userId))) ?? [];
  const records = await Promise.all(ids.slice(0, capped).map((id) => kv.get<DiffRecord>(itemKey(userId, id))));
  return records.filter((r): r is DiffRecord => r !== undefined);
}
