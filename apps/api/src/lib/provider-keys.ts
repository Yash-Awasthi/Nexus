// SPDX-License-Identifier: Apache-2.0
/**
 * Per-user BYOK provider-key resolution (server-side only).
 *
 * Keys live encrypted in user_provider_credentials; this module decrypts them at
 * request time and builds a per-request DriverRegistry containing ONLY the
 * providers the user has configured. Strict policy: there is no env-var
 * fallback — a user with no stored key for a provider cannot use it.
 */
import { db } from "@nexus/db";
import { userProviderCredentials } from "@nexus/db/schema";
import {
  DriverRegistry,
  AnthropicDriver,
  GroqDriver,
  GeminiDriver,
  DeepSeekDriver,
  MistralDriver,
  OpenRouterDriver,
  XaiDriver,
  TogetherDriver,
  PerplexityDriver,
  CohereDriver,
  CerebrasDriver,
  type LlmDriver,
} from "@nexus/llm-drivers";
import { and, eq, isNull } from "drizzle-orm";

import { decryptSecret } from "./secret-crypto.js";

/** Providers we can construct an LLM driver for (openai keys are used directly by REST endpoints). */
const DRIVER_FACTORIES: Record<string, (apiKey: string) => LlmDriver> = {
  anthropic: (apiKey) => new AnthropicDriver({ apiKey }),
  groq: (apiKey) => new GroqDriver({ apiKey }),
  gemini: (apiKey) => new GeminiDriver({ apiKey }),
  deepseek: (apiKey) => new DeepSeekDriver({ apiKey }),
  mistral: (apiKey) => new MistralDriver({ apiKey }),
  openrouter: (apiKey) => new OpenRouterDriver({ apiKey }),
  xai: (apiKey) => new XaiDriver({ apiKey }),
  together: (apiKey) => new TogetherDriver({ apiKey }),
  perplexity: (apiKey) => new PerplexityDriver({ apiKey }),
  cohere: (apiKey) => new CohereDriver({ apiKey }),
  cerebras: (apiKey) => new CerebrasDriver({ apiKey }),
};

/**
 * Resolve a user's decrypted provider key. Returns null when the user has no
 * active key for that provider (or decryption fails). Best-effort bumps
 * last_used_at. NEVER expose the return value over HTTP.
 */
export async function resolveUserProviderKey(
  userId: string | undefined,
  provider: string,
): Promise<string | null> {
  if (!userId) return null;
  const [row] = await db
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
  if (!row?.encryptedKey) return null;
  try {
    const key = decryptSecret(row.encryptedKey);
    void db
      .update(userProviderCredentials)
      .set({ lastUsedAt: new Date() })
      .where(eq(userProviderCredentials.id, row.id));
    return key;
  } catch {
    return null;
  }
}

/**
 * Build a per-request DriverRegistry from the user's stored keys for the given
 * providers. Returns the registry plus the list of providers that could not be
 * registered (no stored key, or unsupported provider) so callers can surface a
 * precise error per provider/model.
 */
export async function buildUserDriverRegistry(
  userId: string | undefined,
  providers: Iterable<string>,
): Promise<{ registry: DriverRegistry; missing: string[] }> {
  const registry = new DriverRegistry();
  const missing: string[] = [];
  for (const provider of new Set(providers)) {
    const factory = DRIVER_FACTORIES[provider];
    if (!factory) {
      missing.push(provider);
      continue;
    }
    const key = await resolveUserProviderKey(userId, provider);
    if (!key) {
      missing.push(provider);
      continue;
    }
    registry.register(factory(key), provider);
  }
  return { registry, missing };
}
