// SPDX-License-Identifier: Apache-2.0
import { createCipheriv, randomBytes } from "node:crypto";

import { describe, it, expect } from "vitest";

import {
  AesGcmVault,
  generatePkce,
  randomState,
  TokenRefresher,
  GoogleVertexAuthProvider,
  AuthProviderRegistry,
  registryFromEnv,
  type TokenHttp,
  type OAuthTokens,
} from "../src/index.js";

// ── Vault ───────────────────────────────────────────────────────────────────

describe("AesGcmVault", () => {
  const key = randomBytes(32);

  it("round-trips plaintext", () => {
    const v = new AesGcmVault(key);
    const sealed = v.seal("super-secret-token");
    expect(sealed).not.toContain("super-secret-token");
    expect(v.open(sealed)).toBe("super-secret-token");
  });

  it("rejects a non-32-byte key", () => {
    expect(() => new AesGcmVault(randomBytes(16))).toThrow(/32 bytes/);
  });

  it("fails to open under a different key (tamper/wrong-key)", () => {
    const sealed = new AesGcmVault(key).seal("x");
    expect(() => new AesGcmVault(randomBytes(32)).open(sealed)).toThrow();
  });

  it("is wire-compatible with secret-crypto's base64(iv|tag|ct) format", () => {
    // Encrypt the way apps/api/src/lib/secret-crypto.ts does, open with the vault.
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([c.update("hello", "utf8"), c.final()]);
    const sealed = Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
    expect(new AesGcmVault(key).open(sealed)).toBe("hello");
  });

  it("fromEnv decodes hex and base64 keys, rejects bad ones", () => {
    const hex = key.toString("hex");
    const b64 = key.toString("base64");
    expect(AesGcmVault.fromEnv("K", { K: hex })).toBeInstanceOf(AesGcmVault);
    expect(AesGcmVault.fromEnv("K", { K: b64 })).toBeInstanceOf(AesGcmVault);
    expect(AesGcmVault.fromEnv("K", { K: "too-short" })).toBeNull();
    expect(AesGcmVault.fromEnv("K", {})).toBeNull();
  });
});

// ── PKCE ────────────────────────────────────────────────────────────────────

