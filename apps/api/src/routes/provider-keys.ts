// SPDX-License-Identifier: Apache-2.0
/**
 * BYOK provider credentials OWNER — extracted from api-bridge.ts.
 *
 * Users store their own LLM provider keys. Keys are encrypted at rest with
 * AES-256-GCM via secret-crypto and returned only as a prefix; the raw value is
 * resolved server-side at request time by lib/provider-keys.ts. Metadata-only
 * edits keep the stored key, and rotation soft-deletes the previous row.
 *
 * Mounted inside apiBridgeRoutes (same /api/* scope, same auth hooks).
 */

import { db } from "@nexus/db";
import { userProviderCredentials } from "@nexus/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { emitAuditEvent } from "../lib/audit-emitter.ts";
import { sha256hex } from "../lib/crypto-utils.ts";
import { compatibleEndpointError, invalidateUserDrivers } from "../lib/provider-keys.ts";
import { unsafeUrlReason } from "../lib/public-url.ts";
import { encryptSecret, SecretCryptoUnavailableError } from "../lib/secret-crypto.ts";
import { requireAuthWithTier, requireUserId } from "../middleware/auth.ts";

const VALID_PROVIDERS = [
  "openai",
  "anthropic",
  "groq",
  "gemini",
  "deepseek",
  "mistral",
  "openrouter",
  "xai",
  "together",
  "perplexity",
  "cohere",
  "cerebras",
  "ollama",
  // Service keys for non-chat features: image models, web search, voice.
  "replicate",
  "flux",
  "stability",
  "recraft",
  "fal",
  "tavily",
  "exa",
  "github",
  "elevenlabs",
  "deepgram",
  "cartesia",
  "assemblyai",
  // Composite-credential providers — apiKey carries a JSON blob (parsed in
  // lib/provider-keys.ts). The UI collects the parts in a multi-field form.
  "bedrock",
  "vertex",
  "custom",
] as const;
type ProviderName = (typeof VALID_PROVIDERS)[number];

