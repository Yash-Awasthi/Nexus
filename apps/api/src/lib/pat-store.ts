// SPDX-License-Identifier: Apache-2.0
/**
 * Personal-access-token (PAT) store OWNER.
 *
 * Defect history:
 *   - Playtest round 4: the /tokens surface minted `nxk_` tokens that nothing
 *     verified — pure fiction. This module became the owner of real PAT state.
 *   - Playtest round 5: the store was in-memory only, so every server restart
 *     silently invalidated all tokens. Now DB-backed: the `api_keys` table
 *     (packages/db, migration 0015) is the SOURCE OF TRUTH; the in-process
 *     map is a write-through cache hydrated at startup by initPatStore() and
 *     rebuilt on every restart, so it can never leak stale state across one.
 *
 * Properties:
 *   - SHA-256 hash of the raw token (raw is returned exactly once, at creation)
 *   - per-owner scoping (nexusUserId) so users only ever see their own tokens
 *   - optional expiry (expiresInDays; 0/undefined = no expiry) and revocation
 *     (hard delete — the pinned /tokens contract)
 *   - lastUsedAt so users can rotate unused tokens
 *   - PAT rows are discriminated from BYOK rows (packages/billing) by the
 *     `nxk_` key_prefix; BYOK keys never appear in PAT listings or lookups.
 *
 * Degradation: when the DB is unreachable (or absent, e.g. hermetic tests),
 * the store latches to in-memory mode after one failed probe — tokens minted
 * in that mode live only for the process, exactly like the round-4 behavior.
 *
 * Verification consumer: apps/api/src/middleware/auth.ts (requireAuth and
 * requireAuthWithTier consult verifyPat for `nxk_`-prefixed Bearer tokens).
 */

import crypto from "node:crypto";

import { db as defaultDb } from "@nexus/db";
import { apiKeys, type ApiKey } from "@nexus/db/schema";
import { and, eq, like, isNull } from "drizzle-orm";

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

/** Write-through cache — hydrated from api_keys at startup, kept in sync on every mutation. */
const _pats = new Map<string, PersonalAccessToken>();

/** DB availability latch: null = not probed, "db" = usable, "mem" = stay in-memory. */
let _dbMode: "db" | "mem" | null = null;

/** Any API-key row whose prefix starts with this belongs to this store (not BYOK). */
const PAT_PREFIX = "nxk_";

function _dbUsable(): boolean {
  if (_dbMode === "mem") return false;
  return _dbMode === "db";
}

/** Row → in-memory entry (timestamptz Date → ISO string). */
function _fromRow(row: ApiKey): PersonalAccessToken {
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    prefix: row.keyPrefix,
    hash: row.keyHash,
    scopes: row.scopes ?? ["*"],
    tier: row.tier,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  };
}

/**
 * Probe the DB once per process. A failed probe latches in-memory mode so a
 * down DB can never slow every request — and hermetic test runs (fake
 * DATABASE_URL) fall back deterministically after one fast failure.
 */
async function _probeDb(): Promise<boolean> {
  if (_dbMode !== null) return _dbUsable();
  // Hermetic unit tests: skip the probe entirely (setup.ts sets a fake
  // DATABASE_URL; a real probe would hit the network). Persistence tests
  // stub this away and mock @nexus/db instead.
  if (process.env.VITEST === "true") {
    _dbMode = "mem";
    return false;
  }
  if (!process.env.DATABASE_URL) {
    _dbMode = "mem";
    return false;
  }
  try {
    await Promise.race([
      defaultDb.select().from(apiKeys).limit(0),
      new Promise((_, reject) => setTimeout(() => reject(new Error("probe timeout")), 2000)),
    ]);
    _dbMode = "db";
    return true;
  } catch {
    _dbMode = "mem";
    return false;
  }
}

/** Stamp lastUsedAt in the cache and (best-effort) in the DB. */
async function _stampUsed(entry: PersonalAccessToken): Promise<void> {
  const now = new Date().toISOString();
  entry.lastUsedAt = now;
  if (!_dbUsable()) return;
  try {
    await defaultDb
      .update(apiKeys)
      .set({ lastUsedAt: new Date(now) })
      .where(eq(apiKeys.keyHash, entry.hash));
  } catch {
    _dbMode = "mem";
  }
}

