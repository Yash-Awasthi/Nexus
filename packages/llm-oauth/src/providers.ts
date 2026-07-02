// SPDX-License-Identifier: Apache-2.0
/**
 * Concrete authentication providers + the catalog of what's supported.
 *
 * IMPLEMENTED: Google Cloud (→ Vertex AI). Uses the operator's OWN registered
 * Google OAuth client (GOOGLE_OAUTH_CLIENT_ID/SECRET), the standard Google
 * authorization-code + PKCE flow, and the documented `cloud-platform` scope. The
 * resulting access token calls Vertex on the user's own GCP project — a fully
 * sanctioned third-party flow, not CLI impersonation.
 *
 * IMPLEMENTED: Azure OpenAI (→ Microsoft Entra ID). Standard Entra authorization-
 * code + PKCE against the operator's OWN registered app (AZURE_OAUTH_CLIENT_ID/
 * SECRET + AZURE_TENANT_ID), documented `cognitiveservices.azure.com/.default`
 * scope; the issued token is a Bearer AAD token the AzureOpenAIDriver consumes via
 * `authMode:"aad"`. Sanctioned third-party flow, not CLI impersonation.
 *
 * NOT IMPLEMENTED (descriptor stub with reason, per product direction — no
 * workarounds): GitHub Models. See DESCRIPTORS below.
 */
import { generatePkce, randomState } from "./crypto.js";
import type {
  AuthProvider,
  AuthStartResult,
  OAuthTokens,
  PendingAuth,
  ProviderDescriptor,
  TokenHttp,
} from "./types.js";

// ── Default transport (fetch + form encoding) ───────────────────────────────────

export class FetchTokenHttp implements TokenHttp {
  async postForm(url: string, params: Record<string, string>): Promise<unknown> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(params).toString(),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { error: "non_json_response", body: text.slice(0, 500) };
    }
    if (!res.ok) {
      const e = json as { error?: string; error_description?: string };
      throw new Error(`token endpoint ${res.status}: ${e.error ?? ""} ${e.error_description ?? ""}`.trim());
    }
    return json;
  }
}

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

export interface GoogleVertexConfig {
  clientId: string;
  clientSecret: string;
  /** GCP project the Vertex calls bill to (user-supplied). */
  project: string;
  /** Vertex region. Default us-central1. */
  region?: string;
}

/** Google Cloud OAuth → Vertex AI. Sanctioned third-party flow. */
export class GoogleVertexAuthProvider implements AuthProvider {
  readonly id = "google-vertex";
  readonly displayName = "Google Cloud (Vertex AI)";
  readonly flow = "oauth-pkce" as const;

  private static readonly AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
  private static readonly TOKEN_URL = "https://oauth2.googleapis.com/token";
  private static readonly SCOPE = "https://www.googleapis.com/auth/cloud-platform";

  constructor(
    private readonly cfg: GoogleVertexConfig,
    private readonly http: TokenHttp = new FetchTokenHttp(),
  ) {}

  async startLogin({ redirectUri }: { redirectUri: string }): Promise<AuthStartResult> {
    const pkce = generatePkce();
    const state = randomState();
    const url = new URL(GoogleVertexAuthProvider.AUTH_URL);
    url.search = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: GoogleVertexAuthProvider.SCOPE,
      code_challenge: pkce.challenge,
      code_challenge_method: pkce.method,
      state,
      access_type: "offline", // ask for a refresh token
      prompt: "consent", // force refresh-token issuance on re-auth
    }).toString();
    return {
      authUrl: url.toString(),
      pending: { state, codeVerifier: pkce.verifier, redirectUri, providerId: this.id },
    };
  }

  async completeLogin({
    code,
    pending,
  }: {
    code: string;
    pending: PendingAuth;
  }): Promise<OAuthTokens> {
    if (!pending.codeVerifier) throw new Error("google-vertex: missing PKCE verifier");
    const res = (await this.http.postForm(GoogleVertexAuthProvider.TOKEN_URL, {
      grant_type: "authorization_code",
      code,
      redirect_uri: pending.redirectUri,
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      code_verifier: pending.codeVerifier,
    })) as GoogleTokenResponse;
    return this.toTokens(res);
  }

  async refresh(tokens: OAuthTokens): Promise<OAuthTokens> {
    if (!tokens.refreshToken) throw new Error("google-vertex: no refresh token");
    const res = (await this.http.postForm(GoogleVertexAuthProvider.TOKEN_URL, {
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
    })) as GoogleTokenResponse;
    // Google omits refresh_token on refresh — carry the existing one forward.
    return this.toTokens(res, tokens.refreshToken);
  }

  toDriverCredentials(tokens: OAuthTokens): Record<string, unknown> {
    // Shape = VertexConfig from @nexus/llm-drivers. Stored as the same JSON blob
    // the BYOK vertex path already understands, so no new driver wiring.
    return {
      apiKey: tokens.accessToken,
      project: this.cfg.project,
      region: this.cfg.region ?? "us-central1",
    };
  }

  private toTokens(res: GoogleTokenResponse, carryRefresh?: string): OAuthTokens {
    if (!res.access_token) throw new Error("google-vertex: token response missing access_token");
    return {
      accessToken: res.access_token,
      refreshToken: res.refresh_token ?? carryRefresh,
      expiresAt: res.expires_in ? Date.now() + res.expires_in * 1000 : undefined,
      tokenType: res.token_type,
      scope: res.scope,
      extra: { project: this.cfg.project, region: this.cfg.region ?? "us-central1" },
    };
  }
}

interface EntraTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

