// SPDX-License-Identifier: Apache-2.0
/**
 * OAuth-backed LLM drivers for chat resolution.
 *
 * Bridges the two credential worlds:
 *   - BYOK:  the user pastes an API key → `user_provider_credentials`
 *   - OAuth: the user links a provider account (Sign in with Google → Vertex,
 *            Microsoft Entra → Azure OpenAI) → `oauth_credentials`
 *
 * `resolveOAuthDriver(userId, driverProvider)` loads the user's linked account
 * for the llm-oauth provider that can serve a given driver-provider id, refreshes
 * an expiring access token, and hands the provider's `toDriverCredentials()`
 * output straight to the matching @nexus/llm-drivers constructor — no new driver
 * wiring. Returns null whenever nothing is linked / configured, so callers treat
 * it exactly like "no key": a missing account is not an error.
 */
import { AzureOpenAIDriver, VertexDriver, type LlmDriver } from "@nexus/llm-drivers";
import { registryFromEnv, type OAuthTokens } from "@nexus/llm-oauth";

import { createOAuthTokenStore } from "./oauth-token-store.js";

/** Driver-provider id (chat member `provider`) → llm-oauth provider id that can
 *  supply credentials for it. Extend as more OAuth providers ship. */
export const OAUTH_DRIVER_PROVIDERS: Record<string, string> = {
  vertex: "google-vertex",
  azure_openai: "azure-openai",
};

/** Build a driver from an llm-oauth provider's `toDriverCredentials()` output. */
function buildDriver(driverProvider: string, creds: Record<string, unknown>): LlmDriver {
  // The llm-oauth providers promise their toDriverCredentials() output matches
  // the matching llm-drivers config — assert via unknown to cross the type gap.
  if (driverProvider === "vertex") {
    return new VertexDriver(creds as unknown as ConstructorParameters<typeof VertexDriver>[0]);
  }
  if (driverProvider === "azure_openai") {
    return new AzureOpenAIDriver(
      creds as unknown as ConstructorParameters<typeof AzureOpenAIDriver>[0],
    );
  }
  throw new Error(`oauth-drivers: no driver factory for provider "${driverProvider}"`);
}

/**
 * Resolve a driver backed by the user's OAuth-linked provider account.
 * Resolution order is caller's job (BYOK key wins over OAuth, which wins over
 * server env). Refresh-before-use when the access token is within 60s of expiry;
 * a failed refresh keeps the stored token and lets the call fail loudly.
 */
export async function resolveOAuthDriver(
  userId: string | undefined,
  driverProvider: string,
): Promise<{ driver: LlmDriver; oauthProviderId: string } | null> {
  if (!userId) return null;
  const oauthProviderId = OAUTH_DRIVER_PROVIDERS[driverProvider];
  if (!oauthProviderId) return null;
  const provider = registryFromEnv().get(oauthProviderId);
  if (!provider) return null; // operator hasn't configured the OAuth app
  const store = createOAuthTokenStore();
  if (!store) return null; // vault key unset → 503-equivalent, like BYOK
  let tokens: OAuthTokens | null = null;
  try {
    tokens = await store.load(userId, oauthProviderId);
  } catch {
    return null; // sealed blob unreadable → treat as not linked
  }
  if (!tokens) return null;
  if (tokens.expiresAt && tokens.expiresAt < Date.now() + 60_000) {
    try {
      const fresh = await provider.refresh(tokens);
      await store.save(userId, oauthProviderId, fresh);
      tokens = fresh;
    } catch {
      /* keep the stored token; the driver call surfaces the failure */
    }
  }
  return {
    driver: buildDriver(driverProvider, provider.toDriverCredentials(tokens)),
    oauthProviderId,
  };
}