/**
 * Hydrate the cache from api_keys (source of truth). Called at server startup;
 * idempotent, so restarting the process rebuilds the exact same set — a token
 * minted before a restart keeps working, and a revoke performed before it
 * stays revoked.
 */
export async function initPatStore(): Promise<void> {
  if (_dbMode === "mem" || !process.env.DATABASE_URL) return;
  if (_dbMode !== "db" && !(await _probeDb())) return;
  try {
    const rows = await defaultDb
      .select()
      .from(apiKeys)
      .where(and(like(apiKeys.keyPrefix, `${PAT_PREFIX}%`), isNull(apiKeys.revokedAt)));
    for (const row of rows) _pats.set(row.id, _fromRow(row));
  } catch {
    _dbMode = "mem";
  }
}

/** Create a PAT. Persists to api_keys when the DB is usable, always caches. */
export async function createPat(input: {
  ownerId: string;
  name: string;
  tier?: string;
  scopes?: string[];
  expiresInDays?: number;
}): Promise<{ entry: PersonalAccessToken; raw: string }> {
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
  if (await _probeDb()) {
    try {
      await defaultDb.insert(apiKeys).values({
        // Persist the entry's own id: the table default (gen_random_uuid)
        // would give the row a DIFFERENT id than the one returned to the
        // caller, so after a restart revoke-by-id would 404 (caught live in
        // the round-5 restart verification).
        id: entry.id,
        keyHash: entry.hash,
        keyPrefix: entry.prefix,
        name: entry.name,
        ownerId: entry.ownerId,
        plan: entry.tier === "pro" ? "pro" : entry.tier === "enterprise" ? "enterprise" : "free",
        expiresAt: entry.expiresAt ? new Date(entry.expiresAt) : null,
        lastUsedAt: null,
        scopes: entry.scopes,
        tier: entry.tier,
      });
    } catch {
      _dbMode = "mem"; // DB down — token lives in the cache for this process only
    }
  }
  _pats.set(entry.id, entry);
  return { entry, raw };
}

/** Verify a raw `nxk_` token; stamps lastUsedAt on success. */
export async function verifyPat(raw: string): Promise<PersonalAccessToken | null> {
  const hash = sha256hex(raw);
  for (const t of _pats.values()) {
    if (t.hash !== hash) continue;
    if (t.revokedAt) return null;
    if (t.expiresAt && new Date(t.expiresAt).getTime() < Date.now()) return null;
    await _stampUsed(t);
    return t;
  }
  // Cache miss — could be a token minted by another process. Consult the DB.
  if (await _probeDb()) {
    try {
      const [row] = await defaultDb
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.keyHash, hash), like(apiKeys.keyPrefix, `${PAT_PREFIX}%`)))
        .limit(1);
      if (row && !row.revokedAt && (!row.expiresAt || row.expiresAt.getTime() > Date.now())) {
        const entry = _fromRow(row);
        _pats.set(entry.id, entry);
        await _stampUsed(entry);
        return entry;
      }
    } catch {
      _dbMode = "mem";
    }
  }
  return null;
}

/** List only the owner's tokens, newest first (cache merged with the DB). */
export async function listPats(ownerId: string): Promise<PersonalAccessToken[]> {
  const merged = new Map(_pats);
  if (await _probeDb()) {
    try {
      const rows = await defaultDb
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.ownerId, ownerId), like(apiKeys.keyPrefix, `${PAT_PREFIX}%`)));
      for (const row of rows) merged.set(row.id, _fromRow(row));
    } catch {
      _dbMode = "mem";
    }
  }
  return Array.from(merged.values())
    .filter((t) => t.ownerId === ownerId && !t.revokedAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Revoke by id; returns false when the token doesn't exist or isn't the caller's.
 * Hard-deletes from api_keys AND the cache: the token vanishes from the
 * listing immediately (the pinned /tokens contract, tests/routes/tokens.test.ts)
 * and verifyPat can no longer find it, so in-flight calls fail instantly.
 */
export async function revokePat(id: string, ownerId: string): Promise<boolean> {
  const t = _pats.get(id);
  if (!t || t.ownerId !== ownerId) return false;
  if (_dbUsable()) {
    try {
      await defaultDb
        .delete(apiKeys)
        .where(and(eq(apiKeys.id, id), eq(apiKeys.ownerId, ownerId)));
    } catch {
      _dbMode = "mem"; // DB down — cache delete still applies for this process
    }
  }
  _pats.delete(id);
  return true;
}