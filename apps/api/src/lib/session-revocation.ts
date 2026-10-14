// SPDX-License-Identifier: Apache-2.0
// Access-token revocation that survives restarts and reaches every replica, kept in the security
// KV for one token lifetime: after that every token it could reject has expired.

import { db } from "@nexus/db";
import { refreshTokens } from "@nexus/db/schema";
import { and, desc, eq, gt, isNull } from "drizzle-orm";

import { ACCESS_TOKEN_TTL_SEC } from "./issue-access-token.ts";
import { revokeOwnerPats } from "./pat-store.ts";
import { getSecurityKV } from "./shared-kv.ts";

const TTL_MS = (ACCESS_TOKEN_TTL_SEC + 60) * 1000;
/** Other replicas may accept a revoked token for at most this long. */
const MEMO_MS = 5_000;
const memo = new Map<string, { value: number | null; at: number }>();

async function mark(key: string): Promise<void> {
  const now = Date.now();
  memo.set(key, { value: now, at: now });
  await getSecurityKV().set(`auth:revoked:${key}`, now, TTL_MS);
}

async function read(key: string): Promise<number | null> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.value;
  let value: number | null = null;
  try {
    value = (await getSecurityKV().get<number>(`auth:revoked:${key}`)) ?? null;
  } catch {
    // ponytail: fails open when the KV is down; the 15-minute token lifetime stays the bound
    return hit?.value ?? null;
  }
  memo.set(key, { value, at: Date.now() });
  return value;
}

/** Reject every access token `userId` holds that was issued before now. */
export function revokeSubject(userId: string): Promise<void> {
  return mark(`sub:${userId}`);
}

/** Reject the access tokens minted for one session (a refresh-token row id). */
export function revokeSession(sid: string): Promise<void> {
  return mark(`sid:${sid}`);
}

/** `userId`'s sessions that can still refresh, newest first. */
export function liveSessions(userId: string) {
  return db
    .select({
      id: refreshTokens.id,
      userAgent: refreshTokens.userAgent,
      createdAt: refreshTokens.createdAt,
      expiresAt: refreshTokens.expiresAt,
    })
    .from(refreshTokens)
    .where(
      and(
        eq(refreshTokens.userId, userId),
        isNull(refreshTokens.revokedAt),
        gt(refreshTokens.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(refreshTokens.createdAt));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** End one session and its access tokens; false when `sid` is not one of `userId`'s. */
export async function endSession(userId: string, sid: string): Promise<boolean> {
  // A non-UUID would make Postgres throw on the uuid columns instead of matching nothing.
  if (!UUID.test(userId) || !UUID.test(sid)) return false;
  const [owned] = await db
    .select({ id: refreshTokens.id })
    .from(refreshTokens)
    .where(and(eq(refreshTokens.id, sid), eq(refreshTokens.userId, userId)))
    .limit(1);
  if (!owned) return false;
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.id, sid), isNull(refreshTokens.revokedAt)));
  await revokeSession(sid);
  return true;
}

/** End every session `userId` has: refresh tokens and the access tokens already issued. */
export async function endAllSessions(userId: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  await revokeSubject(userId);
}

/**
 * End every way into an account that is being suspended, deleted or claimed: sessions, access
 * tokens and personal access tokens. Signing out everywhere leaves the account's API tokens alone.
 */
export async function endAccountAccess(userId: string): Promise<void> {
  await endAllSessions(userId);
  await revokeOwnerPats(userId);
}

/** Whether a verified access-token payload was revoked after it was issued. */
export async function isRevoked(claims: Record<string, unknown>): Promise<boolean> {
  const issuedMs =
    typeof claims.iatMs === "number"
      ? claims.iatMs
      : typeof claims.iat === "number"
        ? claims.iat * 1000
        : 0;
  if (typeof claims.sub === "string") {
    const cutoff = await read(`sub:${claims.sub}`);
    if (cutoff !== null && issuedMs <= cutoff) return true;
  }
  return typeof claims.sid === "string" && (await read(`sid:${claims.sid}`)) !== null;
}
