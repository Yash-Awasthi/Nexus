// SPDX-License-Identifier: Apache-2.0
/**
 * Personal-access-token (PAT) store OWNER.
 *
 * Defect history (playtest round 4): the /tokens surface minted `nxk_` tokens
 * that nothing verified — pure fiction. This module owns real PAT state:
 *   - SHA-256 hash of the raw token (raw is returned exactly once, at creation)
 *   - per-owner scoping (nexusUserId) so users only ever see their own tokens
 *   - optional expiry (expiresInDays; 0/undefined = no expiry) and revocation
 *   - lastUsedAt so users can rotate unused tokens
 *
 * Verification consumer: apps/api/src/middleware/auth.ts (requireAuth and
 * requireAuthWithTier consult verifyPat for `nxk_`-prefixed Bearer tokens).
 */

import crypto from "node:crypto";

import { sha256hex } from "./crypto-utils.js";

export interface PersonalAccessToken {
  id: string;
  /** nexusUserId of the creator — tokens are private to their owner. */
  ownerId: string;
  name: string;
  /** First 10 chars of the raw token, for display only. */
  prefix: string;
  /** SHA-256 hex of the raw token. */
  hash: string;
  /** Scope list; ["*"] = full tier access. */
  scopes: string[];
  tier: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

const _pats = new Map<string, PersonalAccessToken>();

export function createPat(input: {
  ownerId: string;
  name: string;
  tier?: string;
  scopes?: string[];
  expiresInDays?: number;
}): { entry: PersonalAccessToken; raw: string } {
  const raw = `nxk_${crypto.randomBytes(24).toString("hex")}`;
  const days = input.expiresInDays ?? 0;
  const entry: PersonalAccessToken = {
    id: crypto.randomUUID(),
    ownerId: input.ownerId,
    name: input.name,
    prefix: raw.slice(0, 10),
    hash: sha256hex(raw),
    scopes: input.scopes && input.scopes.length > 0 ? input.scopes : ["*"],
    tier: input.tier ?? "basic",
    createdAt: new Date().toISOString(),
    // 0 or undefined = no expiry (a 0-day expiry would be instantly useless).
    expiresAt: days > 0 ? new Date(Date.now() + days * 86_400_000).toISOString() : null,
    revokedAt: null,
    lastUsedAt: null,
  };
  _pats.set(entry.id, entry);
  return { entry, raw };
}

/** Verify a raw `nxk_` token; stamps lastUsedAt on success. */
export function verifyPat(raw: string): PersonalAccessToken | null {
  const hash = sha256hex(raw);
  for (const t of _pats.values()) {
    if (t.hash !== hash) continue;
    if (t.revokedAt) return null;
    if (t.expiresAt && new Date(t.expiresAt).getTime() < Date.now()) return null;
    t.lastUsedAt = new Date().toISOString();
    return t;
  }
  return null;
}

/** List only the owner's tokens, newest first. */
export function listPats(ownerId: string): PersonalAccessToken[] {
  return Array.from(_pats.values())
    .filter((t) => t.ownerId === ownerId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Revoke by id; returns false when the token doesn't exist or isn't the caller's.
 * Hard-deletes: the token vanishes from the listing immediately (the pinned
 * /tokens contract, tests/routes/tokens.test.ts) and verifyPat can no longer
 * find it, so in-flight calls fail instantly.
 */
export function revokePat(id: string, ownerId: string): boolean {
  const t = _pats.get(id);
  if (!t || t.ownerId !== ownerId) return false;
  _pats.delete(id);
  return true;
}