describe("PKCE", () => {
  it("generates a URL-safe verifier + S256 challenge", () => {
    const p = generatePkce();
    expect(p.method).toBe("S256");
    expect(p.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(p.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(p.challenge).not.toBe(p.verifier);
  });
  it("randomState is unique-ish and URL-safe", () => {
    const a = randomState();
    const b = randomState();
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
  });
});

// ── Fake transport ────────────────────────────────────────────────────────────

function fakeHttp(responder: (url: string, p: Record<string, string>) => unknown): TokenHttp & {
  calls: Array<{ url: string; params: Record<string, string> }>;
} {
  const calls: Array<{ url: string; params: Record<string, string> }> = [];
  return {
    calls,
    async postForm(url, params) {
      calls.push({ url, params });
      return responder(url, params);
    },
  };
}

// ── Google Vertex provider ────────────────────────────────────────────────────

describe("GoogleVertexAuthProvider", () => {
  const cfg = { clientId: "cid", clientSecret: "csec", project: "my-proj", region: "us-east1" };

  it("builds an auth URL with PKCE + offline access", async () => {
    const p = new GoogleVertexAuthProvider(cfg, fakeHttp(() => ({})));
    const { authUrl, pending } = await p.startLogin({ redirectUri: "https://app/cb" });
    const u = new URL(authUrl);
    expect(u.searchParams.get("client_id")).toBe("cid");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("scope")).toContain("cloud-platform");
    expect(u.searchParams.get("state")).toBe(pending.state);
    expect(pending.codeVerifier).toBeTruthy();
    expect(pending.providerId).toBe("google-vertex");
  });

  it("exchanges a code for tokens and maps to VertexConfig creds", async () => {
    const http = fakeHttp(() => ({
      access_token: "ya29.abc",
      refresh_token: "1//refresh",
      expires_in: 3600,
      token_type: "Bearer",
      scope: "cloud-platform",
    }));
    const p = new GoogleVertexAuthProvider(cfg, http);
    const start = await p.startLogin({ redirectUri: "https://app/cb" });
    const tokens = await p.completeLogin({ code: "auth-code", pending: start.pending });

    expect(tokens.accessToken).toBe("ya29.abc");
    expect(tokens.refreshToken).toBe("1//refresh");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
    // exchange sent the PKCE verifier + grant
    expect(http.calls[0]!.params.grant_type).toBe("authorization_code");
    expect(http.calls[0]!.params.code_verifier).toBe(start.pending.codeVerifier);

    const creds = p.toDriverCredentials(tokens);
    expect(creds).toEqual({ apiKey: "ya29.abc", project: "my-proj", region: "us-east1" });
  });

  it("carries the existing refresh token forward when refresh omits it", async () => {
    const http = fakeHttp(() => ({ access_token: "ya29.new", expires_in: 3600 }));
    const p = new GoogleVertexAuthProvider(cfg, http);
    const refreshed = await p.refresh({ accessToken: "old", refreshToken: "keep-me" });
    expect(refreshed.accessToken).toBe("ya29.new");
    expect(refreshed.refreshToken).toBe("keep-me");
    expect(http.calls[0]!.params.grant_type).toBe("refresh_token");
  });

  it("refuses to refresh without a refresh token", async () => {
    const p = new GoogleVertexAuthProvider(cfg, fakeHttp(() => ({})));
    await expect(p.refresh({ accessToken: "x" })).rejects.toThrow(/no refresh token/);
  });
});

// ── Refresh dedup ─────────────────────────────────────────────────────────────

describe("TokenRefresher", () => {
  const base: OAuthTokens = { accessToken: "a", refreshToken: "r", expiresAt: 1_000_000 };

  it("returns the token untouched when not expiring", async () => {
    const r = new TokenRefresher(60_000);
    let refreshes = 0;
    const provider = {
      refresh: async () => {
        refreshes++;
        return base;
      },
    } as unknown as Parameters<TokenRefresher["ensureFresh"]>[2];
    const out = await r.ensureFresh("k", base, provider, 0); // now far before expiry
    expect(out).toBe(base);
    expect(refreshes).toBe(0);
  });

  it("dedups concurrent refreshes into a single call", async () => {
    const r = new TokenRefresher(60_000);
    let refreshes = 0;
    const provider = {
      refresh: async () => {
        refreshes++;
        await new Promise((res) => setTimeout(res, 10));
        return { accessToken: "fresh", refreshToken: "r", expiresAt: 9_000_000 };
      },
    } as unknown as Parameters<TokenRefresher["ensureFresh"]>[2];
    // now is past (expiresAt - skew) → expiring
    const now = base.expiresAt! - 1;
    const [a, b, c] = await Promise.all([
      r.ensureFresh("acct", base, provider, now),
      r.ensureFresh("acct", base, provider, now),
      r.ensureFresh("acct", base, provider, now),
    ]);
    expect(refreshes).toBe(1); // single refresh shared by all three
    expect(a.accessToken).toBe("fresh");
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("throws when expiring but not refreshable", async () => {
    const r = new TokenRefresher(60_000);
    const provider = {} as unknown as Parameters<TokenRefresher["ensureFresh"]>[2];
    await expect(
      r.ensureFresh("k", { accessToken: "a", expiresAt: 100 }, provider, 100),
    ).rejects.toThrow(/not refreshable/);
  });
});

// ── Registry + skip-with-TODO catalog ──────────────────────────────────────────

describe("AuthProviderRegistry", () => {
  it("registers a provider and rejects duplicates", () => {
    const reg = new AuthProviderRegistry();
    const p = new GoogleVertexAuthProvider({
      clientId: "c",
      clientSecret: "s",
      project: "p",
    });
    reg.register(p);
    expect(reg.get("google-vertex")).toBe(p);
    expect(() => reg.register(p)).toThrow(/duplicate/);
  });

  it("catalog marks unimplemented providers supported:false with a reason", () => {
    const reg = new AuthProviderRegistry();
    const cat = reg.catalog();
    const azure = cat.find((c) => c.id === "azure-openai")!;
    const github = cat.find((c) => c.id === "github-models")!;
    expect(azure.supported).toBe(false);
    expect(azure.reason).toMatch(/driver/i);
    expect(github.supported).toBe(false);
    expect(github.reason).toMatch(/documented/i);
    // google-vertex is supported only once a live plugin is registered
    expect(cat.find((c) => c.id === "google-vertex")!.supported).toBe(false);
  });

  it("registryFromEnv only registers fully-configured providers", () => {
    expect(registryFromEnv({}).list()).toHaveLength(0);
    const reg = registryFromEnv({
      GOOGLE_OAUTH_CLIENT_ID: "c",
      GOOGLE_OAUTH_CLIENT_SECRET: "s",
      GOOGLE_CLOUD_PROJECT: "proj",
    });
    expect(reg.list().map((p) => p.id)).toEqual(["google-vertex"]);
    expect(reg.catalog().find((c) => c.id === "google-vertex")!.supported).toBe(true);
  });
});
