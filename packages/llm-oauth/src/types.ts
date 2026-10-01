// SPDX-License-Identifier: Apache-2.0
/**
 * Core contracts for the official-authentication framework.
 *
 * SCOPE GUARD: every provider plugin in this package authenticates through a
 * mechanism the provider OFFICIALLY supports for third-party applications (its
 * own OAuth app registration or its documented API auth). This package never
 * reuses an official CLI's embedded client ID and never routes a consumer
 * subscription account. Providers without a documented third-party auth path are
 * left as descriptor stubs marked `supported: false` with a reason — never a
 * workaround.
 */

/** Tokens returned by an OAuth exchange/refresh, provider-agnostic. */
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds at which accessToken expires (undefined = unknown/non-expiring). */
  expiresAt?: number;
  tokenType?: string;
  scope?: string;
  /** Provider-specific non-secret extras carried alongside (e.g. GCP project id). */
  extra?: Record<string, string>;
}

/** Opaque state a login flow must persist between start and callback. */
export interface PendingAuth {
  /** CSRF state echoed back on the callback. */
  state: string;
  /** PKCE code verifier (oauth-pkce flow only). */
  codeVerifier?: string;
  redirectUri: string;
  /** Device-code flow: the device_code to poll the token endpoint with. */
  deviceCode?: string;
  /** Provider id this pending auth belongs to. */
  providerId: string;
}

export interface AuthStartResult {
  /** URL to send the user to (oauth-pkce), or the verification URL (device-code). */
  authUrl: string;
  /** Persist this until the callback / poll completes. Contains no long-lived secret. */
  pending: PendingAuth;
  /** Device-code flow: user code to display + poll interval seconds. */
  device?: { userCode: string; intervalSec: number; expiresInSec: number };
}

export type AuthFlow = "oauth-pkce" | "oauth-device" | "api-key";

/**
 * A pluggable authentication provider. All concrete providers implement this
 * single interface so the registry and refresh machinery stay provider-agnostic.
 */
export interface AuthProvider {
  readonly id: string;
  readonly displayName: string;
  readonly flow: AuthFlow;
  /** Begin a login. Returns the URL to visit + pending state to persist. */
  startLogin(opts: { redirectUri: string }): Promise<AuthStartResult>;
  /** Complete an authorization-code/PKCE login by exchanging the callback code. */
  completeLogin(params: { code: string; pending: PendingAuth }): Promise<OAuthTokens>;
  /** Exchange a refresh token for a fresh access token. Throws if not refreshable. */
  refresh(tokens: OAuthTokens): Promise<OAuthTokens>;
  /**
   * Map stored tokens into the credential object the matching @nexus/llm-drivers
   * driver consumes (e.g. Google → VertexConfig `{ apiKey, project, region }`).
   */
  toDriverCredentials(tokens: OAuthTokens): Record<string, unknown>;
}

/** Catalog metadata for a provider — drives UI + records why a provider is absent. */
export interface ProviderDescriptor {
  id: string;
  displayName: string;
  flow: AuthFlow;
  /** False = no plugin yet; `reason` explains why (skip-with-TODO, never a workaround). */
  supported: boolean;
  reason?: string;
  /** llm-drivers provider id this maps to when authed. */
  driverProvider?: string;
  /** Env vars the operator must set to enable this provider (their OWN registered app). */
  requiredEnv?: string[];
}

/** Minimal form-POST transport so token exchange is unit-testable without network. */
export interface TokenHttp {
  postForm(url: string, params: Record<string, string>): Promise<unknown>;
}

/** Encrypted-at-rest credential store. */
export interface Vault {
  /** Encrypt plaintext → opaque base64 token. */
  seal(plaintext: string): string;
  /** Decrypt a value produced by seal(). Throws on tamper/wrong key. */
  open(sealed: string): string;
}
