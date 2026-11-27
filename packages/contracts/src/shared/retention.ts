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
 *
 * Sessions and sandbox drives are the same shape as traces in reverse: they are data the user
 * expects to keep until they finish with it, so the expiry is long (a month) and stated once —
 * the sign-in cookie's Max-Age and the row's `expires_at` read the same constant, and so does the
 * worker that reclaims an idle drive.
 *
 * Logs are the one row whose window this process does not own: the API writes to stdout and has no
 * file sink, so retention belongs to whatever collects stdout. Saying so in the table beats a
 * number that only looks like a policy.
 */

/**
 * Every store that keeps something a person put in, or that we wrote about them, is named here — including the
 * two whose policy is "the deployment decides", because a row that says so is an answer and a missing row is
 * not. `apps/api/tests/lib/retention.test.ts` reads `enforcedBy.file` for each policy and checks the symbol is
 * still there, so moving or deleting the code that enforces a policy fails a test instead of leaving a
 * document describing a control that stopped existing.
 */
export type RetentionKey =
  | "traces"
  | "notifications"
  | "auditLog"
  | "sessions"
  | "sandboxArtefacts"
  | "logs";

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
  /** The code that makes this true, as a repository path and a symbol a reader can search for. */
  readonly enforcedBy: { readonly file: string; readonly symbol: string };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const RETENTION: Readonly<Record<RetentionKey, RetentionPolicy>> = {
  traces: {
    key: "traces",
    description: "In-memory and persisted request traces; newest 1000 kept",
    maxEntries: 1_000,
    enforcedBy: {
      file: "apps/api/src/lib/request-traces.ts",
      symbol: "RETENTION.traces.maxEntries",
    },
  },
  notifications: {
    key: "notifications",
    description: "Per-user notifications and their index, expiring in the shared KV",
    ttlMs: 30 * DAY_MS,
    enforcedBy: {
      file: "apps/api/src/lib/notifications-store.ts",
      symbol: "RETENTION.notifications",
    },
  },
  auditLog: {
    key: "auditLog",
    description: "Hash-chained audit log; removed only by an explicit erasure request",
    indefinite: true,
    enforcedBy: {
      file: "packages/db/migrations/20240610061320_0000_bootstrap/migration.sql",
      symbol: "audit_log_no_delete",
    },
  },
  sessions: {
    key: "sessions",
    description:
      "Refresh tokens (sign-in sessions); the cookie and the row expire together after 30 days",
    ttlMs: 30 * DAY_MS,
    enforcedBy: { file: "apps/api/src/routes/auth-users.ts", symbol: 'retentionTtlMs("sessions")' },
  },
  sandboxArtefacts: {
    key: "sandboxArtefacts",
    description: "Per-user sandbox drives: files a run wrote, reclaimed when idle",
    ttlMs: 30 * DAY_MS,
    enforcedBy: { file: "packages/sandbox/src/drive-fs.ts", symbol: "DRIVE_IDLE_MS" },
  },
  logs: {
    key: "logs",
    description:
      "Request and application logs; written to stdout with no file sink, so the deployment's log service owns the window",
    indefinite: false,
    enforcedBy: { file: "apps/api/src/server.ts", symbol: "logger" },
  },
};

/**
 * The expiry of a policy that has one, as a number the type system can see.
 *
 * `ttlMs` is optional because the audit log has none, so a caller that needs a lifetime either reads a policy it
 * knows has one — and would otherwise carry an `undefined` through arithmetic — or asks here and gets an error
 * naming the store. Sessions and sandbox drives use this; it is what keeps their cookie, row and sweep quantity
 * one value.
 */
export function retentionTtlMs(key: RetentionKey): number {
  const policy = RETENTION[key];
  if (policy.ttlMs === undefined) throw new Error(`${key} has no expiry`);
  return policy.ttlMs;
}

/** True when a policy with this key may keep data past its write time on its own. */
export function keepsForever(policy: RetentionPolicy): boolean {
  return (
    policy.indefinite === true && policy.maxEntries === undefined && policy.ttlMs === undefined
  );
}
