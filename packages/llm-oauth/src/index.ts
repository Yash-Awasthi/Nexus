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
 * output matches an existing @nexus/llm-drivers config (Google → VertexConfig),
 * so an authed account is stored as the same encrypted JSON-blob credential the
 * BYOK path already routes — no new driver wiring required.
 *
 * Persistence: `OAuthTokenStore` (store.ts) seals the token bundle and persists
 * it through an injected `SealedTokenStore` port; the DB adapter binds that port
 * to the `oauth_credentials` table (@nexus/db). `resolveFresh()` refreshes +
 * re-persists at resolve time; `revoke()` hard-deletes.
 *
 * Not yet wired: the API login/callback routes themselves + the concrete drizzle
 * `SealedTokenStore` adapter. TODO(P5-routes): add apps/api routes that start the
 * login, persist via OAuthTokenStore.save(), and resolve via resolveFresh().
 */
export * from "./types.js";
export { AesGcmVault, generatePkce, randomState, type Pkce } from "./crypto.js";
export { TokenRefresher } from "./refresh.js";
export {
  GoogleVertexAuthProvider,
  FetchTokenHttp,
  DESCRIPTORS,
  type GoogleVertexConfig,
} from "./providers.js";
export { AuthProviderRegistry, registryFromEnv } from "./registry.js";
export { OAuthTokenStore } from "./store.js";
export type { SealedRecord, SealedTokenStore, OAuthTokenStoreOptions } from "./store.js";
