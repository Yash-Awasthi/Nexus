// SPDX-License-Identifier: Apache-2.0
/**
 * Token refresh with concurrency dedup. When many in-flight requests share an
 * account whose access token is about to expire, only ONE refresh fires; the
 * rest await the same promise. Prevents the refresh stampede (and the
 * double-rotation that revokes a just-issued token) is worth guarding against.
 */
import type { AuthProvider, OAuthTokens } from "./types.js";

/** Refresh when the token expires within this skew (default 60s). */
const DEFAULT_SKEW_MS = 60_000;

export class TokenRefresher {
  private readonly inFlight = new Map<string, Promise<OAuthTokens>>();

  constructor(private readonly skewMs: number = DEFAULT_SKEW_MS) {}

  /** True when the token is missing an expiry or is within the skew window. */
  isExpiring(tokens: OAuthTokens, nowMs: number): boolean {
    if (tokens.expiresAt === undefined) return false; // unknown expiry → assume valid
    return tokens.expiresAt - nowMs <= this.skewMs;
  }

  /**
   * Return a still-valid token, refreshing first if it is expiring. `accountKey`
   * scopes the dedup — concurrent calls with the same key share one refresh.
   */
  async ensureFresh(
    accountKey: string,
    tokens: OAuthTokens,
    provider: AuthProvider,
    nowMs: number = Date.now(),
  ): Promise<OAuthTokens> {
    if (!this.isExpiring(tokens, nowMs)) return tokens;
    if (!tokens.refreshToken) {
      throw new Error(`TokenRefresher: token for "${accountKey}" is expiring and not refreshable`);
    }

    const existing = this.inFlight.get(accountKey);
    if (existing) return existing;

    const p = provider
      .refresh(tokens)
      .finally(() => {
        this.inFlight.delete(accountKey);
      });
    this.inFlight.set(accountKey, p);
    return p;
  }
}
