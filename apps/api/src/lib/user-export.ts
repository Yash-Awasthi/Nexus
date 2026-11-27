// SPDX-License-Identifier: Apache-2.0
/**
 * Account export and the "what survives deletion" notice (§14.4, M6.2.1).
 *
 * The right to portability and the right to erasure are the same feature seen from two ends: an account must be
 * able to leave with what it put in, and deletion must say what it did *not* remove and why. Both halves live
 * here so the wording can be tested without a database, and the route stays a guard plus a call.
 *
 * Two rules shape the payload:
 *
 *  - **Secrets never leave.** Provider credentials are stored encrypted and are represented by provider name
 *    plus created date, never a key, prefix or hash; session tokens appear as timestamps only; anything in the
 *    key-value stores that looks like a credential is replaced with `[REDACTED]` by key name rather than by
 *    guessing at values.
 *  - **Retained data is named, not implied.** Subscriptions survive under a legal obligation, audit entries
 *    survive because deleting evidence on request is the opposite of an audit log, and backups age out on a
 *    published schedule. Each carries a sentence a support engineer can paste into a reply.
 */

/** One thing deletion leaves behind, with the reason it is allowed to. */
export interface RetainedItem {
  what: string;
  why: string;
}

/**
 * What survives `DELETE /api/v1/users/:id/data`, in the order a person would ask about it.
 *
 * Kept as data rather than prose so the delete response and the documentation cannot drift apart: the route
 * returns this array, and `apps/api/tests/routes/account-export-delete.test.ts` asserts the reasons are present
 * and non-empty.
 */
export const RETAINED_AFTER_DELETION: RetainedItem[] = [
  {
    what: "Audit log entries",
    why: "They are the record that the deletion was asked for and carried out, and an audit trail that a user can erase is not an audit trail. The actor column keeps the account id; no message content is stored in them.",
  },
  {
    what: "Billing records and subscription state",
    why: "Tax and accounting law requires invoices to outlive the account. They hold the billing identity, not the workspace, prompts or memory.",
  },
  {
    what: "Backups taken before the deletion",
    why: "Point-in-time backups age out on the published schedule (see the retention table in docs/OPERATIONS.md); a restore would bring the account back, so a restored environment re-runs the deletion.",
  },
  {
    what: "Aggregate usage counters",
    why: "Model spend is recorded per call without message content. Rows are re-attributed to a deleted-account bucket rather than deleted, so monthly totals stay correct.",
  },
  {
    what: "Server logs",
    why: "Request logs are kept for incident response for the retention window and contain request metadata, not payloads. They are pruned by age, not by account.",
  },
];

/** A key-value record the account owned, with credential-shaped fields removed. */
export interface StoredRecord {
  collection: string;
  id: string;
  data: unknown;
}

/** Everything the account can take with it. */
export interface UserExport {
  generatedAt: string;
  account: { id: string; email: string; displayName?: string | null; createdAt?: string | null };
  sessions: {
    id: string;
    createdAt?: string | null;
    expiresAt?: string | null;
    revoked?: boolean;
  }[];
  providerKeys: { provider: string; createdAt?: string | null }[];
  apiKeys: {
    name?: string | null;
    prefix?: string | null;
    scopes?: unknown;
    createdAt?: string | null;
  }[];
  memories: { id: string; kind?: string | null; content?: unknown; createdAt?: string | null }[];
  verdicts: {
    id: string;
    decision: string;
    confidence: number;
    rationale: string;
    createdAt?: string | null;
  }[];
  auditEntries: {
    sequence: number;
    action: string;
    entityType: string;
    entityId: string;
    at?: string | null;
  }[];
  storedRecords: StoredRecord[];
  retained: RetainedItem[];
}

/**
 * Field names that hold a credential or a hash of one, matched at the end of the name. Camel, snake and kebab
 * spellings all end the same way, so the test is on the suffix rather than on a separator: \`refreshToken\`,
 * \`refresh_token\` and \`refresh-token\` are one rule instead of three.
 */
const SECRET_FIELD =
  /(?:api_?key|key|token|secret|password|passwd|hash|credential|authorization)s?$/i;

/**
 * Replace credential-shaped values in a key-value record.
 *
 * By field name, deliberately: a value-matching scrubber would either miss a new provider's format or mangle
 * ordinary text. The names are listed in one regex so a reviewer can check the list, and the replacement keeps
 * the shape of the object so the export still reads like the record it came from.
 */
export function scrubSecrets(value: unknown, depth = 0): unknown {
  if (depth > 12 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => scrubSecrets(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] =
      SECRET_FIELD.test(key) && typeof item !== "object"
        ? "[REDACTED]"
        : scrubSecrets(item, depth + 1);
  }
  return out;
}

