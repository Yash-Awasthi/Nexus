// SPDX-License-Identifier: Apache-2.0
/**
 * API key management.
 *
 * Raw keys are never stored — only a SHA-256 hex hash.
 * The key format is:  nxk_<32 random hex chars>
 */

import { createHash, randomBytes } from "node:crypto";

import { db } from "@nexus/db";
import type { ApiKey, NewApiKey } from "@nexus/db/schema";
import { apiKeys } from "@nexus/db/schema";
import { eq } from "drizzle-orm";

// ── Crypto helpers ────────────────────────────────────────────────────────────

export function generateRawKey(): string {
  return `nxk_${randomBytes(16).toString("hex")}`;
}

export function hashKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

export function prefixOf(rawKey: string): string {
  return rawKey.slice(0, 8);
}

// ── Create ────────────────────────────────────────────────────────────────────

export interface CreateApiKeyInput {
  name: string;
  ownerId: string;
  plan?: "free" | "pro" | "enterprise";
  monthlyQuota?: number;
  rpmLimit?: number;
}

export interface CreateApiKeyResult {
  /** The raw key — shown ONCE. Store it immediately; it cannot be recovered. */
  rawKey: string;
  apiKey: ApiKey;
}

export async function createApiKey(input: CreateApiKeyInput): Promise<CreateApiKeyResult> {
  const rawKey = generateRawKey();

  const [apiKey] = await db
    .insert(apiKeys)
    .values({
      keyHash: hashKey(rawKey),
      keyPrefix: prefixOf(rawKey),
      name: input.name,
      ownerId: input.ownerId,
      plan: input.plan ?? "free",
      monthlyQuota: input.monthlyQuota ?? null,
      rpmLimit: input.rpmLimit ?? null,
    } satisfies Omit<NewApiKey, "id" | "createdAt" | "revokedAt">)
    .returning();

  if (!apiKey) throw new Error("Failed to create API key");

  return { rawKey, apiKey };
}

// ── Lookup ────────────────────────────────────────────────────────────────────

/**
 * Look up an API key by its raw value.
 * Returns undefined if the key does not exist or is revoked.
 */
export async function lookupApiKey(rawKey: string): Promise<ApiKey | undefined> {
  const hash = hashKey(rawKey);
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, hash)).limit(1);
  if (!row) return undefined;
  if (row.revokedAt !== null) return undefined;
  return row;
}

// ── Revoke ────────────────────────────────────────────────────────────────────

export async function revokeApiKey(id: string): Promise<void> {
  await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, id));
}

// ── List ──────────────────────────────────────────────────────────────────────

export async function listApiKeys(ownerId: string): Promise<ApiKey[]> {
  return db.select().from(apiKeys).where(eq(apiKeys.ownerId, ownerId));
}
