// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the provider-OAuth routes (/llm-oauth/*).
 *
 * These run WITHOUT live infra or a real Google call: the routes are built with
 * injected deps — a real GoogleVertexAuthProvider wired to a MOCKED TokenHttp
 * (so completeLogin exercises the true PKCE exchange path but returns canned
 * tokens), an in-memory SealedTokenStore, and a trivial reversible vault. Auth
 * is a real HS256 JWT signed with a test secret.
 */
import { signJwt } from "@nexus/auth";
import {
  AuthProviderRegistry,
  GoogleVertexAuthProvider,
  OAuthTokenStore,
  type SealedRecord,
  type SealedTokenStore,
  type TokenHttp,
  type Vault,
} from "@nexus/llm-oauth";
import Fastify, { type FastifyInstance } from "fastify";
import { beforeAll, beforeEach, describe, it, expect, vi } from "vitest";

import { makeLlmOauthRoutes } from "../../src/routes/llm-oauth.js";

const JWT_SECRET = "test-oauth-secret";
const USER_ID = "user-abc-123";

function authHeader(sub = USER_ID): string {
  const token = signJwt(
    { sub, role: "admin", iat: 1_000, exp: 9_999_999_999 } as Parameters<typeof signJwt>[0],
    JWT_SECRET,
  );
  return `Bearer ${token}`;
}

// ── Test doubles ────────────────────────────────────────────────────────────────

/** Mocked token endpoint — records the form it was posted, returns canned tokens. */
class FakeTokenHttp implements TokenHttp {
  calls: { url: string; params: Record<string, string> }[] = [];
   
  async postForm(url: string, params: Record<string, string>): Promise<unknown> {
    this.calls.push({ url, params });
    return {
      access_token: "ya29.fake-access",
      refresh_token: "1//fake-refresh",
      expires_in: 3600,
      token_type: "Bearer",
      scope: "https://www.googleapis.com/auth/cloud-platform",
    };
  }
}

/** In-memory SealedTokenStore keyed (userId, providerId). */
class MemSealedStore implements SealedTokenStore {
  m = new Map<string, SealedRecord>();
  private k(u: string, p: string): string {
    return `${u}::${p}`;
  }
   
  async upsert(rec: SealedRecord): Promise<void> {
    this.m.set(this.k(rec.userId, rec.providerId), rec);
  }
   
  async get(u: string, p: string): Promise<SealedRecord | null> {
    return this.m.get(this.k(u, p)) ?? null;
  }
   
  async delete(u: string, p: string): Promise<boolean> {
    return this.m.delete(this.k(u, p));
  }
}

/** Reversible fake vault — base64 round-trip, no crypto. */
const fakeVault: Vault = {
  seal: (p) => Buffer.from(p, "utf8").toString("base64"),
  open: (s) => Buffer.from(s, "base64").toString("utf8"),
};

function buildRegistry(http: TokenHttp): AuthProviderRegistry {
  return new AuthProviderRegistry().register(
    new GoogleVertexAuthProvider(
      { clientId: "cid", clientSecret: "csecret", project: "proj-1", region: "us-central1" },
      http,
    ),
  );
}

/** Pull the `state` out of a returned Google authorize URL. */
function stateOf(authUrl: string): string {
  return new URL(authUrl).searchParams.get("state")!;
}

// ── Harness ─────────────────────────────────────────────────────────────────────

let app: FastifyInstance;
let http: FakeTokenHttp;
let sealed: MemSealedStore;
let store: OAuthTokenStore | null;

async function boot(makeStore?: () => OAuthTokenStore | null): Promise<void> {
  http = new FakeTokenHttp();
  sealed = new MemSealedStore();
  store = new OAuthTokenStore(fakeVault, sealed);
  app = Fastify();
  await app.register(
    makeLlmOauthRoutes({
      getRegistry: () => buildRegistry(http),
      makeStore: makeStore ?? (() => store),
    }),
  );
  await app.ready();
}

beforeAll(() => {
  process.env.NEXUS_JWT_SECRET = JWT_SECRET;
});

beforeEach(async () => {
  await boot();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /llm-oauth/providers", () => {
  it("returns the catalog with google-vertex supported and stubs unsupported", async () => {
    const res = await app.inject({ method: "GET", url: "/llm-oauth/providers" });
    expect(res.statusCode).toBe(200);
    const { providers } = res.json() as { providers: { id: string; supported: boolean }[] };
    const g = providers.find((p) => p.id === "google-vertex");
    expect(g?.supported).toBe(true);
    expect(providers.find((p) => p.id === "azure-openai")?.supported).toBe(false);
    expect(providers.find((p) => p.id === "github-models")?.supported).toBe(false);
  });
});

