// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/db — GDPR "right to erasure" (Art. 17) cascade (§14.4).
 *
 * {@link eraseUserData} deletes every row a user owns across the user-scoped
 * tables, children first and the `users` row last so foreign keys never block
 * the cascade. The set of tables is declared once in {@link USER_SCOPED_TABLES}
 * — a single, auditable list a compliance reviewer can read — and a unit test
 * asserts every entry actually targets a `user_id` column, so a new user-scoped
 * table that is forgotten here is caught structurally rather than leaking PII.
 *
 * The db handle is a narrow structural interface ({@link ErasableDb}), so the
 * cascade is unit-testable against a fake recorder with no live database.
 *
 * Deliberate exclusions (documented, not oversights):
 *   • billing / usage rows — retained under the "legal obligation" lawful basis
 *     (financial record-keeping); erased on a separate retention schedule.
 *   • `workspaces.ownerId` / `workspaceInvitations.invitedByUserId` — deleting a
 *     workspace owner is an ownership-transfer policy decision, not a row wipe;
 *     handled by a separate workspace-offboarding flow.
 */

import { eq, type SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";

import {
  agentSessions,
  emailVerificationTokens,
  mcpServers,
  memoryEntries,
  oauthCredentials,
  orchestrationRuns,
  passwordResetTokens,
  refreshTokens,
  users,
  userProviderCredentials,
  workspaceMembers,
} from "./schema/index.js";

/** One user-scoped table and the column that carries the owning user id. */
export interface UserScopedTable {
  /** Stable name for logs/audit (matches the SQL table name). */
  name: string;
  table: PgTable;
  column: AnyPgColumn;
}

/**
 * Every table (besides `users` itself) holding rows owned by a user, deleted in
 * this order — all are FK children of `users`, so any order among them is safe;
 * `users` is removed last by {@link eraseUserData}.
 */
export const USER_SCOPED_TABLES: UserScopedTable[] = [
  { name: "agent_sessions", table: agentSessions, column: agentSessions.userId },
  { name: "mcp_servers", table: mcpServers, column: mcpServers.userId },
  { name: "memory_entries", table: memoryEntries, column: memoryEntries.userId },
  { name: "oauth_credentials", table: oauthCredentials, column: oauthCredentials.userId },
  { name: "orchestration_runs", table: orchestrationRuns, column: orchestrationRuns.userId },
  {
    name: "user_provider_credentials",
    table: userProviderCredentials,
    column: userProviderCredentials.userId,
  },
  { name: "refresh_tokens", table: refreshTokens, column: refreshTokens.userId },
  { name: "workspace_members", table: workspaceMembers, column: workspaceMembers.userId },
  { name: "password_reset_tokens", table: passwordResetTokens, column: passwordResetTokens.userId },
  {
    name: "email_verification_tokens",
    table: emailVerificationTokens,
    column: emailVerificationTokens.userId,
  },
];

/** Rows removed from one table by the erasure cascade. */
export interface ErasureResult {
  table: string;
  deleted: number;
}

/** Minimal delete surface of a Drizzle db — satisfied by the real client and by test fakes. */
export interface ErasableDb {
  delete(table: PgTable): {
    where(condition: SQL | undefined): Promise<{ rowCount?: number | null }>;
  };
}

/**
 * Erase all data owned by `userId`: every {@link USER_SCOPED_TABLES} entry, then
 * the `users` row. Returns a per-table deleted-row count (best-effort — `0` when
 * the driver does not report `rowCount`) suitable for an audit-log entry.
 * Idempotent: re-running for an already-erased user deletes nothing and reports
 * zeroes.
 */
export async function eraseUserData(db: ErasableDb, userId: string): Promise<ErasureResult[]> {
  const results: ErasureResult[] = [];
  for (const t of USER_SCOPED_TABLES) {
    const res = await db.delete(t.table).where(eq(t.column, userId));
    results.push({ table: t.name, deleted: res.rowCount ?? 0 });
  }
  const res = await db.delete(users).where(eq(users.id, userId));
  results.push({ table: "users", deleted: res.rowCount ?? 0 });
  return results;
}