export interface MicrosoftEntraConfig {
  clientId: string;
  clientSecret: string;
  /** Entra tenant id (or "organizations"/"common"). Segments the authorize/token URL. */
  tenantId: string;
  /** Azure OpenAI resource endpoint, e.g. https://my-resource.openai.azure.com (user-supplied). */
  endpoint: string;
  /** Azure deployment name to route to (distinct from the model id). */
  deployment: string;
  /** Azure API version. Default 2024-10-21. */
  apiVersion?: string;
}

/**
 * Microsoft Entra ID (Azure AD) OAuth → Azure OpenAI. Sanctioned third-party
 * authorization-code + PKCE flow against the operator's own registered Entra app.
 * The access token is an AAD bearer token routed through AzureOpenAIDriver's
 * `authMode:"aad"` path — no api-key ever leaves the deployment.
 */
export class MicrosoftEntraAuthProvider implements AuthProvider {
  readonly id = "azure-openai";
  readonly displayName = "Azure OpenAI (Entra ID)";
  readonly flow = "oauth-pkce" as const;

  // `.default` requests the app's statically-consented scopes; offline_access buys a refresh token.
  private static readonly SCOPE = "https://cognitiveservices.azure.com/.default offline_access";

  constructor(
    private readonly cfg: MicrosoftEntraConfig,
    private readonly http: TokenHttp = new FetchTokenHttp(),
  ) {}

  private authUrl(): string {
    return `https://login.microsoftonline.com/${this.cfg.tenantId}/oauth2/v2.0/authorize`;
  }
  private tokenUrl(): string {
    return `https://login.microsoftonline.com/${this.cfg.tenantId}/oauth2/v2.0/token`;
  }

  async startLogin({ redirectUri }: { redirectUri: string }): Promise<AuthStartResult> {
    const pkce = generatePkce();
    const state = randomState();
    const url = new URL(this.authUrl());
    url.search = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      response_mode: "query",
      scope: MicrosoftEntraAuthProvider.SCOPE,
      code_challenge: pkce.challenge,
      code_challenge_method: pkce.method,
      state,
    }).toString();
    return {
      authUrl: url.toString(),
      pending: { state, codeVerifier: pkce.verifier, redirectUri, providerId: this.id },
    };
  }

  async completeLogin({ code, pending }: { code: string; pending: PendingAuth }): Promise<OAuthTokens> {
    if (!pending.codeVerifier) throw new Error("azure-openai: missing PKCE verifier");
    const res = (await this.http.postForm(this.tokenUrl(), {
      grant_type: "authorization_code",
      code,
      redirect_uri: pending.redirectUri,
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      code_verifier: pending.codeVerifier,
      scope: MicrosoftEntraAuthProvider.SCOPE,
    })) as EntraTokenResponse;
    return this.toTokens(res);
  }

  async refresh(tokens: OAuthTokens): Promise<OAuthTokens> {
    if (!tokens.refreshToken) throw new Error("azure-openai: no refresh token");
    const res = (await this.http.postForm(this.tokenUrl(), {
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      scope: MicrosoftEntraAuthProvider.SCOPE,
    })) as EntraTokenResponse;
    // Entra rotates refresh tokens; fall back to the prior one if omitted.
    return this.toTokens(res, tokens.refreshToken);
  }

  toDriverCredentials(tokens: OAuthTokens): Record<string, unknown> {
    // Shape = AzureOpenAIDriver config with the AAD bearer path selected.
    return {
      apiKey: tokens.accessToken,
      authMode: "aad",
      endpoint: this.cfg.endpoint,
      deployment: this.cfg.deployment,
      apiVersion: this.cfg.apiVersion ?? "2024-10-21",
    };
  }

  private toTokens(res: EntraTokenResponse, carryRefresh?: string): OAuthTokens {
    if (!res.access_token) throw new Error("azure-openai: token response missing access_token");
    return {
      accessToken: res.access_token,
      refreshToken: res.refresh_token ?? carryRefresh,
      expiresAt: res.expires_in ? Date.now() + res.expires_in * 1000 : undefined,
      tokenType: res.token_type,
      scope: res.scope,
      extra: { endpoint: this.cfg.endpoint, deployment: this.cfg.deployment },
    };
  }
}

/**
 * Provider catalog. `supported: false` entries are deliberate skip-with-TODO
 * markers — the provider has no clearly-documented third-party auth path we can
 * implement without a workaround, so we surface the reason instead of faking it.
 */
export const DESCRIPTORS: ProviderDescriptor[] = [
  {
    id: "google-vertex",
    displayName: "Google Cloud (Vertex AI)",
    flow: "oauth-pkce",
    supported: true,
    driverProvider: "vertex",
    requiredEnv: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
  },
  {
    id: "azure-openai",
    displayName: "Azure OpenAI (Entra ID)",
    flow: "oauth-pkce",
    supported: true,
    driverProvider: "azure_openai",
    // Endpoint + deployment are per-user resource config, not OAuth secrets.
    requiredEnv: [
      "AZURE_OAUTH_CLIENT_ID",
      "AZURE_OAUTH_CLIENT_SECRET",
      "AZURE_TENANT_ID",
      "AZURE_OPENAI_ENDPOINT",
      "AZURE_OPENAI_DEPLOYMENT",
    ],
  },
  {
    id: "github-models",
    displayName: "GitHub Models",
    flow: "oauth-device",
    supported: false,
    // TODO: GitHub OAuth Apps are sanctioned, but the GitHub Models inference
    // API is in preview and its OAuth-token scope for third-party apps is not
    // clearly documented. Revisit when GA; do not guess a scope.
    reason: "GitHub Models inference auth scope for third-party OAuth apps not clearly documented (preview).",
    driverProvider: "github-models",
    requiredEnv: ["GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET"],
  },
];