describe("POST /llm-oauth/:provider/start", () => {
  it("401 without auth", async () => {
    const res = await app.inject({ method: "POST", url: "/llm-oauth/google-vertex/start" });
    expect(res.statusCode).toBe(401);
  });

  it("404 for an unknown/unsupported provider", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/llm-oauth/azure-openai/start",
      headers: { authorization: authHeader() },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns a Google authorize URL with a server-derived redirect_uri", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/llm-oauth/google-vertex/start",
      headers: { authorization: authHeader() },
    });
    expect(res.statusCode).toBe(200);
    const { authUrl } = res.json() as { authUrl: string };
    const u = new URL(authUrl);
    expect(u.host).toBe("accounts.google.com");
    expect(u.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/v1/llm-oauth/google-vertex/callback",
    );
    expect(u.searchParams.get("code_challenge")).toBeTruthy();
    expect(stateOf(authUrl)).toBeTruthy();
  });
});

describe("GET /llm-oauth/:provider/callback", () => {
  async function startAndGetState(): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/llm-oauth/google-vertex/start",
      headers: { authorization: authHeader() },
    });
    return stateOf((res.json() as { authUrl: string }).authUrl);
  }

  it("completes the login: exchanges the code, seals + persists tokens", async () => {
    const state = await startAndGetState();
    const res = await app.inject({
      method: "GET",
      url: `/llm-oauth/google-vertex/callback?code=auth-code-xyz&state=${state}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, provider: "google-vertex" });

    // The token exchange was an authorization_code grant carrying the PKCE verifier.
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]!.params.grant_type).toBe("authorization_code");
    expect(http.calls[0]!.params.code).toBe("auth-code-xyz");
    expect(http.calls[0]!.params.code_verifier).toBeTruthy();

    // Credentials were persisted for this user under google-vertex.
    const rec = await sealed.get(USER_ID, "google-vertex");
    expect(rec).not.toBeNull();
    const opened = JSON.parse(fakeVault.open(rec!.sealed)) as { accessToken: string };
    expect(opened.accessToken).toBe("ya29.fake-access");
  });

  it("400 missing_code", async () => {
    const state = await startAndGetState();
    const res = await app.inject({
      method: "GET",
      url: `/llm-oauth/google-vertex/callback?state=${state}`,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe("missing_code");
  });

  it("400 invalid_state for an unknown state", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/llm-oauth/google-vertex/callback?code=x&state=never-issued",
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe("invalid_state");
  });

  it("state is single-use (delete-on-read)", async () => {
    const state = await startAndGetState();
    const url = `/llm-oauth/google-vertex/callback?code=c1&state=${state}`;
    const first = await app.inject({ method: "GET", url });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "GET", url });
    expect(second.statusCode).toBe(400);
    expect((second.json() as { error: string }).error).toBe("invalid_state");
  });

  it("503 when the vault is unavailable", async () => {
    await boot(() => null); // makeStore returns null → vault unavailable
    const state = await startAndGetState();
    const res = await app.inject({
      method: "GET",
      url: `/llm-oauth/google-vertex/callback?code=c&state=${state}`,
    });
    expect(res.statusCode).toBe(503);
  });

  it("502 when the upstream token exchange throws", async () => {
    const state = await startAndGetState();
    // Swap the provider transport to one that fails the exchange.
    http.postForm = () => Promise.reject(new Error("token endpoint 400"));
    const res = await app.inject({
      method: "GET",
      url: `/llm-oauth/google-vertex/callback?code=c&state=${state}`,
    });
    expect(res.statusCode).toBe(502);
  });
});

describe("POST /llm-oauth/:provider/revoke", () => {
  it("401 without auth", async () => {
    const res = await app.inject({ method: "POST", url: "/llm-oauth/google-vertex/revoke" });
    expect(res.statusCode).toBe(401);
  });

  it("revoked:false when nothing is stored", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/llm-oauth/google-vertex/revoke",
      headers: { authorization: authHeader() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ revoked: false });
  });

  it("revoked:true, calls Google's revoke endpoint, then hard-deletes", async () => {
    await store!.save(USER_ID, "google-vertex", {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: Date.now() + 3600_000,
    });
    expect(await sealed.get(USER_ID, "google-vertex")).not.toBeNull();

    // Stub global fetch so the best-effort upstream revoke never leaves the box.
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    const orig = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const res = await app.inject({
        method: "POST",
        url: "/llm-oauth/google-vertex/revoke",
        headers: { authorization: authHeader() },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ revoked: true });
    } finally {
      globalThis.fetch = orig;
    }

    // Upstream revoke hit Google with the refresh token as the form field.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://oauth2.googleapis.com/revoke");
    expect(String(init.body)).toContain("token=r");

    // Local hard-delete is authoritative.
    expect(await sealed.get(USER_ID, "google-vertex")).toBeNull();
  });
});
