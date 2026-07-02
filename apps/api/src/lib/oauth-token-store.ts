// SPDX-License-Identifier: Apache-2.0
/**
 * Drizzle-backed `SealedTokenStore` + the app's `OAuthTokenStore` factory.
 *
 * Binds the `@nexus/llm-oauth` port to the `oauth_credentials` table. The port
 * speaks epoch-ms (`number | null`) for `expiresAt`; the column is `timestamptz`
 * — converted both ways here. `providerId`↔`provider` and `sealed`↔`sealedTokens`
 * are the other name shims.
 *
 * The factory wires the vault from a DEDICATED key (`NEXUS_OAUTH_VAULT_KEY`, per
 * SECURITY.md §3 — never `NEXUS_SECRETS_KEY`) and returns `null` when that key is
 * unset/invalid, so routes can degrade to 503 exactly like the BYOK path rather
 * than crash.
 */
import { and, eq } from "drizzle-orm";
import { db as defaultDb, type NexusDB } from "@nexus/db";
import { oauthCredentials } from "@nexus/db/schema";
import {
  AesGcmVault,
  OAuthTokenStore,
  type SealedRecord,
  type SealedTokenStore,
} from "@nexus/llm-oauth";

/** `timestamptz` Date → the port's epoch-ms mirror. */
export const dateToMs = (d: Date | null | undefined): number | null => (d ? d.getTime() : null);

/** The port's epoch-ms mirror → a `timestamptz` Date. */
export const msToDate = (ms: number | null | undefined): Date | null =>
  ms === null || ms === undefined ? null : new Date(ms);

/** Concrete drizzle binding of the port. `database` is injectable for unit tests. */
export class DrizzleSealedTokenStore implements SealedTokenStore {
  constructor(private readonly database: NexusDB = defaultDb) {}

  async upsert(rec: SealedRecord): Promise<void> {
    const expiresAt = msToDate(rec.expiresAt);
    await this.database
      .insert(oauthCredentials)
      .values({
        userId: rec.userId,
        provider: rec.providerId,
        sealedTokens: rec.sealed,
        scope: rec.scope,
        expiresAt,
        lastRefreshedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [oauthCredentials.userId, oauthCredentials.provider],
        set: { sealedTokens: rec.sealed, scope: rec.scope, expiresAt, lastRefreshedAt: new Date() },
      });
  }

  async get(userId: string, providerId: string): Promise<SealedRecord | null> {
    const [row] = await this.database
      .select()
      .from(oauthCredentials)
      .where(and(eq(oauthCredentials.userId, userId), eq(oauthCredentials.provider, providerId)))
      .limit(1);
    if (!row) return null;
    return {
      userId: row.userId,
      providerId: row.provider,
      sealed: row.sealedTokens,
      expiresAt: dateToMs(row.expiresAt),
      scope: row.scope,
    };
  }

  async delete(userId: string, providerId: string): Promise<boolean> {
    const rows = await this.database
      .delete(oauthCredentials)
      .where(and(eq(oauthCredentials.userId, userId), eq(oauthCredentials.provider, providerId)))
      .returning({ id: oauthCredentials.id });
    return rows.length > 0;
  }
}

/**
 * Build the app's `OAuthTokenStore`, or `null` when the dedicated vault key is
 * unset/invalid. A `null` return is the signal for routes to answer 503
 * ("vault unavailable"), mirroring the BYOK degrade path.
 */
export function createOAuthTokenStore(
  env: NodeJS.ProcessEnv = process.env,
  database: NexusDB = defaultDb,
): OAuthTokenStore | null {
  const vault = AesGcmVault.fromEnv("NEXUS_OAUTH_VAULT_KEY", env);
  if (!vault) return null;
  return new OAuthTokenStore(vault, new DrizzleSealedTokenStore(database));
}
