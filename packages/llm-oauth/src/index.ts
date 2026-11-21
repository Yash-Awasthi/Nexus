// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/llm-oauth — official-authentication framework for LLM providers.
 *
 * PRODUCT DIRECTION (enforced by scope): authenticate ONLY through mechanisms a
 * provider officially supports for third-party applications. No subscription-CLI
 * routing, no reuse of an official CLI's embedded client ID. Providers without a
 * documented third-party path are skip-with-TODO (see providers.ts DESCRIPTORS).
 *
 * Integration: a completed login yields tokens whose `toDriverCredentials()`
 * output matches an existing @nexus/llm config (Google → VertexConfig),
 * so an authed account is stored as the same encrypted JSON-blob credential the
 * BYOK path already routes — no new driver wiring required.
 *
 * Persistence: `OAuthTokenStore` (store.ts) seals the token bundle and persists
 * it through an injected `SealedTokenStore` port; the DB adapter binds that port
 * to the `oauth_credentials` table (@nexus/db). `resolveFresh()` refreshes +
 * re-persists at resolve time; `revoke()` hard-deletes.
 *
 * Wired: apps/api/src/routes/llm-oauth.ts serves the login, callback and revoke
 * routes, and apps/api/src/lib/oauth-token-store.ts binds the
 * `SealedTokenStore` port to drizzle (`DrizzleSealedTokenStore`).
 */
export * from "./types.ts";
export { AesGcmVault, generatePkce, randomState, type Pkce } from "./crypto.ts";
export { TokenRefresher } from "./refresh.ts";
export {
  GoogleVertexAuthProvider,
  MicrosoftEntraAuthProvider,
  type GoogleVertexConfig,
  type MicrosoftEntraConfig,
} from "./providers.ts";
export { AuthProviderRegistry, registryFromEnv } from "./registry.ts";
export { OAuthTokenStore } from "./store.ts";
export type { SealedRecord, SealedTokenStore, OAuthTokenStoreOptions } from "./store.ts";