/** Register /user/provider-keys. */
export async function providerKeysRoutes(app: FastifyInstance): Promise<void> {
  // A key is optional for local/self-hosted providers (e.g. ollama, custom) as
  // long as a baseUrl is given; baseUrl + models are non-secret connection metadata.
  app.post<{
    Body: {
      provider: string;
      apiKey?: string;
      label?: string;
      baseUrl?: string;
      models?: string[];
    };
  }>("/user/provider-keys", { preHandler: requireAuthWithTier }, async (request, reply) => {
    const { provider, apiKey, label, baseUrl, models } = request.body ?? {};
    if (!provider) return reply.code(400).send({ error: "provider is required" });
    // Any other name is an OpenAI-compatible endpoint, used as `<name>/<model>`.
    if (!VALID_PROVIDERS.includes(provider as ProviderName)) {
      const why = baseUrl
        ? compatibleEndpointError(provider, baseUrl, models)
        : "baseUrl is required";
      if (why)
        return reply
          .code(400)
          .send({ error: "invalid_provider", message: why, valid: VALID_PROVIDERS });
    }
    // Every name, built-in ones like ollama included, meets the same address rule.
    const badUrl = baseUrl ? unsafeUrlReason(baseUrl) : null;
    if (badUrl) return reply.code(400).send({ error: "invalid_base_url", message: badUrl });
    if (apiKey && apiKey.length < 8) return reply.code(400).send({ error: "apiKey too short" });

    const userId = await requireUserId(request, reply);
    if (!userId) return;
    // Look up the existing active connection so a metadata-only edit (new label /
    // models / baseUrl, but no re-entered key) keeps the stored key. Keys are
    // write-only in the UI, so an empty apiKey on edit means "keep existing".
    const [existing] = await db
      .select()
      .from(userProviderCredentials)
      .where(
        and(
          eq(userProviderCredentials.userId, userId),
          eq(userProviderCredentials.provider, provider),
          isNull(userProviderCredentials.deletedAt),
        ),
      )
      .limit(1);

    // A brand-new connection needs at least a key or a baseUrl; an edit can rely
    // on the carried-over key/baseUrl from the existing row.
    const effectiveBaseUrl = baseUrl ?? existing?.baseUrl ?? null;
    if (!apiKey && !effectiveBaseUrl && !existing?.encryptedKey)
      return reply.code(400).send({ error: "apiKey or baseUrl is required" });

    let encryptedKey: string | null = existing?.encryptedKey ?? null;
    let keyPrefix: string | null = existing?.keyPrefix ?? null;
    let keyHash: string | null = existing?.keyHash ?? null;
    if (apiKey) {
      try {
        encryptedKey = encryptSecret(apiKey);
      } catch (e) {
        if (e instanceof SecretCryptoUnavailableError)
          return reply.code(503).send({ error: "encryption_unavailable" });
        throw e;
      }
      keyPrefix = apiKey.slice(0, 8);
      keyHash = sha256hex(apiKey);
    }

    // Rotation: soft-delete any existing active connection for this (user, provider).
    await db
      .update(userProviderCredentials)
      .set({ deletedAt: new Date(), active: false })
      .where(
        and(
          eq(userProviderCredentials.userId, userId),
          eq(userProviderCredentials.provider, provider),
          isNull(userProviderCredentials.deletedAt),
        ),
      );

    const [row] = await db
      .insert(userProviderCredentials)
      .values({
        userId,
        provider,
        label: label ?? existing?.label ?? null,
        encryptedKey,
        keyPrefix,
        keyHash,
        baseUrl: effectiveBaseUrl,
        models: models ?? existing?.models ?? null,
      })
      .returning({
        id: userProviderCredentials.id,
        provider: userProviderCredentials.provider,
        keyPrefix: userProviderCredentials.keyPrefix,
        baseUrl: userProviderCredentials.baseUrl,
        models: userProviderCredentials.models,
        createdAt: userProviderCredentials.createdAt,
      });

    // Record a hash-chained audit event (fire-and-forget, never throws).
    if (row) {
      void emitAuditEvent(
        {
          entityType: "provider_credential",
          entityId: row.id,
          action: existing ? "provider_key.rotate" : "provider_key.create",
          actor: userId,
          payload: { provider },
        },
        request.log,
      );
    }

    invalidateUserDrivers(userId);
    return reply.code(201).send(row);
  });

  // List active keys (prefix only, never the raw key).
  app.get("/user/provider-keys", { preHandler: requireAuthWithTier }, async (request, reply) => {
    const userId = await requireUserId(request, reply);
    if (!userId) return;
    const keys = await db
      .select({
        id: userProviderCredentials.id,
        provider: userProviderCredentials.provider,
        label: userProviderCredentials.label,
        keyPrefix: userProviderCredentials.keyPrefix,
        baseUrl: userProviderCredentials.baseUrl,
        models: userProviderCredentials.models,
        createdAt: userProviderCredentials.createdAt,
        lastUsedAt: userProviderCredentials.lastUsedAt,
      })
      .from(userProviderCredentials)
      .where(
        and(eq(userProviderCredentials.userId, userId), isNull(userProviderCredentials.deletedAt)),
      );
    return reply.send({ keys, total: keys.length });
  });

  // Soft-delete, ownership-checked.
  app.delete<{ Params: { id: string } }>(
    "/user/provider-keys/:id",
    { preHandler: requireAuthWithTier },
    async (request, reply) => {
      const userId = await requireUserId(request, reply);
      if (!userId) return;
      const [row] = await db
        .select({
          id: userProviderCredentials.id,
          userId: userProviderCredentials.userId,
        })
        .from(userProviderCredentials)
        .where(
          and(
            eq(userProviderCredentials.id, request.params.id),
            isNull(userProviderCredentials.deletedAt),
          ),
        )
        .limit(1);
      if (!row) return reply.code(404).send({ error: "not_found" });
      if (row.userId !== userId) return reply.code(403).send({ error: "forbidden" });
      await db
        .update(userProviderCredentials)
        .set({ deletedAt: new Date(), active: false })
        .where(eq(userProviderCredentials.id, request.params.id));
      invalidateUserDrivers(userId);
      return reply.send({ ok: true });
    },
  );

  // The former GET /user/provider-keys/resolve/:provider endpoint was
  // intentionally removed — decrypted keys must never be returned over HTTP.
  // Server-side callers use resolveUserProviderKey() instead.
}
