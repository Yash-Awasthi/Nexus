// SPDX-License-Identifier: Apache-2.0
/**
 * §9.1: OIDC discovery (`/.well-known/openid-configuration`) and JWKS/token
 * fetches in oidc.ts must go through `pinnedFetch`, not the raw global
 * `fetch`. NEXUS_OIDC_ISSUER is admin-configured, not request-time input, but
 * the discovery call fires on every login attempt — pin the socket to the
 * validated DNS answer to close the DNS-rebinding window (same pattern as
 * connectors.ts's token-exchange sink).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildServer } from "../../src/server.js";
import type { FastifyInstance } from "fastify";

const pinnedFetchMock = vi.fn();
vi.mock("../../src/lib/pinned-fetch.js", () => ({
  pinnedFetch: (...args: unknown[]) => pinnedFetchMock(...args),
}));

describe("GET /auth/oidc/authorize — pinned-fetch sink", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.NEXUS_OIDC_ISSUER = "https://idp.example.com";
    process.env.NEXUS_OIDC_CLIENT_ID = "oidc-client-id";
    process.env.NEXUS_OIDC_CLIENT_SECRET = "oidc-client-secret";
    process.env.NEXUS_OIDC_REDIRECT_URI = "https://nexus.example.com/api/v1/auth/oidc/callback";
    pinnedFetchMock.mockReset();
    app = await buildServer();
  });

  afterEach(async () => {
    await app.close();
    delete process.env.NEXUS_OIDC_ISSUER;
    delete process.env.NEXUS_OIDC_CLIENT_ID;
    delete process.env.NEXUS_OIDC_CLIENT_SECRET;
    delete process.env.NEXUS_OIDC_REDIRECT_URI;
  });

  it("routes OIDC discovery through pinnedFetch, not global fetch", async () => {
    const globalFetch = vi.fn();
    vi.stubGlobal("fetch", globalFetch);
    pinnedFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        issuer: "https://idp.example.com",
        authorization_endpoint: "https://idp.example.com/authorize",
        token_endpoint: "https://idp.example.com/token",
        jwks_uri: "https://idp.example.com/jwks",
      }),
    });

    const res = await app.inject({ method: "GET", url: "/api/v1/auth/oidc/authorize" });

    expect(res.statusCode).toBe(302);
    expect(pinnedFetchMock).toHaveBeenCalledTimes(1);
    expect(pinnedFetchMock.mock.calls[0]?.[0]).toBe(
      "https://idp.example.com/.well-known/openid-configuration",
    );
    expect(globalFetch).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("surfaces a pinnedFetch discovery rejection (e.g. DNS-rebind block) as a clean 502", async () => {
    // Distinct issuer from the previous test — fetchDiscovery caches by
    // issuer, and a cache hit would skip pinnedFetch entirely.
    process.env.NEXUS_OIDC_ISSUER = "https://idp2.example.com";
    pinnedFetchMock.mockRejectedValue(
      new Error("pinnedFetch: destination resolved to a private address"),
    );

    const res = await app.inject({ method: "GET", url: "/api/v1/auth/oidc/authorize" });

    expect(res.statusCode).toBe(502);
    const body = res.json<{ error: string }>();
    expect(body.error).toBe("oidc_discovery_failed");
  });
});
