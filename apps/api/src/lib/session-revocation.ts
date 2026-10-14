// SPDX-License-Identifier: Apache-2.0
// Access-token revocation that survives restarts and reaches every replica, kept in the
// shared KV for one token lifetime: after that every token it could reject has expired.

import { db } from "@nexus/db";
import { refreshTokens } from "@nexus/db/schema";
import { and, eq, isNull } from "drizzle-orm";

import { ACCESS_TOKEN_TTL_SEC } from "./issue-access-token.ts";
import { getSharedKV } from "./shared-kv.ts";

const TTL_MS = (ACCESS_TOKEN_TTL_SEC + 60) * 1000;
/** Other replicas may accept a revoked token for at most this long. */
const MEMO_MS = 5_000;
const memo = new Map<string, { value: number | null; at: number }>();

async function mark(key: string): Promise<void> {
  const now = Date.now();
  memo.set(key, { value: now, at: now });
  await getSharedKV().set(`auth:revoked:${key}`, now, TTL_MS);
}

async function read(key: string): Promise<number | null> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.value;
  let value: number | null = null;
  try {
    value = (await getSharedKV().get<number>(`auth:revoked:${key}`)) ?? null;
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

/** End every session `userId` has: refresh tokens and the access tokens already issued. */
export async function endAllSessions(userId: string): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
  await revokeSubject(userId);
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
