// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/db — GDPR "right to erasure" (Art. 17) cascade (§14.4).
 *
 * {@link eraseUserData} deletes every row a user owns across the user-scoped
 * tables, children first and the `users` row last so foreign keys never block
 * the cascade. The tables are declared once in {@link USER_SCOPED_TABLES} and
 * {@link UNMODELLED_TABLES} — auditable lists a compliance reviewer can read —
 * and a test against the migrated schema fails on any owner column that
 * {@link ERASURE_COVERAGE} does not account for.
 *
 * The db handle is a narrow structural interface ({@link ErasableDb}), so the
 * cascade is unit-testable against a fake recorder with no live database.
 *
 * Workspaces the user owns pass to the senior remaining member (owner, admin,
 * member, viewer, then earliest joined) or are deleted when nobody else is in
 * them; invitations they sent are re-attributed to the workspace's owner.
 *
 * Deliberate exclusion: subscriptions are retained under the "legal
 * obligation" lawful basis and erased on a separate retention schedule.
 */

import { eq, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";

import {
  agentSessions,
  apiKeys,
  approvalRequests,
  emailVerificationTokens,
  ingestedEvents,
  mcpServers,
  memoryEntries,
  oauthCredentials,
  orchestrationRuns,
  passwordResetTokens,
  refreshTokens,
  runtimeTasks,
  signals,
  users,
  userProviderCredentials,
  verdicts,
  workspaceMembers,
} from "./schema/index.ts";

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
  { name: "api_keys", table: apiKeys, column: apiKeys.ownerId },
  { name: "approval_requests", table: approvalRequests, column: approvalRequests.ownerId },
  { name: "runtime_tasks", table: runtimeTasks, column: runtimeTasks.ownerId },
  { name: "verdicts", table: verdicts, column: verdicts.ownerId },
  { name: "signals", table: signals, column: signals.ownerId },
  { name: "ingested_events", table: ingestedEvents, column: ingestedEvents.ownerId },
];

/** Tables created by migration that Drizzle does not model: [table, owning column]. */
export const UNMODELLED_TABLES = [
  ["kg_edges", "owner"],
  ["kg_nodes", "owner"],
  ["prompts", "user_id"],
  ["build_tasks", "user_id"],
] as const;

/** Every `table.column` naming an account, each erased or handled on purpose. */
export const ERASURE_COVERAGE = new Set([
  ...USER_SCOPED_TABLES.map((t) => `${t.name}.${(t.column as unknown as { name: string }).name}`),
  ...UNMODELLED_TABLES.map(([t, c]) => `${t}.${c}`),
  "workspaces.owner_id",
  "workspace_invitations.invited_by_user_id",
  "subscriptions.owner_id",
  // Removed by ON DELETE CASCADE with the users row.
  "passkeys.user_id",
]);

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
  execute(query: SQL): Promise<unknown>;
}

/** Statements that release the user's workspaces, run before any row is deleted. */
const workspaceHandoff = (userId: string): SQL[] => [
  sql`UPDATE workspaces w SET owner_id = heir.user_id
      FROM (SELECT DISTINCT ON (m.workspace_id) m.workspace_id, m.user_id
            FROM workspace_members m JOIN workspaces o ON o.id = m.workspace_id
            WHERE o.owner_id = ${userId} AND m.user_id <> ${userId}
            ORDER BY m.workspace_id,
              CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END,
              m.created_at) heir
      WHERE w.id = heir.workspace_id`,
  sql`UPDATE workspace_members m SET role = 'owner'
      FROM workspaces w
      WHERE m.workspace_id = w.id AND m.user_id = w.owner_id AND m.role <> 'owner'
        AND EXISTS (SELECT 1 FROM workspace_members x
                    WHERE x.workspace_id = w.id AND x.user_id = ${userId})`,
  sql`DELETE FROM workspaces WHERE owner_id = ${userId}`,
  sql`UPDATE workspace_invitations i SET invited_by_user_id = w.owner_id
      FROM workspaces w
      WHERE i.workspace_id = w.id AND i.invited_by_user_id = ${userId}`,
];

/**
 * Erase all data owned by `userId`: every {@link USER_SCOPED_TABLES} entry, then
 * the `users` row. Returns a per-table deleted-row count (best-effort — `0` when
 * the driver does not report `rowCount`) suitable for an audit-log entry.
 * Idempotent: re-running for an already-erased user deletes nothing and reports
 * zeroes.
 */
export async function eraseUserData(db: ErasableDb, userId: string): Promise<ErasureResult[]> {
  for (const statement of workspaceHandoff(userId)) await db.execute(statement);
  const results: ErasureResult[] = [];
  for (const [table, column] of UNMODELLED_TABLES) {
    try {
      const res = (await db.execute(
        sql`DELETE FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)} = ${userId}`,
      )) as { rowCount?: number | null } | undefined;
      results.push({ table, deleted: res?.rowCount ?? 0 });
    } catch (err) {
      // The graph tables appear on first use, so a fresh database may not have them yet.
      const code = (err as { code?: string; cause?: { code?: string } }).cause?.code;
      if ((err as { code?: string }).code !== "42P01" && code !== "42P01") throw err;
      results.push({ table, deleted: 0 });
    }
  }
  for (const t of USER_SCOPED_TABLES) {
    const res = await db.delete(t.table).where(eq(t.column, userId));
    results.push({ table: t.name, deleted: res.rowCount ?? 0 });
  }
  const res = await db.delete(users).where(eq(users.id, userId));
  results.push({ table: "users", deleted: res.rowCount ?? 0 });
  return results;
}