/** A filename a browser will not mangle: no address, no identifier that could collide after deletion. */
export function exportFilename(userId: string, now = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  return `nexus-export-${userId.slice(0, 8)}-${day}.json`;
}

/** The slice of a `pg` pool this module needs; a fake satisfies it in tests. */
export interface ExportPool {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

const rows = async <T>(
  pool: ExportPool | undefined,
  sql: string,
  params: unknown[],
): Promise<T[]> => (pool ? (await pool.query<T>(sql, params)).rows : []);

/**
 * Gather everything the account owns into one document.
 *
 * Queries are written as SQL rather than through Drizzle because the export spans modelled tables and the
 * key-value stores in one pass, and because an export that silently skips a table is worse than one that names
 * it in a list a reviewer can check. Each `SELECT` lists its columns explicitly, so a later schema addition
 * cannot start leaking a new secret column into every export by default.
 */
export async function collectUserExport(
  pool: ExportPool | undefined,
  userId: string,
  now = new Date(),
): Promise<UserExport> {
  const [account] = await rows<{
    id: string;
    email: string;
    name: string | null;
    created_at: string | null;
  }>(pool, `SELECT id, email, name, created_at FROM users WHERE id = $1`, [userId]);

  const sessions = await rows<{
    id: string;
    created_at: string | null;
    expires_at: string | null;
    revoked_at: string | null;
  }>(
    pool,
    `SELECT id, created_at, expires_at, revoked_at FROM refresh_tokens WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );

  const providerKeys = await rows<{ provider: string; created_at: string | null }>(
    pool,
    `SELECT provider, created_at FROM user_provider_credentials
     WHERE user_id = $1 AND deleted_at IS NULL ORDER BY provider`,
    [userId],
  );

  const apiKeys = await rows<{
    name: string;
    key_prefix: string;
    scopes: unknown;
    created_at: string | null;
  }>(
    pool,
    `SELECT name, key_prefix, scopes, created_at FROM api_keys WHERE owner_id = $1 ORDER BY created_at`,
    [userId],
  );

  const memories = await rows<{
    id: string;
    text: string;
    metadata: unknown;
    created_at: number | null;
  }>(
    pool,
    `SELECT id, text, metadata, created_at FROM memory_entries WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );

  const verdicts = await rows<{
    id: string;
    decision: string;
    confidence: number;
    rationale: string;
    created_at: string | null;
  }>(
    pool,
    `SELECT id, decision, confidence, rationale, created_at FROM verdicts WHERE owner_id = $1 ORDER BY created_at`,
    [userId],
  );

  const auditEntries = await rows<{
    sequence: string | number;
    action: string;
    entity_type: string;
    entity_id: string;
    created_at: string | null;
  }>(
    pool,
    `SELECT sequence, action, entity_type, entity_id, created_at FROM audit_log
     WHERE actor = $1 ORDER BY sequence`,
    [userId],
  );

  const storedRecords = await rows<{ collection: string; id: string; data: unknown }>(
    pool,
    `SELECT collection, id, data FROM nexus_kv
     WHERE id = $1 OR starts_with(id, $1 || '::') OR data->>'ownerId' = $1 OR data->>'userId' = $1
     ORDER BY collection, id`,
    [userId],
  );

  return {
    generatedAt: now.toISOString(),
    account: {
      id: userId,
      email: account?.email ?? "",
      displayName: account?.name ?? null,
      createdAt: account?.created_at ?? null,
    },
    // Timestamps only: the token hashes are not the account's data to read back, and they are not useful to it.
    sessions: sessions.map((session) => ({
      id: session.id,
      createdAt: session.created_at,
      expiresAt: session.expires_at,
      revoked: Boolean(session.revoked_at),
    })),
    // Provider name and date, never the prefix or the encrypted material.
    providerKeys: providerKeys.map((key) => ({
      provider: key.provider,
      createdAt: key.created_at,
    })),
    apiKeys: apiKeys.map((key) => ({
      name: key.name,
      prefix: key.key_prefix,
      scopes: key.scopes,
      createdAt: key.created_at,
    })),
    memories: memories.map((memory) => ({
      id: memory.id,
      content: memory.text,
      createdAt: memory.created_at ? new Date(memory.created_at).toISOString() : null,
    })),
    verdicts: verdicts.map((verdict) => ({
      id: verdict.id,
      decision: verdict.decision,
      confidence: verdict.confidence,
      rationale: verdict.rationale,
      createdAt: verdict.created_at,
    })),
    auditEntries: auditEntries.map((entry) => ({
      sequence: Number(entry.sequence),
      action: entry.action,
      entityType: entry.entity_type,
      entityId: entry.entity_id,
      at: entry.created_at,
    })),
    storedRecords: storedRecords.map((record) => ({
      collection: record.collection,
      id: record.id,
      data: scrubSecrets(record.data),
    })),
    retained: RETAINED_AFTER_DELETION,
  };
}
