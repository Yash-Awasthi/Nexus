// SPDX-License-Identifier: Apache-2.0
/**
 * Persistence + revoke for OAuth credentials.
 *
 * `OAuthTokenStore` seals the token bundle with a {@link Vault}, hands the opaque
 * blob to an injected {@link SealedTokenStore} (the DB adapter), and loads /
 * refreshes / revokes through the same port. Keeping the store a port — like
 * {@link Vault} and `TokenHttp` — leaves this package DB-agnostic: the concrete
 * adapter binds `SealedTokenStore` to the `oauth_credentials` table at the app
 * layer (see packages/db `oauthCredentials`).
 *
 * Security posture (see SECURITY.md): only the sealed blob holds the refresh
 * token; `revoke()` HARD-DELETES the row (a soft-deleted sealed token is still a
 * live grant) and the local delete is authoritative — a failed upstream revoke
 * never leaves a live credential behind.
 */
import { TokenRefresher } from "./refresh.js";
import type { AuthProvider, OAuthTokens, Vault } from "./types.js";

/** A persisted, encrypted credential. `sealed` = Vault.seal(JSON(OAuthTokens)). */
export interface SealedRecord {
  userId: string;
  providerId: string;
  sealed: string;
  /** Non-secret access-token expiry mirror (epoch ms), or null when unknown. */
  expiresAt: number | null;
  /** Non-secret granted scope. */
  scope: string | null;
}

/**
 * DB port. The app binds this to the `oauth_credentials` drizzle table. `upsert`
 * is create-or-rotate keyed on (userId, providerId); `delete` HARD-removes the row
 * and returns whether one existed.
 */
export interface SealedTokenStore {
  upsert(rec: SealedRecord): Promise<void>;
  get(userId: string, providerId: string): Promise<SealedRecord | null>;
  delete(userId: string, providerId: string): Promise<boolean>;
}

export interface OAuthTokenStoreOptions {
  /** Shared refresher for load-time freshness; defaults to a fresh one. */
  refresher?: TokenRefresher;
  /** Injectable clock (epoch ms) for deterministic tests. */
  now?: () => number;
}

export class OAuthTokenStore {
  private readonly refresher: TokenRefresher;
  private readonly now: () => number;

  constructor(
    private readonly vault: Vault,
    private readonly store: SealedTokenStore,
    opts: OAuthTokenStoreOptions = {},
  ) {
    this.refresher = opts.refresher ?? new TokenRefresher();
    this.now = opts.now ?? Date.now;
  }

  /** Seal + persist a token bundle (create or rotate). */
  async save(userId: string, providerId: string, tokens: OAuthTokens): Promise<void> {
    const sealed = this.vault.seal(JSON.stringify(tokens));
    await this.store.upsert({
      userId,
      providerId,
      sealed,
      expiresAt: tokens.expiresAt ?? null,
      scope: tokens.scope ?? null,
    });
  }

  /** Load and decrypt the stored tokens, or null when nothing is persisted. */
  async load(userId: string, providerId: string): Promise<OAuthTokens | null> {
    const rec = await this.store.get(userId, providerId);
    if (!rec) return null;
    return JSON.parse(this.vault.open(rec.sealed)) as OAuthTokens;
  }

  /**
   * Load a guaranteed-fresh token for `provider`, refreshing + re-persisting when
   * the stored access token is within the refresher's skew window. Returns null
   * when nothing is stored. The refresh is deduped per (user, provider) so
   * concurrent resolves share one upstream refresh.
   */
  async resolveFresh(userId: string, provider: AuthProvider): Promise<OAuthTokens | null> {
    const stored = await this.load(userId, provider.id);
    if (!stored) return null;
    const fresh = await this.refresher.ensureFresh(
      `${userId}:${provider.id}`,
      stored,
      provider,
      this.now(),
    );
    if (fresh !== stored) await this.save(userId, provider.id, fresh);
    return fresh;
  }

  /**
   * Revoke a credential: best-effort upstream revoke (if `revokeUpstream` is
   * given), then HARD-DELETE the local row. The local delete is authoritative —
   * an upstream failure is swallowed so a live sealed token is never left behind.
   * Returns true when a row was deleted.
   */
  async revoke(
    userId: string,
    providerId: string,
    revokeUpstream?: (tokens: OAuthTokens) => Promise<void>,
  ): Promise<boolean> {
    if (revokeUpstream) {
      const stored = await this.load(userId, providerId).catch(() => null);
      if (stored) {
        try {
          await revokeUpstream(stored);
        } catch {
          /* best-effort — the authoritative local delete below still runs */
        }
      }
    }
    return this.store.delete(userId, providerId);
  }
}
