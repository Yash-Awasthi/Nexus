// SPDX-License-Identifier: Apache-2.0
/**
 * How long each stored thing is kept — in one place, so the answer to "how long do
 * you keep this" is a value in code and not a paragraph in a doc.
 *
 * Three policies, deliberately different, because the three stores exist for
 * different reasons:
 *
 *   Traces are for looking at what just happened. A thousand of them is days of
 *   traffic on a busy instance and enough to debug a slow afternoon; past that the
 *   newest evict the oldest, because nobody reads the ten-thousandth-oldest span.
 *
 *   Notifications exist until the user has had a fair chance to see them. Thirty
 *   days is the KV expiry, so a notification that nobody opened is not a permanent
 *   row in the user's face — and the list index carries the same expiry, so the
 *   index cannot outlive the items it points at.
 *
 *   The audit log is evidence. It is never pruned by time or by count: an entry is
 *   removed only by an explicit, audited erasure request (GDPR erasure), which
 *   writes its own record. A retention policy that could delete an audit entry on a
 *   schedule would be a policy for deleting evidence.
 *
 * Consumers import from here rather than holding their own literal, and
 * `apps/api/tests/lib/retention.test.ts` holds each policy to its store.
 */

export type RetentionKey = "traces" | "notifications" | "auditLog";

export interface RetentionPolicy {
  readonly key: RetentionKey;
  /** What is kept, in the terms the store uses. */
  readonly description: string;
  /** The store keeps at most this many entries, oldest evicted. */
  readonly maxEntries?: number;
  /** Entries expire this long after they are written. */
  readonly ttlMs?: number;
  /** Nothing removes this data except an explicit erasure request. */
  readonly indefinite?: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const RETENTION: Readonly<Record<RetentionKey, RetentionPolicy>> = {
  traces: {
    key: "traces",
    description: "In-memory and persisted request traces; newest 1000 kept",
    maxEntries: 1_000,
  },
  notifications: {
    key: "notifications",
    description: "Per-user notifications and their index, expiring in the shared KV",
    ttlMs: 30 * DAY_MS,
  },
  auditLog: {
    key: "auditLog",
    description: "Hash-chained audit log; removed only by an explicit erasure request",
    indefinite: true,
  },
};

/** True when a policy with this key may keep data past its write time on its own. */
export function keepsForever(policy: RetentionPolicy): boolean {
  return (
    policy.indefinite === true && policy.maxEntries === undefined && policy.ttlMs === undefined
  );
}
