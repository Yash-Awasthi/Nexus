// SPDX-License-Identifier: Apache-2.0
/**
 * Shared access-token issuance (§14.1) — the single place that mints user JWTs.
 *
 * Every issuer (auth-users register/login/refresh, OAuth SSO, OIDC SSO, SAML SSO)
 * goes through {@link issueAccessToken} so the configured algorithm is honored
 * consistently and a token signed by one route is always verifiable by
 * `requireAuth` / `requireAuthWithTier`:
 *
 *   NEXUS_JWT_ALG=RS256 → signed with NEXUS_JWT_PRIVATE_KEY (asymmetric; a
 *                         downstream service verifies with the public key,
 *                         alg-pinned — no shared secret crosses trust
 *                         boundaries). Missing key → hard error at issuance.
 *   NEXUS_JWT_ALG=HS256 (default) → signed with the NEXUS_JWT_SECRET shared
 *                         secret, as before.
 *
 * The platform role → NexusRole mapping lives here too, so SSO routes can no
 * longer smuggle a non-NexusRole value ("member") into the token payload.
 */
import { signJwt, signJwtRS256, type NexusRole } from "@nexus/auth";

/** Env-overridable so dev/playtest can prove refresh with a short TTL. */
export const ACCESS_TOKEN_TTL_SEC = parseInt(
  process.env.ACCESS_TOKEN_TTL_SEC ?? String(15 * 60),
  10,
);

/** Result of {@link issueAccessToken}. */
export interface IssuedAccessToken {
  accessToken: string;
  /** Seconds until `accessToken` expires — mirrors the `exp` claim. */
  expiresIn: number;
}

/**
 * Map a platform role (users.role: owner|admin|member|viewer) to a NexusRole
 * (admin|agent|read-only) understood by @nexus/auth's role hierarchy. Without
 * this, tokens carry a role outside ROLE_RANK and fail authenticate().
 */
export function toNexusRole(role: string): NexusRole {
  switch (role) {
    case "owner":
    case "admin":
      return "admin";
    case "member":
      return "agent";
    default:
      return "read-only"; // viewer / unknown
  }
}

/**
 * Issue a user access token honoring NEXUS_JWT_ALG (RS256 vs HS256).
 *
 * @param userId     token `sub`
 * @param role       platform role — mapped via {@link toNexusRole}
 * @param tier       optional tier claim (auth-users passes it; SAML omits it)
 * @param jwtSecret  HS256 signing secret (required for the HS256 path; the
 *                   RS256 path uses NEXUS_JWT_PRIVATE_KEY instead)
 */
export function issueAccessToken(
  userId: string,
  role: string,
  tier?: string,
  jwtSecret?: string,
): IssuedAccessToken {
  const payload = {
    sub: userId,
    role: toNexusRole(role),
    ...(tier !== undefined ? { tier } : {}),
    exp: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SEC,
  } as Parameters<typeof signJwt>[0];

  if (process.env.NEXUS_JWT_ALG === "RS256") {
    const privateKey = process.env.NEXUS_JWT_PRIVATE_KEY;
    if (!privateKey) throw new Error("NEXUS_JWT_PRIVATE_KEY is not set (NEXUS_JWT_ALG=RS256)");
    return { accessToken: signJwtRS256(payload, privateKey), expiresIn: ACCESS_TOKEN_TTL_SEC };
  }

  const secret = jwtSecret ?? process.env.NEXUS_JWT_SECRET;
  if (!secret) throw new Error("NEXUS_JWT_SECRET is not set");
  return { accessToken: signJwt(payload, secret), expiresIn: ACCESS_TOKEN_TTL_SEC };
}
