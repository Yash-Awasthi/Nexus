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
 * Not yet wired: API login/callback routes + a DB column for the refresh token.
 * TODO(P5-routes): add apps/api routes that persist the sealed token blob and
 * call TokenRefresher.ensureFresh() at resolve time.
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
